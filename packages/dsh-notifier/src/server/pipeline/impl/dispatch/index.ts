/**
 * dsh-notifier pipeline 域 —— 投递块：把定稿的消息送到选定的出口，并把终态记下来。
 *
 * 本块不做判断：该不该发由裁决块回答，发给谁由路由块回答。它只负责把两份清单按
 * 下标对上——`deliver` 承诺结果与目标同序，而下标是这一层唯一拿得到的对应关系。
 *
 * 这里没有 try/catch：出口失败不外抛（channels 契约承诺逐目标 fail-soft），失败
 * 已经是一个正常的返回值，记进状态即可。为「不会被抛的异常」写兜底，只会让下一
 * 个读代码的人以为出口会抛。
 *
 * 依赖方向：只引用本目录、`../route/type.ts` 与 `../../deps.ts`，不引用 `interface.ts`。
 */
import type { NotifyMessage } from "../../deps.ts";
import type { RoutedTarget } from "../route/type.ts";
import type { DispatchDeps } from "./type.ts";

/** 投递：逐目标结果按序归位到频道身份，写进频道状态。 */
export async function dispatchMessage(
  deps: DispatchDeps,
  message: NotifyMessage,
  targets: RoutedTarget[],
): Promise<void> {
  const results = await deps.deliver(
    message,
    targets.map((routed) => routed.target),
  );
  targets.forEach((routed, index) => {
    const result = results[index];
    deps.recordStatus(routed.channelId, result.status, result.reason);
  });
}
