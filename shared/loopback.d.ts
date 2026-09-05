import type { IncomingMessage } from "node:http";

/**
 * Loopback 围栏判定参数。
 * - allowCrossSiteNoCors（#549）：仅 serve 类资源伺服路由使用——放行「显式
 *   sec-fetch-mode: no-cors」的跨站子资源请求（sandbox iframe opaque origin
 *   的相对路径 css/js/img 加载）；cors fetch/XHR 与 navigate 仍拒绝。
 *   普通 /api 路由必须保持默认（不传 options）拒绝一切 cross-site。
 */
export interface LoopbackOptions {
  allowCrossSiteNoCors?: boolean;
}

/**
 * Loopback 围栏：请求必须来自回环地址 + 回环 Host，且满足跨站/来源约束，
 * 否则拒绝（DNS 重绑定 + 跨站防御）。
 */
export declare function isLoopbackRequest(request: IncomingMessage, options?: LoopbackOptions): boolean;
