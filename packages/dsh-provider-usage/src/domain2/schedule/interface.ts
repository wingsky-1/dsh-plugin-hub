/**
 * dsh-provider-usage — domain2/schedule/ 报告调度层对外门面。
 *
 * 目录化约定：目录外（domain2 其他层 / apply）一律经本文件消费，
 * 目录内实现文件互引保持直接相对 import。最小面 = 逐个命名导出实际被消费的
 * 「类型 + 函数」，禁 `export * from` 整文件 re-export。
 *
 * 配置面已归 server/config 域（形态 + 归一化单答案 + 持久化 + 双源收口服务，
 * #768 D1）：本域只剩调度面 = 窗口/幂等纯函数（schedule.ts）+ ReportScheduler
 * + ReportTaskQueue（调度→执行交接口）。配置符号一律经 server/config/interface.ts
 * 消费，本文件不再转发（单答案即单入口）。
 */

// ------------------------------------------------------------------ 触发调度纯函数（schedule.ts）

export {
  candidateWindow,
  pendingReports,
  presetLastRunForNewlyEnabled,
  previousClosedWindow,
  deriveLastRun,
  alignLastRun,
  isClosedWindowRecord,
  LAST_RUN_SCHEMA,
} from "./schedule.ts";
export type { DueReport, LastRunRecord } from "./schedule.ts";

// ------------------------------------------------------------------ 调度器（scheduler.ts）

export { ReportScheduler } from "./scheduler.ts";
export type { ReportSchedulerOptions } from "./scheduler.ts";

// ------------------------------------------------------------------ 报告任务队列（tasks.ts）

export { ReportTaskQueue } from "./tasks.ts";
export type {
  ReportTask,
  ReportTaskInput,
  ReportTaskResult,
  ReportTaskStatus,
  ReportTaskQueueOptions,
} from "./tasks.ts";
