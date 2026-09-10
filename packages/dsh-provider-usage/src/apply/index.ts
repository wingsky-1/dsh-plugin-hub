/**
 * dsh-provider-usage — 用量统计插件（宿主端组合根，v2 重构版）。
 *
 * 结构：职责按模块拆分（contracts / registry /
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
 * - GET/POST /api/dsh-provider-usage/report-config 报告配置（读/写）
 * - GET /api/dsh-provider-usage/reports  报告历史索引
 * - GET /api/dsh-provider-usage/reports/detail  报告详情
 * - POST /api/dsh-provider-usage/reports/generate  手动生成报告
 */

// ------------------------------------------------------------------ 对外 re-export
// 注意：bundle-host 会把 tsc 产物中的子模块全部内联进 lib/index.js 并清理游离 .js，
// smoke/lint 只能从 lib/index.js 导入，故契约与核心模块一律在此 re-export。
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
} from "../shared/interface.ts";
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
} from "../shared/interface.ts";
export { makeAdapterRegistry } from "../domain1/registry/interface.ts";
export type { AdapterSource, AdapterErrorInfo, AdapterInfo, ReplaceFileResult, AdapterRegistry } from "../domain1/registry/interface.ts";
// 共享图表工具库（AdapterUtils/ADAPTER_UTILS 等）——外部 TS 消费者可经 index 导入。
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
} from "../shared/interface.ts";
export type { AdapterUtils } from "../shared/interface.ts";
// 内置适配器 mjs 化：.mjs 为权威实现，.d.mts 提供类型声明（bundle 后 index 内联
// 保留具名导出面——unit-contract/unit-deepseek-official 等测试从 lib/index.js 导入不变）
export { OPENCODE_GO_PROVIDER, OPENCODE_GO_ADAPTER_ID, DEFAULT_BASE_URL, OPENCODE_GO_WINDOWS, pickWindow, parseUsageResponse, fetchOpenCodeGoV2, miniChartSvgMarkup, openCodeGoAdapter } from "../domain1/adapters/interface.ts";
export { DEEPSEEK_OFFICIAL_PROVIDER, DEEPSEEK_OFFICIAL_ADAPTER_ID, BASE_URL, parseAmount, resolveEndpoint, GAP_MS, TOL, ANOMALY_NEG, PEAK_WINDOWS_UTC, isPeakUtc, nextPeakTransition, peakBadgeHtml, fetchDeepSeekOfficialV2, formatCapsuleWithBadge, classifyIntervalDs, aggregateDaily, dailyBarTitle, niceCeil, dayKey, lastNDayKeys, deepSeekOfficialAdapter } from "../domain1/adapters/interface.ts";
export type { SamplePoint, DayRecord } from "../domain1/adapters/interface.ts";
export { ZAI_CODING_CN_PROVIDER, ZAI_CODING_CN_ADAPTER_ID, QUOTA_PATH, fetchData, zaiCodingCnAdapter } from "../domain1/adapters/interface.ts";
export { credentialsFile, opencodeAuthFile, resolveProviderConfig } from "../domain1/registry/interface.ts";
export type { ProviderConfigInput, ResolvedProviderConfig } from "../domain1/registry/interface.ts";
export { HistoryStore, parseJsonl, startOfDay, migrateLegacyV3, legacySampleToData, listAdapters } from "../domain1/history/interface.ts";
export type { HistoryEntry } from "../domain1/history/interface.ts";
export { safeFetchData, safeFormat, fetchWithTimeout } from "../domain1/pipeline/interface.ts";
export { sanitizeHtml } from "../shared/interface.ts";
// 客户端行为纯函数（设置页列表拆分/徽标文案，经此透出供单元测试）。
export { splitProviderList, providerBadgeText } from "../shared/interface.ts";
export { runV2Pipeline, runV2PanelPipeline, panelCacheKey, normalizeRangeDay, isPanelCacheStale, PANEL_CACHE_TTL_MS } from "../domain1/pipeline/interface.ts";
export type { PanelCacheEntry } from "../domain1/pipeline/interface.ts";
export { HotReloadableAdapter, loadAndValidateAdapter, readStamp, stampEqual } from "../domain1/registry/interface.ts";
// 会话用量趋势：trend 模块公共面（测试/外部消费者从 lib/index.js 导入）
export { TrendTracker } from "../domain2/aggregate/interface.ts";
export type { TrendTrackerOptions } from "../domain2/aggregate/interface.ts";
export { TrendCollector, TREND_DONE_MAX } from "../domain2/collect/interface.ts";
export type { TrendCallRecord, TrendCorrectRecord, TrendCounterRecord, TrendEmit } from "../domain2/collect/interface.ts";
export { TrendAggregator, metricValue, weekStartKey, lastNWeekKeys, lastNMonthKeys, monthRange, weekRange, mergeAggRows, mergeDirRows, mergeHourRows } from "../domain2/aggregate/interface.ts";
export type { TrendMetric, TrendGranularity, TrendStackPart, TrendStackPoint, TrendWindowSummary } from "../domain2/aggregate/interface.ts";
export { TrendStore } from "../domain2/aggregate/interface.ts";
// isValidShardRow/safeToken/safeId：分片行校验与防御提取纯函数（单测从 lib/index.js 导入）
export { TREND_ROW_VERSION, TREND_UNIDENTIFIED, TREND_DIR_MAX, sumToken, isValidShardRow, safeToken, safeId, sanitizeDirName, hourOfDay } from "../domain2/collect/interface.ts";
export type { TrendAttribution, TrendTokens, TrendDetailRow, TrendCounterRow, TrendAggRow, TrendDirRow, TrendHourRow, TrendCell } from "../domain2/collect/interface.ts";
// 会话用量报告：report 模块公共面（测试/外部消费者从 lib/index.js 导入）
export { candidateWindow, pendingReports, presetLastRunForNewlyEnabled, previousClosedWindow, deriveLastRun, isClosedWindowRecord, LAST_RUN_SCHEMA } from "../domain2/schedule/interface.ts";
export type { DueReport, LastRunRecord } from "../domain2/schedule/interface.ts";
export { parseHHMM, normalizeReportConfig, normalizeReportDirectories, DEFAULT_REPORT_CONFIG, DEFAULT_PROMPT_TEMPLATE, readReportConfig, writeReportConfig, reportConfigFile } from "../domain2/schedule/interface.ts";
export type { ReportConfig, ReportPeriod, ReportPeriodConfig } from "../domain2/schedule/interface.ts";
export { generateReport, applyPromptTemplate, buildStatsSnapshot, PERIOD_BUCKETS } from "../domain2/execute/interface.ts";
export { reportBodyToHtml } from "../domain2/execute/interface.ts";
export { DEFAULT_DAILY_PROMPT, DEFAULT_WEEKLY_PROMPT, DEFAULT_MONTHLY_PROMPT, DEFAULT_PROMPTS, LEGACY_PROMPT_TEMPLATE, LEGACY_DAILY_PROMPT_V1, LEGACY_WEEKLY_PROMPT_V1, LEGACY_MONTHLY_PROMPT_V1, LEGACY_DAILY_PROMPT_V2, LEGACY_WEEKLY_PROMPT_V2, LEGACY_MONTHLY_PROMPT_V2, LEGACY_DAILY_PROMPT_V3, LEGACY_WEEKLY_PROMPT_V3, LEGACY_MONTHLY_PROMPT_V3, LEGACY_DAILY_PROMPT_V4, LEGACY_WEEKLY_PROMPT_V4, LEGACY_MONTHLY_PROMPT_V4, promptFor } from "../domain2/schedule/interface.ts";
export type { ReportPrompts } from "../domain2/schedule/interface.ts";
export type { ReportMeta, ReportResult, ReportStatsSnapshot, ReportLlmService, ReportTokenUsage } from "../domain2/execute/interface.ts";
export { ReportScheduler } from "../domain2/schedule/interface.ts";
export { readLastRun, writeLastRun, updateLastRun, ensureLastRunMigrated, __lastRunChainForTests } from "../domain2/common/interface.ts";
// 执行器工厂与报告配置服务（装配面公共符号，测试/外部消费者从 lib 导入）
export { makeDueReportExecutor } from "../domain2/execute/interface.ts";
export type { DueExecutorDeps } from "../domain2/execute/interface.ts";
export { ReportConfigService } from "./report-config-service.ts";
export type { ReportConfigServiceOptions } from "./report-config-service.ts";
// 任务队列（手动生成与定时共用执行入口）
export { ReportTaskQueue } from "../domain2/schedule/interface.ts";
export type { ReportTask, ReportTaskInput, ReportTaskResult, ReportTaskStatus } from "../domain2/schedule/interface.ts";
// 读侧投影（一行/窗口=最新版）与公共解析（解析原语在 report-index.ts）
export { readReportIndex, prevWindowTotal, runDueReport, persistReport, reportHtmlFile, reportMetaFile, notifyReport, __clearReportIndexCacheForTests, __reportIndexCacheStatsForTests } from "../domain2/execute/interface.ts";
export { parseReportIndexLines } from "../domain2/common/interface.ts";
// 路径解析纯函数透出（供测试与调用方复用同一展开/解析规则，无行为变更）
export { resolvePath, pluginHome, expandHomePath } from "../domain1/registry/interface.ts";
// 配置归一化（默认值 / schemastery schema / normalizeConfig）
export { DEFAULT_CONFIG, Config, normalizeConfig } from "../shared/interface.ts";
export type { NormalizedConfig } from "../shared/interface.ts";

// ------------------------------------------------------------------ 类型

export const name = "provider-usage";
// `sessions` 必须声明——apply 的 resolveCwd 经 ctx.sessions.get(id)?.header.cwd
// 取会话工作目录（目录维度归属主源）。cordis 4 对未在 inject 声明的服务属性直访抛
// 「cannot get property "sessions" without inject」；该异常会被 resolveCwd 的 catch 吞掉，
// 于是每个会话恒归未识别桶、目录维度全链路失效（历史与当期数据双失）。缺声明是静默
// 降级（无告警、无失败），故补源码契约断言锁定（unit-trend.test.ts「inject 契约」节）。
export const inject: string[] = ["webServer", "llm", "sessions"];

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
} from "../shared/interface.ts";
export type { FloatBreakpoint, ViewportPoint, RectLike } from "../shared/interface.ts";
// 面板锚点判定同为纯函数，随定位数学一起从单一事实源 re-export。
export { panelAnchorForPlacement } from "../shared/interface.ts";
// 胶囊位置 UI 配置（纯函数 + 持久化读写）
export { DEFAULT_UI_CONFIG, normalizeUiConfig, panelTopForAnchor, uiConfigFile, readUiConfig, writeUiConfig } from "../shared/interface.ts";
export type { UiPlacementConfig } from "../shared/interface.ts";
// sseData 已收敛 shared/host-utils.js：单独改指共享层，导出面保持不变
export { sseData } from "../../../../shared/host-utils.js";
// 用户适配器持久化（清单/启用状态读写 + add 文件校验）
export { userAdaptersFile, adapterStateFile, parseUserAdapters, readUserAdapters, readAdapterState, resolveAddAdapterFile } from "../domain1/registry/interface.ts";
export type { UserAdapterRecord } from "../domain1/registry/interface.ts";
// 插件契约转发（apply 主流程 + 路由表实现于 apply.ts）
export { apply, ROUTES } from "./apply.ts";
// 路由 handler 直出（status 响应 reused 透传的单元断言面）
export { handleReportStatus } from "../domain2/routes/interface.ts";