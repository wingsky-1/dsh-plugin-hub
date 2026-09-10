/**
 * dsh-provider-usage — 用量报告路由（配置读写、模型发现、历史索引、详情、手动生成）。
 *
 * 手动生成异步化：POST /reports/generate 立即返回 202 {taskId}（幂等短路时
 * 200 {meta, reused:true}），客户端经 GET /reports/generate/status 轮询；生成在
 * ReportTaskQueue 内串行执行，HTTP 响应与 LLM 耗时解耦。
 */
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { guardLoopbackMethod, readJsonBody, writeJson } from "../../../../../shared/host-utils.js";
import {
  DEFAULT_PROMPTS,
  normalizeReportConfig,
  readReportConfig,
  writeReportConfig,
  type ReportConfig,
  type ReportPeriod,
} from "../schedule/interface.ts";
import { readReportIndex, reportHtmlFile, reportMetaFile } from "../execute/interface.ts";
import { presetLastRunForNewlyEnabled, previousClosedWindow, type DueReport } from "../schedule/interface.ts";
import { readLastRun, updateLastRun } from "../common/interface.ts";
import type { ReportTaskQueue } from "../schedule/interface.ts";
import type { ReportConfigService } from "../../apply/interface.ts";
import { sanitizeHtml } from "../../shared/interface.ts";

export interface ReportRoutesContext {
  ctx: Context;
  historyRoot: string;
  reportQueue: ReportTaskQueue;
  /** reportCfg 双源收口（get 读内存权威；update 串行写盘+内存+scheduler 热更）。 */
  reportCfgService: ReportConfigService;
  /**
   * 目录候选清单：GET /report-config 附带 dirs（trend.dirTotals
   * 全留存窗口聚合，含未识别桶），设置页目录范围多选的数据源。可选——测试/无趋势
   * 数据场景缺省返回空数组（多选控件降级为「仅全部」+ 已保存值回显）。
   */
  listDirs?: () => Array<{ dir: string; calls: number; total: number | null }>;
}

const REPORT_KEY_RES: Record<ReportPeriod, RegExp> = {
  daily: /^\d{4}-\d{2}-\d{2}$/,
  weekly: /^\d{4}-\d{2}-\d{2}$/,
  monthly: /^\d{4}-\d{2}$/,
};
const REPORT_PERIODS = new Set<ReportPeriod>(["daily", "weekly", "monthly"]);
/** taskId 白名单（uuid v4）。 */
const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 报告周期白名单（period 合法性独立校验，保持 invalid-period/invalid-key 双错误码语义）。 */
export function isReportPeriodValid(period: string): boolean {
  return REPORT_PERIODS.has(period as ReportPeriod);
}

/** 报告窗口键合法性（period+key 双白名单；抽离供路由与单测共用，变异段前置）。 */
export function isReportKeyValid(period: string, key: string): boolean {
  if (!REPORT_PERIODS.has(period as ReportPeriod)) return false;
  return REPORT_KEY_RES[period as ReportPeriod].test(key);
}

/** 生成任务 taskId 合法性（uuid v4 白名单；抽离供路由与单测共用）。 */
export function isTaskIdValid(taskId: string): boolean {
  return TASK_ID_RE.test(taskId);
}

export async function handleReportConfig(
  req: IncomingMessage,
  res: ServerResponse,
  context: ReportRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["GET", "POST"])) return;
  const { ctx, historyRoot } = context;

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
    // 目录候选（calls 降序全留存聚合，含未识别桶键）；异常不连坐
    // 配置读取（清单失败 → 空数组，多选控件降级，配置本身照常返回）。
    let dirs: Array<{ dir: string }> = [];
    try {
      dirs = (context.listDirs?.() ?? []).map((r) => ({ dir: r.dir }));
    } catch {
      dirs = [];
    }
    return writeJson(res, 200, { ok: true, config, providers, dirs, promptDefaults: DEFAULT_PROMPTS });
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return writeJson(res, 400, { error: "bad-json" });
  }

  const normalized = normalizeReportConfig(body);
  const currentCfg = context.reportCfgService.get();
  // preset 写 lastRun 走单一临界区（写前重读），不与任务执行器推进互踩字段；
  // readLastRun 仅作 changed 预判（乐观跳过无变化时的写盘），真实快照在临界区内重读。
  const preset = presetLastRunForNewlyEnabled(currentCfg, normalized, Date.now(), await readLastRun(historyRoot));
  if (preset.changed) await updateLastRun(historyRoot, (cur) => presetLastRunForNewlyEnabled(currentCfg, normalized, Date.now(), cur).lastRun);
  try {
    // 写盘 + 内存权威 + scheduler 热更由 ReportConfigService 串行收口（并发 POST 不交错）
    await context.reportCfgService.update(normalized);
  } catch {
    return writeJson(res, 500, { error: "persist-failed" });
  }
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
  if (!isReportPeriodValid(period)) {
    return writeJson(res, 400, { error: "invalid-period" });
  }
  if (!isReportKeyValid(period, key)) {
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
  const { historyRoot, reportQueue, reportCfgService } = context;

  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(req);
    if (typeof raw !== "object" || raw === null) return writeJson(res, 400, { error: "bad-json" });
    body = raw as Record<string, unknown>;
  } catch {
    return writeJson(res, 400, { error: "bad-json" });
  }

  const period = body.period;
  if (typeof period !== "string" || !isReportPeriodValid(period)) {
    return writeJson(res, 400, { error: "invalid-period" });
  }
  // force 必须严格 === true 才生效（防御 "force":"false" 等字符串形态）
  const force = body.force === true;

  // 手动生成恒定锚定已闭环的上一完整周期（日报=昨天全天，消灭凌晨漂移；不检查 enabled）
  const due = previousClosedWindow(period as ReportPeriod, reportCfgService.get(), Date.now());

  // 幂等短路：窗口已有成功报告且非强制重生成 → 直接复用，不产生新任务
  if (!force) {
    const existing = (await readReportIndex(historyRoot)).find(
      (m) => m.period === due.period && m.key === due.key && m.ok === true,
    );
    if (existing !== undefined) {
      return writeJson(res, 200, { ok: true, meta: existing, reused: true });
    }
  }

  const { taskId } = reportQueue.submit({ ...due, force });
  writeJson(res, 202, { ok: true, taskId });
}

export async function handleReportStatus(
  req: IncomingMessage,
  res: ServerResponse,
  context: ReportRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["GET"])) return;
  const { reportQueue } = context;
  const url = new URL(req.url ?? "/", "http://localhost");
  const taskId = url.searchParams.get("taskId") ?? "";
  if (!isTaskIdValid(taskId)) return writeJson(res, 404, { error: "task-not-found" });
  const task = reportQueue.get(taskId);
  if (task === undefined) return writeJson(res, 404, { error: "task-not-found" });
  writeJson(res, 200, {
    ok: true,
    status: task.status,
    ...(task.status === "done" && task.meta !== undefined ? { meta: task.meta } : {}),
    // executor 侧幂等短路复用时透出 reused，客户端轮询路径与 200 直接复用路径提示对称
    ...(task.status === "done" && task.reused === true ? { reused: true } : {}),
    ...(task.status === "failed" ? { error: task.error ?? "生成失败" } : {}),
  });
}

export function createReportRoutes(
  routes: {
    reportConfig: string;
    reportModels: string;
    reports: string;
    reportDetail: string;
    reportGenerate: string;
    reportGenerateStatus: string;
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
    {
      kind: "exact",
      path: routes.reportGenerateStatus,
      handler: (req, res) => handleReportStatus(req, res, context),
    },
  ];
}
