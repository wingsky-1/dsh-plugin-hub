/**
 * dsh-provider-usage — shared/ 共享底座对外门面（契约/工具层）。
 *
 * 目录化约定：目录外（apply/domain1/domain2/client）一律经本文件消费；
 * 目录内实现文件互引保持直接相对 import。最小面 = 逐个命名导出实际被消费的
 * 「类型 + 函数」，禁 `export * from` 整文件 re-export。
 *
 * 注：charts 的 dayKey/lastNDayKeys 与 deepseek-official.mjs 文件级导出重名
 * （测试导入面），lib 聚合面（apply/index.ts）显式排除本面同名符号——两处语义
 * 同源（见 charts.ts 头部说明），消费方无感知。
 *
 * 客户端（src/client/**）**不走本面**：client bundle 为 browser 平台 cjs，esbuild
 * 会对本面全部 re-export 目标做解析校验，config/ui-config 等 host 专属模块的
 * node:fs/schemastery 依赖会拉进浏览器端——故 client 继续直引各实现文件
 * （verify-dir-imports 门禁对 src/client/ 豁免，契约面见 scripts/gate 说明）。
 */

// ------------------------------------------------------------------ 契约（contracts.ts）

export {
  ADAPTER_CONTRACT_VERSION,
  ERROR_CODES,
  esc,
  isUsageStatsAdapter,
  describeUsageStatsAdapterShape,
  safeSegment,
} from "./contracts.ts";
export type {
  AdapterErrorCode,
  FetchContext,
  CapsuleInput,
  PanelInput,
  UsageStatsAdapter,
} from "./contracts.ts";

// ------------------------------------------------------------------ 图表/转义/日界工具（charts.ts）

export {
  fin,
  escHtml,
  escAttr,
  dayKey,
  lastNDayKeys,
  toEpochMs,
  resetTicks,
  fmtAxisTime,
  axisLabelWidthPx,
  niceStep,
  niceDomain,
  fmtPctTick,
  timeTickStep,
  timeTicks,
  trendOf,
  downsample,
  smoothPath,
  miniAreaSvg,
  ADAPTER_UTILS,
} from "./charts.ts";
export type { AdapterUtils } from "./charts.ts";

// ------------------------------------------------------------------ 跨端 provider 名（provider.ts，#768 A波7）

export { OPENCODE_GO_PROVIDER } from "./provider.ts";

// ------------------------------------------------------------------ 配置归一化（config.ts）

export { DEFAULT_CONFIG, Config, normalizeConfig } from "./config.ts";
export type { NormalizedConfig } from "./config.ts";

// ------------------------------------------------------------------ HTML 净化（sanitize.ts）

export { sanitizeHtml } from "./sanitize.ts";

// ------------------------------------------------------------------ 胶囊位置 UI 配置与原子写原语（ui-config.ts）

export {
  DEFAULT_UI_CONFIG,
  normalizeUiConfig,
  uiConfigFile,
  readUiConfig,
  writeUiConfig,
} from "./ui-config.ts";
export type { UiPlacementConfig } from "./ui-config.ts";
// 原子写原语（temporaryNameFor / atomicWrite）：本包 tmp+rename 的唯一实现，宿主在
// ui-config.ts（shared/ 下唯一的持久化读写落点）。两个符号的取用口径不同，别混：
//   - atomicWrite 是「写 tmp + rename + 失败清残留」的落点统一入口，凡是要整体落盘的
//     域都用它（本面即它的大门）；
//   - temporaryNameFor 只给**需自持独占创建与目录 fsync 的耐久链**取名（`open("wx")`
//     + `handle.sync()` + `syncDirectory`），那类链换不了 atomicWrite——后者用
//     `writeFile`，没有 `wx` 独占标志，也没有 fsync。取它不等于漏改。
// 直引 ui-config.ts 的实现细节仍禁止；符号本体一律经本面。
export { atomicWrite, temporaryNameFor } from "./ui-config.ts";

// ------------------------------------------------------------------ 客户端行为纯函数（client-logic.ts）

export { splitProviderList, providerBadgeText } from "./client-logic.ts";
export type { ProviderListInput, ProviderListItem } from "./client-logic.ts";

// ------------------------------------------------------------------ 胶囊定位/层级/断点纯函数（placement-math.ts）

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
  panelAnchorForPlacement,
  panelZIndexFor,
  panelTopForAnchor,
} from "./placement-math.ts";
export type { FloatBreakpoint, ViewportPoint, RectLike } from "./placement-math.ts";
