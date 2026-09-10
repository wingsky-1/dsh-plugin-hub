/**
 * dsh-provider-usage — domain2/schedule/ 报告调度层对外门面。
 *
 * 目录化约定：目录外（domain2 其他层 / apply）一律经本文件消费，
 * 目录内实现文件互引保持直接相对 import。最小面 = 逐个命名导出实际被消费的
 * 「类型 + 函数」，禁 `export * from` 整文件 re-export。
 *
 * 配置面 = reportCfg 双源收口（读侧内存权威 + 持久化磁盘 config.json 的
 * 归一化入口，ReportConfigService 收敛消费写侧）；调度面 = 窗口/幂等纯函数
 * （schedule.ts）+ ReportScheduler + ReportTaskQueue（调度→执行交接口）。
 */

// ------------------------------------------------------------------ 报告配置（config.ts）

export {
  parseHHMM,
  normalizeReportConfig,
  normalizeReportDirectories,
  DEFAULT_REPORT_CONFIG,
  DEFAULT_PROMPT_TEMPLATE,
  readReportConfig,
  writeReportConfig,
  reportConfigFile,
  DEFAULT_DAILY_PROMPT,
  DEFAULT_WEEKLY_PROMPT,
  DEFAULT_MONTHLY_PROMPT,
  DEFAULT_PROMPTS,
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
  promptFor,
} from "./config.ts";
export type { ReportConfig, ReportPeriod, ReportPeriodConfig, ReportPrompts } from "./config.ts";

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