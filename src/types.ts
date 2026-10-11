/**
 * 跨端共用的协议类型，host 与 client 两个 bundle 各自内联所需子集。
 *
 * 本模块**只放类型声明**，包括 interface、type，构建后是空模块、零运行时开销；
 * 对应的纯函数在 utils.ts。协议类型与纯函数分离，避免类型与逻辑混杂。这些类型是插件自有协议的单一事实来源，host 与 client 各自 re-export。
 *
 * 设计约束：本文件禁止任何运行时语句，包括值、函数、有副作用的 import，
 * 以保证两端 bundle 都能安全剔除。
 */

/** 单个额度窗口，包含用量百分比与重置时间。 */
export interface GoWindow {
  percent: number
  resetsAt: string
}

/** 额度查询结果，status 由客户端本地化展示；no-plan 为已配置 Key 但未开通订阅。 */
export interface GoQuota {
  status: 'ok' | 'no-key' | 'no-plan' | 'error'
  fetchedAt: number
  rolling: GoWindow | null
  weekly: GoWindow | null
  monthly: GoWindow | null
}

/** DeepSeek 单币种余额明细，归一化后金额保持字符串以避免浮点精度丢失。 */
export interface DeepSeekBalanceInfo {
  currency: string
  totalBalance: string
  grantedBalance: string
  toppedUpBalance: string
}

/** DeepSeek 余额查询结果，与 GoQuota 同级，status 由客户端本地化。 */
export interface DeepSeekBalance {
  status: 'ok' | 'no-key' | 'error'
  fetchedAt: number
  isAvailable: boolean
  balances: DeepSeekBalanceInfo[]
  /** 预留：官方今日消耗金额，v1 无官方日耗接口固定为 null，未来有接口时填充。 */
  todayAmount?: string | null
  /** 预留：对应币种，v1 为 null。 */
  todayCurrency?: string | null
}

/**
 * Z.ai 单个百分比额度窗口，与 GoWindow 同形，用于滚动 5 小时、周额度。
 * `used`/`limit` 为点数明细，对应官方 `currentValue`、`usage`，官方未下发时为 null。
 */
export interface ZaiWindow {
  percent: number
  resetsAt: string
  used: number | null
  limit: number | null
}

/** Z.ai 每月 Web 搜索额度，次数型，已用、总量、百分比与重置时间。 */
export interface ZaiWebSearchQuota {
  used: number
  limit: number
  percent: number
  resetsAt: string
}

/** Z.ai 额度查询结果，与 GoQuota、DeepSeekBalance 同级，status 由客户端本地化。 */
export interface ZaiQuota {
  status: 'ok' | 'no-key' | 'no-plan' | 'error'
  fetchedAt: number
  /** 计划名，如来自 data.level 的 "Z.ai pro"，无时为 null。 */
  plan: string | null
  /** 5 小时会话窗口，百分比额度。 */
  session: ZaiWindow | null
  /** 周窗口，百分比额度。 */
  weekly: ZaiWindow | null
  /** 每月 Web 搜索次数额度，类型为 TIME_LIMIT。 */
  webSearches: ZaiWebSearchQuota | null
}

/**
 * 服务商额度条目标识：内置三家为固定小写 id（SiliconFlow 余额 / 小米 MiMo 套餐额度 /
 * 火山引擎账户余额），用户在「服务商」页自助添加的 Bearer 厂商为自定义 id
 * （`custom-<短随机串>`）。id 仅作线路与渲染键，显示名一律走配置/文案，故放宽为 string。
 */
export type ProviderQuotaId = string;

/**
 * 服务商金额类条目（余额）：金额以数值给出，币种单独携带，展示格式由客户端决定。
 * granted/toppedUp 为赠送与充值拆分，官方未下发时为 null。
 */
export interface ProviderQuotaAmount {
  /** 币种标识，如 CNY、USD。 */
  currency: string
  /** 主数值：总余额，未知为 null。 */
  total: number | null
  /** 赠送余额，未知为 null。 */
  granted: number | null
  /** 充值余额，未知为 null。 */
  toppedUp: number | null
}

/** 服务商额度窗口（百分比类）：kind 为客户端本地化文案键，percent 为已用百分比 0..100。 */
export interface ProviderQuotaWindow {
  /** 窗口标识：plan 套餐总额、month 本月用量。 */
  kind: 'plan' | 'month'
  /** 已用百分比 0..100。 */
  percent: number
  /** 重置时间 ISO 字符串，未知为 null。 */
  resetsAt: string | null
}

/**
 * 单个服务商的额度/余额查询结果，status 由客户端本地化展示：
 * ok 有值、no-key 未配置凭据、error 查询失败（error 字段带原因）。
 */
export interface ProviderQuotaEntry {
  id: ProviderQuotaId
  status: 'ok' | 'no-key' | 'error'
  fetchedAt: number
  /** 套餐名，未知为 null。 */
  plan: string | null
  /** 金额类明细（余额型服务商）。 */
  amounts: ProviderQuotaAmount[]
  /** 百分比窗口（套餐额度型服务商）。 */
  windows: ProviderQuotaWindow[]
  /** 失败原因，仅 status='error' 时有值。 */
  error: string | null
}

/** usageStats/providerQuotas 的 value：一次返回内置与/或自定义服务商的额度/余额。 */
export interface ProviderQuotas {
  status: 'ok' | 'error'
  fetchedAt: number
  providers: ProviderQuotaEntry[]
}

/**
 * 内置服务商（SiliconFlow / 小米 MiMo / 火山引擎）的单项偏好：密钥值仍在凭据中心，
 * 这里只有开关与间隔。id 取 BUILTIN_PROVIDER_IDS 里的固定小写名，三家各一条。
 */
export interface BuiltinProviderSettings {
  /** 内置服务商 id，如 siliconflow。 */
  id: string
  /** 是否启用该服务商额度监控，关闭后不发起请求。 */
  enabled: boolean
  /** 是否在侧边栏底部展示该服务商额度芯片。 */
  showInSidebar: boolean
  /** 抓取间隔，单位分钟，下限 3。 */
  fetchMinutes: number
}

/**
 * 用户在「服务商」页自助添加的 Bearer 余额厂商配置（存在 profile 配置文档里，跟随部署）。
 *
 * 安全约束：这里**只存凭据的环境变量名引用** `credentialRef`，绝不存密钥值；
 * 密钥只落在 DSH 凭据中心 `~/.dsh/.credentials.yaml`。余额接口各家不同，
 * 故除 Key 外还需用户给出 `endpoint`（https 余额地址）与 `valuePath`（JSON 点路径）。
 */
export interface CustomProviderConfig {
  /** 稳定唯一标识，`custom-<短随机串>`，删除/编辑都按它定位。 */
  id: string
  /** 展示名，如「Kimi」。 */
  label: string
  /** 余额查询地址，强制 https，GET + Bearer。 */
  endpoint: string
  /** 凭据环境变量名引用，如 MOONSHOT_API_KEY；值在凭据中心，不在本配置。 */
  credentialRef: string
  /** 响应 JSON 中余额数值的点路径，如 data.available_balance。 */
  valuePath: string
  /** 余额币种标识，如 CNY、USD，未知用空串由展示层兜底。 */
  currency: string
  /** 是否启用该厂商监控，关闭后不发起请求。 */
  enabled: boolean
  /** 是否在侧边栏底部展示余额芯片。 */
  showInSidebar: boolean
  /** 抓取间隔，单位分钟，下限 3。 */
  fetchMinutes: number
}

/**
 * 线路上查询单个自定义厂商所需的字段（由配置投影），仍不含任何密钥值；
 * 服务端据 credentialRef 自行向凭据中心解析 Key。
 */
export interface CustomProviderQuery {
  id: string
  endpoint: string
  credentialRef: string
  valuePath: string
  currency: string
}

/**
 * usageStats/providerQuotas 请求：在通用间隔/强制刷新之外，控制查询范围。
 * 服务商页查「启用的内置三家 + 全部启用的自定义」，侧边栏只查「勾选侧边栏的子集」，
 * 两种形状在服务端分别缓存互不串味；只查用到的内置家，避免白轮询关掉监控的家。
 */
export interface ProviderQuotasRequest extends QuotaRequest {
  /** 本轮要查的内置服务商 id 列表（BUILTIN_PROVIDER_IDS 子集）；缺省/空数组表示不查内置。 */
  builtinIds?: string[]
  /** 本轮要查的自定义厂商列表；缺省/空数组表示不查自定义。 */
  providers?: CustomProviderQuery[]
}

/** usageStats/describeCredential 请求：按环境变量名探测凭据是否已配置（不回传值）。 */
export interface DescribeCredentialRequest {
  ref: string
}

/** 凭据探测结果：只回布尔状态，configured 不回传任何密钥内容。 */
export interface DescribeCredentialResult {
  ref: string
  /** 该环境变量名当前能否解析到非空值（env / 凭据文件 / .env 任一层）。 */
  configured: boolean
  /** 凭据中心当前是否支持写入（本地凭据服务恒为 true；只读/缺席部署为 false）。 */
  writable: boolean
}

/** usageStats/saveCredential 请求：把一个 Key 写入凭据中心。 */
export interface SaveCredentialRequest {
  /** 环境变量名引用，须符合 POSIX shell 标识符。 */
  ref: string
  /** 密钥明文，仅在本次请求内出现，不落配置/日志/返回。 */
  value: string
}

/** 写凭据结果：成功只回 saved 与 ref，绝不回显 value。 */
export interface SaveCredentialResult {
  saved: true
  ref: string
}

/** 对外暴露的用量形状，total 为 input、output、cacheRead 与 cacheWrite 之和，reasoning 单列。 */
export interface UsageAgg {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  total: number
}

/** 一组聚合计数：UsageAgg 加调用次数，host 折叠与 client 展示共用。 */
export interface Agg extends UsageAgg {
  calls: number
}

/** 按日序列点，为快照 series 元素，host snapshot 构建与 client 图表共用。 */
export interface SeriesPoint {
  t: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  calls: number
}

/** 快照中按模型、Provider 的拆分条目，host snapshot 构建与 client 图表共用。 */
export interface ModelStat {
  provider: string
  model: string
  calls: number
  usage: UsageAgg
  /** 按日细分，用于时间范围筛选与堆叠柱，可能缺失于旧快照。 */
  series?: SeriesPoint[]
}

/** 快照中按会话的拆分条目，已含子代理归属字段，复用 SessionHeader 语义。 */
export interface SessionStat {
  id: string
  title: string
  cwd: string
  createdAt: number
  lastActive: number
  calls: number
  usage: UsageAgg
  parentSession: string | null
  origin: string | null
  delegationDepth: number
}

/**
 * usageStats/snapshot 的 value 部分快照协议，为本插件自有 API 协议，
 * 见 AGENTS §8，host snapshot() 构建与 client useSnapshot 消费共用，避免两端镜像漂移。
 * Remote 传输外层为 { ok, value } 信封，此类型对应成功时的 value。
 */
export interface UsageSnapshot {
  scanning: boolean
  scans: number
  failed: number
  rawSessions: number
  harnessSessions: number
  foldedEvents: number
  dedupSkipped: number
  lastError: string | null
  scanError: string | null
  lastScanAt: number
  time: number
  sessions: number
  current: { id: string; calls: number; usage: UsageAgg } | null
  all: { calls: number; usage: UsageAgg }
  series: { all: SeriesPoint[]; current: SeriesPoint[] }
  models: ModelStat[]
  sessionsList: SessionStat[]
}

/**
 * Remote 请求与结果类型：每个 @Remote 方法取单个具名必填 request 对象
 * （严格约定禁可选参数/解构/默认值，字段级可选不受限），返回结果值；
 * 传输信封 RemoteResult（{ ok:true,value } | { ok:false,error }）由网关负责。
 */

/** usageStats/snapshot 请求：按会话过滤与明细分页上限。 */
export interface SnapshotRequest {
  sessionId: string | null
  limit?: number
}

/** usageStats/rebuild 结果：清空账本后全量重扫的折叠事件数。 */
export interface RebuildResult {
  rebuilt: boolean
  foldedEvents: number
}

/** usageStats/clear 结果：清空账本不重扫，计数归零。 */
export interface ClearResult {
  cleared: boolean
  foldedEvents: number
}

/** usageStats/seal 结果：手动物化预统计的密封边界与事件数。 */
export interface SealResult {
  sealed: boolean
  sealedUntil: number
  foldedEvents: number
}

/** 额度/余额轮询请求：客户端抓取间隔与强制刷新。 */
export interface QuotaRequest {
  intervalMinutes?: number
  force?: boolean
}

/**
 * 一条模型统计重定向规则：把「来源供应商 + 来源模型」的用量算到
 * 「目标供应商 + 目标模型」名下（只影响模型页统计，不动账本）。
 */
export interface ModelRedirect {
  /** 来源供应商，如 opencode-go-vision。 */
  fromProvider: string
  /** 来源模型，如 deepseek-v4-flash。 */
  fromModel: string
  /** 目标供应商，如 opencode-go。 */
  toProvider: string
  /** 目标模型，如 deepseek-v4-flash。 */
  toModel: string
}

/**
 * 插件偏好设置：OpenCode Go 额度、DeepSeek 余额、Z.ai 额度监控各三项，内置三家
 * 服务商按家三项（builtinProviders）、自助添加厂商按家三项（customProviders），
 * 会话标题 session-id 徽标开关，加模型统计重定向规则表；字段与 host 侧
 * `usage-stats` 条目的 schemastery schema（src/host/settings.ts）一一对应，
 * client 侧经 ctx.configForms 取得同一形状的解析值。各服务商的开关与间隔
 * 统一在「服务商」页卡片里改。
 */
export interface UsageSettings {
  /** 是否启用 OpenCode Go 额度监控，关闭后不再请求官方额度接口。 */
  goEnabled: boolean
  /** 是否在侧边栏底部展示 OpenCode Go 剩余额度芯片。 */
  showGoInSidebar: boolean
  /** OpenCode Go 额度抓取间隔，单位分钟，下限 3 分钟。 */
  goFetchMinutes: number
  /** 是否启用 DeepSeek 余额监控，关闭后不再请求官方余额接口。 */
  deepseekEnabled: boolean
  /** 是否在侧边栏底部展示 DeepSeek 余额芯片。 */
  showDeepSeekInSidebar: boolean
  /** DeepSeek 余额抓取间隔，单位分钟，下限 3 分钟。 */
  deepseekFetchMinutes: number
  /** 是否启用 Z.ai 额度监控，关闭后不再请求官方额度接口。 */
  zaiEnabled: boolean
  /** 是否在侧边栏底部展示 Z.ai 额度芯片。 */
  showZaiInSidebar: boolean
  /** Z.ai 额度抓取间隔，单位分钟，下限 3 分钟。 */
  zaiFetchMinutes: number
  /** 内置三家（SiliconFlow / 小米 MiMo / 火山引擎）各自的开关与间隔，固定三家各一条。 */
  builtinProviders: BuiltinProviderSettings[]
  /** 是否在会话标题右侧展示 session-id 徽标（含悬停复制），默认开启。 */
  showSessionId: boolean
  /**
   * 模型统计重定向规则：按顺序匹配来源（同一来源只有最上面一条生效），
   * 由浏览器端在模型页归并，见 `src/client/stats.ts` 的 redirectModels。
   */
  modelRedirects: ModelRedirect[]
  /**
   * 用户自助添加的 Bearer 余额厂商列表（仅存变量名引用与查询定义，不含密钥值）。
   * 每家在「服务商」页整表渲染「启用监控 / 侧边栏展示 / 抓取间隔」三项。
   */
  customProviders: CustomProviderConfig[]
}
