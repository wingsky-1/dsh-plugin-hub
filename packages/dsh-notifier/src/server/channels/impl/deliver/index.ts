/**
 * dsh-notifier channels 域 —— 投递编排（聚合，只做聚合）。
 *
 * 本文件是本域实现层的唯一聚合点：声明「投递目标」这个联合，并把每个目标分派给
 * 各自的出口实现。它不定义出口的形状（那些随各自目录走），也不做业务——「该发给
 * 谁」是裁决层的问题。
 *
 * 逐目标 fail-soft 由出口实现保证（失败即返回 `failed` 结果，不外抛）；
 * 单个出口失败不影响其余，结果按 `targets` 下标归位。
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
  return Promise.all(
    targets.map(async (target) => {
      switch (target.type) {
        case "bark":
          return sendBark(target, message);
        case "webhook":
          return sendWebhook(target, message);
        case "browser":
          return sendBrowser(target, message);
        case "system":
          return sendSystem(target, message);
      }
    }),
  );
}
