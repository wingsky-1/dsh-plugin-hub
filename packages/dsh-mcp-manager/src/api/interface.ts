/**
 * dsh-mcp-manager — api/interface.ts：API 层门面（D10，#664 阶段 6）。
 *
 * API 层 = 路由装配（routes）+ 端点控制器（routes-controllers）+ 查询辅助
 * （routes-helpers）。目录外模块**只能**从这里引用（verify-dir-imports
 * 静态强制）。
 */
export {
  ROUTES,
  queryParam,
  makeRoutes,
  makeEventsRoute,
  makeHealthRoute,
  uiConfigChangedFrame,
  broadcastFrame,
  SSE_HEARTBEAT_MS,
  SSE_PING_FRAME,
} from "./routes.ts";
