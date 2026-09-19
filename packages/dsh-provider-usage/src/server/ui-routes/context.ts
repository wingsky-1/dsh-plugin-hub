/**
 * dsh-provider-usage — ui 路由装配形状与创建面（server/ui-routes 域，
 * #768 D12 由 domain2/routes/ui.ts 迁入，零行为变更）。
 *
 * 本文件是域内跨块值文件（四特征块 health/trend/ui-config/events 共享的装配形状，
 * 与 server/aggregate/index.ts 的 TrendTracker 组合根同形）：UiRoutesContext
 * 深封装（「路由 context 类」，与 server/pipeline 的 StatsServiceCtor 同形，
 * #768 D13 表述对齐）+ createUiRoutes 路由装配器。目录外（apply 装配）
 * 只经构造入口装配依赖并交给 createUiRoutes；字段保持只读、无行为逻辑；
 * 特征块经 `import type` 取用本形状
 * （类型边，运行时无环：本文件按值引用四块，四块只按类型引用本文件）。
 */
import type { ServerResponse } from "node:http";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { UiPlacementConfig } from "../../shared/interface.ts";
import type { LayerErrorSurface } from "../shared/interface.ts";
import type { StatsService } from "../pipeline/interface.ts";
import type { TrendTracker } from "../aggregate/interface.ts";
import { handleHealth } from "./health.ts";
import { handleTrend } from "./trend.ts";
import { handleUiConfig } from "./ui-config.ts";
import { handleEvents } from "./events.ts";

/** UiRoutesContext 依赖装配形状（路由 context 类的构造入口）。 */
export interface UiRoutesContextOptions {
  statsService: StatsService;
  trend: TrendTracker;
  uiConfig: UiPlacementConfig;
  sseClients: Set<ServerResponse>;
  broadcastUiConfigChanged: () => void;
  /** 域2每层错误面：health 响应 per-layer 段数据源。 */
  layerErrors: LayerErrorSurface;
}

/**
 * 路由 context 类（深封装）：把路由依赖收敛为类实例，目录外只经构造
 * 入口装配后交给 createUiRoutes；字段保持只读、无行为逻辑（只做面）。
 */
export class UiRoutesContext {
  readonly statsService: StatsService;
  readonly trend: TrendTracker;
  readonly uiConfig: UiPlacementConfig;
  readonly sseClients: Set<ServerResponse>;
  readonly broadcastUiConfigChanged: () => void;
  readonly layerErrors: LayerErrorSurface;

  constructor(opts: UiRoutesContextOptions) {
    this.statsService = opts.statsService;
    this.trend = opts.trend;
    this.uiConfig = opts.uiConfig;
    this.sseClients = opts.sseClients;
    this.broadcastUiConfigChanged = opts.broadcastUiConfigChanged;
    this.layerErrors = opts.layerErrors;
  }
}

export function createUiRoutes(
  routes: { health: string; trend: string; uiConfig: string; events: string },
  context: UiRoutesContext,
): WebRoute[] {
  return [
    {
      kind: "exact",
      path: routes.health,
      handler: (req, res) => handleHealth(req, res, context),
    },
    {
      kind: "exact",
      path: routes.trend,
      handler: (req, res) => handleTrend(req, res, context),
    },
    {
      kind: "exact",
      path: routes.uiConfig,
      handler: (req, res) => handleUiConfig(req, res, context),
    },
    {
      kind: "exact",
      path: routes.events,
      handler: (req, res) => handleEvents(req, res, context),
    },
  ];
}
