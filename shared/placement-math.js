// dsh 插件家族共享层 — 浮窗/胶囊定位、层级、断点纯函数（issue #128 → #378 抽取）。
//
// 历史：dsh-mcp-manager 与 dsh-provider-usage 各持一份逐行同构的 src/placement-math.ts
// （仅 DEFAULT_Z_INDEX_BASE 10 vs 40、panelAnchorForPosition/Placement 命名、头注释
// 不同），统一由本模块提供纯核心；两包 src/placement-math.ts 保留为薄 facade
// （包级常量 DEFAULT_Z_INDEX_BASE、命名别名、panelZIndexFor 包装注入、re-export），
// 对外导出面零变化。
//
// 本模块为「纯 / 稳定 / 无包级常量依赖」逻辑，零依赖（禁止 import 任何 node:* 模块，
// 否则会污染 client 产物）。跨包约定：断点档位阈值、zIndex 值域与派生量、safe-area
// 视口 clamp 语义见 docs/DEVELOPMENT.md「浮窗移动端适配约定」。

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

/**
 * 层级基准 clamp 纯函数（供 smoke 断言边界）：非有限数回退默认；
 * 有限数四舍五入后压进 [Z_INDEX_BASE_MIN, Z_INDEX_BASE_MAX]。
 * @param {unknown} value - 原始配置值。
 * @param {number} dflt - 回退默认（调用方传包级 DEFAULT_Z_INDEX_BASE）。
 * @returns {number} clamp 后的层级基准。
 */
export function clampZIndexBase(value, dflt) {
  if (typeof value !== "number" || !Number.isFinite(value)) return dflt;
  return Math.min(Z_INDEX_BASE_MAX, Math.max(Z_INDEX_BASE_MIN, Math.round(value)));
}

/**
 * 面板内子浮层层级派生纯函数（#128 重开：主面板与胶囊 computed z-index 一律取
 * 配置 zIndexBase，不再派生 +30——维护者 2026-08-28 要求）；本函数仅作为面板内
 * 次级层（设置卡片等）的派生扩展点，不占用 zIndexBase 预算。
 * 参数化 dflt：包级默认不同（mcp=10 / provider-usage=40），由各包薄 facade
 * 包装注入，本模块不持有包级常量。
 * @param {number} base - 主面板/胶囊层级基准。
 * @param {number} dflt - 非法 base 回退默认（包级 DEFAULT_Z_INDEX_BASE）。
 * @returns {number} 面板内子浮层层级。
 */
export function panelZIndexFor(base, dflt) {
  return clampZIndexBase(base, dflt) + Z_INDEX_PANEL_DELTA;
}

// ---- 面板锚点判定 ----------------------------------------------------------

/**
 * 面板垂直锚点规则：底部锚点（bottom-*）→ 向上弹出；否则顶部锚点（向下弹出）。
 * 统一实现；两包分别以 panelAnchorForPosition（mcp-manager）/ panelAnchorForPlacement
 * （provider-usage）薄 re-export，公开命名不变。
 * @param {string|undefined} placement - 锚点值（bottom-right / bottom-left 判底）。
 * @returns {"top"|"bottom"} 垂直锚点方向。
 */
export function panelAnchorForPlacement(placement) {
  return placement === "bottom-right" || placement === "bottom-left" ? "bottom" : "top";
}

// ---- 断点档位（#128）-------------------------------------------------------

// 判定基准 = conversationHost rect 宽度（JS 判定 + data 属性切换样式），非纯
// @media——防桌面窄窗 / iPad Slide Over 误触发（规格 #128 第 3 条）。

/** 窄屏档上界（手机竖屏 / 极窄分栏）。 */
export const BREAKPOINT_NARROW_MAX = 480;
/** 平板档上界（平板竖屏 / 手机横屏；超过即桌面档）。 */
export const BREAKPOINT_TABLET_MAX = 834;

/** 断点判定纯函数（供 smoke 断言分支翻转）：按会话容器宽度返回档位。 */
export function breakpointForWidth(width) {
  const w = Number.isFinite(width) ? width : Number.POSITIVE_INFINITY;
  if (w <= BREAKPOINT_NARROW_MAX) return "narrow";
  if (w <= BREAKPOINT_TABLET_MAX) return "tablet";
  return "wide";
}

// ---- 终坐标视口 clamp（safe-area 语义，规格 #128 第 1 条）-------------------

/**
 * 终坐标视口 clamp 纯函数（供 smoke 断言）：对算好的 fixed 坐标做钳制，保证元素
 * 完整落在 [safeInset, viewport - size - safeInset] 内。宿主 viewport meta 无
 * viewport-fit=cover → env(safe-area-inset-*) 恒 0 → safeInset 缺省 0 时本函数
 * 自然退化为普通视口 clamp（现状行为不回归）；未来宿主若开启 cover 可传实测 inset。
 * @param {number} x - 计算后 left。
 * @param {number} y - 计算后 top。
 * @param {number} width - 元素宽。
 * @param {number} height - 元素高。
 * @param {number} viewportW - 视口宽。
 * @param {number} viewportH - 视口高。
 * @param {number} [safeInset=0] - 安全区内缩 px。
 * @returns {{x: number, y: number}} clamp 后的视口坐标。
 */
export function clampPointToViewport(x, y, width, height, viewportW, viewportH, safeInset = 0) {
  const ins = Number.isFinite(safeInset) ? Math.max(0, safeInset) : 0;
  const hiX = Math.max(ins, viewportW - width - ins);
  const hiY = Math.max(ins, viewportH - height - ins);
  return {
    x: Math.min(Math.max(x, ins), hiX),
    y: Math.min(Math.max(y, ins), hiY),
  };
}

// ---- bottom-* 锚点移动端修正（#128 重开回归）--------------------------------

/**
 * composer seat 贴底判定纯函数（供 smoke 断言）：seat 非空且 seat.bottom 与
 * container.bottom 在容差内（seat 贴住容器底缘=视口底缘）即为贴底。容差 0.5px：
 * 恰好贴底（差 0）→ true；距底缘 1px → false（D4 断言语义）。
 * @param {{top: number, bottom: number}|null|undefined} seatRect - 输入区矩形子集。
 * @param {{top: number, bottom: number}|null|undefined} containerRect - 容器矩形子集。
 * @returns {boolean} 是否贴底。
 */
export function composerDockedAtBottom(seatRect, containerRect) {
  if (seatRect == null || containerRect == null) return false;
  return Math.abs(seatRect.bottom - containerRect.bottom) <= 0.5;
}

/**
 * bottom-* 锚点下边界纯函数（供 smoke 断言）：贴底时返回 seat 上缘（胶囊上移到
 * 输入区上方，避免遮挡）；否则返回容器底（桌面 / 未贴底零回归）；seatTop 缺失
 * 或非有限数时回落容器底（不产生 NaN 坐标）。
 * @param {number} containerBottom - 容器底缘。
 * @param {number|null|undefined} seatTop - 输入区上缘（可缺）。
 * @param {boolean} docked - 是否贴底。
 * @returns {number} 面板下边界。
 */
export function bottomAnchorEdge(containerBottom, seatTop, docked) {
  if (docked && typeof seatTop === "number" && Number.isFinite(seatTop)) return seatTop;
  return containerBottom;
}

// ---- 面板垂直定位 ----------------------------------------------------------

/**
 * 面板垂直定位纯函数（供 smoke 断言翻转分支；clamp 到视口内，不溢出）。
 * 两包宿主端（config-schema.ts / ui-config.ts）此前各持一份逐字同构实现，
 * #378 随 placement 纯核心上移本模块。
 * @param {"top"|"bottom"} anchor - 垂直锚点方向。
 * @param {number} pillTop - 胶囊上缘。
 * @param {number} pillBottom - 胶囊下缘。
 * @param {number} panelHeight - 面板高。
 * @param {number} gap - 间距 px。
 * @returns {number} 面板 top。
 */
export function panelTopForAnchor(anchor, pillTop, pillBottom, panelHeight, gap) {
  return anchor === "bottom" ? Math.max(6, pillTop - panelHeight - gap) : Math.max(6, pillBottom + gap);
}
