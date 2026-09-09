/**
 * dsh-provider-usage — domain2/common/ 域2公共层对外门面（D8 归位）。
 *
 * 目录化约定（#670 D9）：目录外（domain2 其他层 / apply）一律经本文件消费，
 * 目录内实现文件互引保持直接相对 import。最小面 = 逐个命名导出实际被消费的
 * 「类型 + 函数」，禁 `export * from` 整文件 re-export。
 *
 * 本目录边界 = 无状态无缓存（layer-architecture.md §2.3）：
 * - last-run.ts：per-root 临界区链（#629 P2 唯一实现），E3 调度与 E4 执行共同依赖；
 * - report-index.ts：index.jsonl 纯解析原语（读侧记忆化留在 runner，防双份缓存）；
 * - errsurf.ts：域2每层错误面（aggregate/schedule/execute）。
 */

// ------------------------------------------------------------------ lastRun 持久化原语（last-run.ts）

export {
  readLastRun,
  writeLastRun,
  updateLastRun,
  ensureLastRunMigrated,
  __lastRunChainForTests,
} from "./last-run.ts";

// ------------------------------------------------------------------ 报告索引解析（report-index.ts）

export { parseReportIndexLines } from "./report-index.ts";

// ------------------------------------------------------------------ 域2每层错误面（errsurf.ts）

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