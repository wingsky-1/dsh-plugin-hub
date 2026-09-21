/**
 * dsh-provider-usage — server/shared 共享层门面（#768 S2 / A波下沉）。
 *
 * 共享层是叶子——它不依赖任何域，域依赖它。收口到一处是为了让「共享层提供了什么」
 * 有一个可被门禁校验的答案，而不是散落在各域对实现文件的直引里。
 * 本包 server/shared 现阶段叶子 = errsurf（域2每层错误面）+ A波纯下沉四叶
 * （time 时间解析 / prompts 冻结文本锁表 / trend 趋势数据原语 + metricValue /
 * last-run 纯面）；禁新建 file-io 叶（S2 约束：per-root 链留 schedule，
 * 见 server/upgrade/deps.ts 注记）。
 * 目录化约定：目录外一律经本文件消费，禁 `export * from` 整文件 re-export。
 */
export {
  makeLayerErrorSurface,
  makeNoopLayerErrorSurface,
  LAYER_ERROR_KEYS,
  LAYER_ERROR_MAX_RECENT_DEFAULT,
} from "./errsurf.ts";
export type {
  LayerErrorKey,
  LayerErrorRecord,
  LayerErrorState,
  LayerErrorSurface,
  LayerErrorSurfaceOptions,
} from "./errsurf.ts";

// ------------------------------------------------------------------ 时间解析（time.ts，A波1）

export { parseHHMM } from "./time.ts";

// ------------------------------------------------------------------ 冻结文本锁表（prompts.ts，A波2）

export {
  LEGACY_PROMPT_TEMPLATE,
  LEGACY_DAILY_PROMPT_V1,
  LEGACY_WEEKLY_PROMPT_V1,
  LEGACY_MONTHLY_PROMPT_V1,
  LEGACY_DAILY_PROMPT_V2,
  LEGACY_WEEKLY_PROMPT_V2,
  LEGACY_MONTHLY_PROMPT_V2,
  LEGACY_DAILY_PROMPT_V3,
  LEGACY_WEEKLY_PROMPT_V3,
  LEGACY_MONTHLY_PROMPT_V3,
  LEGACY_DAILY_PROMPT_V4,
  LEGACY_WEEKLY_PROMPT_V4,
  LEGACY_MONTHLY_PROMPT_V4,
  DEFAULT_DAILY_PROMPT,
  DEFAULT_WEEKLY_PROMPT,
  DEFAULT_MONTHLY_PROMPT,
  DEFAULT_PROMPTS,
  DEFAULT_PROMPT_TEMPLATE,
} from "./prompts.ts";

// ------------------------------------------------------------------ 趋势数据原语 + metricValue（trend.ts，A波3/5/6）

export {
  TREND_ROW_VERSION,
  TREND_UNIDENTIFIED,
  TREND_DIR_MAX,
  sanitizeDirName,
  hourOfDay,
  sumToken,
  safeToken,
  safeId,
  isValidShardRow,
  metricValue,
} from "./trend.ts";
export type {
  TrendAttribution,
  TrendTokens,
  TrendDetailRow,
  TrendCounterRow,
  TrendAggRow,
  TrendDirRow,
  TrendHourRow,
  TrendRow,
  TrendCell,
  TrendMetric,
} from "./trend.ts";

// ------------------------------------------------------------------ last-run 纯面（last-run.ts，A波4）

export { LAST_RUN_SCHEMA, isClosedWindowRecord, deriveLastRun, alignLastRun } from "./last-run.ts";
export type { LastRunRecord } from "./last-run.ts";
