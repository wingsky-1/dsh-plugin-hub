/**
 * dsh-notifier — server/interface.ts：API 层唯一对外引用面。
 *
 * 目录外代码只能从这里引用：路由常量与纯组装（ROUTES/buildRoutes/
 * applyConfigPatch + RouteDeps/PatchResult）、SSE 枢纽业务包装
 * （createSseHub + SseHub 及相关观测类型）、系统通知通道
 * （createSystemNotifier + SystemNotifier）。系统通知/SSE 的注入面类型
 * （SseHub/SystemNotifier）供 channels 域仅 type 引用
 * （verify-dir-imports 静态强制）。
 */
export { ROUTES, applyConfigPatch, buildRoutes } from "./routes.ts";
export type { PatchResult, RouteDeps } from "./routes.ts";
export { createSseHub } from "./sse-bus.ts";
export type { SseConnHealth, SseEvictStats, SseHub, SseHubOptions } from "./sse-bus.ts";
export { createSystemNotifier } from "./system-notifier.ts";
export type { SystemNotifier } from "./system-notifier.ts";