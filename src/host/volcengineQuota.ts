/**
 * 火山引擎（Volcengine）账户余额查询：账单 OpenAPI `QueryBalanceAcct`。
 *
 * 机制要点：
 *   - 与 OpenAI 兼容供应商不同，火山账单 OpenAPI 走**火山签名 V4（AK/SK）**而非 Bearer：
 *     需要 `VOLCENGINE_ACCESS_KEY_ID` 与 `VOLCENGINE_SECRET_ACCESS_KEY` 两个凭据，
 *     缺任一即返回 no-key。
 *   - 请求：`POST https://billing.volcengineapi.com/?Action=QueryBalanceAcct&Version=2022-01-01`，
 *     空 body，签名算法为规范请求 → StringToSign → 派生密钥链（date/region/service/request）
 *     → HMAC-SHA256，`Authorization: HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=...`。
 *   - 响应 `Result` 含 AvailableBalance（可用余额）、CashBalance（现金）、CreditLimit（信用额度）
 *     等，多为字符串下发；`ResponseMetadata.Error` 在场时按官方码返回 error
 *     （签名不符等实现类问题会原样暴露，而不是伪装成 no-key）。
 *
 * 结果类型 ProviderQuotaEntry 定义在 types.ts，与客户端 ProvidersTab 统一。
 */
import { createHash, createHmac } from 'node:crypto';

import { errorMessage } from '../utils.ts';

import { providerQuotaEntry, QUOTA_UA, resolveFirstKey, toFiniteNumber } from './quota.ts';

import type { ProviderQuotaEntry } from '../types.ts';
import type { CredentialsService } from './quota.ts';

/** 账单服务固定端点与签名参数（火山文档口径）。 */
const BILLING_HOST = 'billing.volcengineapi.com';
const BILLING_SERVICE = 'billing';
const BILLING_REGION = 'cn-north-1';
const BILLING_VERSION = '2022-01-01';
const QUERY_BALANCE_ACTION = 'QueryBalanceAcct';

/** 十六进制 SHA-256。 */
function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** HMAC-SHA256，返回原始字节供密钥链派生。 */
function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** 规范化 X-Date：UTC 的 `YYYYMMDDTHHMMSSZ`。 */
function xDateOf(now: Date): string {
  return now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}/u, '');
}

/** 已签名请求：完整 URL 与需原样发送的请求头。 */
interface SignedRequest {
  url: string
  headers: Record<string, string>
}

/**
 * 构造 QueryBalanceAcct 的火山签名 V4 请求。
 * 规范请求的头部固定为 content-type/host/x-content-sha256/x-date 四项，按字典序拼接。
 */
function buildSignedRequest(accessKeyId: string, secretAccessKey: string, now: Date): SignedRequest {
  const xDate = xDateOf(now);
  const shortDate = xDate.slice(0, 8);
  const payloadHash = sha256Hex('');
  const canonicalQuery = `Action=${QUERY_BALANCE_ACTION}&Version=${BILLING_VERSION}`;
  const canonicalHeaderValues: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    host: BILLING_HOST,
    'x-content-sha256': payloadHash,
    'x-date': xDate,
  };
  const signedHeaderNames = Object.keys(canonicalHeaderValues).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${canonicalHeaderValues[name]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = ['POST', '/', canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${shortDate}/${BILLING_REGION}/${BILLING_SERVICE}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmacSha256(
    hmacSha256(hmacSha256(hmacSha256(secretAccessKey, shortDate), BILLING_REGION), BILLING_SERVICE),
    'request',
  );
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    url: `https://${BILLING_HOST}/?${canonicalQuery}`,
    headers: {
      authorization: `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'content-type': canonicalHeaderValues['content-type'],
      'x-content-sha256': payloadHash,
      'x-date': xDate,
      'user-agent': QUOTA_UA,
    },
  };
}

/** 官方响应里本模块需要的子集。 */
interface VolcBalanceResponse {
  ResponseMetadata?: { Error?: { Code?: unknown; Message?: unknown } | null } | null
  Result?: {
    AvailableBalance?: unknown
    CashBalance?: unknown
    CreditLimit?: unknown
  } | null
}

/** 组合官方错误码与消息为诊断字符串。 */
function apiErrorText(code: string, message: string): string {
  return message ? `${code}: ${message}` : code;
}

/** 无缓存查询火山引擎账户余额。 */
export async function fetchVolcengineQuota(credentials?: CredentialsService): Promise<ProviderQuotaEntry> {
  const accessKeyId = await resolveFirstKey(credentials, ['VOLCENGINE_ACCESS_KEY_ID']);
  const secretAccessKey = await resolveFirstKey(credentials, ['VOLCENGINE_SECRET_ACCESS_KEY']);
  if (accessKeyId === null || secretAccessKey === null) return providerQuotaEntry('volcengine', 'no-key');
  try {
    const signed = buildSignedRequest(accessKeyId, secretAccessKey, new Date());
    const response = await fetch(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: '',
      signal: AbortSignal.timeout(15000),
    });
    const body = (await response.json().catch(() => null)) as VolcBalanceResponse | null;
    const apiError = body?.ResponseMetadata?.Error;
    if (apiError !== null && apiError !== undefined) {
      const code = typeof apiError.Code === 'string' ? apiError.Code : `HTTP ${response.status}`;
      const message = typeof apiError.Message === 'string' ? apiError.Message : '';
      return providerQuotaEntry('volcengine', 'error', apiErrorText(code, message));
    }
    if (!response.ok) return providerQuotaEntry('volcengine', 'error', `HTTP ${response.status}`);
    const result = body?.Result;
    if (result === null || result === undefined || typeof result !== 'object') {
      return providerQuotaEntry('volcengine', 'error', '响应缺少 Result');
    }
    return {
      id: 'volcengine',
      status: 'ok',
      fetchedAt: Date.now(),
      plan: null,
      amounts: [{
        currency: 'CNY',
        total: toFiniteNumber(result.AvailableBalance),
        granted: toFiniteNumber(result.CreditLimit),
        toppedUp: toFiniteNumber(result.CashBalance),
      }],
      windows: [],
      error: null,
    };
  } catch (error) {
    return providerQuotaEntry('volcengine', 'error', errorMessage(error));
  }
}