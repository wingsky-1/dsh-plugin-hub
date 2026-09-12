/**
 * dsh-notifier — server/interface.ts：API 层唯一对外引用面。
 *
 * 目录外代码只能从这里引用：路由常量与纯组装（ROUTES/buildRoutes/
 * applyConfigPatch + RouteDeps/PatchResult）、SSE 枢纽业务包装
 * （createSseHub + SseHub 及相关观测类型）、系统通知通道
 * （createSystemNotifier + SystemNotifier）。SseHub/SystemNotifier 的消费点
 * 是装配层（index.ts 的 play 闭包与路由注入面）——channels 域的内置频道实例
 * 只承载 id + capabilities，故对 server 域零依赖（#733 M1-F3 消除倒置边）。
 */
export { ROUTES, applyConfigPatch, buildRoutes } from "./routes.ts";
export type { PatchResult, RouteDeps } from "./routes.ts";
export { createSseHub } from "./sse-bus.ts";
export type { SseConnHealth, SseEvictStats, SseHub, SseHubOptions } from "./sse-bus.ts";
export { createSystemNotifier } from "./system-notifier.ts";
export type { SystemNotifier } from "./system-notifier.ts";