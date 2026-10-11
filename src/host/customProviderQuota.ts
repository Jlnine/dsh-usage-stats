/**
 * 自定义 Bearer 余额厂商查询（用户在「服务商」页自助添加）。
 *
 * 与内置三家（各自专有解析）不同，本模块走一套通用约定：
 *   - GET `endpoint`（强制 https），请求头 `Authorization: Bearer <key>` + 浏览器 UA；
 *   - key 仅按配置里的环境变量名走 DSH 凭据中心解析，不读 env 文件以外的任何来源；
 *   - 余额数值按用户给的 JSON 点路径 `valuePath` 从响应里取（如 data.available_balance），
 *     数字或数字字符串都接受，归一化为数值；
 *   - 401/403 与未配 Key 一律记 no-key，HTTP 非 2xx、地址/字段非法记 error，不抛错、不拼界面文案。
 *
 * 安全：点路径只允许标识符与数字下标（白名单分段，杜绝原型链访问与任意代码）；
 * 本模块只接触密钥用于发请求，绝不返回或记录它。
 */
import { CREDENTIAL_REF_PATTERN, errorMessage } from '../utils.ts';

import { providerQuotaEntry, QUOTA_UA, resolveFirstKey, toFiniteNumber } from './quota.ts';

import type { CustomProviderQuery, ProviderQuotaEntry } from '../types.ts';
import type { CredentialsService } from './quota.ts';

/**
 * 按点路径从 JSON 响应取余额：分段仅允许标识符或纯数字下标，任一段不是对象即取不到。
 * 不使用 split 后的任意属性访问原型方法——白名单已排除 `__proto__`/`constructor` 之外
 * 仍可能碰撞的名字，但取值只读不改，且 toFiniteNumber 只收原始数值，无原型污染面。
 */
function readNumberByPath(root: unknown, path: string): number | null {
  const parts = path.split('.').map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length === 0) return null;
  let current: unknown = root;
  for (const part of parts) {
    if (!/^[A-Za-z_$][\w$]*$|^\d+$/.test(part)) return null;
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[part];
  }
  return toFiniteNumber(current);
}

/** 无缓存查询单个自定义 Bearer 厂商余额；任何失败都结构化为该 id 的条目，不抛错。 */
export async function fetchCustomProviderQuota(
  query: CustomProviderQuery,
  credentials?: CredentialsService,
): Promise<ProviderQuotaEntry> {
  const id = query.id;
  if (!CREDENTIAL_REF_PATTERN.test(query.credentialRef)) {
    return providerQuotaEntry(id, 'error', '凭据变量名非法');
  }
  let url: URL;
  try {
    url = new URL(query.endpoint);
  } catch {
    return providerQuotaEntry(id, 'error', '余额地址非法');
  }
  if (url.protocol !== 'https:') {
    return providerQuotaEntry(id, 'error', '余额地址必须为 https');
  }
  const key = await resolveFirstKey(credentials, [query.credentialRef]);
  if (key === null) return providerQuotaEntry(id, 'no-key');
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${key}`, 'user-agent': QUOTA_UA },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401 || response.status === 403) return providerQuotaEntry(id, 'no-key');
    if (!response.ok) return providerQuotaEntry(id, 'error', `HTTP ${response.status}`);
    const body: unknown = await response.json();
    const total = readNumberByPath(body, query.valuePath || 'data.balance');
    if (total === null) {
      return providerQuotaEntry(id, 'error', `余额字段 ${query.valuePath || 'data.balance'} 缺失或非数值`);
    }
    return {
      id,
      status: 'ok',
      fetchedAt: Date.now(),
      plan: null,
      amounts: [{ currency: query.currency || 'CNY', total, granted: null, toppedUp: null }],
      windows: [],
      error: null,
    };
  } catch (error) {
    return providerQuotaEntry(id, 'error', errorMessage(error));
  }
}
