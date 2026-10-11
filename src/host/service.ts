/**
 * 用量统计的服务端 Host 服务：账本模式装配，自管理 sqlite 介质，对外暴露
 * usageStats 命名空间的 8 个一元 Remote 方法。
 *
 * 数据流（账本为唯一事实来源、聚合为派生缓存）与原 apply 函数版一致：
 * openLedger → 先挂 session/event 实时监听 →
 * bootstrap（预统计快加载、事件重放、首启全量扫描三档回退）。信任与认证由
 * 网关载体统一处理，本服务只做业务：快照、重建、清零、密封、四路额度。
 *
 * 方法签名遵守严格 Remote 约定：公开非静态实例方法、非泛型、
 * 参数为具名必填简单标识符（无 lookup、无 signal），请求与结果均为
 * Client-safe 纯 JSON 类型（见 src/types.ts）。
 */

import { Service } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

import { BUILTIN_PROVIDER_IDS, CREDENTIAL_REF_PATTERN, CREDENTIAL_VALUE_MAX_LENGTH, CUSTOM_PROVIDER_MAX, errorMessage } from '../utils.ts';

import { queryDeepSeekBalance } from './deepseekBalance.ts';
import { queryGoQuota } from './goquota.ts';
import { Ledger } from './ledger.ts';
import { queryProviderQuotas } from './providerQuota.ts';
import { scanOnce, rebuildFromEvents, rebuildWithDelta, resetStore, sealAggregates } from './scan.ts';
import { recoverLegacyUsageSettings, UsageSettingsSchema } from './settings.ts';
import { snapshot } from './snapshot.ts';
import { createStore, foldRecord, inheritedCountOf } from './store.ts';
import { queryZaiQuota } from './zaiQuota.ts';

// 仅类型导入：把注入服务合并进 Context、把 session/title 事件合并进
// SessionEventMap；协议类型集中 src/types.ts。
import type {
  ClearResult,
  CustomProviderQuery,
  DeepSeekBalance,
  DescribeCredentialRequest,
  DescribeCredentialResult,
  GoQuota,
  ProviderQuotas,
  ProviderQuotasRequest,
  QuotaRequest,
  RebuildResult,
  SaveCredentialRequest,
  SaveCredentialResult,
  SealResult,
  SnapshotRequest,
  UsageSnapshot,
  ZaiQuota,
} from '../types.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-session-query';
import type {} from '@deepseek-ai/dsh-session-title';

declare module '@deepseek-ai/cordis' {
  interface Context {
    usageStats: UsageStatsService
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 写操作被并发的扫描/重建占用。 */
    'usageStats/busy': { readonly operation: string }
    /** 凭据方法入参非法（变量名/密钥不合规）。 */
    'usageStats/bad-request': { readonly reason: string }
    /** 当前部署的凭据中心不支持写入（缺席或只读），无法在插件内保存 Key。 */
    'usageStats/credentials-unavailable': Record<string, never>
  }
}

/**
 * 取可选的凭据中心：不进 inject，直接 ctx.get 判空（官方可选服务写法）。
 * @param ctx - 服务所在上下文。
 * @returns 可用的凭据服务，缺席时为 undefined。
 */
function credentialsOf(ctx: Context): Context['credentials'] | undefined {
  const credentials = ctx.get('credentials');
  return typeof credentials?.resolve === 'function' ? credentials : undefined;
}

/** 可写凭据服务：基座 seam 只声明读，写入方法由本地凭据实现提供，结构探测后使用。 */
type WritableCredentials = CredentialProvider & {
  write(ref: string, value: string): Promise<unknown>;
};

/**
 * 取支持写入的凭据中心：仅当运行时凭据服务暴露 write（本地凭据实现）时返回，
 * 缺席或只读部署返回 undefined，由 saveCredential 转成明确错误，不假设一定可写。
 */
function credentialsForWrite(ctx: Context): WritableCredentials | undefined {
  const credentials = ctx.get('credentials') as unknown as WritableCredentials | undefined;
  return typeof credentials?.write === 'function' ? credentials : undefined;
}

/** 打开/创建账本：版本不兼容或损坏时自动清库重建，保存与连接由 Ledger 负责。 */
function openLedger(): Ledger {
  const ledger = new Ledger();
  ledger.open();
  return ledger;
}

/** usageStats 命名空间的所有者：账本唯一持有者，冷操作不构造 Session。 */
export default class UsageStatsService extends TypertRemoteService {
  /**
   * 挂载前必需的服务（数组即全必需）。credentials 为可选：
   * 不进 inject，调用处经 ctx.get 判空，缺席时额度查询直接返回 no-key，
   * 仅走 DSH 凭据中心，不读 env 与文件。
   */
  static inject = ['sessionQuery', 'sessionPersistence'];

  /**
   * 插件条目的 Config：设置服务据此把 `usage-stats` 条目投影成偏好表单，
   * 浏览器端经 ctx.configForms 读同一份取值（见 settings.ts）。
   */
  static Config = UsageSettingsSchema;

  private readonly store = createStore();
  private readonly ledger = openLedger();

  constructor(ctx: Context) {
    super(ctx, 'usageStats', { namespace: 'usageStats' });
  }

  protected [Service.init](): void {
    const ctx = this.ctx;
    const store = this.store;
    const ledger = this.ledger;

    // 回收卡在旧设置文档里的偏好（基座导入失败后不重试，只此一次收尾）。
    recoverLegacyUsageSettings(ctx);

    // 插件卸载时关闭账本数据库连接，Ledger.close 幂等。
    ctx.effect(() => () => ledger.close(), 'dsh-usage-stats: 关闭账本数据库连接');

    // ---- 先挂实时监听，初始扫描期间不漏事件 ----
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const id = session && typeof session.id === 'string' ? session.id : undefined;
      if (!id) return;
      try {
        // 实时补齐会话 header 的 parentSession、origin、delegationDepth，子代理归属。
        // header 字段 cwd、createdAt、parentSession、origin、delegationDepth 均来自
        // harness 的 SessionHeader，AGENTS §0，直接复用，不手写字段形状。
        // meta 补齐是尽力而为：写失败只记日志，不连累下方用量事件折叠。
        const hdr = (session as { header?: SessionHeader }).header;
        if (hdr) {
          const patch: Parameters<typeof ledger.setMeta>[1] = {};
          if (typeof hdr.parentSession === 'string') patch.parentSession = hdr.parentSession;
          if (hdr.origin === 'subagent') patch.origin = hdr.origin;
          if (typeof hdr.delegationDepth === 'number' && Number.isFinite(hdr.delegationDepth)) patch.delegationDepth = hdr.delegationDepth;
          if (typeof hdr.cwd === 'string') patch.cwd = hdr.cwd;
          if (typeof hdr.createdAt === 'number' && Number.isFinite(hdr.createdAt)) patch.createdAt = hdr.createdAt;
          if (Object.keys(patch).length > 0) {
            try {
              ledger.setMeta(id, patch);
            } catch (e) {
              console.warn('[usage-stats] 会话元数据补齐失败，跳过', id, e);
            }
          }
        }
        // fork 继承前缀属于父会话：seq 落在 inheritedEventCount 之前的事件不折，
        // 避免父的用量在子会话下重复计入（与扫描路径同口径）。
        if (typeof event.seq === 'number' && event.seq < inheritedCountOf((session as { inheritedEventCount?: unknown }).inheritedEventCount)) return;
        foldRecord(store, ledger, id, event);
      } catch (e) {
        // 写账本失败记日志，不打断事件循环；账本/内存保持上次成功点。
        console.error('[usage-stats] 实时事件入账失败', e);
      }
    });

    // ---- 初始化：优先从预统计加载，快速，回退到事件重放或全量扫描 ----
    const bootstrap = async (): Promise<void> => {
      // 1) 预统计快速路径：已物化 agg_* → 直接加载与少量增量重放，通常仅今日
      if (ledger.hasAggregates()) {
        const ok = rebuildWithDelta(store, ledger);
        if (ok) {
          store.scans += 1;
          store.lastScanAt = Date.now();
          return;
        }
      }
      // 2) 兼容旧库：有 events 但无预统计 → 全量重放并物化，一次迁移
      if (ledger.hasEvents()) {
        rebuildFromEvents(store, ledger);
        store.scans += 1;
        store.lastScanAt = Date.now();
        return;
      }
      // 3) 首启：无数据 → 全量扫描日志并物化。清零墓碑在场则跳过——用户已明确
      //    清零（账本 9 表全空才会落到这里），重扫会把刚抹掉的历史统计带回来，
      //    违背「清零不会重新读取历史会话」的承诺；恢复历史的出口是 rebuild，
      //    其经 ledger.clear() 整表清掉 agg_checkpoint，墓碑随之移除。
      if (ledger.getClearedAt() !== null) {
        console.info('[usage-stats] 清零墓碑生效，跳过首启全量扫描（重建可重新统计历史）');
        return;
      }
      await scanOnce(ctx, store, ledger, { initial: true });
    };
    void bootstrap().catch((e) => console.error('[usage-stats] 初始化失败', e));
  }

  /**
   * usageStats/snapshot：聚合快照，带会话过滤返回对应会话的 current。
   * @param request - 会话过滤与明细分页上限。
   * @returns 快照 value（传输信封由网关负责）。
   */
  @Remote('snapshot')
  snapshot(request: SnapshotRequest): UsageSnapshot {
    const raw = request.sessionId;
    const sessionId = typeof raw === 'string' && raw.length > 0 ? raw : null;
    const limit = typeof request.limit === 'number' && Number.isFinite(request.limit) ? request.limit : undefined;
    return snapshot(this.store, this.ledger, sessionId, limit !== undefined ? { limit } : undefined);
  }

  /**
   * usageStats/rebuild：清空账本（顺带清掉清零墓碑）→ 复位聚合缓存 → 全量重扫日志导入。
   * @returns 重建确认与折叠事件数；进行中返回 usageStats/busy。
   */
  @Remote('rebuild')
  async rebuild(): Promise<RebuildResult> {
    const store = this.store;
    // 并发保护：已有扫描/重建正在进行时拒绝，避免交错清库与扫描。
    if (store.running) {
      throw new RemoteError('usageStats/busy', 'rebuild already in progress', { operation: 'rebuild' });
    }
    store.running = true;
    try {
      this.ledger.clear();
      resetStore(store);
      // 持锁调用 scanOnce。
      await scanOnce(this.ctx, store, this.ledger, { initial: true, force: true });
    } finally {
      store.running = false;
      store.scanning = false;
    }
    return { rebuilt: true, foldedEvents: store.foldedEvents };
  }

  /**
   * usageStats/clear：清空账本 → 复位聚合缓存 → 落清零墓碑，不重扫，统计直接归零；
   * 重启后 bootstrap 据墓碑跳过首启全量扫描，历史统计不复活（rebuild 是恢复出口）。
   * @returns 清零确认与折叠事件数；进行中返回 usageStats/busy。
   */
  @Remote('clear')
  async clear(): Promise<ClearResult> {
    const store = this.store;
    if (store.running) {
      throw new RemoteError('usageStats/busy', 'clear already in progress', { operation: 'clear' });
    }
    store.running = true;
    try {
      this.ledger.clear();
      resetStore(store);
      // 落清零墓碑：清库已整表抹掉 agg_checkpoint，标记必须在其后写；
      // 否则重启后空库落进 bootstrap 首启分支，历史统计会原样扫回来。
      this.ledger.markCleared();
    } finally {
      store.running = false;
    }
    return { cleared: true, foldedEvents: store.foldedEvents };
  }

  /**
   * usageStats/seal：手动物化当前聚合至预统计，密封不会再变动的历史数据。
   * @returns 密封确认、密封边界与折叠事件数；进行中返回 usageStats/busy。
   */
  @Remote('seal')
  seal(): SealResult {
    const store = this.store;
    if (store.running) {
      throw new RemoteError('usageStats/busy', 'seal already in progress', { operation: 'seal' });
    }
    sealAggregates(store, this.ledger);
    return { sealed: true, sealedUntil: this.ledger.getSealedUntil(), foldedEvents: store.foldedEvents };
  }

  /**
   * usageStats/goQuota：OpenCode Go 订阅额度，TTL 缓存 + 单飞。
   * @param request - 客户端抓取间隔与强制刷新。
   * @returns 额度 value（无 key 时为 no-key，不抛错）。
   */
  @Remote('goQuota')
  async goQuota(request: QuotaRequest): Promise<GoQuota> {
    const intervalMinutes = typeof request.intervalMinutes === 'number' && Number.isFinite(request.intervalMinutes)
      ? request.intervalMinutes
      : undefined;
    // force=true 概览 Go 磁贴"立即刷新"，绕过 TTL 缓存强制重新抓取；
    // 默认 false 保持轮询语义，有效 TTL 内返回缓存。
    const force = request.force === true;
    return queryGoQuota(intervalMinutes, force, credentialsOf(this.ctx));
  }

  /**
   * usageStats/deepseekBalance：DeepSeek 余额，TTL 缓存 + 单飞。
   * @param request - 客户端抓取间隔与强制刷新。
   * @returns 余额 value（无 key 时为 no-key，不抛错）。
   */
  @Remote('deepseekBalance')
  async deepseekBalance(request: QuotaRequest): Promise<DeepSeekBalance> {
    const intervalMinutes = typeof request.intervalMinutes === 'number' && Number.isFinite(request.intervalMinutes)
      ? request.intervalMinutes
      : undefined;
    // force=true 概览 DeepSeek 磁贴"立即刷新"，绕过 TTL 缓存强制重新抓取；
    // 默认 false 保持轮询语义，有效 TTL 内返回缓存，仍受 3 分钟强制下限保护。
    const force = request.force === true;
    // 凭据中心可选：缺席时查询侧直接返回 no-key，不读 env 与文件。
    return queryDeepSeekBalance(intervalMinutes, force, credentialsOf(this.ctx));
  }

  /**
   * usageStats/zaiQuota：Z.ai 智谱额度，TTL 缓存 + 单飞。
   * @param request - 客户端抓取间隔与强制刷新。
   * @returns 额度 value（无 key 时为 no-key，不抛错）。
   */
  @Remote('zaiQuota')
  async zaiQuota(request: QuotaRequest): Promise<ZaiQuota> {
    const intervalMinutes = typeof request.intervalMinutes === 'number' && Number.isFinite(request.intervalMinutes)
      ? request.intervalMinutes
      : undefined;
    // force=true 概览 Z.ai 磁贴"立即刷新"，绕过 TTL 缓存强制重新抓取；
    // 默认 false 保持轮询语义，有效 TTL 内返回缓存，仍受 3 分钟强制下限保护。
    const force = request.force === true;
    return queryZaiQuota(intervalMinutes, force, credentialsOf(this.ctx));
  }

  /**
   * usageStats/providerQuotas：内置三家（SiliconFlow / 小米 MiMo / 火山引擎）与用户
   * 自助添加的 Bearer 余额厂商，按请求范围（选中内置家 + 自定义列表）聚合返回，
   * TTL 缓存 + 单飞（按范围形状分桶）。
   * @param request - 抓取间隔、强制刷新、内置家 id 子集、自定义厂商查询列表。
   * @returns 服务商额度 value（各条 no-key/error 不抛错，由客户端按 status 本地化）。
   */
  @Remote('providerQuotas')
  async providerQuotas(request: ProviderQuotasRequest): Promise<ProviderQuotas> {
    const intervalMinutes = typeof request.intervalMinutes === 'number' && Number.isFinite(request.intervalMinutes)
      ? request.intervalMinutes
      : undefined;
    // force=true 服务商页"立即刷新"，绕过 TTL 缓存强制重新抓取；
    // 默认 false 保持轮询语义，有效 TTL 内返回缓存，仍受 3 分钟强制下限保护。
    const force = request.force === true;
    // 线路入参做一次防御投影：内置家只收白名单 id，自定义条只取白名单字段并重新校验
    // https 与凭据变量名；zod 已保证基本类型，这里挡住手改客户端发来的畸形条目。
    const builtinIds: string[] = [];
    if (Array.isArray(request.builtinIds)) {
      for (const rawId of request.builtinIds) {
        if (typeof rawId !== 'string') continue;
        const id = rawId.trim();
        if (!(BUILTIN_PROVIDER_IDS as readonly string[]).includes(id) || builtinIds.includes(id)) continue;
        builtinIds.push(id);
      }
    }
    const providers: CustomProviderQuery[] = [];
    if (Array.isArray(request.providers)) {
      for (const item of request.providers) {
        if (providers.length >= CUSTOM_PROVIDER_MAX) break;
        if (item === null || typeof item !== 'object') continue;
        const p = item as Partial<CustomProviderQuery>;
        const id = typeof p.id === 'string' ? p.id.trim() : '';
        const endpoint = typeof p.endpoint === 'string' ? p.endpoint.trim() : '';
        const ref = typeof p.credentialRef === 'string' ? p.credentialRef.trim() : '';
        if (id === '' || !/^https:\/\//i.test(endpoint) || !CREDENTIAL_REF_PATTERN.test(ref)) continue;
        const valuePath = typeof p.valuePath === 'string' && p.valuePath.trim() !== '' ? p.valuePath.trim() : 'data.balance';
        const currency = typeof p.currency === 'string' && p.currency.trim() !== '' ? p.currency.trim().slice(0, 8) : 'CNY';
        providers.push({ id, endpoint, credentialRef: ref, valuePath, currency });
      }
    }
    return queryProviderQuotas(intervalMinutes, force, credentialsOf(this.ctx), { builtinIds, providers });
  }

  /**
   * usageStats/describeCredential：探测某环境变量名当前是否已配置、凭据中心是否可写。
   * 用于「服务商」页保存前提示同名覆盖；只回布尔状态，绝不回传密钥值。
   */
  @Remote('describeCredential')
  async describeCredential(request: DescribeCredentialRequest): Promise<DescribeCredentialResult> {
    const ref = typeof request?.ref === 'string' ? request.ref.trim() : '';
    if (!CREDENTIAL_REF_PATTERN.test(ref)) {
      throw new RemoteError('usageStats/bad-request', '凭据变量名非法', { reason: 'invalid-ref' });
    }
    const credentials = credentialsOf(this.ctx);
    let configured = false;
    if (credentials) {
      try {
        const resolved = await credentials.resolve(credentialRef(ref));
        configured = !!(resolved && typeof resolved.value === 'string' && resolved.value.trim().length > 0);
      } catch {
        configured = false;
      }
    }
    return { ref, configured, writable: credentialsForWrite(this.ctx) !== undefined };
  }

  /**
   * usageStats/saveCredential：把「服务商」页填写的 API Key 存入 DSH 凭据中心。
   *
   * 密钥只在本次请求内出现，经凭据服务原子写入 `~/.dsh/.credentials.yaml`
   * （0600、文件锁、写完热更新），不进偏好文档、日志与返回值。env 只读同名
   * （凭据服务 assertUnshadowed）或凭据中心不可写时抛错，由客户端给出可操作提示。
   */
  @Remote('saveCredential')
  async saveCredential(request: SaveCredentialRequest): Promise<SaveCredentialResult> {
    const ref = typeof request?.ref === 'string' ? request.ref.trim() : '';
    const value = typeof request?.value === 'string' ? request.value : '';
    if (!CREDENTIAL_REF_PATTERN.test(ref)) {
      throw new RemoteError('usageStats/bad-request', '凭据变量名非法', { reason: 'invalid-ref' });
    }
    if (value.length === 0) {
      throw new RemoteError('usageStats/bad-request', 'API Key 不能为空', { reason: 'empty-value' });
    }
    if (value.length > CREDENTIAL_VALUE_MAX_LENGTH) {
      throw new RemoteError('usageStats/bad-request', 'API Key 超出长度上限', { reason: 'value-too-long' });
    }
    const credentials = credentialsForWrite(this.ctx);
    if (!credentials) {
      throw new RemoteError('usageStats/credentials-unavailable', '凭据中心当前不可写，无法在此保存 Key', {});
    }
    try {
      await credentials.write(credentialRef(ref), value);
    } catch (error) {
      // env 只读同名等写入失败：透传凭据服务的可读原因，转 bad-request 由客户端提示。
      throw new RemoteError('usageStats/bad-request', errorMessage(error), { reason: 'write-failed' });
    }
    return { saved: true, ref };
  }
}
