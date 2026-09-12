/**
 * dsh-notifier channels 域 —— **对外契约**。
 *
 * 本域只承担一件事：**把一条通知投递出去**。它没有主见——不裁决发给谁、不读
 * 配置、不渲染文案、不落史、不记状态；消息与目标全部由调用方传入，它只回答
 * 「送到没有、为什么没送到」。
 *
 * 跨端帧经事件出口发出：本域不认识 api 域、不认识 SSE、不认识连接表，帧交给
 * 事件出口即完成职责。谁在听、听没听到，不是投递域能证明的事——浏览器通道
 * 本身不提供展示回执（业界同类通道 FCM / APNs / Web Push 同样只保证 accepted）。
 *
 * **只导出入参类型**：调用方必须构造的东西才需要具名；返回值类型由签名带出，
 * 不额外占一个名字。
 *
 * **本域对其它域零依赖**，因此没有 `deps.ts`：没有对上依赖就不造那个文件。
 */
import { deliverImpl } from "./impl/deliver/index.ts";
import type { DeliveryTarget } from "./impl/deliver/index.ts";
import type { DeliverResult, NotifyMessage } from "./impl/deliver/type.ts";

// 入参类型：只出**真有消费者**的那几个。
// - `NotifyMessage` / `DeliveryTarget`：`deliver` 签名里调用方必须亲手构造的；
// - `BarkTarget` / `WebhookTarget`：config 域的频道配置继承它们（同一组投递字段
//   不在两侧各定义一遍）。
// 其余出口的参数形状经 `DeliveryTarget` 联合可达——调用方要构造哪一路，推导得
// 出来；等真出现「要显式命名某一路」的调用点，再把那一路请出来。
export type { NotifyMessage } from "./impl/deliver/type.ts";
export type { BarkTarget } from "./impl/bark/type.ts";
export type { WebhookTarget } from "./impl/webhook/type.ts";
export type { DeliveryTarget } from "./impl/deliver/index.ts";

/**
 * 投递：消息与目标全部由外部传入。
 *
 * @returns 与 `targets` 同序的结果；逐目标 fail-soft，单个失败不影响其余。
 */
export async function deliver(
  message: NotifyMessage,
  targets: DeliveryTarget[],
): Promise<DeliverResult[]> {
  return deliverImpl(message, targets);
}
