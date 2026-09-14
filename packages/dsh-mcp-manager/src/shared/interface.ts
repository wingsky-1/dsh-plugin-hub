/**
 * dsh-mcp-manager — shared/interface.ts：跨端共享域门面（D5，#767 B1）。
 *
 * shared 域 = 浮窗定位/层级/断点纯函数薄 facade（placement-math），宿主端（src/index.ts
 * re-export 供 smoke 断言）与客户端（src/client/*）都从这里引用，两端共用同一份实现。
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
