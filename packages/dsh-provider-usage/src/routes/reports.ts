/**
 * dsh-provider-usage — 用量报告路由（配置读写、模型发现、历史索引、详情、手动生成）。
 */
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { Mutex } from "async-mutex";
import { guardLoopbackMethod, readJsonBody, writeJson } from "../../../../shared/host-utils.js";
import {
  DEFAULT_PROMPTS,
  normalizeReportConfig,
  readReportConfig,
  writeReportConfig,
  type ReportConfig,
  type ReportPeriod,
} from "../report/config.ts";
import { readReportIndex, reportHtmlFile, reportMetaFile } from "../report/runner.ts";
import { candidateWindow, presetLastRunForNewlyEnabled, previousClosedWindow, type DueReport } from "../report/schedule.ts";
import { readLastRun, writeLastRun, type ReportScheduler } from "../report/scheduler.ts";
import { sanitizeHtml } from "../sanitize.ts";

export interface ReportRoutesContext {
  ctx: Context;
  historyRoot: string;
  reportMutex: Mutex;
  getReportCfg: () => ReportConfig;
  setReportCfg: (cfg: ReportConfig) => void;
  reportScheduler: ReportScheduler;
  runDue: (due: DueReport) => Promise<unknown>;
}

const REPORT_KEY_RES: Record<ReportPeriod, RegExp> = {
  daily: /^\d{4}-\d{2}-\d{2}$/,
  weekly: /^\d{4}-\d{2}-\d{2}$/,
  monthly: /^\d{4}-\d{2}$/,
};
const REPORT_PERIODS = new Set<ReportPeriod>(["daily", "weekly", "monthly"]);

export async function handleReportConfig(
  req: IncomingMessage,
  res: ServerResponse,
  context: ReportRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["GET", "POST"])) return;
  const { ctx, historyRoot, getReportCfg, setReportCfg, reportScheduler } = context;

  if (req.method === "GET") {
    const config = await readReportConfig(historyRoot);
    let providers: Array<{ id: string; name?: string }> = [];
    try {
      const listed = ctx.llm.listProviders();
      if (Array.isArray(listed)) {
        providers = listed
          .map((i) => (i as { id?: unknown; name?: unknown } | null))
          .filter((i): i is { id: string; name?: string } => typeof (i as { id?: unknown })?.id === "string")
          .map((i) => ({ id: i.id as string, ...(typeof i.name === "string" ? { name: i.name } : {}) }));
      }
    } catch {
      // 回落空数组
    }
    return writeJson(res, 200, { ok: true, config, providers, promptDefaults: DEFAULT_PROMPTS });
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return writeJson(res, 400, { error: "bad-json" });
  }

  const normalized = normalizeReportConfig(body);
  const currentCfg = getReportCfg();
  const preset = presetLastRunForNewlyEnabled(currentCfg, normalized, Date.now(), await readLastRun(historyRoot));
  if (preset.changed) await writeLastRun(historyRoot, preset.lastRun);
  try {
    await writeReportConfig(historyRoot, normalized);
  } catch {
    return writeJson(res, 500, { error: "persist-failed" });
  }
  setReportCfg(normalized);
  reportScheduler.updateConfig(normalized);
  writeJson(res, 200, { ok: true, config: normalized });
}

export async function handleReportModels(
  req: IncomingMessage,
  res: ServerResponse,
  context: ReportRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["GET"])) return;
  const { ctx } = context;
  const url = new URL(req.url ?? "/", "http://localhost");
  const provider = url.searchParams.get("provider") ?? "";
  const known = (() => {
    try {
      return ctx.llm.listProviders().some((i) => (i as { id?: unknown })?.id === provider);
    } catch {
      return false;
    }
  })();
  if (provider.length === 0 || !known) {
    return writeJson(res, 200, { ok: false, reason: "unknown-provider" });
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const pending = ctx.llm.listModels(provider);
    pending.catch(() => {});
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("discover-timeout")), 5000);
    });
    const models = await Promise.race([pending, timeout]);
    const list = Array.isArray(models)
      ? (models as Array<{ id?: unknown; name?: unknown } | null>)
          .filter((m): m is { id: string; name?: string } =>
            typeof m?.id === "string" && (m.id as string).length > 0)
          .map((m) => ({ id: m.id, ...(typeof m.name === "string" && m.name.length > 0 ? { name: m.name as string } : {}) }))
      : [];
    writeJson(res, 200, { ok: true, models: list });
  } catch (e: unknown) {
    writeJson(res, 200, { ok: false, reason: e instanceof Error ? e.message : "discover-failed" });
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function handleReports(
  req: IncomingMessage,
  res: ServerResponse,
  context: ReportRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["GET"])) return;
  const list = await readReportIndex(context.historyRoot);
  writeJson(res, 200, { ok: true, reports: list });
}

export async function handleReportDetail(
  req: IncomingMessage,
  res: ServerResponse,
  context: ReportRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["GET"])) return;
  const { historyRoot } = context;
  const url = new URL(req.url ?? "/", "http://localhost");
  const period = url.searchParams.get("period") ?? "";
  const key = url.searchParams.get("key") ?? "";
  if (!REPORT_PERIODS.has(period as ReportPeriod)) {
    return writeJson(res, 400, { error: "invalid-period" });
  }
  if (!REPORT_KEY_RES[period as ReportPeriod].test(key)) {
    return writeJson(res, 400, { error: "invalid-key" });
  }

  let html: string;
  try {
    html = sanitizeHtml(await readFile(reportHtmlFile(historyRoot, period as ReportPeriod, key), "utf8"));
  } catch {
    return writeJson(res, 404, { error: "report-not-found" });
  }

  let meta: unknown;
  try {
    meta = JSON.parse(await readFile(reportMetaFile(historyRoot, period as ReportPeriod, key), "utf8"));
  } catch {
    return writeJson(res, 404, { error: "report-not-found" });
  }
  writeJson(res, 200, { ok: true, html, meta });
}

export async function handleReportGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  context: ReportRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["POST"])) return;
  const { historyRoot, reportMutex, getReportCfg, runDue } = context;

  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(req);
    if (typeof raw !== "object" || raw === null) return writeJson(res, 400, { error: "bad-json" });
    body = raw as Record<string, unknown>;
  } catch {
    return writeJson(res, 400, { error: "bad-json" });
  }

  const period = body.period;
  if (typeof period !== "string" || !REPORT_PERIODS.has(period as ReportPeriod)) {
    return writeJson(res, 400, { error: "invalid-period" });
  }

  // 手动生成恒定锚定已闭环的上一完整周期（日报=昨天全天，消灭凌晨漂移；不检查 enabled）
  const due = previousClosedWindow(period as ReportPeriod, getReportCfg(), Date.now());
  try {
    const meta = await reportMutex.runExclusive(() => runDue(due));
    const lastRun = await readLastRun(historyRoot);
    lastRun[due.period] = due.key;
    await writeLastRun(historyRoot, lastRun);
    writeJson(res, 200, { ok: true, meta });
  } catch (e: unknown) {
    writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export function createReportRoutes(
  routes: {
    reportConfig: string;
    reportModels: string;
    reports: string;
    reportDetail: string;
    reportGenerate: string;
  },
  context: ReportRoutesContext,
): WebRoute[] {
  return [
    {
      kind: "exact",
      path: routes.reportConfig,
      handler: (req, res) => handleReportConfig(req, res, context),
    },
    {
      kind: "exact",
      path: routes.reportModels,
      handler: (req, res) => handleReportModels(req, res, context),
    },
    {
      kind: "exact",
      path: routes.reports,
      handler: (req, res) => handleReports(req, res, context),
    },
    {
      kind: "exact",
      path: routes.reportDetail,
      handler: (req, res) => handleReportDetail(req, res, context),
    },
    {
      kind: "exact",
      path: routes.reportGenerate,
      handler: (req, res) => handleReportGenerate(req, res, context),
    },
  ];
}
