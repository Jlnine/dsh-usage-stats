/**
 * 服务商额度统一查询入口：内置 SiliconFlow / 小米 MiMo / 火山引擎三家，外加用户在
 * 「服务商」页自助添加的 Bearer 余额厂商，各自查询后聚合成一个 ProviderQuotas 下发，
 * 带 TTL 缓存与单飞（同一请求形状并发只打一轮官方端点）。
 *
 * 本模块只负责编排：内置家的凭据键名、端点与解析口径由各 provider 模块承载；
 * 自定义家走通用 Bearer 约定（customProviderQuota.ts）。
 * 缺凭据与请求失败都只影响它自己的条目（返回带 status 的结构化结果），不抛错、不拼用户文案。
 */
import { fetchCustomProviderQuota } from './customProviderQuota.ts';
import { fetchMimoQuota } from './mimoQuota.ts';
import { createQuotaQuery } from './quota.ts';
import { fetchSiliconFlowQuota } from './siliconflowQuota.ts';
import { fetchVolcengineQuota } from './volcengineQuota.ts';

import type { CustomProviderQuery, ProviderQuotaEntry, ProviderQuotaId, ProviderQuotas } from '../types.ts';
import type { CredentialsService } from './quota.ts';

/** 单个内置服务商的查询定义。 */
interface ProviderFetcher {
  id: ProviderQuotaId
  fetch: (credentials?: CredentialsService) => Promise<ProviderQuotaEntry>
}

/** 内置服务商查询表：数组顺序即客户端内置卡片的展示顺序。 */
const PROVIDER_FETCHERS: readonly ProviderFetcher[] = [
  { id: 'siliconflow', fetch: fetchSiliconFlowQuota },
  { id: 'xiaomi-mimo', fetch: fetchMimoQuota },
  { id: 'volcengine', fetch: fetchVolcengineQuota },
];

/** 查询范围选项：本轮查哪些内置家、哪些自定义厂商。 */
export interface ProviderQuotaQueryOptions {
  /** 要查询的内置服务商 id 列表（BUILTIN_PROVIDER_IDS 子集）；缺省/空数组表示不查内置。 */
  builtinIds?: string[]
  /** 自定义厂商查询定义（由偏好配置投影，不含密钥值）。 */
  providers?: CustomProviderQuery[]
}

/**
 * 实时查询一批服务商额度，无缓存；单个服务商失败只影响它自己的条目。
 * 顺序固定为「内置三家（按 PROVIDER_FETCHERS 顺序，仅查传入选中的）在前，自定义按配置顺序在后」。
 */
export async function fetchProviderQuotas(
  credentials?: CredentialsService,
  options?: ProviderQuotaQueryOptions,
): Promise<ProviderQuotas> {
  const wanted = new Set(options?.builtinIds ?? []);
  const custom = options?.providers ?? [];
  const tasks: Promise<ProviderQuotaEntry>[] = [];
  for (const entry of PROVIDER_FETCHERS) {
    if (wanted.has(entry.id)) tasks.push(entry.fetch(credentials));
  }
  for (const query of custom) tasks.push(fetchCustomProviderQuota(query, credentials));
  const providers = await Promise.all(tasks);
  return { status: 'ok', fetchedAt: Date.now(), providers };
}

/**
 * 带 TTL 缓存与单飞的服务商额度查询，路由每次调用都走这里。
 *
 * @param intervalMinutes 客户端抓取间隔，单位分钟；有效 TTL 见共享公式，
 *   未提供时用默认上限。
 * @param force 为 true 时绕过 TTL 缓存强制重新刷新，供服务商页的“立即刷新”按钮使用；
 *   仍走单飞，避免并发打各官方端点。
 * @param credentials DSH 凭据中心，可选，缺席时各家都返回 no-key。
 * @param options 查询范围（是否内置 + 自定义列表），同时是缓存分桶键。
 */
export const queryProviderQuotas = createQuotaQuery<
  ProviderQuotas,
  CredentialsService,
  ProviderQuotaQueryOptions
>((credentials, options) => fetchProviderQuotas(credentials, options));
