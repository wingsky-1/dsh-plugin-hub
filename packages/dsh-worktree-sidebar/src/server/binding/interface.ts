/**
 * binding 域对外契约：绑定表的**唯一事实源**。
 *
 * 本文件只做收口——`BindingApi` 与 `createBinding` 的物理定义在 `impl/service`，
 * 表的读写形状在 `impl/model`，落盘在 `impl/store`。
 */
export { createBinding } from "./impl/service/index.ts";
export type { BindingApi } from "./impl/service/index.ts";
