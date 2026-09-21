/**
 * dsh-provider-usage/trend — 数据类型旧址（#768 A波3/5/6 re-export 门面）。
 *
 * canonical 已下沉 server/shared/trend.ts（表达式逐字一致）；本文件仅作兼容门面；
 * 生产与测试一律经 server/shared/interface.ts 消费（同源纪律）。
 * 采集域内互引（collector.ts）仍经本文件可达同一引用。
 */
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
} from "../shared/interface.ts";
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
} from "../shared/interface.ts";
