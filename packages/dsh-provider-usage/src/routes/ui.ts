/**
 * dsh-provider-usage — 健康检查、趋势图、UI 配置与 SSE 事件路由。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { guardLoopbackMethod, readJsonBody, writeJson } from "../../../../shared/host-utils.js";
import { ADAPTER_CONTRACT_VERSION } from "../contracts.ts";
import type { StatsService } from "../stats-service.ts";
import type { TrendTracker } from "../trend/index.ts";
import { normalizeUiConfig, writeUiConfig, type UiPlacementConfig } from "../ui-config.ts";

export interface UiRoutesContext {
  statsService: StatsService;
  trend: TrendTracker;
  uiConfig: UiPlacementConfig;
  sseClients: Set<ServerResponse>;
  broadcastUiConfigChanged: () => void;
}

const TREND_WINDOW: Record<string, number> = { day: 30, week: 12, month: 12 };
const TREND_METRICS = new Set(["total", "input", "output", "cacheRead", "cacheWrite", "calls"]);

export function clampTrendN(raw: string | null, gran: "day" | "week" | "month", retention: number): number {
  const cap = gran === "day" ? retention : gran === "week" ? Math.ceil(retention / 7) : Math.ceil(retention / 30);
  const parsed = raw === null || raw === "" ? NaN : Number(raw);
  const n = Number.isInteger(parsed) && parsed > 0 ? parsed : TREND_WINDOW[gran] ?? 30;
  return Math.min(n, cap);
}

export function handleHealth(
  req: IncomingMessage,
  res: ServerResponse,
  context: UiRoutesContext,
): void {
  if (!guardLoopbackMethod(req, res, ["GET"])) return;
  const { statsService, trend } = context;
  const snap = statsService.registry.snapshot();

  writeJson(res, 200, {
    ok: true,
    plugin: "dsh-provider-usage",
    version: ADAPTER_CONTRACT_VERSION,
    provider: statsService.config.provider,
    cacheSize: statsService.cache.size,
    adapters: snap.infos.map((i) => ({
      name: i.name,
      label: i.label,
      providers: i.providers,
      source: i.source,
      enabled: i.enabled,
      file: i.file !== undefined ? basename(i.file) : undefined,
    })),
    enabled: snap.enabled,
    errors: snap.errors,
    historyDir: statsService.historyRoot,
    trend: trend.stats(),
  });
}

export function handleTrend(
  req: IncomingMessage,
  res: ServerResponse,
  context: UiRoutesContext,
): void {
  if (!guardLoopbackMethod(req, res, ["GET"])) return;
  const { statsService, trend } = context;
  const url = new URL(req.url ?? "/", "http://localhost");
  const g = url.searchParams.get("granularity") ?? "day";
  const granularity = g === "week" || g === "month" ? g : "day";
  const m = url.searchParams.get("metric") ?? "total";
  const metric = TREND_METRICS.has(m)
    ? (m as "total" | "input" | "output" | "cacheRead" | "cacheWrite" | "calls")
    : "total";
  const providerParam = url.searchParams.get("provider") ?? "";
  const provider = providerParam.length > 0 && providerParam.length <= 128 ? providerParam : undefined;
  // #633 分片 b B1：可选目录过滤（GET query，风格与 provider 参数一致）——
  // 非空且 ≤128 字符按目录键过滤（basename 净化值或未识别桶键）；未传/非法
  // （空串/超长）→ undefined = 全目录聚合，行为与现状完全一致（非法回退不 400）。
  // dir 与 provider 面分流：传 dir → 目录维度查询面；未传 → provider 维度
  // 原查询面（provider/byModel 参数语义原样保留，响应形状零变化）。
  const dirParam = url.searchParams.get("dir") ?? "";
  const dir = dirParam.length > 0 && dirParam.length <= 128 ? dirParam : undefined;
  const byModel = url.searchParams.get("byModel") === "1";
  const n = clampTrendN(url.searchParams.get("n"), granularity, statsService.config.trendRetentionDays);
  const byDir = dir !== undefined;
  // #633 分片 b B1：dir 面与 provider 面的 stack 形状归一（两分支字段并集）——
  // 未过滤分支响应含 providers 图例（现状形状零变化），过滤分支含 dirs 目录图例。
  const stack = byDir
    ? { ...trend.dirStacked(n, granularity, metric, dir), providers: [] as Array<{ provider: string; model: string | null }> }
    : { ...trend.seriesStacked(n, granularity, metric, provider, byModel), dirs: [] as Array<{ dir: string }> };
  const summary = byDir
    ? trend.dirWindowSummary(n, granularity, metric, dir, stack.series)
    : trend.windowSummary(n, granularity, metric, provider, byModel ? undefined : stack.series);

  writeJson(res, 200, {
    ok: true,
    plugin: "dsh-provider-usage",
    version: ADAPTER_CONTRACT_VERSION,
    granularity,
    metric,
    provider: provider ?? null,
    // #633 分片 b B1：目录过滤回显（null = 未过滤 = 现状形状）；dirs 由 stack
    // 归一形状携带（过滤分支 = 窗口内目录图例，含未识别桶；dir 落盘即 basename
    // 净化值，无路径分隔符）。
    dir: dir ?? null,
    byModel,
    n,
    retentionDays: statsService.config.trendRetentionDays,
    ...stack,
    summary,
    firstDay: trend.firstRecordedDay(),
    generatedAt: Date.now(),
  });
}

export async function handleUiConfig(
  req: IncomingMessage,
  res: ServerResponse,
  context: UiRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["GET", "POST"])) return;
  const { statsService, uiConfig, broadcastUiConfigChanged } = context;

  if (req.method === "GET") {
    writeJson(res, 200, { ok: true, ui: uiConfig });
    return;
  }

  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(req);
    if (typeof raw !== "object" || raw === null) return writeJson(res, 400, { error: "bad-json" });
    body = raw as Record<string, unknown>;
  } catch {
    return writeJson(res, 400, { error: "bad-json" });
  }

  const next = normalizeUiConfig(body);
  Object.assign(uiConfig, next);
  try {
    await writeUiConfig(statsService.historyRoot, uiConfig);
  } catch {
    return writeJson(res, 500, { error: "persist-failed" });
  }
  broadcastUiConfigChanged();
  writeJson(res, 200, { ok: true, ui: uiConfig });
}

export function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  context: UiRoutesContext,
): void {
  if (!guardLoopbackMethod(req, res, ["GET"])) return;
  const { sseClients } = context;

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  sseClients.add(res);
  res.on("close", () => {
    sseClients.delete(res);
  });
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
