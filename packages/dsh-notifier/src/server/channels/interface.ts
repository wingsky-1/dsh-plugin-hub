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

/**
 * 草稿测试（dry-run）的单目标出站：api 域经它把内存里的目标打出去，全程 bypass 正常管线的
 * 写面（不 settle、不归档、不 emit 帧，browser 的 emit 由它在内部接空）。bark / webhook 走
 * SSRF 安全 fetch，system 复用平台能力缓存只读。这是 api 域唯一被允许的「伪造投递」入口——
 * 只接受已构造好的单个目标与固定的测试文案，不接受任意通知请求（见实现模块头的 bypass 清单）。
 *
 * 结果理由契约：返回的 failed / skipped 理由已按 FAILURE_REASON_MAX 截断并经 normalizeReason
 * 收编（与状态落盘面同一条上限）——调用方（api 域写响应处）只做形状收窄，不再截第二遍，
 * 跨模块值边因此不增加（目录门面只认 interface.ts，见 verify-dir-imports）。
 */
export { dryRunTarget } from "./impl/dry-run/index.ts";

/**
 * 释放音频临时目录（自播合成音的落盘处）：组合根在卸载时调一次，端口侧在进程退出时也挂一次。
 * 幂等、never-throw——它是本域唯一会把**目录**删掉的入口（按次删目录会让并发投递互踩，
 * 故日常只 unlink 本次文件，目录留到这里）。
 */
export { releaseSoundTemps } from "./impl/system/tone-file.ts";
