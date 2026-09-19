/**
 * dsh-mcp-manager — shared/interface.ts：跨端层门面（D5，#767 B1）。
 *
 * shared 域是两端唯一的跨端语言落点：浮窗定位/层级/断点纯函数（placement-math）、
 * 六态键与计数投影（status）、SSE 帧名与负载形状（frames）、路由路径与围栏（routes）、
 * scope 与全局虚拟 root 契约常量（constants）、跨端 DTO 形状（dto）与服务类型（service）。
 * 宿主端与客户端都从这里引用同一份物理定义——凡「两端必须一致」的规范常量不得在别处
 * 再写一遍（一致性锁 test/e2e/cross-end-lock.test.ts 判红）。
 * 目录外模块**只能**从这里引用（verify-dir-imports 静态强制）。
 */
export {
  DEFAULT_Z_INDEX_BASE,
  Z_INDEX_BASE_MIN,
  Z_INDEX_BASE_MAX,
  Z_INDEX_PANEL_DELTA,
  BREAKPOINT_NARROW_MAX,
  BREAKPOINT_TABLET_MAX,
  clampZIndexBase,
  breakpointForWidth,
  clampPointToViewport,
  composerDockedAtBottom,
  bottomAnchorEdge,
  panelZIndexFor,
  panelTopForAnchor,
} from "./placement-math.ts";
// 包级命名直接由 placement-math.ts 定义并转出（自持实现，无跨目录引用）。
export { panelAnchorForPosition } from "./placement-math.ts";
export type { FloatBreakpoint, ViewportPoint, RectLike } from "./placement-math.ts";

export { SERVER_STATES, EMPTY_STATUS_COUNTS } from "./status.ts";
export type { ServerState } from "./status.ts";
export { SSE_FRAMES } from "./frames.ts";
export type { SseFrame, SseFramePayload } from "./frames.ts";
export { ROUTES, ROUTE_FENCE } from "./routes.ts";
export type { RouteName, RouteFence } from "./routes.ts";
// 跨端契约常量：客户端以字面量重复实现了 scope 与全局 root 前缀，物理定义收到这里后
// 它是唯一落点（客户端改引属 #769，本轮只收宿主侧）。
export { MIDDLEWARE_GLOBAL_ROOT, SCOPE_GLOBAL, SCOPE_PROJECT } from "./constants.ts";

// 跨端 DTO 与服务类型（物理定义在 dto.ts / service.ts，两端一律经本门面引用）。
export type { McpServerSummary, McpServerListEntry, ClientUiConfig } from "./dto.ts";
export type {
  McpManagerServerInput,
  McpManagerService,
  McpScope,
  McpServerStatus,
  McpToolInfo,
} from "./service.ts";
