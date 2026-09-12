/** api 域路由块自己的形状。 */
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";

/** 端点处理函数：自己写完整个响应（SSE 端点会一直持有它）。 */
export type RouteHandler = WebRoute["handler"];

/** 支持的 HTTP 方法：本域的端点只用这四个。 */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** 一组端点：同一路径下的若干方法。按路径分组而不是逐条注册，是因为宿主路由表以 pathname 为键、同一路径注册两次会抛；
 * 方法分派因此是壳的职责，405 也才有唯一的产出点。 */
export interface Endpoint {
  /** 绝对路径（无尾斜杠）。 */
  path: string;
  methods: Partial<Record<HttpMethod, RouteHandler>>;
}
