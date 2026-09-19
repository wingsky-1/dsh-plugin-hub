/**
 * dsh-provider-usage — server/config 域对外门面（#768 D1：config 新域）。
 *
 * 域承诺 = 报告配置的形态 + 归一化单答案 + 持久化 + 双源收口服务：
 * 「什么算合法配置」只有一个答案（normalize.ts），读/写/服务同源。
 *
 * 目录化约定：目录外一律经本文件消费，禁 `export * from` 整文件 re-export。
 * 复用边界：
 * - 业务域（schedule/execute/routes）经本门面复用纯面（类型 + 零 node 依赖纯函数）与
 *   读面；有状态的 ReportConfigService 只由组合根构造、经参数传递，不直引；
 * - 迁移域（upgrade/config-morph.ts）经本门面只复用词表纯数据（LEGACY 锁表 +
 *   DEFAULT_PROMPTS，不调用归一化行为）；
 * - 本域无对上依赖，故无 deps.ts（TREND_DIR_MAX 经 collect 门面复用零依赖纯常量，
 *   与词表复用同形，不是需要注入的运行时能力）。
 */

// ------------------------------------------------------------------ 形态（shape.ts）

export { DEFAULT_REPORT_CONFIG } from "./shape.ts";
export type { ReportConfig, ReportPeriod, ReportPeriodConfig, ReportPrompts } from "./shape.ts";

// ------------------------------------------------------------------ 词表（prompts.ts）

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

// ------------------------------------------------------------------ 归一化单答案（normalize.ts）

export {
  parseHHMM,
  normalizeReportDirectories,
  normalizeReportConfig,
  promptFor,
} from "./normalize.ts";

// ------------------------------------------------------------------ 持久化（store.ts）

export { reportConfigFile, readReportConfig, writeReportConfig } from "./store.ts";

// ------------------------------------------------------------------ 双源收口服务（service.ts）

export { ReportConfigService } from "./service.ts";
export type { ReportConfigServiceOptions } from "./service.ts";
