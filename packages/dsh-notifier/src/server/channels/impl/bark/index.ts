/**
 * dsh-notifier channels 域 —— bark 出口。
 *
 * 投递语义：POST 到 `<baseUrl>/<deviceKey>/<title>/<body>`，查询参数携带分组、
 * 等级与声音；超时与网络错误标注 `retryable`，由调用方按自身策略决策重试。
 *
 * 依赖方向：只引用本目录与共享语言，不引用 `interface.ts`。
 */
import type { DeliverResult, NotifyMessage } from "../deliver/type.ts";
import type { BarkTarget } from "./type.ts";

/** 投递一条消息到 bark 实例。 */
export async function sendBark(target: BarkTarget, message: NotifyMessage): Promise<DeliverResult> {
  void target;
  void message;
  throw new Error("not implemented: sendBark");
}
