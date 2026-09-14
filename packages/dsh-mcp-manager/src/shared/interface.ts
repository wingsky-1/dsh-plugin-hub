/**
 * dsh-mcp-manager — shared/interface.ts：跨端层门面（D5，#767 B1）。
 *
 * shared 域是两端唯一的跨端语言落点：浮窗定位/层级/断点纯函数（placement-math）、
 * 六态键与计数投影（status）、SSE 帧名与负载形状（frames）、路由路径与围栏（routes）。
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
} from "./placement-math.ts";
// 这一个符号不随上面 12 个走同一条链：placement-math.ts 已把它作为**别名**转出，
// 而门禁的 collectExports 对 `export { A as B } from` 只登记源名 A，再经一层同名
// 转出会解析到空（interface.ts 虚导出，规则 4 硬判红）。故别名直连仓库根单源。
export { panelAnchorForPlacement as panelAnchorForPosition } from "../../../../shared/placement-math.js";
export type { FloatBreakpoint, ViewportPoint, RectLike } from "./placement-math.ts";

export { SERVER_STATES, EMPTY_STATUS_COUNTS } from "./status.ts";
export type { ServerState } from "./status.ts";
export { SSE_FRAMES } from "./frames.ts";
export type { SseFrame, SseFramePayload } from "./frames.ts";
export { ROUTES, ROUTE_FENCE } from "./routes.ts";
export type { RouteName, RouteFence } from "./routes.ts";
