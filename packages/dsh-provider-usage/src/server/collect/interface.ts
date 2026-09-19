/**
 * dsh-provider-usage — server/collect 域对外门面（#768 D9：由 domain2 采集目录整域迁入，零行为变更）。
 *
 * 域承诺 = 事件折叠状态机（collector.ts：TrendCollector，吃官方 SessionEvent 流、
 * 产出定稿记录 call/counter，不碰 IO、不持时钟）+ 数据类型与防御工具
 * （types.ts：sanitizeDirName/hourOfDay/sumToken/safeToken/safeId/isValidShardRow/
 * TREND_ROW_VERSION/TREND_UNIDENTIFIED/TREND_DIR_MAX 与行类型）。
 * 目录外（server/aggregate、server/config、server/execute、apply）一律经本文件消费，
 * 目录内实现文件互引保持直接相对 import。最小面 = 逐个命名导出实际被消费的
 * 「类型 + 函数」，禁整文件 re-export。
 *
 * 事件流形状 / TTL / done 上限为本域关键不变量（layer-architecture.md §2 E1），
 * 导出面即这些不变量的唯一外部入口。注入面见 deps.ts。
 */

// ------------------------------------------------------------------ 事件折叠状态机（collector.ts）

export { TrendCollector, TREND_DONE_MAX } from "./collector.ts";
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
