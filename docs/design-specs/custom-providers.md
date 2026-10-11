# 自定义服务商余额（任意 Bearer 厂商）设计

> 后续迭代（服务商卡片化、按家开关、侧边栏软写入）见 `provider-cards.md`：
> `providersEnabled` / `includeBuiltin` 已被 `builtinProviders` / `builtinIds` 取代。

日期：2026-10-11　级别：L2-F　基线：本机魔改工程 v0.4.7（装机版，含未发布的内置三家服务商功能）

## 目标

1. 「服务商」页可直接填任意 Bearer 型厂商的 API Key，保存即完成添加（Key 落 DSH 凭据中心）。
2. 每个已添加服务商在「设置」页出现以 DeepSeek 余额 / Z.ai 额度为模板的开关组。
3. 在设置开启「侧边栏展示」的服务商，其余额出现在侧边栏底部（宽列 + 折叠 rail）。

## 客观约束

- 不存在统一余额接口：每家 URL / 鉴权 / 字段不同。故自助添加必须同时提供
  余额 URL 与余额字段路径；只给 Key 无法通用（否则为假实现）。
- 本期自助仅支持 `Authorization: Bearer <key>` + GET JSON。火山 HMAC、小米 Cookie
  维持现有内置三家，不支持自助。
- Key 唯一落点是凭据中心 `~/.dsh/.credentials.yaml`（0600、文件锁、热更新）。
  插件配置里只存「环境变量名引用」，绝不存值、不进日志、不进 Remote 返回、不回显。

## 数据模型

- `UsageSettings.customProviders: CustomProviderConfig[]`（profile 配置，跟随部署）：
  `{ id, label, endpoint, credentialRef, valuePath, currency, enabled, showInSidebar, fetchMinutes }`。
  密钥不在其中，只有 `credentialRef` 变量名。条数上限 30。
- `ProviderQuotaId` 由三字面量联合放宽为 `string`；内置三家 id 常量移至 utils
  （types.ts 为 types-only，不放运行时常量）。
- 线路请求 `ProviderQuotasRequest` 在 `QuotaRequest` 上增加
  `includeBuiltin?: boolean`（默认 true）与 `providers?: CustomProviderQuery[]`。

## 服务端

- 新增 `host/customProviderQuota.ts`：通用 Bearer 余额查询。强制 https；
  ref 名校验；点路径仅允许标识符/数字下标（无 eval）；401/403→no-key，
  取不到字段→error。全程结构化返回不抛错。
- `providerQuota.ts`：查询集 = 可选内置三家 + 传入的自定义列表，Promise.all 互不影响。
- `quota.ts createQuotaQuery`：缓存/单飞按「请求形状」分桶，避免侧边栏（仅自定义子集）
  与服务商页（内置+全部自定义）互相串缓存；三路既有调用 arg 为空，行为不变。
- 新增 Remote：
  - `describeCredential({ref}) → {ref, configured, writable}`，只回布尔，不回值。
  - `saveCredential({ref, value}) → {saved:true, ref}`，服务端校验后调
    `credentials.write(ref,value)`；凭据服务不可写 / env 只读 / 非法名 → RemoteError。
- 删除服务商卡片只删配置定义，**不删凭据中心的 Key**。

## 客户端

- `ProvidersTab`：列表 = 内置三家（受 `providersEnabled` 控制）+ 自定义（各受自身
  `enabled` 控制）；底部「添加服务商」打开 `ProviderForm`；自定义卡片可编辑/删除。
- `ProviderForm`：预置模板（Kimi、OpenRouter，端点与字段经官方文档核实）+ 通用模板；
  Key 密码框添加必填、编辑留空表示不改；保存前 `describeCredential` 发现同名已存在则
  二次确认覆盖；保存走 `saveCredential` 再写 `customProviders`。
- `SettingsTab`：为每个自定义服务商渲染开关组（启用监控 / 侧边栏展示 / 抓取间隔）。
- `UsageStatsFooter`：对 `enabled && showInSidebar` 的自定义条目常驻轮询
  （includeBuiltin=false，间隔取其中最小值），宽列加余额行、rail 加迷你芯片 + Tooltip。
- 文案进 locales zh/en；动态名称用 `{name}` 插值。

## 安全复核

Key 仅经 saveCredential 写凭据中心；describe 不回值；删除保留 Key；endpoint 强制 https；
ref 白名单；value 长度上限 4096；providers 上限 30 并经 zod 校验；不记录任何密钥值。

## 回滚

- 装机 lib 备份：`…dsh-usage-stats-lib.bak-20261011-122642`。
- 源码 src+lib 备份：工作区 `tmp/ustats-src-baseline-20261011-122642`。
- 回滚 = 还原 lib 两个文件后重启 dsh。Windows 环境，无需 ops.db。

## 生效

服务端产物变更需重启 dsh（本会话运行于 dsh 内，不由 agent 重启）；浏览器刷新加载新 client。
