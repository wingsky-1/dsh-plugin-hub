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

/** 投递一条消息到 webhook 端点。 */
export async function sendWebhook(
  target: WebhookTarget,
  message: NotifyMessage,
): Promise<DeliverResult> {
  void target;
  void message;
  throw new Error("not implemented: sendWebhook");
}
