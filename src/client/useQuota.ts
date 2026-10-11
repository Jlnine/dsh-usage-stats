/**
 * 额度轮询 hooks（浏览器端）：共享轮询骨架 useQuota + Go/DeepSeek/Z.ai 三路薄包装
 * 与聚合三家的服务商额度 useProviderQuotas。
 *
 * 共享语义（useQuota 工厂，调用方只配调用函数、夹取与 error 占位）：
 *   - enabled 为 false 时清空已拉数据、不发起任何请求；
 *   - 轮询体与手动强制刷新共享递增序号，旧响应丢弃；
 *   - 失败时首屏置 error 占位保组件可见，已有数据则保留等下次轮询；
 *   - 手动刷新带 force 绕过服务端 TTL，不重置轮询定时器。
 * 传入的 invoke/clampMinutes/makeError 须为模块级稳定引用，
 * 否则 effect 会反复重建导致刷爆接口。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { clampDeepSeekFetchMinutes, clampGoFetchMinutes, clampProvidersFetchMinutes, clampZaiFetchMinutes } from '../utils.ts';

import { usageStatsRemote } from './remote.ts';

import type {
  CustomProviderConfig,
  CustomProviderQuery,
  DeepSeekBalance,
  GoQuota,
  GoWindow,
  ProviderQuotas,
  ProviderQuotasRequest,
  QuotaRequest,
  UsageSettings,
  ZaiQuota,
  ZaiWindow,
} from '../types.ts';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';

/** 协议类型单一定义在 types.ts，此处仅 re-export 实际被引用的名字。 */
export type { GoQuota, GoWindow, ZaiWindow };

/** 把自定义厂商配置投影成线路查询字段（只取查询所需，仍不含密钥）。 */
export function customProviderQueries(custom: CustomProviderConfig[]): CustomProviderQuery[] {
  return custom.map((p) => ({
    id: p.id,
    endpoint: p.endpoint,
    credentialRef: p.credentialRef,
    valuePath: p.valuePath,
    currency: p.currency,
  }));
}

/** 额度轮询：返回 [数据, 手动刷新]，未启用/失败未加载时为 null。 */
export function useQuota<T>(options: {
  enabled: boolean
  intervalMinutes: number
  invoke: (request: QuotaRequest) => Promise<RemoteResult<T>>
  clampMinutes: (v: number) => number
  makeError: () => T
  /** 合并进请求的额外字段（服务商额度的 builtinIds/providers）；按 JSON 参与 effect 依赖。 */
  extra?: unknown
}): [T | null, () => void] {
  const { enabled, intervalMinutes, invoke, clampMinutes, makeError, extra } = options;
  const [data, setData] = useState<T | null>(null);
  // 乱序守卫：轮询与手动强制刷新共享同一递增序号，最后发起者胜出。
  const seqRef = useRef(0);
  // 额外字段的稳定键：内容变化才重建轮询，引用变化但内容不变不重拉。
  const extraKey = JSON.stringify(extra ?? null);

  useEffect(() => {
    if (!enabled) {
      // 未启用额度抓取：清空已拉数据、不发起任何请求。
      setData(null);
      return;
    }
    // 防御性夹取：偏好已夹到下限，这里再兜底一次防止误用。
    const minutes = clampMinutes(intervalMinutes);
    const extraPart = (extra !== undefined && extra !== null && typeof extra === 'object')
      ? extra as Partial<ProviderQuotasRequest>
      : {};
    let live = true;
    const load = async (force: boolean) => {
      const mine = ++seqRef.current;
      let parsed: { ok?: boolean; value?: T } = {};
      try {
        const request: ProviderQuotasRequest = { intervalMinutes: minutes, ...(force ? { force: true } : {}), ...extraPart };
        const result = await invoke(request);
        parsed = result.ok ? { ok: true, value: result.value } : { ok: false };
      } catch {
        parsed = {};
      }
      if (!live || mine !== seqRef.current) return;
      if (parsed.ok === true && parsed.value) {
        setData(parsed.value);
      } else {
        setData((prev) => prev ?? makeError());
      }
    };
    void load(false);
    const timerId = window.setInterval(() => { void load(false); }, minutes * 60 * 1000);
    return () => { live = false; window.clearInterval(timerId); };
    // intervalMinutes 参与夹取，effect 依赖用原始值以感知变化；extraKey 代表额外请求形状。
  }, [enabled, intervalMinutes, invoke, clampMinutes, makeError, extraKey]);

  /** 手动触发一次立即刷新，未启用时忽略，直接带 force 抓取。 */
  const refresh = useCallback(() => {
    if (!enabled) return;
    const minutes = clampMinutes(intervalMinutes);
    const extraPart = (extra !== undefined && extra !== null && typeof extra === 'object')
      ? extra as Partial<ProviderQuotasRequest>
      : {};
    const mine = ++seqRef.current;
    void (async () => {
      try {
        const request: ProviderQuotasRequest = { intervalMinutes: minutes, force: true, ...extraPart };
        const result = await invoke(request);
        if (mine !== seqRef.current) return;
        if (result.ok) {
          setData(result.value);
        } else {
          setData((prev) => prev ?? makeError());
        }
      } catch {
        setData((prev) => prev ?? makeError());
      }
    })();
  }, [enabled, intervalMinutes, invoke, clampMinutes, makeError, extraKey]);

  return [data, refresh];
}

/**
 * OpenCode Go 订阅额度：服务端 usageStats/goQuota（网关统一信任与认证），TTL 缓存。
 * 额度窗口含滚动 5 小时、本周与本月，显示在底部角标与模态窗详情里。
 */

/** Go 额度调用（模块级稳定引用）。 */
function invokeGoQuota(request: QuotaRequest): Promise<RemoteResult<GoQuota>> {
  return usageStatsRemote().goQuota(request);
}

/** 首屏失败时的 error 占位：保证侧边栏/概览组件可见（模块级稳定引用）。 */
function makeGoError(): GoQuota {
  return { status: 'error', fetchedAt: Date.now(), rolling: null, weekly: null, monthly: null };
}

/**
 * 每 `intervalMinutes` 分钟轮询一次额度；未启用 / 请求失败 / 尚未加载时为
 * null。返回 [数据, 手动刷新]。`intervalMinutes` 下限 3 分钟、默认 5 分钟，
 * 请求体携带 intervalMinutes，服务端有效 TTL 为 min(5 分钟, max(3 分钟, 间隔))。
 */
export function useGoQuota(
  enabled: boolean,
  intervalMinutes: number,
): [GoQuota | null, () => void] {
  return useQuota({ enabled, intervalMinutes, invoke: invokeGoQuota, clampMinutes: clampGoFetchMinutes, makeError: makeGoError });
}

/**
 * DeepSeek 余额：服务端 usageStats/deepseekBalance（网关统一信任与认证），TTL 缓存。
 * 余额信息含多币种 total、granted 与 toppedUp，显示在底部角标与模态窗详情里。
 */

/** DeepSeek 余额调用（模块级稳定引用）。 */
function invokeDeepSeekBalance(request: QuotaRequest): Promise<RemoteResult<DeepSeekBalance>> {
  return usageStatsRemote().deepseekBalance(request);
}

/** 首屏失败时的 error 占位：保证侧边栏/概览组件可见（模块级稳定引用）。 */
function makeDeepSeekError(): DeepSeekBalance {
  return { status: 'error', fetchedAt: Date.now(), isAvailable: false, balances: [] };
}

/**
 * 每 `intervalMinutes` 分钟轮询一次余额；未启用 / 请求失败 / 尚未加载时为
 * null。返回 [数据, 手动刷新]。间隔下限 3 分钟、默认 5 分钟。
 */
export function useDeepSeekBalance(
  enabled: boolean,
  intervalMinutes: number,
): [DeepSeekBalance | null, () => void] {
  return useQuota({ enabled, intervalMinutes, invoke: invokeDeepSeekBalance, clampMinutes: clampDeepSeekFetchMinutes, makeError: makeDeepSeekError });
}

/**
 * Z.ai 额度：服务端 usageStats/zaiQuota（网关统一信任与认证），TTL 缓存。
 * 额度信息含会话窗口（子日，<24h）、周窗口（多日）与 Web 搜索，对应协议字段
 * session/weekly/webSearches，显示在底部角标与模态窗详情里。
 */

/** Z.ai 额度调用（模块级稳定引用）。 */
function invokeZaiQuota(request: QuotaRequest): Promise<RemoteResult<ZaiQuota>> {
  return usageStatsRemote().zaiQuota(request);
}

/** 首屏失败时的 error 占位：保证侧边栏/概览组件可见（模块级稳定引用）。 */
function makeZaiError(): ZaiQuota {
  return { status: 'error', fetchedAt: Date.now(), plan: null, session: null, weekly: null, webSearches: null };
}

/**
 * 每 `intervalMinutes` 分钟轮询一次额度；未启用 / 请求失败 / 尚未加载时为
 * null。返回 [数据, 手动刷新]。间隔下限 3 分钟，默认 5 分钟。
 */
export function useZaiQuota(
  enabled: boolean,
  intervalMinutes: number,
): [ZaiQuota | null, () => void] {
  return useQuota({ enabled, intervalMinutes, invoke: invokeZaiQuota, clampMinutes: clampZaiFetchMinutes, makeError: makeZaiError });
}

/**
 * 服务商额度：内置三家（SiliconFlow / 小米 MiMo / 火山引擎）+ 用户自助添加的
 * Bearer 余额厂商，服务端 usageStats/providerQuotas 一次聚合返回，TTL 缓存。
 * 服务商页在 Tab 打开时按「启用的内置家 + 全部自定义」轮询；侧边栏只轮询
 * 「勾选侧边栏」的子集（内置与自定义各自子集，不白拉没勾选的家）。
 * 两种范围服务端按形状分桶缓存互不串味。
 */

/** 服务商额度调用（模块级稳定引用）。 */
function invokeProviderQuotas(request: QuotaRequest): Promise<RemoteResult<ProviderQuotas>> {
  return usageStatsRemote().providerQuotas(request as ProviderQuotasRequest);
}

/** 首屏失败时的 error 占位：保证服务商页可见（模块级稳定引用）。 */
function makeProviderError(): ProviderQuotas {
  return { status: 'error', fetchedAt: Date.now(), providers: [] };
}

/** 服务商页：查哪些内置家由 builtinIds 控制，自定义列表按配置投影。 */
export function useProviderQuotas(
  enabled: boolean,
  intervalMinutes: number,
  builtinIds: string[],
  custom: CustomProviderConfig[],
): [ProviderQuotas | null, () => void] {
  return useQuota({
    enabled,
    intervalMinutes,
    invoke: invokeProviderQuotas,
    clampMinutes: clampProvidersFetchMinutes,
    makeError: makeProviderError,
    extra: { builtinIds, providers: customProviderQueries(custom) },
  });
}

/**
 * 侧边栏底部：只轮询「启用监控且勾选侧边栏」的服务商（内置与自定义各自的子集）。
 * 间隔取这些家里最小的抓取间隔（保证最勤的那家不过期）；没有可见家时不请求。
 */
export function useSidebarProviderQuotas(
  settings: UsageSettings,
): [ProviderQuotas | null, () => void] {
  const visibleBuiltins = settings.builtinProviders.filter((p) => p.enabled && p.showInSidebar);
  const visibleCustom = settings.customProviders.filter((p) => p.enabled && p.showInSidebar);
  const enabled = visibleBuiltins.length > 0 || visibleCustom.length > 0;
  const intervalMinutes = [...visibleBuiltins, ...visibleCustom].reduce(
    (min, p) => Math.min(min, clampProvidersFetchMinutes(p.fetchMinutes)),
    clampProvidersFetchMinutes(NaN),
  );
  return useQuota({
    enabled,
    intervalMinutes,
    invoke: invokeProviderQuotas,
    clampMinutes: clampProvidersFetchMinutes,
    makeError: makeProviderError,
    extra: {
      builtinIds: visibleBuiltins.map((p) => p.id),
      providers: customProviderQueries(visibleCustom),
    },
  });
}
