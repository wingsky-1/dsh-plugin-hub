/**
 * dsh-provider-usage — server/aggregate 域对外门面（#768 D8：aggregate 新域）。
 *
 * 域承诺 = 双面记账 + 压实 + 分片存储 + 自愈（aggregator.ts 状态容器与记账方法）+
 * 压实转换纯函数（aggregate-rows.ts：addDetailTo/addCounterTo/mergeCell/merge*Rows/
 * sub/diffToken/empty*Row）+ 查询投影纯函数（aggregate-query.ts：
 * metricValue/weekStartKey/lastNWeekKeys/lastNMonthKeys/monthRange/weekRange/
 * dayValueOf/rangeValueOf/build*Series/build*Summary/buildDirTotals）+
 * 按天分片 JSONL 存储（store.ts：TrendStore）+ 组合根（index.ts：TrendTracker）：
 * 目录外（apply/路由/server/execute）一律经本文件消费，目录内互引直连。
 * 最小面 = 逐个命名导出实际被消费的「类型 + 函数」，禁整文件 re-export。
 *
 * derive/align 聚合查询纯面（与 D2 schedule 域 deriveLastRun/alignLastRun 同形）：
 * 本域查询投影函数以 days/dirDays/rows 显式传参、不接触 this——server/execute
 *（runner/generate 的 metricValue）与路由经本门面以 pure + type 复用，
 * 不调业务实例（TrendTracker/TrendStore 实例只由组合根构造、经参数传递）。
 * 四不变量（身份快照/防双计/聚合权威/残差归未识别）为消费方依赖的契约，
 * 见 layer-architecture.md §2 E2。
 *
 * 注入面见 deps.ts（AggregateWarn/AggregateClock/AggregateResolveCwd 命名接缝与
 * 块内联双生子；resolveCwd 运行时观测与 A4(g) 量级基线标延期未验证，不动行为）。
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
