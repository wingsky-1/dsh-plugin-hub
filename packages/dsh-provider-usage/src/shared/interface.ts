/**
 * dsh-provider-usage — shared/ 共享底座对外门面（C1 契约/工具层）。
 *
 * 目录化约定（#670 D9）：目录外（apply/domain1/domain2/client）一律经本文件消费；
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
  ADAPTER_CONTRACT_VERSION_V1,
  ADAPTER_CONTRACT_VERSION,
  ERROR_CODES,
  esc,
  isUsageStatsAdapter,
  describeUsageStatsAdapterShape,
  safeSegment,
  USAGE_GLOBAL_KEY,
  isHostProviderAdapter,
  describeAdapterShape,
  isClientProviderRenderer,
  usageError,
  usageOk,
  summarizeTextFromWindows,
  levelFromWindows,
  defineUsageAdapter,
} from "./contracts.ts";
export type {
  AdapterErrorCode,
  FetchContext,
  CapsuleInput,
  PanelInput,
  UsageStatsAdapter,
  UsageWindow,
  ProviderUsage,
  SummaryLevel,
  ProviderSummary,
  SampleColumn,
  FetchLike,
  HostFetchContext,
  SamplePointData,
  HostProviderAdapter,
  ClientProviderRenderer,
  RenderContext,
  DshUsageGlobal,
  UsageAdapterSpec,
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

// ------------------------------------------------------------------ 配置归一化（config.ts）

export { DEFAULT_CONFIG, Config, normalizeConfig } from "./config.ts";
export type { NormalizedConfig } from "./config.ts";

// ------------------------------------------------------------------ HTML 净化（sanitize.ts）

export { sanitizeHtml } from "./sanitize.ts";

// ------------------------------------------------------------------ 胶囊位置 UI 配置（ui-config.ts）

export {
  DEFAULT_UI_CONFIG,
  normalizeUiConfig,
  panelTopForAnchor,
  uiConfigFile,
  readUiConfig,
  writeUiConfig,
} from "./ui-config.ts";
export type { UiPlacementConfig } from "./ui-config.ts";

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
} from "./placement-math.ts";
export type { FloatBreakpoint, ViewportPoint, RectLike } from "./placement-math.ts";
