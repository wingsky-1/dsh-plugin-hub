/**
 * dsh-provider-usage —— 包组合根入口（#768 D13）。
 *
 * 薄转发：全部符号经 ./apply/index.ts（装配层组合根）透出，本文件不定义行为。
 * 为什么是显式具名转发而不是 export *：export-surface-snapshot 的提取器只读具名导出与声明块（不跟随星导出），星转发会让主入口导出面读出为空而判红。
 * 新增公共符号时两处同步加名（漂移即门禁红）。
 *
 * 导出面收窄（#875 M2b 批次 2）：本入口从 64 条收到 41 条，撤出 23 条能力内部
 * 形状。判据与逐条证据见 scripts/data/dsh-provider-usage-export-faces.json 的
 * 规则段（(b)/(d) 三支）；撤出前已穷举包外消费方——全仓无任何代码 import 本包
 * （dsh-mcp-manager 的 FloatBreakpoint/ViewportPoint/RectLike 是它自己
 * src/shared/placement-math.ts:60/71/101 的独立副本，sseData 取自仓级
 * shared/host-utils.ts:71，均非从本包导入）。域门面（各 server/<域>/interface.ts）
 * 继续导出这些符号，包内测试走深路径不受影响；唯一从产物入口 lib/index.js 消费的
 * test/e2e/smoke.test.ts:207 只用 apply/inject/ROUTES/HotReloadableAdapter，
 * 四条全在保留侧。
 */
export { HotReloadableAdapter, ROUTES, apply, inject, name } from "./apply/index.ts";
export type {
  AdapterErrorCode,
  AdapterErrorInfo,
  AdapterInfo,
  AdapterRegistry,
  AdapterSource,
  AdapterUtils,
  CapsuleInput,
  DayRecord,
  FetchContext,
  HistoryEntry,
  LastRunRecord,
  NormalizedConfig,
  PanelInput,
  ProviderConfigInput,
  ReportConfig,
  ReportConfigServiceOptions,
  ReportLlmService,
  ReportMeta,
  ReportPeriod,
  ReportPeriodConfig,
  ReportPrompts,
  ResolvedProviderConfig,
  SamplePoint,
  TrendAggRow,
  TrendCounterRow,
  TrendDetailRow,
  TrendDirRow,
  TrendGranularity,
  TrendHourRow,
  TrendMetric,
  TrendStackPart,
  TrendStackPoint,
  TrendWindowSummary,
  UiPlacementConfig,
  UsageStatsAdapter,
  UserAdapterRecord,
} from "./apply/index.ts";
