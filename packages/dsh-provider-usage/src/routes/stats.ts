/**
 * dsh-provider-usage — 用量统计与历史面板路由（GET /stats, GET /history）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { guardLoopbackMethod, writeJson } from "../../../../shared/host-utils.js";
import { ADAPTER_CONTRACT_VERSION } from "../contracts.ts";
import { isPanelCacheStale, panelCacheKey, runV2PanelPipeline } from "../pipeline/v2.ts";
import type { StatsService } from "../stats-service.ts";

export interface StatsRoutesContext {
  statsService: StatsService;
}

export async function handleStats(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: StatsRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["GET"])) return;
  const { statsService } = ctx;
  const url = new URL(req.url ?? "/", "http://localhost");
  const prov = url.searchParams.get("provider") ?? statsService.config.provider;
  const controller = new AbortController();
  let settled = false;

  const finish = (status: number, body: unknown): void => {
    if (settled) return;
    settled = true;
    if (!res.destroyed && !res.writableEnded) writeJson(res, status, body);
  };

  if (typeof res.on === "function") {
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
  }

  try {
    const result = await statsService.getStats(prov, controller.signal);
    finish(200, {
      plugin: "dsh-provider-usage",
      version: ADAPTER_CONTRACT_VERSION,
      provider: result.provider,
      adapterName: result.adapterName,
      status: result.status,
      capsuleHtml: result.capsuleHtml,
      ok: result.ok,
      configured: result.configured,
      reason: result.reason,
      error: result.error,
      fetchedAt: result.fetchedAt,
      adapterVersion: 0,
    });
  } catch {
    finish(504, { error: "stats timeout" });
  }
}

export async function handleHistory(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: StatsRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["GET"])) return;
  const { statsService } = ctx;
  const url = new URL(req.url ?? "/", "http://localhost");
  const prov = url.searchParams.get("provider") ?? statsService.config.provider;
  const entry = statsService.registry.getEntry(prov);

  if (entry === undefined) {
    const code = statsService.registry.hasCandidates(prov) ? "no-enabled-adapter" : "no-adapter";
    return writeJson(res, 200, {
      ok: false,
      plugin: "dsh-provider-usage",
      version: ADAPTER_CONTRACT_VERSION,
      provider: prov,
      adapterName: null,
      panelHtml: null,
      error: null,
      reason: code,
      range: { start: 0, end: 0 },
    });
  }

  const days = Number(url.searchParams.get("days"));
  const end = Date.now();
  const start = Number.isFinite(days) && days > 0
    ? end - Math.min(Math.round(days), statsService.config.maxAgeDays) * 86400000
    : end - 86400000;

  const cacheKey = panelCacheKey(prov, entry.name, { start, end });
  const hitEntry = statsService.panelCache.get(cacheKey);
  if (hitEntry !== undefined && !isPanelCacheStale(hitEntry, Date.now())) {
    return writeJson(res, 200, {
      ok: hitEntry.error === undefined,
      plugin: "dsh-provider-usage",
      version: ADAPTER_CONTRACT_VERSION,
      provider: prov,
      adapterName: entry.name,
      panelHtml: hitEntry.panelHtml,
      error: hitEntry.error ?? null,
      range: { start, end },
    });
  }

  statsService.panelCache.delete(cacheKey);
  const result = await runV2PanelPipeline({
    adapter: entry.adapter,
    provider: prov,
    history: statsService.history,
    range: { start, end },
    timeoutMs: statsService.config.fetchTimeoutMs,
  });

  if (result.error === undefined) {
    statsService.panelCache.set(cacheKey, { panelHtml: result.panelHtml, error: result.error, at: Date.now() });
  }

  writeJson(res, 200, {
    ok: result.error === undefined,
    plugin: "dsh-provider-usage",
    version: ADAPTER_CONTRACT_VERSION,
    provider: prov,
    adapterName: entry.name,
    panelHtml: result.panelHtml,
    error: result.error ?? null,
    range: { start, end },
  });
}

export function createStatsRoutes(
  routes: { stats: string; history: string },
  ctx: StatsRoutesContext,
): WebRoute[] {
  return [
    {
      kind: "exact",
      path: routes.stats,
      handler: (req, res) => handleStats(req, res, ctx),
    },
    {
      kind: "exact",
      path: routes.history,
      handler: (req, res) => handleHistory(req, res, ctx),
    },
  ];
}
