/**
 * dsh-provider-usage — 用量统计插件（宿主端组合根，v2 重构版）。
 *
 * 结构：职责按模块拆分（contracts / registry /
 * adapters / core / pipeline / provider-config / path-resolve / hotreload /
 * placement-math / config / ui-config / user-adapters / apply），本文件保留
 * 插件契约转发（apply 与路由表）与全部公共符号 re-export（导出面不变，
 * 外部消费者从 lib/index.js 导入不受影响）。
 *
 * 路由（loopback 围栏，实现在 apply.ts）：
 * - GET /api/dsh-provider-usage/stats  用量统计 + 胶囊 HTML
 * - GET /api/dsh-provider-usage/history 历史数据 + 面板 HTML
 * - GET /api/dsh-provider-usage/adapters.json 适配器候选元数据（设置页主列表同源）
 * - POST /api/dsh-provider-usage/adapters/select 切换/清空启用适配器
 * - POST /api/dsh-provider-usage/adapters/inspect 预览适配器文件（回显导出信息，不注册）
 * - POST /api/dsh-provider-usage/adapters/add 登记用户适配器文件（设置页承载，免手改配置）
 * - GET /api/dsh-provider-usage/health  健康检查 + 适配器快照
 * - GET/POST /api/dsh-provider-usage/ui-config 胶囊位置配置（读取/保存，保存后 SSE 广播）
 * - GET /api/dsh-provider-usage/events  SSE 事件通道（ui-config-changed 等，客户端即时热更新）
 * - GET/POST /api/dsh-provider-usage/report-config 报告配置（读/写）
 * - GET /api/dsh-provider-usage/reports  报告历史索引
 * - GET /api/dsh-provider-usage/reports/detail  报告详情
 * - POST /api/dsh-provider-usage/reports/generate  手动生成报告
 */

// ------------------------------------------------------------------ 对外 re-export
// 注意：bundle-host 会把 tsc 产物中的子模块全部内联进 lib/index.js 并清理游离 .js，
// smoke/lint 只能从 lib/index.js 导入，故契约与核心模块一律在此 re-export。
export type {
  AdapterErrorCode,
  FetchContext,
  CapsuleInput,
  PanelInput,
  UsageStatsAdapter,
} from "../shared/interface.ts";

export type {
  AdapterSource,
  AdapterErrorInfo,
  AdapterInfo,
  ReplaceFileResult,
  AdapterRegistry,
} from "../server/registry/interface.ts";

export type { AdapterUtils } from "../shared/interface.ts";
// 内置适配器 mjs 化：.mjs 为权威实现，.d.mts 提供类型声明（bundle 后 index 内联
// 保留具名导出面——unit-contract/unit-deepseek-official 等测试从 lib/index.js 导入不变）
export type { SamplePoint, DayRecord } from "../server/adapters/interface.ts";
export type { ProviderConfigInput, ResolvedProviderConfig } from "../server/registry/interface.ts";
export type { HistoryEntry } from "../server/history/interface.ts";
export type { PanelCacheEntry } from "../server/pipeline/interface.ts";
export { HotReloadableAdapter } from "../server/registry/interface.ts";
export type { TrendTrackerOptions } from "../server/aggregate/interface.ts";

export type {
  TrendCallRecord,
  TrendCorrectRecord,
  TrendCounterRecord,
  TrendEmit,
} from "../server/collect/interface.ts";

export type {
  TrendMetric,
  TrendGranularity,
  TrendStackPart,
  TrendStackPoint,
  TrendWindowSummary,
} from "../server/aggregate/interface.ts";

export type {
  TrendAttribution,
  TrendTokens,
  TrendDetailRow,
  TrendCounterRow,
  TrendAggRow,
  TrendDirRow,
  TrendHourRow,
  TrendCell,
} from "../server/collect/interface.ts";
export type { DueReport, LastRunRecord } from "../server/schedule/interface.ts";

export type { ReportConfig, ReportPeriod, ReportPeriodConfig } from "../server/config/interface.ts";

export type { ReportPrompts } from "../server/config/interface.ts";
export type {
  ReportMeta,
  ReportResult,
  ReportStatsSnapshot,
  ReportLlmService,
  ReportTokenUsage,
} from "../server/execute/interface.ts";

// 执行器工厂与报告配置服务类型面（值已退役白盒直连域门面，见unit-report-executor）。
export type { DueExecutorDeps } from "../server/execute/interface.ts";
export type { ReportConfigServiceOptions } from "../server/config/interface.ts";
// 任务队列（手动生成与定时共用执行入口）

export type {
  ReportTask,
  ReportTaskInput,
  ReportTaskResult,
  ReportTaskStatus,
} from "../server/schedule/interface.ts";

export type { NormalizedConfig } from "../shared/interface.ts";

// ------------------------------------------------------------------ 类型

export const name = "provider-usage";
// `sessions` 必须声明——apply 的 resolveCwd 经 ctx.sessions.get(id)?.header.cwd
// 取会话工作目录（目录维度归属主源）。cordis 4 对未在 inject 声明的服务属性直访抛
// 「cannot get property "sessions" without inject」；该异常会被 resolveCwd 的 catch 吞掉，
// 于是每个会话恒归未识别桶、目录维度全链路失效（历史与当期数据双失）。缺声明是静默
// 降级（无告警、无失败），故补源码契约断言锁定（unit-trend.test.ts「inject 契约」节）。
export const inject: string[] = ["webServer", "llm", "sessions"];

export type { FloatBreakpoint, ViewportPoint, RectLike } from "../shared/interface.ts";

export type { UiPlacementConfig } from "../shared/interface.ts";
// sseData 已收敛 shared/host-utils.js：单独改指共享层，导出面保持不变
export { sseData } from "../../../../shared/host-utils.js";
export type { UserAdapterRecord } from "../server/registry/interface.ts";
// 插件契约转发（apply 主流程 + 路由表实现于 apply.ts）
export { apply, ROUTES } from "./apply.ts";
