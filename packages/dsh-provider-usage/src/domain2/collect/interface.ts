/**
 * dsh-provider-usage — domain2/collect/ 事件采集层对外门面（E1）。
 *
 * 目录化约定（#670 D9）：目录外（domain2 其他层 / apply）一律经本文件消费，
 * 目录内实现文件互引保持直接相对 import。最小面 = 逐个命名导出实际被消费的
 * 「类型 + 函数」，禁 `export * from` 整文件 re-export。
 *
 * 事件流形状 / TTL / done 上限为本层关键不变量（layer-architecture.md §2 E1），
 * 导出面即这些不变量的唯一外部入口。
 */

// ------------------------------------------------------------------ 事件折叠状态机（collector.ts）

export { TrendCollector, TREND_FOLD_TTL_MS, TREND_DONE_MAX } from "./collector.ts";
export type {
  TrendCallRecord,
  TrendCorrectRecord,
  TrendCounterRecord,
  TrendEmit,
  TrendCollectorOptions,
} from "./collector.ts";

// ------------------------------------------------------------------ 数据类型与防御工具（types.ts）

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
} from "./types.ts";
export type {
  TrendAttribution,
  TrendTokens,
  TrendDetailRow,
  TrendCounterRow,
  TrendAggRow,
  TrendDirRow,
  TrendHourRow,
  TrendCell,
} from "./types.ts";
