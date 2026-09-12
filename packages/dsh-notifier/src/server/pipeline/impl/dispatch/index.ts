/**
 * dsh-notifier pipeline 域 —— 投递块：把定稿的消息送到选定的出口，并把结果按频道归位。
 *
 * 本块不做判断：该不该发由裁决块回答，发给谁由路由块回答。它只负责把两份清单按
 * 下标对上——`deliver` 承诺结果与目标同序，而下标是这一层唯一拿得到的对应关系。
 *
 * 归位的结果有两个去处，因此一次遍历里同时完成：写进频道状态（设置页要看），以及
 * 作为返回值交给编排层归档（历史要留）。拆成两次遍历或者把两份清单各自带出去，都是
 * 在重复同一次投递的产物。
 *
 * 这里没有 try/catch：出口失败不外抛（channels 契约承诺逐目标 fail-soft），失败
 * 已经是一个正常的返回值，记进状态即可。为「不会被抛的异常」写兜底，只会让下一
 * 个读代码的人以为出口会抛。
 *
 * 依赖方向：只引用本目录、`../route/type.ts` 与 `../../deps.ts`，不引用 `interface.ts`。
 */
import type { ChannelDelivery, NotifyMessage } from "../../deps.ts";
import { deliver, recordStatus } from "../../deps.ts";
import type { RoutedTarget } from "../route/type.ts";

/** 投递：逐目标结果按序归位到频道身份，写进频道状态并返回归档用的明细。 */
export async function dispatchMessage(
  message: NotifyMessage,
  targets: RoutedTarget[],
): Promise<ChannelDelivery[]> {
  const results = await deliver(
    message,
    targets.map((routed) => routed.target),
  );
  return targets.map((routed, index) => {
    const result = results[index];
    recordStatus(routed.channelId, result.status, result.reason);
    return { channelId: routed.channelId, status: result.status, reason: result.reason };
  });
}
