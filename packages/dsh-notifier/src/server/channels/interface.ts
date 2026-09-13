/**
 * dsh-notifier channels 域 —— **对外契约**。
 * 只做一件事：把一条通知投递出去——不裁决发给谁、不读配置、不落史，只回答「送到没有、
 * 为什么没送到」；跨端帧交给帧出口即完成职责。本域对其它域零依赖，故没有域级 deps.ts
 * （`impl/system/deps.ts` 收的是本进程事实，不是别的域的注入面）。
 */
import { deliverImpl } from "./impl/deliver/index.ts";
import type { DeliveryTarget } from "./impl/deliver/index.ts";
import type { DeliverResult, NotifyMessage } from "./impl/deliver/type.ts";

// 只导出入参类型：调用方必须亲手构造的那几个。`NotifySeverity` 是消息的字段类型，请求方
// 只能经本域拿到这个名字，否则「有哪几档强度」会变成两份事实源；`BarkTarget` /
// `WebhookTarget` 被 config 域的频道配置继承；`NotifyFrame` 是本域产出的线协议。
// 其余出口参数经 `DeliveryTarget` 联合可达，等真出现要显式命名的调用点再请出来。
export type { NotifyMessage, NotifySeverity } from "./impl/deliver/type.ts";
export type { BarkTarget } from "./impl/bark/type.ts";
export type { WebhookTarget } from "./impl/webhook/type.ts";
export type { NotifyFrame } from "./impl/browser/type.ts";
export type { DeliveryTarget } from "./impl/deliver/index.ts";

/** 投递：消息与目标全部由外部传入；结果与 `targets` 同序，逐目标 fail-soft。 */
export async function deliver(
  message: NotifyMessage,
  targets: DeliveryTarget[],
): Promise<DeliverResult[]> {
  return deliverImpl(message, targets);
}
