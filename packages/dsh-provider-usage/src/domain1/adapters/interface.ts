/**
 * dsh-provider-usage — domain1/adapters/ 内置适配器对外薄门面（C5）。
 *
 * 适配器为 .mjs 运行时模块（权威实现 + 相邻 .d.mts 类型声明）；本面统一
 * re-export 其类型与常量（如 shared/config.ts 引用的 OPENCODE_GO_PROVIDER、
 * apply 装配的 openCodeGoAdapter 等）。目录外一律经本文件消费，禁整文件 re-export。
 * 内置 mjs 因自包含约束不 import 本面（见图表注入面说明，charts.ts 头部）。
 */

// ------------------------------------------------------------------ opencode-go.mjs

export {
  OPENCODE_GO_PROVIDER,
  OPENCODE_GO_ADAPTER_ID,
  DEFAULT_BASE_URL,
  OPENCODE_GO_WINDOWS,
  pickWindow,
  parseUsageResponse,
  fetchOpenCodeGoV2,
  miniChartSvgMarkup,
  openCodeGoAdapter,
} from "./opencode-go.mjs";

// ------------------------------------------------------------------ deepseek-official.mjs

export {
  DEEPSEEK_OFFICIAL_PROVIDER,
  DEEPSEEK_OFFICIAL_ADAPTER_ID,
  BASE_URL,
  parseAmount,
  resolveEndpoint,
  GAP_MS,
  TOL,
  ANOMALY_NEG,
  PEAK_WINDOWS_UTC,
  isPeakUtc,
  nextPeakTransition,
  peakBadgeHtml,
  fetchDeepSeekOfficialV2,
  formatCapsuleWithBadge,
  classifyIntervalDs,
  aggregateDaily,
  dailyBarTitle,
  niceCeil,
  dayKey,
  lastNDayKeys,
  deepSeekOfficialAdapter,
} from "./deepseek-official.mjs";
export type { SamplePoint, DayRecord } from "./deepseek-official.mjs";

// ------------------------------------------------------------------ zai-coding-cn.mjs

export {
  ZAI_CODING_CN_PROVIDER,
  ZAI_CODING_CN_ADAPTER_ID,
  QUOTA_PATH,
  fetchData,
  zaiCodingCnAdapter,
} from "./zai-coding-cn.mjs";