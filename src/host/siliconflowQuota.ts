/**
 * SiliconFlow（硅基流动）账户余额查询：端点为 `GET https://api.siliconflow.cn/v1/user/info`。
 *
 * 机制要点：
 *   - 官方固定域名端点；Bearer key + 浏览器 UA。
 *   - key 仅走 DSH 凭据中心 `SILICONFLOW_API_KEY`，不读 env 与文件。
 *   - 响应 `data` 含 balance（赠送）、chargeBalance（充值）、totalBalance（总额），
 *     官方以字符串下发，此处归一化为数值。
 *   - 未配 key / 401 / 403 返回 no-key，其余失败返回 error，由客户端本地化。
 *
 * 结果类型 ProviderQuotaEntry 定义在 types.ts，与客户端 ProvidersTab 统一。
 */
import { errorMessage } from '../utils.ts';

import { providerQuotaEntry, QUOTA_UA, resolveFirstKey, toFiniteNumber } from './quota.ts';

import type { ProviderQuotaEntry } from '../types.ts';
import type { CredentialsService } from './quota.ts';

/** SiliconFlow 账户信息端点，固定域名（官方文档确认）。 */
const SILICONFLOW_USER_INFO_URL = 'https://api.siliconflow.cn/v1/user/info';

/** 官方 user/info 响应里本模块需要的子集。 */
interface SiliconFlowUserInfo {
  data?: { balance?: unknown; chargeBalance?: unknown; totalBalance?: unknown } | null
}

/** 无缓存查询 SiliconFlow 账户余额。 */
export async function fetchSiliconFlowQuota(credentials?: CredentialsService): Promise<ProviderQuotaEntry> {
  const key = await resolveFirstKey(credentials, ['SILICONFLOW_API_KEY']);
  if (key === null) return providerQuotaEntry('siliconflow', 'no-key');
  try {
    const response = await fetch(SILICONFLOW_USER_INFO_URL, {
      headers: { authorization: `Bearer ${key}`, 'user-agent': QUOTA_UA },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401 || response.status === 403) return providerQuotaEntry('siliconflow', 'no-key');
    if (!response.ok) return providerQuotaEntry('siliconflow', 'error', `HTTP ${response.status}`);
    const body = (await response.json()) as SiliconFlowUserInfo;
    const data = body?.data;
    if (data === null || data === undefined || typeof data !== 'object') {
      return providerQuotaEntry('siliconflow', 'error', '响应缺少 data');
    }
    const granted = toFiniteNumber(data.balance);
    const toppedUp = toFiniteNumber(data.chargeBalance);
    // 总额优先取 totalBalance，官方未下发时回退到赠送余额。
    const total = toFiniteNumber(data.totalBalance) ?? granted;
    return {
      id: 'siliconflow',
      status: 'ok',
      fetchedAt: Date.now(),
      plan: null,
      amounts: [{ currency: 'CNY', total, granted, toppedUp }],
      windows: [],
      error: null,
    };
  } catch (error) {
    return providerQuotaEntry('siliconflow', 'error', errorMessage(error));
  }
}