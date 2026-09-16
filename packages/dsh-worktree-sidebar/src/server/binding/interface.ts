/**
 * binding 域对外契约：绑定表的**唯一事实源**。
 *
 * 本文件只做收口——`BindingApi` 与单例的物理定义在 `impl/service`，表的读写形状在 `impl/model`，
 * 落盘在 `impl/store`。单例本身不出这道门：它一旦被转出就成了本域的第二张公开契约，
 * 调用方还能持有它、绕过释放。
 */
import type { BindingRecord } from "./impl/model/type.ts";
import type { FileWrite } from "../shared/interface.ts";
import type { BindingDeps } from "./deps.ts";
import { bindingService } from "./impl/service/index.ts";

export { BINDINGS_VERSION } from "./impl/model/type.ts";
export type { BindingRecord } from "./impl/model/type.ts";

/** 装配 binding 域（组合根在 `apply` 期调用一次）。重复装配是编程错误，当场抛错。 */
export function installBinding(deps: BindingDeps): void {
  bindingService.install(deps);
}

/** 卸载 binding 域，与 `installBinding` 配对：等在飞的写盘落定后丢掉内存快照。此后能力面当场失败。 */
export function releaseBinding(): Promise<void> {
  return bindingService.release();
}

/** 当前表版本。与 api 域路由读的是同一快照，故它也是客户端能观察到的版本。 */
export function revision(): number {
  return bindingService.revision();
}

/** 按会话取绑定。 */
export function get(sessionId: string): BindingRecord | undefined {
  return bindingService.get(sessionId);
}

/** 落一条绑定并持久化。 */
export function put(sessionId: string, record: BindingRecord): Promise<FileWrite> {
  return bindingService.put(sessionId, record);
}

/** 摘一条绑定并持久化（幂等：本来就没有不算失败）。 */
export function drop(sessionId: string): Promise<FileWrite> {
  return bindingService.drop(sessionId);
}
