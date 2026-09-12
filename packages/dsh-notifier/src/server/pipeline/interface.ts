/**
 * dsh-notifier pipeline 域 —— **对外契约**。
 *
 * ## 职责边界
 *
 * **一条通知的生命周期，以及「该不该发」的唯一裁决点。** 通知请求进，投递出去、并
 * 把经历写进历史出。开关、免打扰、动态 kind 白名单、频道路由都在域内判完，调用方
 * 不需要知道这条链上有几道工序。
 *
 * 通知请求的形状与它那套种类词汇也归本域：它们是**裁决的坐标系**——事件开关、频道
 * 路由、动态 kind 白名单、bark 的按 kind 紧急度全按它查。宿主事件那边只是**适配层**：
 * 把「审批来了」「turn 结束了」翻译成本域的词汇，翻译完就不再有发言权。
 *
 * 唯一裁决点的意思是：**别处不许再判一次**。events 域产出「发生了什么」的陈述，
 * api 域与 sdk 域提交「请处理这一条」，三条路都汇到这里的 `submit`，由同一套判据
 * 回答。分散判断的代价不是多算一次——是两个答案不一致时，用户看到的是「设置改了不
 * 起作用」，而没人会想到去看第二个判断点。
 *
 * ## 为什么是「装配 + 具名释放 + 提交口」
 *
 * 管线是**有状态域**：装配入参要留着（裁决每次都得重新读设置），将来的合并窗口与
 * 审批二次提醒还要定时器。状态收在实现里，对外只给三个动作——外面拿不到句柄就造不出
 * 第二份管线，「唯一裁决点」这句话才有物理含义。
 *
 * 释放做成具名动作而不是 `install` 的返回值：返回一个闭包，等于把「谁负责清干净」
 * 交给调用方保管，而这本来就是这个域的责任。
 *
 * ## 提交口为什么没有返回值
 *
 * `submit` 不返回结果、也不抛错。它挂在宿主事件链上，调用方只负责把事实递进来；
 * 要不要发、发去哪、送没送到都是本域的事，结果写进历史与频道状态供查询。让调用方
 * 从返回值里读出「发了没」，等于把裁决结果又摊回调用方。
 *
 * ## 依赖方向
 *
 * 只引本域 `./impl/`（契约调实现）与 `./deps.ts`（依赖声明）。后者是本域的对外依赖
 * 清单，摆在契约旁边而不是藏进实现——装配方从契约就能读全「装这条管线要给它什么」。
 */
import type { PipelineDeps } from "./deps.ts";
import { notificationPipeline } from "./impl/service/index.ts";
import type { NotifyRequest } from "./impl/service/type.ts";

export type { NotifySeverity, OutgoingFrame } from "./deps.ts";
export type { BuiltinKind, ExternalKind, NotifyKind } from "./impl/service/kinds.ts";
export type { NotifyRequest } from "./impl/service/type.ts";

/**
 * 帧在宿主事件总线上的地址。
 *
 * 定义在 `deps.ts`（与帧出口同处），这里只是把它交出去：组合根要拿它 `emit` 与 `on`，
 * 而包入口那段声明合并也引用同一个常量。写死一个字面量同样能编译，代价是名字有两份，
 * 改名漏改一处的症状是「帧发出去没人收到」。
 */
export { NOTIFIER_FRAME } from "./deps.ts";

/**
 * 是不是内置通知种类。
 *
 * 值出口而不只是类型出口：这是「内置 / 外部注册」的唯一判据，而下游拿到的是运行时的
 * 字符串。让每个需要它的域各写一份内置名单，就等于把同一张表抄成几份，新增一种通知时
 * 漏抄一处，症状是那个域把新内置种类当成外部注册的——而外部种类要经用户确认才放行。
 */
export { isBuiltinKind } from "./impl/service/kinds.ts";

/**
 * 装配裁决管线（组合根在 `apply` 期调用一次）。
 */
export function installPipeline(deps: PipelineDeps): void {
  notificationPipeline.install(deps);
}

/**
 * 卸载裁决管线（组合根在卸载期调用）。
 *
 * 与 `installPipeline` 配对；重复调用无害——卸载后到达的请求会被丢弃。
 */
export function releasePipeline(): void {
  notificationPipeline.release();
}

/**
 * 提交一条通知请求。
 *
 * 入口有三条：宿主事件（经 events 域）、页面上的测试按钮（经 api 域）、对外 ABI
 * （经 sdk 域）。三条都走到这里，所以「该不该发」只有一个答案。
 */
export function submit(request: NotifyRequest): void {
  notificationPipeline.submit(request);
}
