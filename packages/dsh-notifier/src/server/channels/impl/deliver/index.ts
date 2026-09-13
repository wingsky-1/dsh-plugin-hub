/**
 * dsh-notifier channels 域 —— 投递编排（聚合，只做聚合）。
 *
 * 本域实现层的唯一聚合点：声明「投递目标」这个联合，把每个目标分派给各自的出口实现。
 * 它不定义出口的形状，也不做业务——「该发给谁」是裁决层的问题。
 */
import { reason, reasonFromCause } from "../../../shared/interface.ts";
import { sendBark } from "../bark/index.ts";
import type { BarkTarget } from "../bark/type.ts";
import { sendBrowser } from "../browser/index.ts";
import type { BrowserTarget } from "../browser/type.ts";
import { sendSystem } from "../system/index.ts";
import type { SystemTarget } from "../system/type.ts";
import { sendWebhook } from "../webhook/index.ts";
import type { WebhookTarget } from "../webhook/type.ts";
import type { DeliverResult, NotifyMessage } from "./type.ts";

/** 投递目标：出口类型 + 该出口的投递参数（联合在聚合点声明，各出口只交出自己的那一路）。 */
export type DeliveryTarget = BarkTarget | WebhookTarget | BrowserTarget | SystemTarget;

/** 投递能力实现：并行投递，逐目标分派，结果与 `targets` 下标同序。 */
export async function deliverImpl(
  message: NotifyMessage,
  targets: DeliveryTarget[],
): Promise<DeliverResult[]> {
  return Promise.all(targets.map((target) => deliverOne(target, message)));
}

/**
 * 投一个目标，并把「出口违约」收成本域的结果。
 *
 * 出口承诺失败是返回值而不是异常，所以走进 catch 就是违约。在这里收口而不是让它冒给
 * `Promise.all`：一次拒绝会让整批一起失败，调用方只能记一条「全都没发出去」。
 * `stage` 取 `accepted`——违约的出口没给出任何证据；`retryable` 为假——出口本应把失败
 * 做成返回值，抛出来说明它有洞，再投一次只是把同一个洞踩第二遍。
 */
async function deliverOne(target: DeliveryTarget, message: NotifyMessage): Promise<DeliverResult> {
  try {
    // 出口类型是跨边界数据：编译期的联合穷举不代表运行时的值也在枚举里，故留一份原始值给守卫。
    const kind: string = target.type;
    switch (target.type) {
      case "bark":
        return await sendBark(target, message);
      case "webhook":
        return await sendWebhook(target, message);
      case "browser":
        return sendBrowser(target, message);
      case "system":
        return await sendSystem(target, message);
    }
    // 枚举之外的出口没有实现可派发；落成空元素会让下游读 `result.status` 当场 TypeError，
    // 整批结果连同一起来到这一步的出口一起丢，所以这里按「本目标失败」收口。
    return unknownTarget(kind);
  } catch (cause) {
    return {
      status: "failed",
      stage: "accepted",
      reason: reasonFromCause("reasonChannelThrew", cause),
      retryable: false,
    };
  }
}

/**
 * 未知出口类型的失败明细：形状与出口违约那条完全一致，好让调用方只认一套结果。
 * `stage` 取 `accepted`、`retryable` 为假——这个目标根本没被派发出去，没有任何证据可依据。
 */
function unknownTarget(kind: string): DeliverResult {
  return {
    status: "failed",
    stage: "accepted",
    reason: reason("reasonUnknownTarget", { params: { kind } }),
    retryable: false,
  };
}
