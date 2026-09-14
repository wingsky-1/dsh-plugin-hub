/**
 * api 域对外契约：**浏览器出口**。把宿主端的事实经 HTTP 送到页面。
 *
 * 本文件只做收口——`ApiInstance` 与 `createApi` 的物理定义在 `impl/service`，
 * 围栏与端点注册在 `impl/route`，端点形状在 `impl/handlers`。
 */
export { createApi } from "./impl/service/index.ts";
export type { ApiInstance } from "./impl/service/index.ts";
