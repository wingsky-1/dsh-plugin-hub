/**
 * dsh-provider-usage — 胶囊定位/层级/断点纯函数薄 facade（#128 → #378 抽取）。
 *
 * 实现上移 shared/placement-math.js（插件家族共享层，纯核心零依赖）；本文件
 * 保留包级常量 DEFAULT_Z_INDEX_BASE（对应 CSS 默认 z-index:40）与
 * panelZIndexFor 的包级默认注入（胶囊与主面板取配置值，不再派生 +30）。
 * 宿主端（src/index.ts re-export 供 smoke 断言）与客户端（src/client/* 直接
 * import）路径不变，公开导出面零变化。
 */

import { panelZIndexFor as sharedPanelZIndexFor } from "../../../shared/placement-math.js";

/** 默认层级基准（provider-usage 包：对应 CSS 默认 z-index:40，升级前行为不回归）。 */
export const DEFAULT_Z_INDEX_BASE = 40;

// 纯核心：实现单一事实源在 shared/placement-math.js（薄 re-export，导出面不变）
export {
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
  panelAnchorForPlacement,
} from "../../../shared/placement-math.js";
export type { FloatBreakpoint, ViewportPoint, RectLike } from "../../../shared/placement-math.js";

/**
 * 面板内子浮层层级派生纯函数（#128 重开：主面板与胶囊 computed z-index 一律取
 * 配置 zIndexBase，不再派生 +30——维护者 2026-08-28 要求）；本函数仅作为面板内
 * 次级层（设置卡片等）的派生扩展点，不占用 zIndexBase 预算。包装注入包级默认
 * （shared 参数化版 panelZIndexFor(base, dflt)），对外签名保持 (base) 不变。
 */
export function panelZIndexFor(base: number): number {
  return sharedPanelZIndexFor(base, DEFAULT_Z_INDEX_BASE);
}