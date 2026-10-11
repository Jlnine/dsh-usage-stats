/**
 * 额度查询共享基元（服务端）：浏览器 UA、key 回退解析、TTL 缓存单飞工厂。
 *
 * Go/DeepSeek/Z.ai 同一写法：官方端点固定域名 + 浏览器 UA 防前置拦截；
 * key 仅走 DSH 凭据中心、按名回退；结果带 TTL 缓存与单飞（并发只打一次官方端点）；
 * 未配 key / 401 / 403 一律结构化返回、不抛错，由客户端按 status 本地化。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials';

import { effectiveQuotaTtl } from '../utils.ts';

import type { ProviderQuotaEntry, ProviderQuotaId } from '../types.ts';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';

/** DSH 凭据中心服务，为 Context.credentials 合并类型，cordis 可选注入，运行时可能缺席。 */
export type CredentialsService = CredentialProvider;

/** 浏览器 UA：四路额度官方端点共用，避免被前置 Cloudflare 拦截。 */
export const QUOTA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** 按名回退解析 key：首个成功者胜出（去空格），全部失败回 null。 */
export async function resolveFirstKey(
  credentials: CredentialsService | undefined,
  names: string[],
): Promise<string | null> {
  if (credentials && typeof credentials.resolve === 'function') {
    for (const name of names) {
      try {
        const resolved = await credentials.resolve(credentialRef(name));
        if (resolved && typeof resolved.value === 'string' && resolved.value.trim().length > 0) {
          return resolved.value.trim();
        }
      } catch {
        // 凭据解析失败：继续尝试下一个名字
      }
    }
  }
  return null;
}

/**
 * 金额强转：数值或数字字符串取有限数，空串与非法值回 null。
 * 官方余额接口多把金额下发成字符串（避免浮点误差），故两种形态都接。
 */
export function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 服务商额度条目的空值构造：no-key / error 分支复用，保证字段齐备
 * （客户端按 status 本地化，不读其余字段）。
 */
export function providerQuotaEntry(
  id: ProviderQuotaId,
  status: 'no-key' | 'error',
  error: string | null = null,
): ProviderQuotaEntry {
  return { id, status, fetchedAt: Date.now(), plan: null, amounts: [], windows: [], error };
}

/**
 * 带 TTL 缓存与单飞的查询工厂：每个调用处实例独立缓存。
 * 常规调用在 TTL 内直接回缓存；force 为用户手动刷新，完全绕过 TTL 与下限、
 * 立即重拉官方端点，仅经单飞合并并发请求，返回后缓存窗口重新起算
 * （失败的结构化结果同样写入缓存，失败窗口内不重复打官方端点）。
 *
 * 可选的第四参 `arg` 参与查询并作为缓存分桶键：服务商额度一处实例要同时服务
 * 「服务商页（内置三家 + 全部自定义）」与「侧边栏（仅要展示的自定义子集）」两种请求，
 * 用 arg 的 JSON 形状分桶，避免范围不同的请求互相回错缓存。arg 恒为 undefined 的
 * 既有三路（Go/DeepSeek/Z.ai）退化为单个空键桶，行为与改造前完全一致。
 */
export function createQuotaQuery<T, C, A = undefined>(
  fetch: (credentials: C | undefined, arg: A | undefined) => Promise<T>,
): (intervalMinutes?: number, force?: boolean, credentials?: C, arg?: A) => Promise<T> {
  /** 分桶缓存：键为 arg 的 JSON 形状（undefined → 空串单桶）。 */
  const buckets = new Map<string, { at: number; value: T }>();
  const inflight = new Map<string, Promise<T>>();
  /** 缓存桶上限：自定义配置变更会产生新形状键，超出即整体清空由下拍重建，防无界增长。 */
  const MAX_BUCKETS = 24;
  return async (intervalMinutes?: number, force = false, credentials?: C, arg?: A): Promise<T> => {
    const effectiveTtlMs = effectiveQuotaTtl(intervalMinutes);
    const bucketKey = arg === undefined ? '' : JSON.stringify(arg ?? null);
    const now = Date.now();
    const cached = buckets.get(bucketKey);
    if (!force && cached !== undefined && now - cached.at < effectiveTtlMs) return cached.value;
    let job = inflight.get(bucketKey);
    if (job === undefined) {
      job = fetch(credentials, arg).then((value) => {
        if (buckets.size >= MAX_BUCKETS) buckets.clear();
        buckets.set(bucketKey, { at: Date.now(), value });
        return value;
      }).finally(() => {
        inflight.delete(bucketKey);
      });
      inflight.set(bucketKey, job);
    }
    return job;
  };
}
