/**
 * dsh-provider-usage — 用量报告路由（server/report-routes 域，
 * #768 D11 由 domain2/routes/reports.ts 迁入，零行为变更）。
 *
 * 手动生成异步化：POST /reports/generate 立即返回 202 {taskId}（幂等短路时
 * 200 {meta, reused:true}），客户端经 GET /reports/generate/status 轮询；生成在
 * ReportTaskQueue 内串行执行，HTTP 响应与 LLM 耗时解耦。
 *
 * 依赖方向：配置服务与任务队列只经本域 deps.ts 窄口消费
 * （ReportRoutesConfigPort/ReportRoutesQueuePort），不经 apply 装配面；
 * 执行器由队列内嵌（server/execute 工厂在组合根装配），本文件不直引。
 * 调度面（preset/previous 纯函数 + read/update 读写）经 ReportRoutesContext
 * 注入（#768 B1：不直引 schedule 门面值边；纯函数不下沉 shared，DueReport
 * 语义留调度域；per-root 链唯一实现留 schedule 域，本域不自建第二条链）。
 * 配置面（normalize/read/默认表）与执行读面（index/路径）经 ReportRoutesContext
 * 注入（#768 B2：不直引 config/execute 门面值边；类型经门面以 type 复用）。
 */
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import {
  guardLoopbackMethod,
  readJsonBodyOutcome,
  writeJson,
} from "../../../../../shared/host-utils.js";
import type { ReportConfig, ReportPeriod } from "../config/interface.ts";
import type { ReportCycleMeta } from "../execute/interface.ts";
import type {
  DueReport,
  ReportStateCoordinator,
  RetryEntry,
  ReportTaskInput,
} from "../schedule/interface.ts";
import type { ReportRoutesConfigPort, ReportRoutesQueuePort } from "./deps.ts";

type ReportRouteQueue = ReportRoutesQueuePort & {
  submitForce?(input: ReportTaskInput): Promise<{ taskId: string; existing: boolean }>;
};

type ReportRetryView = {
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number | null;
  terminal: boolean;
  terminalReason: { code: string; kind: string } | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    durationMs: number | null;
  };
};
import { sanitizeHtml } from "../../shared/interface.ts";

export interface ReportRoutesContext {
  ctx: Context;
  historyRoot: string;
  /** 任务队列窄口（submit 入队去重；get 状态轮询；执行器由队列内嵌）。 */
  reportQueue: ReportRouteQueue;
  /** B2b retry state coordinator；缺省时保留旧 route fixture 契约。 */
  retryState?: ReportStateCoordinator;
  /** reportCfg 双源收口窄口（get 读内存权威；update 串行写盘+内存+scheduler 热更）。 */
  reportCfgService: ReportRoutesConfigPort;
  /**
   * 调度纯函数注入（#768 B1：不直引 schedule 门面值边；纯函数不下沉
   * shared，DueReport 语义留调度域）。
   */
  presetLastRunForNewlyEnabled: (
    prev: ReportConfig,
    next: ReportConfig,
    now: number,
    lastRun: Partial<Record<ReportPeriod, string>>,
  ) => { lastRun: Partial<Record<ReportPeriod, string>>; changed: boolean };
  previousClosedWindow: (period: ReportPeriod, cfg: ReportConfig, now: number) => DueReport;
  /**
   * lastRun 读写注入（per-root 临界区链唯一实现留 schedule 域 store.ts；
   * 路由 preset 与执行器推进共走同一条链，本域不自建第二条链，#768 B1）。
   */
  readLastRun: (root: string) => Promise<Partial<Record<ReportPeriod, string>>>;
  updateLastRun: (
    root: string,
    patch: (
      prev: Partial<Record<ReportPeriod, string>>,
    ) => Partial<Record<ReportPeriod, string>> | Promise<Partial<Record<ReportPeriod, string>>>,
  ) => Promise<void>;
  /**
   * 配置面注入（#768 B2：不直引 config 门面值边；归一化/磁盘读/默认表由组合根供给）。
   */
  normalizeReportConfig: (raw: unknown) => ReportConfig;
  readReportConfig: (root: string) => Promise<ReportConfig>;
  /**
   * 执行读面注入（#768 B2：不直引 execute 门面值边；只读查询闭包，实例不直引）。
   */
  readReportIndex: (root: string) => Promise<ReportCycleMeta[]>;
  reportHtmlFile: (root: string, period: ReportPeriod, key: string) => string;
  reportMetaFile: (root: string, period: ReportPeriod, key: string) => string;
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

function retryView(entry: RetryEntry): ReportRetryView {
  return {
    attempts: entry.attempts,
    maxAttempts: entry.maxAttempts,
    nextRetryAt: entry.nextRetryAt,
    terminal: entry.terminal,
    terminalReason:
      entry.reason === null ? null : { code: entry.reason.code, kind: entry.reason.kind },
    usage: { ...entry.usage },
  };
}

function stableFailureCode(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(code)) return code;
  }
  return fallback;
}

async function readStateLastRun(
  context: ReportRoutesContext,
): Promise<Partial<Record<ReportPeriod, string>>> {
  return context.retryState === undefined
    ? context.readLastRun(context.historyRoot)
    : context.retryState.readLastRun();
}

async function updateStateLastRun(
  context: ReportRoutesContext,
  patch: (
    previous: Partial<Record<ReportPeriod, string>>,
  ) => Partial<Record<ReportPeriod, string>> | Promise<Partial<Record<ReportPeriod, string>>>,
): Promise<void> {
  if (context.retryState !== undefined) {
    await context.retryState.updateLastRun(patch);
    return;
  }
  await context.updateLastRun(context.historyRoot, patch);
}

export async function handleReportConfig(
  req: IncomingMessage,
  res: ServerResponse,
  context: ReportRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["GET", "POST"])) return;
  const { ctx, historyRoot } = context;

  if (req.method === "GET") {
    const config = await context.readReportConfig(historyRoot);
    let providers: Array<{ id: string; name?: string }> = [];
    try {
      const listed = ctx.llm.listProviders();
      if (Array.isArray(listed)) {
        providers = listed
          .map((i) => i as { id?: unknown; name?: unknown } | null)
          .filter(
            (i): i is { id: string; name?: string } =>
              typeof (i as { id?: unknown })?.id === "string",
          )
          .map((i) => ({
            id: i.id as string,
            ...(typeof i.name === "string" ? { name: i.name } : {}),
          }));
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
    return writeJson(res, 200, {
      ok: true,
      config,
      providers,
      dirs,
      promptDefaults: context.reportCfgService.promptDefaults,
    });
  }

  // 读不出来的 body 不能当「没给配置」：normalizeReportConfig(undefined) 会回落**整套默认值**，
  // 于是畸形或超限的请求会把用户已存的报告配置静默重置（写盘 + 热更都照做）。
  // reasoningEffort wire：缺字段表示 unset；显式空串或非 string 在归一化前稳定返回 400。
  const outcome = await readJsonBodyOutcome(req);
  if (outcome.kind !== "json") return writeJson(res, 400, { error: "bad-json" });
  if (
    typeof outcome.value === "object" &&
    outcome.value !== null &&
    Object.hasOwn(outcome.value, "reasoningEffort")
  ) {
    const effort = (outcome.value as Record<string, unknown>).reasoningEffort;
    if (typeof effort !== "string" || effort.length === 0) {
      return writeJson(res, 400, { error: "invalid-reasoning-effort" });
    }
  }

  const normalized = context.normalizeReportConfig(outcome.value);
  const currentCfg = context.reportCfgService.get();
  // preset 写 lastRun 走单一临界区（写前重读），不与任务执行器推进互踩字段；
  // readLastRun 仅作 changed 预判（乐观跳过无变化时的写盘），真实快照在临界区内重读。
  const preset = context.presetLastRunForNewlyEnabled(
    currentCfg,
    normalized,
    Date.now(),
    await readStateLastRun(context),
  );
  if (preset.changed)
    await updateStateLastRun(
      context,
      (cur) =>
        context.presetLastRunForNewlyEnabled(currentCfg, normalized, Date.now(), cur).lastRun,
    );
  try {
    // 写盘 + 内存权威 + scheduler 热更由 ReportConfigService 串行收口（并发 POST 不交错）
    await context.reportCfgService.update(normalized);
  } catch {
    return writeJson(res, 500, { error: "persist-failed" });
  }
  writeJson(res, 200, { ok: true, config: normalized });
}

const REPORT_MODELS_DISCOVERY_TIMEOUT_MS = 5_000;
const REPORT_MODELS_DISCOVERY_TIMEOUT = Symbol("report-models-discovery-timeout");

/** 每个发现步骤独立计时；resolver 忽略取消时，race 仍在 5s 后稳定收敛。 */
async function withReportModelsDeadline<T>(start: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const pending = start(controller.signal);
  void pending.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(REPORT_MODELS_DISCOVERY_TIMEOUT);
    }, REPORT_MODELS_DISCOVERY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
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
  const requestedModel = url.searchParams.get("model");
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

  try {
    const models = await withReportModelsDeadline(() => ctx.llm.listModels(provider));
    const list = Array.isArray(models)
      ? (models as Array<{ id?: unknown; name?: unknown } | null>)
          .filter(
            (m): m is { id: string; name?: string } =>
              typeof m?.id === "string" && (m.id as string).length > 0,
          )
          .map((m) => ({
            id: m.id,
            ...(typeof m.name === "string" && m.name.length > 0 ? { name: m.name as string } : {}),
          }))
      : [];

    if (requestedModel === null) {
      writeJson(res, 200, { ok: true, models: list });
      return;
    }
    const selected = list.find((model) => model.id === requestedModel);
    if (selected === undefined) {
      writeJson(res, 200, { ok: false, reason: "unknown-model" });
      return;
    }

    try {
      const info = await withReportModelsDeadline((signal) =>
        ctx.llm.resolveModelInfo(provider, selected.id, signal),
      );
      const selectedModel: {
        id: string;
        name?: string;
        reasoning?: {
          efforts: Array<{ id: string; name: string; description?: string }>;
          defaultEffort?: string;
        };
      } = { id: selected.id };
      if (typeof info.name === "string" && info.name.length > 0) {
        selectedModel.name = info.name;
      } else if (selected.name !== undefined) {
        selectedModel.name = selected.name;
      }
      if (info.reasoning !== undefined) {
        selectedModel.reasoning = {
          efforts: info.reasoning.efforts.map((effort) => ({
            id: effort.id,
            name: effort.name,
            ...(typeof effort.description === "string" ? { description: effort.description } : {}),
          })),
          ...(info.reasoning.defaultEffort !== undefined
            ? { defaultEffort: info.reasoning.defaultEffort }
            : {}),
        };
      }
      writeJson(res, 200, { ok: true, models: list, selectedModel });
    } catch {
      writeJson(res, 200, {
        ok: true,
        models: list,
        selectedModel: { id: selected.id, capabilityError: true },
      });
    }
  } catch (error: unknown) {
    writeJson(res, 200, {
      ok: false,
      reason: error === REPORT_MODELS_DISCOVERY_TIMEOUT ? "discover-timeout" : "discover-failed",
    });
  }
}

export async function handleReports(
  req: IncomingMessage,
  res: ServerResponse,
  context: ReportRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["GET"])) return;
  const list = await context.readReportIndex(context.historyRoot);
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
    html = sanitizeHtml(
      await readFile(context.reportHtmlFile(historyRoot, period as ReportPeriod, key), "utf8"),
    );
  } catch {
    return writeJson(res, 404, { error: "report-not-found" });
  }

  let meta: unknown;
  try {
    meta = JSON.parse(
      await readFile(context.reportMetaFile(historyRoot, period as ReportPeriod, key), "utf8"),
    );
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

  const outcome = await readJsonBodyOutcome(req);
  if (outcome.kind !== "json") return writeJson(res, 400, { error: "bad-json" });
  const body = outcome.value as Record<string, unknown>;

  const period = body.period;
  if (typeof period !== "string" || !isReportPeriodValid(period)) {
    return writeJson(res, 400, { error: "invalid-period" });
  }
  // force 必须严格 === true 才生效（防御 "force":"false" 等字符串形态）
  const force = body.force === true;

  // 手动生成恒定锚定已闭环的上一完整周期（日报=昨天全天，消灭凌晨漂移；不检查 enabled）
  const due = context.previousClosedWindow(
    period as ReportPeriod,
    reportCfgService.get(),
    Date.now(),
  );

  // 幂等短路：窗口已有成功报告且非强制重生成 → 直接复用，不产生新任务
  if (!force) {
    const existing = (await context.readReportIndex(historyRoot)).find(
      (m) => m.period === due.period && m.key === due.key && m.ok === true,
    );
    if (existing !== undefined) {
      if (context.retryState !== undefined) {
        try {
          await context.retryState.reconcileIndex({
            period: due.period,
            key: due.key,
            indexed: true,
            cycleId: existing.cycleId,
          });
        } catch {
          return writeJson(res, 503, { ok: false, error: "retry-state-unavailable" });
        }
      }
      return writeJson(res, 200, { ok: true, meta: existing, reused: true });
    }
    if (context.retryState !== undefined) {
      let entry: RetryEntry | undefined;
      try {
        entry = await context.retryState.get(due.period, due.key);
      } catch {
        return writeJson(res, 503, { ok: false, error: "retry-state-unavailable" });
      }
      if (entry !== undefined) {
        if (entry.terminal) {
          return writeJson(res, 409, {
            ok: false,
            status: "terminal",
            reason: entry.reason?.code ?? "terminal",
            retry: retryView(entry),
          });
        }
        return writeJson(res, 409, {
          ok: false,
          status: entry.phase === "in-flight" ? "busy" : "deferred",
          reason: "retry-in-progress",
          retry: retryView(entry),
        });
      }
    }
  }

  if (force && reportQueue.submitForce !== undefined) {
    try {
      const submitted = await reportQueue.submitForce({ ...due, force: true });
      return writeJson(res, 202, { ok: true, taskId: submitted.taskId });
    } catch (error: unknown) {
      return writeJson(res, 503, {
        ok: false,
        error: stableFailureCode(error, "force-unavailable"),
      });
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
  let retry: ReportRetryView | undefined;
  if (context.retryState !== undefined) {
    try {
      const entry = await context.retryState.get(task.period, task.key);
      if (entry !== undefined) retry = retryView(entry);
    } catch {
      return writeJson(res, 503, { ok: false, error: "retry-state-unavailable" });
    }
  }
  writeJson(res, 200, {
    ok: true,
    status: task.status,
    ...(task.status === "done" && task.meta !== undefined ? { meta: task.meta } : {}),
    ...(task.status === "done" && task.reused === true ? { reused: true } : {}),
    ...(task.status === "failed" ? { error: task.error ?? "生成失败" } : {}),
    ...(retry !== undefined ? { retry } : {}),
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
