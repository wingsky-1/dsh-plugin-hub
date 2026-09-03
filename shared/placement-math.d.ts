// dsh 插件家族共享层 — 浮窗/胶囊定位、层级、断点纯函数类型面（issue #128 → #378）。
// 与 shared/placement-math.js 双写；各包 src/placement-math.ts 薄 facade re-export。

/** 层级基准值域下界。 */
export declare const Z_INDEX_BASE_MIN: number;
/** 层级基准值域上界（避开宿主 shell 的模态/遮罩层）。 */
export declare const Z_INDEX_BASE_MAX: number;
/** 面板内子浮层（设置卡片等次级层）的层级派生量。 */
export declare const Z_INDEX_PANEL_DELTA: number;

/**
 * 层级基准 clamp 纯函数：非有限数回退默认；有限数四舍五入后压进
 * [Z_INDEX_BASE_MIN, Z_INDEX_BASE_MAX]。
 */
export declare function clampZIndexBase(value: unknown, dflt: number): number;

/**
 * 面板内子浮层层级派生纯函数（base + Z_INDEX_PANEL_DELTA，不占用 zIndexBase 预算）。
 * 参数化 dflt：包级默认不同（mcp=10 / provider-usage=40），由各包薄 facade 包装注入。
 */
export declare function panelZIndexFor(base: number, dflt: number): number;

/**
 * 面板垂直锚点规则：底部锚点（bottom-*）→ 向上弹出；否则顶部锚点（向下弹出）。
 * 统一实现；两包分别以 panelAnchorForPosition / panelAnchorForPlacement 薄 re-export。
 */
export declare function panelAnchorForPlacement(placement: string | undefined): "top" | "bottom";

/** 窄屏档上界（手机竖屏 / 极窄分栏）。 */
export declare const BREAKPOINT_NARROW_MAX: number;
/** 平板档上界（平板竖屏 / 手机横屏；超过即桌面档）。 */
export declare const BREAKPOINT_TABLET_MAX: number;

export type FloatBreakpoint = "narrow" | "tablet" | "wide";

/** 断点判定纯函数：按会话容器宽度返回档位。 */
export declare function breakpointForWidth(width: number): FloatBreakpoint;

/** 视口坐标点（fixed 元素最终 left/top）。 */
export interface ViewportPoint {
  x: number;
  y: number;
}

/**
 * 终坐标视口 clamp 纯函数：对算好的 fixed 坐标做钳制，保证元素完整落在
 * [safeInset, viewport - size - safeInset] 内。
 */
export declare function clampPointToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportW: number,
  viewportH: number,
  safeInset?: number,
): ViewportPoint;

/** 参与贴底判定的矩形最小结构（DOMRect 子集：仅需 top/bottom）。 */
export interface RectLike {
  top: number;
  bottom: number;
}

/** composer seat 贴底判定纯函数（容差 0.5px：差 0 → true；距底 1px → false）。 */
export declare function composerDockedAtBottom(
  seatRect: RectLike | null | undefined,
  containerRect: RectLike | null | undefined,
): boolean;

/** bottom-* 锚点下边界纯函数：贴底返回 seat 上缘，否则容器底；seatTop 缺失回落容器底。 */
export declare function bottomAnchorEdge(
  containerBottom: number,
  seatTop: number | null | undefined,
  docked: boolean,
): number;

/** 面板垂直定位纯函数（clamp 到视口内，不溢出）。 */
export declare function panelTopForAnchor(
  anchor: "top" | "bottom",
  pillTop: number,
  pillBottom: number,
  panelHeight: number,
  gap: number,
): number;
