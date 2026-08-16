import type { IncomingMessage } from "node:http";

/**
 * Loopback 围栏：请求必须来自回环地址 + 回环 Host + 非跨站，否则拒绝。
 * 全部 /api 路由（含写路由）强制调用（DNS 重绑定 + 跨站防御）。
 */
export declare function isLoopbackRequest(request: IncomingMessage): boolean;
