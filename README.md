# dsh-usage-stats — DSH 用量统计插件

DSH 的 Web 用量统计插件，按模型、会话、日期三个维度统计 token 用量与调用次数，挂载于侧边栏底部展示今日用量，点击打开详情面板。

> 本仓库是 [xfqz86/dsh-usage-stats](https://github.com/xfqz86/dsh-usage-stats) 的 fork，在服务商额度管理上做了增强：「服务商」页集中管理各家的额度监控、可直接填入 API Key、逐家开关侧边栏展示（见 [CHANGELOG](CHANGELOG.md)）。上游发布的 npm 包不含这些改动。

## 功能

- 侧边栏底部今日统计，宽列与 56px rail 自适应展示
- 详情面板按概览、日期、会话、模型、服务商、设置组织
- 模型统计重定向：在设置页配置「把某个供应商的某个模型的用量算到另一个供应商的某个模型名下」，模型页按规则归并展示（账本原始数据不变）
- 「服务商」页一家一卡集中管理额度监控：可直接填入 API Key 保存（写入 DSH 凭据中心），并逐家开关「启用监控 / 在侧边栏展示 / 抓取间隔」
- OpenCode Go 额度，展示滚动 5 小时、本周、本月三档剩余额度
- DeepSeek 余额，展示多币种余额
- Z.ai 额度，展示滚动 5 小时与本周百分比，以及每月 Web 搜索次数
- 会话标题旁 session-id 徽标，悬停浮现复制按钮（设置页可关，默认开）

<p align="center">
  <img src="https://raw.githubusercontent.com/Jlnine/dsh-usage-stats/main/docs/screenshot/footer.png" alt="侧边栏底部" width="320" />
  <br>
  <em>侧边栏底部</em>
</p>

<table>
  <tr>
    <td align="center" width="50%">
      <img src="https://raw.githubusercontent.com/Jlnine/dsh-usage-stats/main/docs/screenshot/01-overview.png" alt="概览" />
      <br>
      <sub>概览</sub>
    </td>
    <td align="center" width="50%">
      <img src="https://raw.githubusercontent.com/Jlnine/dsh-usage-stats/main/docs/screenshot/02-dates.png" alt="日期" />
      <br>
      <sub>日期</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="https://raw.githubusercontent.com/Jlnine/dsh-usage-stats/main/docs/screenshot/03-sessions.png" alt="会话" />
      <br>
      <sub>会话</sub>
    </td>
    <td align="center" width="50%">
      <img src="https://raw.githubusercontent.com/Jlnine/dsh-usage-stats/main/docs/screenshot/04-models.png" alt="模型" />
      <br>
      <sub>模型</sub>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2" width="50%">
      <img src="https://raw.githubusercontent.com/Jlnine/dsh-usage-stats/main/docs/screenshot/05-settings.png" alt="设置" width="75%" />
      <br>
      <sub>设置</sub>
    </td>
  </tr>
</table>

## 安装与卸载

本插件为标准 cordis 组合包，通过 profile 注入 web。

### 从 npm 安装

```bash
dsh plugin --profile web add @xfqz86/dsh-usage-stats
```

> 这是上游发布的正式包，**不含本仓库的增强**；要装本仓库的版本请用下面的 GitHub 或 tarball 方式。

### 从 GitHub 安装（源码，安装时自构建）

```bash
dsh plugin --profile web add github:Jlnine/dsh-usage-stats
```

> 安装时经 `prepare: tsdown` 自动构建，取到的始终是 main 的最新源码。上游另有预构建的
> `release` 分支形态（`github:Jlnine/dsh-usage-stats#release`）；本 fork 的 `release` 分支由
> 工作流在 main 的 CI 跑绿后自动同步（fork 仓库需先在 Actions 页启用工作流），启用前该形态
> 仍是上游旧产物，不建议使用。

### 从 tarball 安装

```bash
dsh plugin --profile web add https://github.com/Jlnine/dsh-usage-stats/releases/latest/download/xfqz86-dsh-usage-stats.tgz
```

> 固定地址，始终指向本仓库最新 Release 的 tarball（文件名沿用包名，不含版本号）。

### 本地开发

```bash
git clone https://github.com/Jlnine/dsh-usage-stats.git
cd dsh-usage-stats
pnpm install
pnpm build
dsh plugin --profile web add "link:$(pwd)"
# 后续改动后重新 pnpm build，浏览器刷新即可；服务端改动需重启 dsh
```

### 卸载

```bash
dsh plugin --profile web remove @xfqz86/dsh-usage-stats
```

## 设置

设置位于详情面板的设置 Tab，保存在 DSH 该 profile 的配置文件 `~/.dsh/profiles/<profile>/cordis.patch.yml`（`$DSH_HOME` 改变时随之变化）的 `usage-stats` 条目里，换浏览器、换设备登录同一台 DSH 都用同一份偏好。设置页保留模型统计重定向与会话徽标两项，其余偏好按下面两处管理。

**「服务商」Tab（额度监控一家一卡）**：DeepSeek 余额、Z.ai 额度、OpenCode Go 额度与内置三家余额厂商（SiliconFlow、小米 MiMo、火山引擎）、自助添加的厂商，每家都可在卡片内：

- 直接填入 API Key 并点「保存」：Key 经插件写入 DSH 凭据中心（`~/.dsh/.credentials.yaml`，0600），**不回显、不进配置文件**；变量名已有 Key 时会先要求二次确认覆盖；火山引擎填账号级 AccessKey ID / Secret 两项（V4 HMAC 签名，非推理 Bearer Key，可在卡片上切换「套餐用量 / 账户余额」），小米 MiMo 只填浏览器登录 Cookie（余额接口不接受 API Key），按卡片内提示填写；
- 开关「启用监控」（关闭即停止轮询）、「在侧边栏展示」（开启即在侧边栏底部出现该家额度芯片，数据未加载时先显示占位横杠）；
- 调整抓取间隔（默认 5 分钟，下限 3 分钟）。

**设置 Tab**：模型统计重定向、会话标题旁 session-id 徽标（默认开启，支持悬停复制），底部为账本操作（清零与重建），需二次确认；扫描历史会话期间（面板顶部显示“扫描中…”）两项置灰不可点，等扫描结束自动恢复。

配置文件里只写改过的字段，例如把 Go 额度抓取间隔改成 10 分钟：

```yaml
- id: usage-stats
  name: '@xfqz86/dsh-usage-stats'
  config:
    goFetchMinutes: 10
```

各家 Key 也可继续在 DSH 凭据中心配置：

- OpenCode Go：`OPENCODE_GO_API_KEY`
- DeepSeek：`DEEPSEEK_API_KEY`（兼容 `DEEPSEEK_APIKEY`、`DEEPSEEK_API_TOKEN`、`DEEPSEEK_TOKEN`）
- Z.ai：`ZAI_CODING_CN_API_KEY` 或 `ZAI_API_KEY`（前者优先）

## 服务商额度

详情面板的「服务商」Tab 聚合各家额度 / 余额，一家一卡。内置三家开箱即用：SiliconFlow（`SILICONFLOW_API_KEY`）、小米 MiMo（凭据变量名 `XIAOMI_TOKEN_PLAN_CN`，值为浏览器登录 Cookie 串；查的是账户金额余额，不使用 `XIAOMI_MIMO_API_KEY`）、火山引擎（`VOLCENGINE_ACCESS_KEY_ID` + `VOLCENGINE_SECRET_ACCESS_KEY`，V4 HMAC 签名，默认显示 Agent Plan 套餐用量、可切到账户余额）——Key 既可在此页直接填入保存，也可在 DSH 凭据中心配置。火山套餐接口对某账号返回空（套餐名与各窗口额度均为 0）时显示暂无数据，需确认该 AK/SK 来自开通 Agent Plan 的同一主账号；MiMo Cookie 在重新登录后可能失效，需重新粘贴覆盖。

也可以在该页直接添加任意 **Bearer 鉴权** 的余额厂商：

1. 点「添加服务商」，选预置模板（Kimi、OpenRouter，余额地址与字段自动带出）或「通用」手填；
2. 填显示名、凭据变量名（如 `MOONSHOT_API_KEY`，可复用凭据中心已有的同名变量）和 API Key；
3. Key 经插件直接写入 DSH 凭据中心（`~/.dsh/.credentials.yaml`，0600），**只存变量名引用在配置里，不存 Key 本身、不回显**；变量名已存在会先要求二次确认覆盖；
4. 通用模板需填 https 余额地址与响应中余额数值的点路径（如 `data.available_balance`）及币种；
5. 添加完成后该厂商卡片内嵌「启用监控 / 在侧边栏展示 / 抓取间隔」三项，开启侧边栏即在底部看到余额芯片。

删除服务商卡片只删除配置，凭据中心里已存的 Key 会保留。火山 HMAC、小米 Cookie 等非 Bearer 鉴权由内置三家承载，不支持自助添加。

## 统计口径

- 数据源为携带 `data.usage` 的记录：对话调用 `assistant/message`，压缩上下文的调用 `compaction/summary`
- `total = input + output + cacheRead + cacheWrite`，`reasoning` 单列
- 按模型维度取 `provider` 与 `model`（对话调用在 `message.source`，压缩调用在事件顶层），缺失记为 `unknown`
- 按会话维度记录标题、工作目录、创建与最近活跃时间
- 按本地自然日划分日期
- 不含会话标题自动生成等辅助调用的用量：dsh 只记录这类调用的请求，不记录返回的用量

## 数据存储

账本位于 `$DSH_HOME/storages/dsh-usage-stats/ledger.sqlite`，SQLite 存储。首次启动自动扫描历史会话并导入，后续随事件实时增量更新，重启后可从账本恢复。

## 开发者

- 工程规范见 `AGENTS.md`；架构、数据流与统计口径见 `docs/ARCHITECTURE.md`
- 风格经验（lint 之外的统一约定）见 `docs/STYLE.md`
- 接口协议见 `docs/API.md`
- 模块结构见 `docs/STRUCTURE.md`，由 `pnpm tree` 生成
- 发布流程见 `.agents/skills/release/SKILL.md`（发版技能，可直接加载执行）
- 更新日志见 `CHANGELOG.md`，每次发版同步记录功能更新与 Bug 修复

## License

MIT
