/**
 * dsh-provider-usage — domain2/aggregate/ 聚合/压实/存储层对外门面（E2）。
 *
 * 目录化约定（#670 D9）：目录外（domain2 其他层 / apply）一律经本文件消费，
 * 目录内实现文件互引保持直接相对 import。最小面 = 逐个命名导出实际被消费的
 * 「类型 + 函数」，禁 `export * from` 整文件 re-export。
 *
 * 阶段三 D2 拆分后，纯函数面（aggregate-rows / aggregate-query）的导出经
 * aggregator.ts 尾部 re-export 保持可达；本面按消费方需要的符号**自定义处具名
 * 导出**（不经过 aggregator 的 re-export 链），避免整文件透传。
 * 四不变量（身份快照/防双计/聚合权威/残差归未识别）为消费方依赖的契约，
 * 见 layer-architecture.md §2 E2。
 */

// ------------------------------------------------------------------ 内存聚合主类（aggregator.ts）

export { TrendAggregator } from "./aggregator.ts";

// ------------------------------------------------------------------ 组合根 TrendTracker（index.ts）

export { TrendTracker } from "./index.ts";
export type { TrendTrackerOptions } from "./index.ts";

// ------------------------------------------------------------------ 按天分片存储（store.ts）

export { TrendStore } from "./store.ts";

// ------------------------------------------------------------------ 查询投影纯函数（aggregate-query.ts）

export {
  metricValue,
  weekStartKey,
  lastNWeekKeys,
  lastNMonthKeys,
  monthRange,
  weekRange,
} from "./aggregate-query.ts";
export type {
  TrendGranularity,
  TrendMetric,
  TrendStackPart,
  TrendStackPoint,
  TrendWindowSummary,
} from "./aggregate-query.ts";

// ------------------------------------------------------------------ 压实转换纯函数（aggregate-rows.ts）

export { mergeAggRows, mergeDirRows, mergeHourRows } from "./aggregate-rows.ts";
