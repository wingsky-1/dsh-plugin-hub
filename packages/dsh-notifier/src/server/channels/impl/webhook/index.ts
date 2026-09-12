/**
 * dsh-notifier channels 域 —— webhook 出口。
 *
 * 投递语义：按 preset 决定 body 模板与优先级字段形态，按 `auth` 构造认证头；
 * 零重试是硬约束——失败即 failed，由调用方记状态。
 *
 * 依赖方向：只引用本目录与共享语言，不引用 `interface.ts`。
 */
import type { DeliverResult, NotifyMessage } from "../deliver/type.ts";
import type { WebhookTarget } from "./type.ts";

/** ntfy 优先级取值。 */
const SEVERITY_NTFY_PRIORITY: Readonly<Record<string, string>> = {
  info: "3",
  success: "4",
  warning: "4",
  failure: "5",
};

/** gotify 优先级取值。 */
const SEVERITY_GOTIFY_PRIORITY: Readonly<Record<string, number>> = {
  info: 3,
  success: 5,
  warning: 7,
  failure: 10,
};

/** 默认请求超时（秒）。 */
const DEFAULT_TIMEOUT_SEC = 10;
/** 超时下限（秒）。 */
const MIN_TIMEOUT_SEC = 1;
/** 超时上限（秒）。 */
const MAX_TIMEOUT_SEC = 60;

/** 投递一条消息到 webhook 端点。 */
export async function sendWebhook(target: WebhookTarget, message: NotifyMessage): Promise<DeliverResult> {
  throw new Error("not implemented: sendWebhook");
}
