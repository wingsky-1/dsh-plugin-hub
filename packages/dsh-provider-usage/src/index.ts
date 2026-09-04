/**
 * dsh-provider-usage — 用量统计插件（宿主端组合根，v2 重构版）。
 *
 * 结构（#276 方案 A 阶段 3 拆分）：职责按模块拆分（contracts / registry /
 * adapters / core / pipeline / provider-config / path-resolve / hotreload /
 * placement-math / config / ui-config / user-adapters / apply），本文件保留
 * 插件契约转发（apply 与路由表）与全部公共符号 re-export（导出面不变，
 * 外部消费者从 lib/index.js 导入不受影响）。
 *
 * 路由（loopback 围栏，实现在 apply.ts）：
 * - GET /api/dsh-provider-usage/stats  用量统计 + 胶囊 HTML
 * - GET /api/dsh-provider-usage/history 历史数据 + 面板 HTML
 * - GET /api/dsh-provider-usage/adapters.json 适配器候选元数据（设置页主列表同源）
 * - POST /api/dsh-provider-usage/adapters/select 切换/清空启用适配器
 * - POST /api/dsh-provider-usage/adapters/inspect 预览适配器文件（回显导出信息，不注册）
 * - POST /api/dsh-provider-usage/adapters/add 登记用户适配器文件（设置页承载，免手改配置）
 * - GET /api/dsh-provider-usage/health  健康检查 + 适配器快照
 * - GET/POST /api/dsh-provider-usage/ui-config 胶囊位置配置（读取/保存，保存后 SSE 广播）
 * - GET /api/dsh-provider-usage/events  SSE 事件通道（ui-config-changed 等，客户端即时热更新）
 */

// ------------------------------------------------------------------ 对外 re-export
// 注意：bundle-host 会把 tsc 产物中的子模块全部内联进 lib/index.js 并清理游离 .js，
// smoke/lint 只能从 lib/index.js 导入，故契约与核心模块一律在此 re-export。
export * from "./contracts.ts";
export * from "./registry.ts";
// #215 共享图表工具库（AdapterUtils/ADAPTER_UTILS 等）——外部 TS 消费者可经 index 导入。
// dayKey/lastNDayKeys 与 deepseek-official.mjs 文件级导出重名（测试导入面），
// 此处显式排除，deepseek-official.mjs 的导出保留（同源副本，语义一致）。
export {
  fin,
  escHtml,
  escAttr,
  niceDomain,
  trendOf,
  timeTicks,
  resetTicks,
  downsample,
  smoothPath,
  miniAreaSvg,
  niceStep,
  fmtPctTick,
  timeTickStep,
  fmtAxisTime,
  axisLabelWidthPx,
  toEpochMs,
  ADAPTER_UTILS,
} from "./charts.ts";
export type { AdapterUtils } from "./charts.ts";
// #215 内置适配器 mjs 化：.mjs 为权威实现，.d.mts 提供类型声明（bundle 后 index 内联
// 保留具名导出面——unit-contract/unit-deepseek-official 等测试从 lib/index.js 导入不变）
export * from "./adapters/opencode-go.mjs";
export * from "./adapters/deepseek-official.mjs";
export * from "./adapters/zai-coding-cn.mjs";
export * from "./provider-config.ts";
export { HistoryStore, parseJsonl, startOfDay, migrateLegacyV3, legacySampleToData, listAdapters } from "./core/history.ts";
export type { HistoryEntry } from "./core/history.ts";
export { safeFetchData, safeFormat, fetchWithTimeout } from "./core/guards.ts";
export { sanitizeHtml } from "./sanitize.ts";
// 客户端行为纯函数（设置页列表拆分/徽标文案，经此透出供单元测试）。
export { splitProviderList, providerBadgeText } from "./client-logic.ts";
export { runV2Pipeline, runV2PanelPipeline, capsuleHtmlFromHistory, panelCacheKey, normalizeRangeDay, isPanelCacheStale, PANEL_CACHE_TTL_MS } from "./pipeline/v2.ts";
export type { PanelCacheEntry } from "./pipeline/v2.ts";
export { HotReloadableAdapter, loadAndValidateAdapter, readStamp, stampEqual } from "./hotreload.ts";
// 路径解析纯函数透出（供测试与调用方复用同一展开/解析规则，无行为变更）
export { resolvePath, pluginHome, expandHomePath } from "./path-resolve.ts";
// 配置归一化（#276 方案 A 阶段 3 拆出：默认值 / schemastery schema / normalizeConfig）
export { DEFAULT_CONFIG, Config, normalizeConfig } from "./config.ts";
export type { NormalizedConfig } from "./config.ts";

// ------------------------------------------------------------------ 类型

export const name = "provider-usage";
export const inject: string[] = ["webServer", "llm"];

// 胶囊定位/层级/断点纯函数：实现在 placement-math.ts（零依赖单一事实源，
// 客户端 bundle 与宿主端共用同一份），此处 re-export 保持导出面不变。
export {
  BREAKPOINT_NARROW_MAX,
  BREAKPOINT_TABLET_MAX,
  DEFAULT_Z_INDEX_BASE,
  Z_INDEX_BASE_MIN,
  Z_INDEX_BASE_MAX,
  Z_INDEX_PANEL_DELTA,
  breakpointForWidth,
  clampPointToViewport,
  clampZIndexBase,
  composerDockedAtBottom,
  bottomAnchorEdge,
  panelZIndexFor,
} from "./placement-math.ts";
export type { FloatBreakpoint, ViewportPoint, RectLike } from "./placement-math.ts";
// 面板锚点判定同为纯函数，随定位数学一起从单一事实源 re-export。
export { panelAnchorForPlacement } from "./placement-math.ts";
// 胶囊位置 UI 配置（#276 方案 A 阶段 3 拆出：纯函数 + 持久化读写）
export { DEFAULT_UI_CONFIG, normalizeUiConfig, panelTopForAnchor, uiConfigFile, readUiConfig, writeUiConfig } from "./ui-config.ts";
export type { UiPlacementConfig } from "./ui-config.ts";
// sseData 已收敛 shared/host-utils.js（#472）：单独改指共享层，导出面保持不变
export { sseData } from "../../../shared/host-utils.js";
// 用户适配器持久化（#276 方案 A 阶段 3 拆出：清单/启用状态读写 + add 文件校验）
export { userAdaptersFile, adapterStateFile, parseUserAdapters, readUserAdapters, readAdapterState, resolveAddAdapterFile } from "./user-adapters.ts";
export type { UserAdapterRecord } from "./user-adapters.ts";
// 插件契约转发（apply 主流程 + 路由表实现于 apply.ts）
export { apply, ROUTES } from "./apply.ts";