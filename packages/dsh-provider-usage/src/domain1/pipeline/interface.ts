/**
 * dsh-provider-usage — domain1/pipeline/ 取数管道对外门面（C3）。
 *
 * StatsService 深封装（#670 D7 裁定）：本面只暴露「读 + 失效」操作——
 * getPanelResult/getStats/cacheSize/purgeAllCaches 等受控方法；不暴露
 * cache/panelCache 等可变缓存内部（写路径全部经上述方法收敛）。装配层构造
 * 入口经 StatsServiceCtor（组合根特权，完整实现仅在 apply 可见），路由/域2
 * 消费的是收窄后的 StatsService 门面类型。
 * 最小面 = 逐个命名导出，禁整文件 re-export。
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

/** 装配层构造入口（完整实现；仅 apply/ 组合根应使用）。 */
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
