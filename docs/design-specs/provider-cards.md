# 服务商卡片化：Key 直填、按家开关与侧边栏软写入设计

日期：2026-10-11　级别：L2-F　基线：本机魔改工程 v0.4.7（含自定义 Bearer 厂商，见 `custom-providers.md`）

## 目标（用户四条，逐条落点）

1. DeepSeek 余额、Z.ai 额度、OpenCode Go 额度三个监控的设置从「设置」页迁到「服务商」页。
2. 侧边栏里 Z.ai / OpenCode Go 由硬编码行改为与内置/自定义服务商同构的「软写入」行；
   DeepSeek 余额保留专属硬编码行（多币种明细是它独有的展示）。
3. 「服务商」页每张卡可直接填 Key（+保存按钮），并内嵌「启用监控 / 在侧边栏展示 / 抓取间隔」。
4. 侧边栏展示开关打开即在底部出现该家额度行（数据未加载时给占位横杠）。

## 客观约束

- 各家凭据变量名不同且部分是多凭据：SiliconFlow 1 项；DeepSeek / Z.ai / Go 1–2 项（互为回退）；
  小米 MiMo 2 项（API Key 或 Cookie 二选一）；火山引擎 AK/SK 2 项（签名鉴权，缺一不可）。
  故 Key 行按「该家的变量名清单」渲染 N 个密码框，保存逐项写凭据中心（留空 = 不改）。
- 内置三家的余额查询彼此独立、按 id 白名单查询；此前共享一个总开关，无法按家停用/上侧边栏。
- 侧边栏轮询必须只带「需要展示的子集」，否则关掉监控的家会被白白轮询。

## 数据模型

- 新增 `UsageSettings.builtinProviders: BuiltinProviderSettings[]`
  （`{ id, enabled, showInSidebar, fetchMinutes }`，恒为固定三家、顺序同
  `BUILTIN_PROVIDER_IDS`）。删除共享字段 `providersEnabled` / `providersFetchMinutes`；
  归一化时若旧字段仍在配置文档里，其值灌进三家初始值（各家已有取值优先），升级不丢选择。
- `ProviderQuotasRequest` 的 `includeBuiltin?: boolean` 改为 `builtinIds?: string[]`
  （白名单子集；参与服务端缓存分桶）。服务商页传「启用的内置家」，侧边栏传
  「启用且勾选侧边栏」的内置家与自定义家。

## 客户端

- 新增 `ProviderKeyRow`：性格化的卡片内 Key 行（密码框 × N + 保存），流程与
  `ProviderForm` 同源（本地校验 → `describeCredential` 探测可写/同名 → 二次确认 →
  `saveCredential` 逐项写 → 回调刷新额度）。
- 新增 `ProviderSwitchRows`：三项偏好行（文案键由调用方给，支持 `{name}` 插值），
  内置三家、DeepSeek / Z.ai / Go 与自定义厂商共用；`CustomProviderSettingsGroup` 删除。
- `ProvidersTab` 重排为：内置服务商分组 = DeepSeek / Z.ai / OpenCode Go（各自 hook 的
  额度摘要 + Key 行 + 三项开关）+ SiliconFlow / 小米 MiMo / 火山引擎（`providerQuotas`
  聚合，按家开关），随后是「我添加的服务商」分组（卡片内嵌三项开关与编辑/删除）。
  面板把底部角标的 go/deepseek/zai 数据与刷新回调透传给本 Tab（与概览共用一份轮询）。
- `SettingsTab` 移除四组额度偏好与自定义厂商组，只留模型重定向、会话徽标、账本操作与页脚。
- `UsageStatsFooter`：Z.ai / Go / 内置 / 自定义统一进 `monitorItems` + `providerItems`
  两份数据驱动清单（是否出现只由偏好决定），DeepSeek 保留专属硬编码行；提供方行支持
  金额与百分比窗口芯片、按 id 取条目、未加载给占位横杠。

## 验证

`tsc --noEmit`、`eslint .`（0 errors）、`tsdown` 生产构建、`pure.mjs`（120 用例）、
`smoke.mjs`（含 builtinIds 子集与空聚合断言）、`styles.mjs`、`client-bundle.mjs`
全部通过；产物覆盖到装机 lib 后需完全重启 dsh（host 变更）并刷新浏览器（client 变更）。

## 回滚

- 源码与产物基线：工作区 `.backups/dsh-usage-stats-baseline-<时间戳>`（src/lib/docs/test）。
- 装机 lib 备份：`~/.dsh/profiles/desktop/node_modules/@xfqz86/dsh-usage-stats-lib.bak-*`。
- 回滚 = 还原 src 与 lib 后重新构建/重启。Windows 本地工程，无需 ops.db。