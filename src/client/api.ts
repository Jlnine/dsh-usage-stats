/**
 * usageStats 命名空间的浏览器端调用约定。
 *
 * 经 usageStatsRemote 取命名空间服务后调用。线路上走客户端 Connection 的
 * RPC：`POST /api/usageStats/<方法>`，请求体为 `{ type:'client-request',
 * rpcId, method, payload:{ args } }`，同一 rpcId 的响应里再带
 * `{ ok:true, value } | { ok:false, error }` 信封，调用方按 ok 分支即可；
 * 信任与认证由网关载体统一处理（Host/Origin 围栏 + 浏览器会话 cookie）。
 * 方法表与信封的单一来源为 src/remote/contribution.ts，本模块只定义
 * 快照轮询常量与 rebuild/clear 共用的调用封装。
 */

import { usageStatsRemote } from './remote.ts';

/** 快照轮询间隔：底部角标与模态窗共用同一份数据。 */
export const SNAPSHOT_INTERVAL_MS = 4000;
/** 快照会话明细请求上限：服务端默认 200、上限 1000，此值兼顾完整与序列化开销。 */
export const SNAPSHOT_LIMIT = 500;

/**
 * 账本写操作 Remote 调用：rebuild/clear 同一写法（seal 仅协议保留，界面未暴露）。
 * 成功后调 onRefresh 重拉快照；失败抛错，由调用方落回 idle。二次确认与 busy/done 状态机归 useConfirmOp。
 */
export async function postLedgerApi(endpoint: 'rebuild' | 'clear', onRefresh: () => void): Promise<void> {
  const remote = usageStatsRemote();
  const result = endpoint === 'rebuild' ? await remote.rebuild() : await remote.clear();
  if (!result.ok) throw new Error(`${endpoint} failed`);
  onRefresh();
}

/**
 * 探测某环境变量名在凭据中心是否已配置、是否可写（不回传密钥值）。
 * 供「服务商」页在保存 Key 前提示同名覆盖。
 */
export async function describeCredential(ref: string): Promise<{ configured: boolean; writable: boolean }> {
  const result = await usageStatsRemote().describeCredential({ ref });
  if (!result.ok) throw new Error(result.error.message || 'describeCredential failed');
  return { configured: result.value.configured, writable: result.value.writable };
}

/**
 * 把「服务商」页填写的 API Key 存入 DSH 凭据中心；失败抛出带服务端原因的错误，
 * 由表单显示（如变量名非法、该名被启动环境只读占用、凭据中心不可写）。
 */
export async function saveCredential(ref: string, value: string): Promise<void> {
  const result = await usageStatsRemote().saveCredential({ ref, value });
  if (!result.ok) throw new Error(result.error.message || 'saveCredential failed');
}
