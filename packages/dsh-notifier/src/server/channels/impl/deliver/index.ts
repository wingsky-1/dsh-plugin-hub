/**
 * dsh-notifier channels 域 —— 投递编排（聚合，只做聚合）。
 *
 * 本文件是本域实现层的唯一聚合点：声明「投递目标」这个联合，并把每个目标分派给
 * 各自的出口实现。它不定义出口的形状（那些随各自目录走），也不做业务——「该发给
 * 谁」是裁决层的问题。
 *
 * 逐目标 fail-soft 由出口实现保证（失败即返回 `failed` 结果，不外抛）；单个出口失败
 * 不影响其余，结果按 `targets` 下标归位。出口**违约**（真抛了异常）由本层收口成一条
 * `failed` 结果——契约是承诺，而承诺要靠收口才成立。
 *
 * 依赖方向：只引用 `./type.ts`、各出口目录，不引用 `interface.ts`。
 */
import { sendBark } from "../bark/index.ts";
import type { BarkTarget } from "../bark/type.ts";
import { sendBrowser } from "../browser/index.ts";
import type { BrowserTarget } from "../browser/type.ts";
import { sendSystem } from "../system/index.ts";
import type { SystemTarget } from "../system/type.ts";
import { sendWebhook } from "../webhook/index.ts";
import type { WebhookTarget } from "../webhook/type.ts";
import type { DeliverResult, NotifyMessage } from "./type.ts";

/**
 * 投递目标：出口类型 + 该出口的投递参数。
 *
 * 联合在聚合点声明，各出口只交出自己的那一路——出口不需要知道「一共有几种出口」，
 * 新增一种也只动这里与它自己的目录。
 */
export type DeliveryTarget = BarkTarget | WebhookTarget | BrowserTarget | SystemTarget;

/** 投递能力实现：逐目标分派到各自的出口实现。 */
export async function deliverImpl(
  message: NotifyMessage,
  targets: DeliveryTarget[],
): Promise<DeliverResult[]> {
  // 并行投递、逐个收口：一次违约不该连带丢掉其余出口的结果（见 deliverOne）。
  return Promise.all(targets.map((target) => deliverOne(target, message)));
}

/**
 * 投一个目标，并把「出口违约」收成本域的结果。
 *
 * 契约把逐目标 fail-soft 交给出口实现（失败是返回值，不是异常），所以走进 catch 就说明
 * 那个出口违约了。在这里收口而不是让它冒给 `Promise.all`：一次拒绝会让整批投递一起失败，
 * 调用方只能记一条「全都没发出去」，而事实是只有一个出口出了问题——下游据此写的频道状态
 * 会把没问题的出口一起标红。
 *
 * `stage` 取 `accepted`：违约的出口没给出任何证据，按证据上限的最低档记。
 */
async function deliverOne(target: DeliveryTarget, message: NotifyMessage): Promise<DeliverResult> {
  try {
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
  } catch (cause) {
    return {
      status: "failed",
      stage: "accepted",
      reason: cause instanceof Error ? cause.message : String(cause),
      // 违约不可重试：出口本应把失败做成返回值，抛出来说明它的错误处理有洞——
      // 再投一次只会把同一个洞踩第二遍，而两次的失败长得一模一样。
      retryable: false,
    };
  }
}
