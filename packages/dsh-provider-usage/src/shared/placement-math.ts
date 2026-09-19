/**
 * dsh-provider-usage — 胶囊定位/层级/断点纯函数。
 *
 * 本文件自持实现（shared-leaf 叶子约束）：src/shared/ 是客户端经 interface.ts
 * 直接消费的共享面，esbuild 会把该目录的转出目标内联进浏览器产物，故不得出现
 * 跨目录相对引用。本实现与 dsh-mcp-manager 包内 src/shared/placement-math.ts
 * 同构（两包自持，仓库根 shared/placement-math.js 已退役），两处必须保持逐行
 * 同构——改任一处须同步另一处（判据不覆盖跨文件一致性，靠评审保证）。
 *
 * 本文件保留包级常量 DEFAULT_Z_INDEX_BASE（对应 CSS 默认 z-index:40）与
 * panelZIndexFor 的包级默认注入（胶囊与主面板取配置值，不再派生 +30）。
 * 宿主端与客户端路径不变，公开导出面零变化。
 */

/** 默认层级基准（provider-usage 包：对应 CSS 默认 z-index:40，升级前行为不回归）。 */
export const DEFAULT_Z_INDEX_BASE = 40;

/** 层级基准值域下界。 */
export const Z_INDEX_BASE_MIN = 1;
/** 层级基准值域上界（避开宿主 shell 的模态/遮罩层）。 */
export const Z_INDEX_BASE_MAX = 9000;
/** 面板内子浮层（设置卡片等次级层）的层级派生量。 */
export const Z_INDEX_PANEL_DELTA = 30;

/**
 * 层级基准 clamp 纯函数：非有限数回退默认；有限数四舍五入后压进
 * [Z_INDEX_BASE_MIN, Z_INDEX_BASE_MAX]。
 */
export function clampZIndexBase(value: unknown, dflt: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return dflt;
  return Math.min(Z_INDEX_BASE_MAX, Math.max(Z_INDEX_BASE_MIN, Math.round(value)));
}

/**
 * 面板内子浮层层级派生纯函数。包级默认注入 DEFAULT_Z_INDEX_BASE，
 * 对外签名保持 (base) 不变。
 */
export function panelZIndexFor(base: number): number {
  return clampZIndexBase(base, DEFAULT_Z_INDEX_BASE) + Z_INDEX_PANEL_DELTA;
}

/**
 * 面板垂直锚点规则：底部锚点（bottom-*）→ 向上弹出；否则顶部锚点（向下弹出）。
 */
export function panelAnchorForPlacement(placement: string | undefined): "top" | "bottom" {
  return placement === "bottom-right" || placement === "bottom-left" ? "bottom" : "top";
}

/** 窄屏档上界（手机竖屏 / 极窄分栏）。 */
export const BREAKPOINT_NARROW_MAX = 480;
/** 平板档上界（平板竖屏 / 手机横屏；超过即桌面档）。 */
export const BREAKPOINT_TABLET_MAX = 834;

export type FloatBreakpoint = "narrow" | "tablet" | "wide";

/** 断点判定纯函数：按会话容器宽度返回档位。 */
export function breakpointForWidth(width: number): FloatBreakpoint {
  const w = Number.isFinite(width) ? width : Number.POSITIVE_INFINITY;
  if (w <= BREAKPOINT_NARROW_MAX) return "narrow";
  if (w <= BREAKPOINT_TABLET_MAX) return "tablet";
  return "wide";
}

/** 视口坐标点（fixed 元素最终 left/top）。 */
export interface ViewportPoint {
  x: number;
  y: number;
}

/** 终坐标视口 clamp 纯函数：对算好的 fixed 坐标做钳制，保证元素完整落在视口内。 */
export function clampPointToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportW: number,
  viewportH: number,
  safeInset = 0,
): ViewportPoint {
  const ins = Number.isFinite(safeInset) ? Math.max(0, safeInset) : 0;
  const hiX = Math.max(ins, viewportW - width - ins);
  const hiY = Math.max(ins, viewportH - height - ins);
  return {
    x: Math.min(Math.max(x, ins), hiX),
    y: Math.min(Math.max(y, ins), hiY),
  };
}

/** 参与贴底判定的矩形最小结构（DOMRect 子集：仅需 top/bottom）。 */
export interface RectLike {
  top: number;
  bottom: number;
}

/** composer seat 贴底判定纯函数（容差 0.5px）。 */
export function composerDockedAtBottom(
  seatRect: RectLike | null | undefined,
  containerRect: RectLike | null | undefined,
): boolean {
  if (seatRect == null || containerRect == null) return false;
  return Math.abs(seatRect.bottom - containerRect.bottom) <= 0.5;
}

/** bottom-* 锚点下边界纯函数：贴底返回 seat 上缘，否则容器底。 */
export function bottomAnchorEdge(
  containerBottom: number,
  seatTop: number | null | undefined,
  docked: boolean,
): number {
  if (docked && typeof seatTop === "number" && Number.isFinite(seatTop)) return seatTop;
  return containerBottom;
}

/** 面板垂直定位纯函数（clamp 到视口内，不溢出）。 */
export function panelTopForAnchor(
  anchor: "top" | "bottom",
  pillTop: number,
  pillBottom: number,
  panelHeight: number,
  gap: number,
): number {
  return anchor === "bottom"
    ? Math.max(6, pillTop - panelHeight - gap)
    : Math.max(6, pillBottom + gap);
}
