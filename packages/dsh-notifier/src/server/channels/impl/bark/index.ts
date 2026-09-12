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

/** 请求超时（毫秒）。 */
const BARK_TIMEOUT_MS = 10_000;

/** severity → bark 等级映射（未显式指定 level 时生效）。 */
const SEVERITY_LEVEL: Readonly<Record<string, string>> = {
  info: "passive",
  success: "active",
  warning: "timeSensitive",
  failure: "critical",
};

/** 投递一条消息到 bark 实例。 */
export async function sendBark(target: BarkTarget, message: NotifyMessage): Promise<DeliverResult> {
  throw new Error("not implemented: sendBark");
}
