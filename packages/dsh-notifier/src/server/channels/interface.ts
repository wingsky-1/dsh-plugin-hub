/**
 * dsh-notifier channels 域 —— **对外契约**。
 * 只做一件事：把一条通知投递出去——不裁决发给谁、不读配置、不落史，只回答「送到没有、
 * 为什么没送到」；跨端帧交给帧出口即完成职责。本域对其它域零依赖，故没有域级 deps.ts
 * （`impl/system/deps.ts` 收的是本进程事实，不是别的域的注入面）。
 */
import { deliverImpl } from "./impl/deliver/index.ts";
import type { DeliveryTarget } from "./impl/deliver/index.ts";
import type { DeliverResult, NotifyMessage } from "./impl/deliver/type.ts";
import { probeHostCapabilities, undeterminedCapabilities } from "./impl/capabilities/index.ts";
import { systemDeps } from "./impl/system/deps.ts";
import type { HostCapabilities } from "./impl/capabilities/type.ts";

// 只导出入参类型：调用方必须亲手构造的那几个。`NotifySeverity` 是消息的字段类型，请求方
// 只能经本域拿到这个名字，否则「有哪几档强度」会变成两份事实源；`BarkTarget` /
// `WebhookTarget` 被 config 域的频道配置继承；`NotifyFrame` 是本域产出的线协议。
// 其余出口参数经 `DeliveryTarget` 联合可达，等真出现要显式命名的调用点再请出来。
export type { NotifyMessage, NotifySeverity } from "./impl/deliver/type.ts";
export type { BarkTarget } from "./impl/bark/type.ts";
export type { WebhookTarget } from "./impl/webhook/type.ts";
export type { NotifyFrame } from "./impl/browser/type.ts";
export type { DeliveryTarget } from "./impl/deliver/index.ts";
export type {
  CapabilityDimension,
  CheckedDimension,
  HostCapabilities,
  PackageManager,
  Remediation,
  RemediationCode,
  RemediationParams,
  Verdict,
} from "./impl/capabilities/type.ts";

/** 投递：消息与目标全部由外部传入；结果与 `targets` 同序，逐目标 fail-soft。 */
export async function deliver(
  message: NotifyMessage,
  targets: DeliveryTarget[],
): Promise<DeliverResult[]> {
  return deliverImpl(message, targets);
}

/**
 * 宿主能力自检。**调用方负责缓存**：探测会起子进程，每个请求各探一次就是把用户机器当靶场。
 * 探测只读（只向 `org.freedesktop.DBus` 问 owner 与可激活清单），不触发任何服务激活。
 */
export async function probeCapabilities(): Promise<HostCapabilities> {
  return probeHostCapabilities();
}

/** 本进程的平台事实。与能力面同一来源（同一端口），api 域不得直读 `process.platform`——那样三平台断言写不出来。 */
export function hostPlatform(): string {
  return systemDeps().platform;
}

/**
 * 探测没能给出结论时的诚实回答（两个维度都「无法判定」）。
 * 出口在这里，是为了让「探测失败/超预算」的兜底形状只有一份：调用方各自就地拼一个字面量，
 * 很快就会漂成三种形状，而客户端只认得其中一种。
 */
export { undeterminedCapabilities };
