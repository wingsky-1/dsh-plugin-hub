/**
 * 双端共享契约的收口面——宿主与浏览器都必须一致的定义从这里取。
 *
 * 三个同名 `shared` 不同层，别互相搬：`src/shared/` 是**双端**共享；
 * `src/server/shared/` 是宿主内部叶子；`src/client/shared/` 是客户端块间类型面。
 */
export { ROUTES } from "./contract.ts";
export type { BindingResponse } from "./contract.ts";
