/**
 * dsh-notifier sdk 域 —— **对外契约**。
 *
 * ## 职责边界
 *
 * 本插件对**其他插件**开放的编程面，以及动态通知种类的登记与确认。
 *
 * 它是**入站适配器**：把兄弟插件的调用翻译成裁决管线认识的请求，翻译完就不再有发言权。
 * 与 events 域同构——那边是「宿主事件 → 请求」，这边是「兄弟插件 → 请求」，两条都汇到
 * `pipeline.submit`，所以「该不该发」仍然只有一个答案。本域不认识 HTTP、不做裁决、
 * 不落盘、不渲染文案。
 *
 * ## 两个面，不是一份能力
 *
 * | 面 | 给谁 | 有什么 |
 * |---|---|---|
 * | 服务面（`ctx["wingsky.notifier"]`） | 兄弟插件 | 登记种类、发送通知 |
 * | 管理面（本文件的 `listKinds` / `confirmKind`） | 设置端点（经 `api/deps.ts` 注入） | 看清单、替用户确认 |
 *
 * 分开的理由是**授权**：确认回答的是「用户答不答应」，它只能由用户经设置页发起。把确认
 * 挂上服务面，任何插件都能替用户放行自己——设置页上那份确认清单随之变成摆设，而它本来
 * 是用户唯一能表达「别打扰我」的地方。
 *
 * ## 依赖方向
 *
 * 只引本域 `./impl/`（契约调实现）与 `./deps.ts`（依赖声明）；不引任何他域实现。
 */
import type { ConfigPort, SdkDeps } from "./deps.ts";
import type { RegisteredKind } from "./impl/registry/type.ts";
import { sdkService } from "./impl/service/index.ts";

// 只出两个名字，其余经签名可达即可：
// - `NotifierService`：服务面本身。消费方要写类型标注就得能命名它，而它同时是包入口
//   声明合并的载荷；
// - `RegisteredKind`：`listKinds()` 的返回元素，设置端点要按字段读它。
// `KindRegistration` / `NotifyRequest` 是服务面方法的入参——调用方按上下文类型写字面量
// 就够了，等真出现「要显式命名它」的调用点再请出来。
export type { RegisteredKind } from "./impl/registry/type.ts";
export type { NotifierService } from "./impl/service/type.ts";

// 服务名的值出口：组合根拿它去 `ctx.provide`，不自己写一遍字面量。
export { NOTIFIER_SERVICE } from "./impl/service/index.ts";

/**
 * 装配对外服务面（组合根在 `apply` 期调用一次）。
 */
export function installSdk(deps: SdkDeps): void {
  sdkService.install(deps);
}

/**
 * 卸载对外服务面（组合根在卸载期调用）。
 *
 * 与 `installSdk` 配对：把服务从宿主上下文上收回来。此后消费方 `ctx.get` 拿到空，
 * 它们本就该按「通知中心不在」降级。
 */
export function releaseSdk(): void {
  sdkService.release();
}

/**
 * 动态种类清单：登记项 × 确认态（设置页渲染「允许 / 拒绝」用）。
 */
export function listKinds(): RegisteredKind[] {
  return sdkService.listKinds();
}

/**
 * 确认 / 撤销一个动态种类（设置端点调用）。
 *
 * 返回值是设置写面的结果而不是布尔：失败分「版本冲突」与「服务不可用」两类，端点要据此
 * 回 409 与 503——压成一个布尔，用户看到的就只剩「操作失败」，而两种原因要做的事不同。
 */
export function confirmKind(id: string, confirmed: boolean): Promise<Awaited<ReturnType<ConfigPort["writeConfig"]>>> {
  return sdkService.confirmKind(id, confirmed);
}
