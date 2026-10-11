/**
 * 小米 MiMo 套餐额度查询：端点为 `GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage`。
 *
 * 机制要点：
 *   - 该端点**官方未公开文档化**（社区实现口径），响应形状按社区实测解析：
 *     `data.usage.percent` 为套餐总额用量、`data.monthUsage.percent` 为本月用量，
 *     均为 0..1 小数，此处归一化成 0..100；字段缺失只少一个窗口，不影响整体判定。
 *   - 鉴权：先以 `XIAOMI_MIMO_API_KEY` 走 Bearer，官方对 API Key 常返回 401，
 *     再回退到浏览器 Cookie（`XIAOMI_TOKEN_PLAN_CN` / `XIAOMI_MIMO_COOKIE`，原样 Cookie 串）。
 *   - 未配任何凭据返回 no-key，其余失败返回 error，由客户端本地化。
 *
 * 结果类型 ProviderQuotaEntry 定义在 types.ts，与客户端 ProvidersTab 统一。
 */
import { errorMessage } from '../utils.ts';

import { providerQuotaEntry, QUOTA_UA, resolveFirstKey, toFiniteNumber } from './quota.ts';

import type { ProviderQuotaEntry, ProviderQuotaWindow } from '../types.ts';
import type { CredentialsService } from './quota.ts';

/** 小米 MiMo 套餐用量端点（社区口径，官方未文档化）。 */
const MIMO_TOKEN_PLAN_URL = 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage';

/** 重置时间候选字段名（官方未文档化，逐个尝试）。 */
const RESET_FIELD_NAMES = ['resetsAt', 'resetTime', 'expireTime'] as const;

/** 普通对象判定：null、数组、非对象都返回 false。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 百分比归一化：社区口径为 0..1 小数，≤1 视作小数放大到百分比，>1 视作已是百分比；
 * 结果夹在 0..100 并保留一位小数。
 */
function normalizeFraction(raw: unknown): number | null {
  const n = toFiniteNumber(raw);
  if (n === null) return null;
  const percent = n <= 1 ? n * 100 : n;
  return Math.round(Math.max(0, Math.min(100, percent)) * 10) / 10;
}

/** 从窗口对象里取重置时间字符串，候选字段都缺失时返回 null。 */
function resetsAtOf(source: Record<string, unknown>): string | null {
  for (const name of RESET_FIELD_NAMES) {
    const value = source[name];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/** 解析官方响应为服务商条目；无任何可用额度窗口时判 error。 */
function buildMimoEntry(payload: unknown): ProviderQuotaEntry {
  const root = isRecord(payload) ? payload : {};
  // data 可能是根对象本身，也可能包在 data 下，两种都接。
  const scope = isRecord(root.data) ? root.data : root;
  const windows: ProviderQuotaWindow[] = [];
  const usage = isRecord(scope.usage) ? scope.usage : null;
  if (usage !== null) {
    const percent = normalizeFraction(usage.percent);
    if (percent !== null) windows.push({ kind: 'plan', percent, resetsAt: resetsAtOf(usage) });
  }
  const month = isRecord(scope.monthUsage) ? scope.monthUsage : null;
  if (month !== null) {
    const percent = normalizeFraction(month.percent);
    if (percent !== null) windows.push({ kind: 'month', percent, resetsAt: resetsAtOf(month) });
  }
  if (windows.length === 0) return providerQuotaEntry('xiaomi-mimo', 'error', '响应缺少额度字段');
  const planRaw = scope.planName ?? scope.plan;
  const plan = typeof planRaw === 'string' && planRaw.trim() !== '' ? planRaw.trim() : null;
  return { id: 'xiaomi-mimo', status: 'ok', fetchedAt: Date.now(), plan, amounts: [], windows, error: null };
}

/** 单次请求：附加 UA 与调用方给定鉴权头。 */
function requestMimo(auth: Record<string, string>): Promise<Response> {
  return fetch(MIMO_TOKEN_PLAN_URL, {
    headers: { 'user-agent': QUOTA_UA, ...auth },
    signal: AbortSignal.timeout(15000),
  });
}

/** 无缓存查询小米 MiMo 套餐额度（Bearer 优先，401/403 回退 Cookie）。 */
export async function fetchMimoQuota(credentials?: CredentialsService): Promise<ProviderQuotaEntry> {
  const key = await resolveFirstKey(credentials, ['XIAOMI_MIMO_API_KEY']);
  const cookie = await resolveFirstKey(credentials, ['XIAOMI_TOKEN_PLAN_CN', 'XIAOMI_MIMO_COOKIE']);
  if (key === null && cookie === null) return providerQuotaEntry('xiaomi-mimo', 'no-key');
  try {
    if (key !== null) {
      const bearer = await requestMimo({ authorization: `Bearer ${key}` });
      // Bearer 未被拒（非 401/403）：直接按结果判定，不再走 Cookie 回退。
      if (bearer.status !== 401 && bearer.status !== 403) {
        if (!bearer.ok) return providerQuotaEntry('xiaomi-mimo', 'error', `HTTP ${bearer.status}`);
        return buildMimoEntry(await bearer.json());
      }
    }
    if (cookie !== null) {
      const withCookie = await requestMimo({ cookie });
      if (withCookie.status === 401 || withCookie.status === 403) return providerQuotaEntry('xiaomi-mimo', 'no-key');
      if (!withCookie.ok) return providerQuotaEntry('xiaomi-mimo', 'error', `HTTP ${withCookie.status}`);
      return buildMimoEntry(await withCookie.json());
    }
    // 只有 Bearer 且被拒：维持 no-key 语义（与其它额度一致）。
    return providerQuotaEntry('xiaomi-mimo', 'no-key');
  } catch (error) {
    return providerQuotaEntry('xiaomi-mimo', 'error', errorMessage(error));
  }
}