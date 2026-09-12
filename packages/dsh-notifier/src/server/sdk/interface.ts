/**
 * sdk 域对外契约：对**其他插件**开放的编程面，以及动态通知种类的登记与确认（入站适配器，翻译成管线请求后不再发言）。
 * 管理面与服务面分开的理由是**授权**——确认只能由用户经设置页发起，否则任何插件都能替用户放行自己。
 */
import type { ConfigPort, SdkDeps } from "./deps.ts";
import type { RegisteredKind } from "./impl/registry/type.ts";
import { sdkService } from "./impl/service/index.ts";

// 只出两个名字，其余经签名可达即可：`NotifierService`（消费方要写标注、同时是包入口声明合并的载荷）
// 与 `RegisteredKind`（设置端点要按字段读它）。
export type { RegisteredKind } from "./impl/registry/type.ts";
export type { NotifierService } from "./impl/service/type.ts";

// 服务名的值出口：组合根拿它去 `ctx.provide`，不自己写一遍字面量。
export { NOTIFIER_SERVICE } from "./impl/service/index.ts";

/** 装配对外服务面（组合根在 `apply` 期调用一次）。 */
export function installSdk(deps: SdkDeps): void {
  sdkService.install(deps);
}

/** 卸载对外服务面，与 `installSdk` 配对：把服务从宿主上下文上收回来——此后消费方 `ctx.get` 拿到空，
 * 它们本就该按「通知中心不在」降级。 */
export function releaseSdk(): void {
  sdkService.release();
}

/** 动态种类清单：登记项 × 确认态（设置页渲染「允许 / 拒绝」用）。 */
export function listKinds(): RegisteredKind[] {
  return sdkService.listKinds();
}

/** 确认 / 撤销一个动态种类（设置端点调用）。返回设置写面的结果而不是布尔：失败分「版本冲突」与「服务不可用」
 * 两类，端点据此回 409 与 503——压成一个布尔，用户看到的就只剩「操作失败」。 */
export function confirmKind(
  id: string,
  confirmed: boolean,
): Promise<Awaited<ReturnType<ConfigPort["writeConfig"]>>> {
  return sdkService.confirmKind(id, confirmed);
}
