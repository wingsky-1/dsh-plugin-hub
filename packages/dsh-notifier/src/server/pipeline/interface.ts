/** pipeline 域对外契约：一条通知的生命周期，以及「该不该发」的**唯一裁决点**——开关、免打扰、动态 kind 白名单、
 * 频道路由都在域内判完。别处不许再判一次：分散判断的代价是两个答案不一致时用户看到「设置改了不起作用」。 */
import type { PipelineDeps } from "./deps.ts";
import { notificationPipeline } from "./impl/service/index.ts";
import type { NotifyRequest } from "./impl/service/type.ts";

export type { NotifySeverity, OutgoingFrame } from "./deps.ts";
export type { BuiltinKind, ExternalKind, NotifyKind } from "./impl/service/kinds.ts";
export type { NotifyRequest } from "./impl/service/type.ts";

/** 是不是内置通知种类。值出口而不只是类型出口：这是「内置 / 外部注册」的唯一判据——各域各写一份内置名单，新增
 * 一种通知时漏抄一处，那个域就会把新内置种类当成外部注册的，而外部种类要经用户确认才放行。 */
export { isBuiltinKind } from "./impl/service/kinds.ts";

/** 装配裁决管线（组合根在 `apply` 期调用一次）。 */
export function installPipeline(deps: PipelineDeps): void {
  notificationPipeline.install(deps);
}

/** 卸载裁决管线，与 `installPipeline` 配对；重复调用无害——卸载后到达的请求会被丢弃。 */
export function releasePipeline(): void {
  notificationPipeline.release();
}

/**
 * 提交一条通知请求。入口有三条（宿主事件经 events 域、页面测试按钮经 api 域、对外 ABI 经 sdk
 * 域），三条都走到这里，所以「该不该发」只有一个答案。**不返回结果、也不抛错**：要不要发、发去哪、
 * 送没送到都是本域的事，结果写进历史与频道状态供查询。
 */
export function submit(request: NotifyRequest): void {
  notificationPipeline.submit(request);
}
