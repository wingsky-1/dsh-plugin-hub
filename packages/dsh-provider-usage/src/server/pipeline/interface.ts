/**
 * dsh-provider-usage — server/pipeline 域对外门面（#768 D6：pipeline 新域）。
 *
 * 域承诺 = 取数渲染管道（入参组装 → safe 执行 → 净化 → 归一化：v2.ts）+
 * 缓存编排与互斥服务（stats-service.ts）+ 用户代码安全执行守卫（guards.ts）：
 * 目录外（apply/路由/域2）一律经本文件消费；目录内互引直连。
 *
 * StatsService 深封装：本面只暴露「读 + 失效」操作——
 * getPanelResult/getStats/cacheSize/purgeAllCaches 等受控方法；不暴露
 * cache/panelCache 等可变缓存内部（写路径全部经上述方法收敛）。装配层构造
 * 入口经 StatsServiceCtor（组合根特权，完整实现仅在 apply 可见），路由/域2
 * 消费的是收窄后的 StatsService 门面类型。
 * 最小面 = 逐个命名导出，禁整文件 re-export。
 *
 * 复用边界（与 D2 schedule / D3 execute 同形）：
 * - 业务域（routes）经本门面复用读面（StatsService 门面类型）与纯面
 *   （panelCacheKey/normalizeRangeDay/isPanelCacheStale）；有状态的
 *   StatsService 只由组合根构造、经参数传递，不直引；
 * - 注入面见 deps.ts（PipelineSanitize/PipelineDiagnose 命名接缝与块内联双生子）。
 */
import { StatsService as StatsServiceImpl } from "./stats-service.ts";

export type { StatsServiceOptions } from "./stats-service.ts";

/** StatsService 目录外门面类型：只含读与失效操作，不含缓存内部字段。 */
export type StatsService = Pick<
  StatsServiceImpl,
  | "config"
  | "historyRoot"
  | "registry"
  | "history"
  | "sanitizeDiagnostic"
  | "recordAdapterStateDiagnostic"
  | "lockOf"
  | "cacheFresh"
  | "cacheSize"
  | "purgeAllCaches"
  | "purgePanelCacheForProvider"
  | "purgeCachesForProviders"
  | "getPanelResult"
  | "warmupProviders"
  | "scheduleWriteAdapterState"
  | "persistUserAdapter"
  | "getStats"
  | "dispose"
>;

/** 构造入口（深封装）：目录外（apply 组合根）只经此构造完整实现；字段保持只读、无行为逻辑（与 server/ui-routes/context.ts 的 UiRoutesContext 同形，#768 D13 表述对齐）。 */
export { StatsService as StatsServiceCtor } from "./stats-service.ts";

// ------------------------------------------------------------------ v2 管道（v2.ts）

export {
  runV2Pipeline,
  runV2PanelPipeline,
  panelCacheKey,
  normalizeRangeDay,
  isPanelCacheStale,
  PANEL_CACHE_TTL_MS,
} from "./v2.ts";
export type { V2PipelineResult, V2PipelineContext, PanelCacheEntry } from "./v2.ts";

// ------------------------------------------------------------------ 用户代码安全执行守卫（guards.ts）

export { safeFetchData, safeFormat, fetchWithTimeout } from "./guards.ts";
