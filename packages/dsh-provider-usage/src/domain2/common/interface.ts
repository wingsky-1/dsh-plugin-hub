/**
 * dsh-provider-usage — domain2/common/ 域2公共层对外门面。
 *
 * 目录化约定：目录外（domain2 其他层 / apply）一律经本文件消费，
 * 目录内实现文件互引保持直接相对 import。最小面 = 逐个命名导出实际被消费的
 * 「类型 + 函数」，禁 `export * from` 整文件 re-export。
 *
 * 本目录边界 = 无状态无缓存（layer-architecture.md §2.3）：
 * - report-index.ts：index.jsonl 纯解析原语（读侧记忆化留在 runner，防双份缓存；
 *   lastRun 推导侧的同口径解析由 server/schedule/store.ts 经本门面复用）；
 * - errsurf.ts：过渡垫片（canonical 已迁 server/shared/errsurf.ts，D13 随本目录消除）。
 * lastRun 持久化原语（读/写/per-root 链/校准）D2 起归 server/schedule 域
 * （server/schedule/store.ts，唯一定义），本门面不再转发（单答案即单入口）。
 */

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
