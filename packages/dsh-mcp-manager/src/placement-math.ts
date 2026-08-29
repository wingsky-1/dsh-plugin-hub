/**
 * dsh-mcp-manager — 浮窗定位/层级/断点纯函数（#128 移动端适配）。
 *
 * 单一事实源：宿主端（src/index.ts）re-export 供 smoke 断言；客户端（src/client/*）
 * 直接 import 同一份实现打进 browser bundle。本文件必须保持零依赖（禁止 import
 * 任何 node:* 模块），否则会污染 client 产物。
 *
 * 跨包约定（与 dsh-provider-usage 同构）：断点档位阈值、zIndex 值域与派生量、
 * safe-area 视口 clamp 语义见 docs/DEVELOPMENT.md「浮窗移动端适配约定」。
 */

// ---- z-index 层级基准 ------------------------------------------------------

/** 层级基准值域下界。 */
export const Z_INDEX_BASE_MIN = 1;
/** 层级基准值域上界（避开宿主 shell 的模态/遮罩层）。 */
export const Z_INDEX_BASE_MAX = 9000;
/**
 * 面板内子浮层（设置卡片等次级层）的层级派生量（#128 重开：主面板与胶囊同取
 * 配置值，派生 +30 仅保留给面板内子浮层作为扩展点，不占用 zIndexBase 预算）。
 */
export const Z_INDEX_PANEL_DELTA = 30;

/** 默认层级基准（mcp-manager 包：对应 CSS 默认 z-index:10，升级前行为不回归）。 */
export const DEFAULT_Z_INDEX_BASE = 10;

/**
 * 层级基准 clamp 纯函数（供 smoke 断言边界）：非有限数回退默认；
 * 有限数四舍五入后压进 [Z_INDEX_BASE_MIN, Z_INDEX_BASE_MAX]。
 */
export function clampZIndexBase(value: unknown, dflt: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return dflt;
  return Math.min(Z_INDEX_BASE_MAX, Math.max(Z_INDEX_BASE_MIN, Math.round(value)));
}

/**
 * 面板内子浮层层级派生纯函数（#128 重开：主面板与胶囊 computed z-index 一律取
 * 配置 zIndexBase，不再派生 +30——维护者 2026-08-28 要求）；本函数仅作为面板内
 * 次级层（设置卡片等）的派生扩展点，不占用 zIndexBase 预算。
 */
export function panelZIndexFor(base: number): number {
  return clampZIndexBase(base, DEFAULT_Z_INDEX_BASE) + Z_INDEX_PANEL_DELTA;
}

/** 面板垂直锚点规则：底部锚点（bottom-*）→ 向上弹出；否则顶部锚点（向下弹出）。 */
export function panelAnchorForPosition(position: string | undefined): "top" | "bottom" {
  return position === "bottom-right" || position === "bottom-left" ? "bottom" : "top";
}

// ---- 断点档位（#128）-------------------------------------------------------

// 判定基准 = conversationHost rect 宽度（JS 判定 + data 属性切换样式），非纯
// @media——防桌面窄窗 / iPad Slide Over 误触发（规格 #128 第 3 条）。

/** 窄屏档上界（手机竖屏 / 极窄分栏）。 */
export const BREAKPOINT_NARROW_MAX = 480;
/** 平板档上界（平板竖屏 / 手机横屏；超过即桌面档）。 */
export const BREAKPOINT_TABLET_MAX = 834;

export type FloatBreakpoint = "narrow" | "tablet" | "wide";

/** 断点判定纯函数（供 smoke 断言分支翻转）：按会话容器宽度返回档位。 */
export function breakpointForWidth(width: number): FloatBreakpoint {
  const w = Number.isFinite(width) ? width : Number.POSITIVE_INFINITY;
  if (w <= BREAKPOINT_NARROW_MAX) return "narrow";
  if (w <= BREAKPOINT_TABLET_MAX) return "tablet";
  return "wide";
}

// ---- 终坐标视口 clamp（safe-area 语义，规格 #128 第 1 条）-------------------

/** 视口坐标点（fixed 元素最终 left/top）。 */
export interface ViewportPoint { x: number; y: number; }

/**
 * 终坐标视口 clamp 纯函数（供 smoke 断言）：对算好的 fixed 坐标做钳制，保证元素
 * 完整落在 [safeInset, viewport - size - safeInset] 内。宿主 viewport meta 无
 * viewport-fit=cover → env(safe-area-inset-*) 恒 0 → safeInset 缺省 0 时本函数
 * 自然退化为普通视口 clamp（现状行为不回归）；未来宿主若开启 cover 可传实测 inset。
 */
export function clampPointToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportW: number,
  viewportH: number,
  safeInset: number = 0,
): ViewportPoint {
  const ins = Number.isFinite(safeInset) ? Math.max(0, safeInset) : 0;
  const hiX = Math.max(ins, viewportW - width - ins);
  const hiY = Math.max(ins, viewportH - height - ins);
  return {
    x: Math.min(Math.max(x, ins), hiX),
    y: Math.min(Math.max(y, ins), hiY),
  };
}

// ---- bottom-* 锚点移动端修正（#128 重开回归）--------------------------------

/** 参与贴底判定的矩形最小结构（DOMRect 子集：仅需 top/bottom）。 */
export interface RectLike { top: number; bottom: number; }

/**
 * composer seat 贴底判定纯函数（供 smoke 断言）：seat 非空且 seat.bottom 与
 * container.bottom 在容差内（seat 贴住容器底缘=视口底缘）即为贴底。容差 0.5px：
 * 恰好贴底（差 0）→ true；距底缘 1px → false（D4 断言语义）。
 */
export function composerDockedAtBottom(
  seatRect: RectLike | null | undefined,
  containerRect: RectLike | null | undefined,
): boolean {
  if (seatRect == null || containerRect == null) return false;
  return Math.abs(seatRect.bottom - containerRect.bottom) <= 0.5;
}

/**
 * bottom-* 锚点下边界纯函数（供 smoke 断言）：贴底时返回 seat 上缘（胶囊上移到
 * 输入区上方，避免遮挡）；否则返回容器底（桌面 / 未贴底零回归）；seatTop 缺失
 * 或非有限数时回落容器底（不产生 NaN 坐标）。
 */
export function bottomAnchorEdge(
  containerBottom: number,
  seatTop: number | null | undefined,
  docked: boolean,
): number {
  if (docked && typeof seatTop === "number" && Number.isFinite(seatTop)) return seatTop;
  return containerBottom;
}
