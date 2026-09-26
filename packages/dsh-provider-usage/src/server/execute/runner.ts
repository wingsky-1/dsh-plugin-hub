/**
 * dsh-provider-usage — server/execute 域：报告生成执行器与索引读取辅助
 * （#768 D3，由 domain2/execute/runner.ts 搬入，零行为变更）。
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { errorMessage } from "../../../../../shared/host-utils.js";
import { dayKey, escHtml } from "../../shared/interface.ts";
import { metricValue } from "../shared/interface.ts";
import type { TrendTracker } from "../aggregate/interface.ts";
import { sumToken, type TrendCell } from "../shared/interface.ts";
import type { ReportConfig, ReportPeriod } from "../config/interface.ts";
import { reportBodyToHtml } from "./format.ts";
import {
  buildStatsSnapshot,
  generateReportOutcome,
  type GenerateReportAttempt,
  type GenerateRouteOutcome,
  type ReportMeta,
  type ReportMetaSummary,
  type ReportResult,
  type ReportStatsSnapshot,
  type ReportTokenUsage,
} from "./generate.ts";
import type {
  DueReport,
  RetryAttemptObservation,
  RetryAttemptTokens,
  RetryFailure,
  RetryRouteSnapshot,
  RetryUsageTotals,
} from "../schedule/interface.ts";
export type { RetryFailure, RetryRouteSnapshot };
import { parseReportIndexLines } from "./report-index.ts";

export function reportsDir(root: string): string {
  return join(root, "reports");
}

export function reportIndexFile(root: string): string {
  return join(root, "reports", "index.jsonl");
}

/** index 中可带事务 cycle token；旧记录没有该字段，仍只可复用，不可证明同 cycle。 */
export interface ReportCycleMeta extends ReportMeta {
  cycleId?: string;
}

// 解析记忆化缓存（readReportIndex 专用；键=historyRoot，值=stat 失效键+投影）。
interface IndexCacheEntry {
  stamp: string;
  value: ReportCycleMeta[];
}
const indexCache = new Map<string, IndexCacheEntry>();
// 命中/未命中计数（测试可观测：确定性证明「重复读不再重解析」，不依赖时钟度量）
let indexCacheHits = 0;
let indexCacheMisses = 0;

/** 测试隔离钩子：清空解析缓存与计数（防同进程多测试块跨 root 残留；生产路径无需调用）。 */
export function __clearReportIndexCacheForTests(): void {
  indexCache.clear();
  indexCacheHits = 0;
  indexCacheMisses = 0;
}

/** 测试观测钩子：缓存命中/未命中计数（连续读 hits 只增 1 次 miss）。 */
export function __reportIndexCacheStatsForTests(): { hits: number; misses: number } {
  return { hits: indexCacheHits, misses: indexCacheMisses };
}

export function reportHtmlFile(root: string, period: ReportPeriod, key: string): string {
  return join(root, "reports", `${period}-${key}.html`);
}

export function reportMetaFile(root: string, period: ReportPeriod, key: string): string {
  return join(root, "reports", `${period}-${key}.meta.json`);
}

function shiftDayKey(key: string, n: number): string {
  const [y, mo, d] = key.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  dt.setDate(dt.getDate() + n);
  return dayKey(dt.getTime());
}

function windowDayCount(startDay: string, endDay: string): number {
  return Math.round((Date.parse(endDay) - Date.parse(startDay)) / 86400000) + 1;
}

/** 环比基准：同长度窗口整体前移（[startDay-len, startDay-1]）的 total 求和（null-aware）。 */
export function prevWindowTotal(
  buckets: Array<{
    day: string;
    providers: Array<{ provider: string; model: string | null; cell: TrendCell }>;
  }>,
  startDay: string,
  endDay: string,
): number | null {
  const len = windowDayCount(startDay, endDay);
  const prevStart = shiftDayKey(startDay, -len);
  const prevEnd = shiftDayKey(startDay, -1);
  let acc: number | null = null;
  for (const { day, providers } of buckets) {
    if (day < prevStart || day > prevEnd) continue;
    for (const { cell } of providers) acc = sumToken(acc, metricValue(cell, "total"));
  }
  return acc;
}

export function summaryOf(snapshot: ReportStatsSnapshot): ReportMetaSummary {
  return {
    total: snapshot.totals.total,
    calls: snapshot.totals.calls,
    activeDays: snapshot.activeDays,
    windowDays: snapshot.windowDays,
    longestStreak: snapshot.longestStreak,
    wowRatio: snapshot.wowRatio,
    peakDay: snapshot.peakDay,
    peakHour: snapshot.peakHour,
  };
}

export function optionalNotifier(ctx: Context): {
  send: (req: {
    source: string;
    kind: string;
    severity: string;
    title: string;
    body: string;
  }) => Promise<unknown>;
  registerKind?: (reg: { id: string; label: string }) => unknown;
} | null {
  try {
    const n = (ctx as { get?: (name: string, strict?: boolean) => unknown }).get?.(
      "wingsky.notifier",
      false,
    );
    if (
      n !== null &&
      typeof n === "object" &&
      typeof (n as { send?: unknown }).send === "function"
    ) {
      return n as {
        send: (req: {
          source: string;
          kind: string;
          severity: string;
          title: string;
          body: string;
        }) => Promise<unknown>;
        registerKind?: (reg: { id: string; label: string }) => unknown;
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function notifyReport(
  ctx: Context,
  reportCfg: ReportConfig,
  meta: ReportMeta,
  snapshot: ReportStatsSnapshot,
  sanitizeDiagnostic: (s: string) => string,
): void {
  if (!reportCfg.push.enabled) return;
  const notifier = optionalNotifier(ctx);
  if (notifier === null) return;
  const total = snapshot.totals.total;
  const body = `${meta.period} ${meta.key}（${meta.startDay} ~ ${meta.endDay}）：token 总量 ${
    total === null ? "无数据" : total.toLocaleString("en-US")
  }，调用 ${snapshot.totals.calls} 次。详情见 dsh 设置页用量报告。`;
  const warnPushFailure = (e: unknown): void => {
    console.warn(
      `[dsh-provider-usage] report: 推送失败（不影响主流程）：${sanitizeDiagnostic(errorMessage(e))}`,
    );
  };
  try {
    notifier
      .send({
        source: "@wingsky-1/dsh-provider-usage",
        kind: "provider-usage:report",
        severity: "info",
        title: "用量报告",
        body,
      })
      .catch(warnPushFailure);
  } catch (e: unknown) {
    warnPushFailure(e);
  }
}

function reportHtmlDocument(meta: ReportMeta, bodyText: string): string {
  const title = `${meta.period} ${meta.key} 用量报告`;
  return [
    "<!doctype html>",
    `<html lang="zh-CN"><head><meta charset="utf-8"><title>${escHtml(title)}</title></head>`,
    `<body><article class="dou-report-body">${reportBodyToHtml(bodyText)}</article></body></html>`,
  ].join("");
}

export async function persistReport(
  historyRoot: string,
  meta: ReportMeta,
  bodyText: string,
  cycleId?: string,
): Promise<void> {
  const dir = reportsDir(historyRoot);
  const htmlFile = reportHtmlFile(historyRoot, meta.period, meta.key);
  const metaFile = reportMetaFile(historyRoot, meta.period, meta.key);
  const indexFile = reportIndexFile(historyRoot);

  await mkdir(dir, { recursive: true });
  const tmpHtml = `${htmlFile}.${Date.now()}.tmp`;
  await writeFile(tmpHtml, reportHtmlDocument(meta, bodyText), { mode: 0o600 });
  await rename(tmpHtml, htmlFile);

  const tmpMeta = `${metaFile}.${Date.now()}.tmp`;
  await writeFile(tmpMeta, JSON.stringify(meta, null, 2), { mode: 0o600 });
  await rename(tmpMeta, metaFile);

  const indexedMeta: ReportCycleMeta = cycleId === undefined ? meta : { ...meta, cycleId };
  await appendFile(indexFile, `${JSON.stringify(indexedMeta)}\n`, { mode: 0o600 });
}

export interface RunDueReportParams {
  due: DueReport;
  trend: TrendTracker;
  ctx: Context;
  reportCfg: ReportConfig;
  promptTemplate: string;
  historyRoot: string;
  sanitizeDiagnostic: (s: string) => string;
  route?: GenerateRouteOutcome;
  /** B3a internal seam: record the observation before report files are written. */
  attemptNumber?: number;
  /** 内部取消信号；仅透传到唯一模型生成边界。 */
  signal?: AbortSignal;
  onAttempt?: (observation: RetryAttemptObservation) => Promise<RetryUsageTotals | null>;
  /** 读取当前 cycle 已持久化累计事实；noData 不产生新 attempt。 */
  getUsage?: () => RetryUsageTotals | null;
}

export type RunDueReportOutcome =
  | { status: "success"; result: ReportResult; attempt?: GenerateReportAttempt }
  | {
      status: "failure";
      failure: RetryFailure;
      result?: ReportResult;
      attempt?: GenerateReportAttempt;
    };

const REPORT_STORAGE_FAILURE = {
  kind: "storage",
  code: "report-persist-failed",
} as const satisfies RetryFailure;

const REPORT_CYCLE_CONFLICT_FAILURE = {
  kind: "unknown",
  code: "retry-cycle-conflict",
} as const satisfies RetryFailure;

const REPORT_OBSERVATION_STORAGE_FAILURE = {
  kind: "storage",
  code: "retry-observation-storage",
} as const satisfies RetryFailure;

function retryTokens(value: ReportTokenUsage | null): RetryAttemptTokens {
  return value === null
    ? {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      }
    : { ...value };
}

function observationFor(
  attempt: GenerateReportAttempt,
  attemptNumber: number,
  failure: RetryFailure | null,
): RetryAttemptObservation {
  const status: RetryAttemptObservation["status"] =
    failure === null
      ? "success"
      : failure.kind === "aborted"
        ? "aborted"
        : (failure.kind === "transient" || failure.kind === "empty-output") && attemptNumber <= 5
          ? "retry"
          : "terminal";
  return {
    attempt: attemptNumber,
    result: failure === null ? "success" : "failure",
    code: failure?.code ?? null,
    status,
    durationMs: attempt.durationMs,
    tokens: retryTokens(attempt.tokens),
  };
}

function withCumulativeUsage(result: ReportResult, usage: RetryUsageTotals): ReportResult {
  return {
    ...result,
    meta: {
      ...result.meta,
      durationMs: usage.durationMs,
      tokens: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
    },
  };
}

type AttemptObservationResult = RetryUsageTotals | null | "error";

async function observeAttempt(
  params: RunDueReportParams,
  attempt: GenerateReportAttempt,
  attemptNumber: number,
  failure: RetryFailure | null,
): Promise<AttemptObservationResult> {
  if (params.onAttempt === undefined) return null;
  try {
    const usage = await params.onAttempt(observationFor(attempt, attemptNumber, failure));
    return usage === undefined ? "error" : usage;
  } catch {
    return "error";
  }
}

export type PreparedDueReportOutcome =
  | {
      status: "success";
      result: ReportResult;
      attempt?: GenerateReportAttempt;
      /** coordinator 校验 current claim 后，在根锁内调用；cycleId 仅写 index token。 */
      persist: (cycleId?: string) => Promise<void>;
    }
  | {
      status: "failure";
      failure: RetryFailure;
      result?: ReportResult;
      attempt?: GenerateReportAttempt;
    };

type PreparedReportSuccess = Extract<PreparedDueReportOutcome, { status: "success" }>;

function reportPersistenceError(): Error & { code: string } {
  return Object.assign(new Error("报告持久化失败"), { code: REPORT_STORAGE_FAILURE.code });
}

function preparedSuccess(
  params: RunDueReportParams,
  result: ReportResult,
  snapshot: ReportStatsSnapshot,
  attempt?: GenerateReportAttempt,
): PreparedReportSuccess {
  return {
    status: "success",
    result,
    ...(attempt === undefined ? {} : { attempt }),
    persist: async (cycleId) => {
      try {
        await persistReport(params.historyRoot, result.meta, result.body, cycleId);
      } catch {
        throw reportPersistenceError();
      }
      notifyReport(params.ctx, params.reportCfg, result.meta, snapshot, params.sanitizeDiagnostic);
    },
  };
}

/**
 * 窗口内是否有用量（口径与 buildStatsSnapshot 的 totals.calls 一致：窗口闭区间
 * day 过滤后求和 calls）。空窗口报告不调模型，故不必解析 provider/model 路由。
 */
export function reportWindowHasUsage(
  buckets: Array<{
    day: string;
    providers: Array<{ provider: string; model: string | null; cell: TrendCell }>;
  }>,
  startDay: string,
  endDay: string,
): boolean {
  for (const item of buckets) {
    if (item.day < startDay || item.day > endDay) continue;
    for (const entry of item.providers) {
      if (entry.cell.calls > 0) return true;
    }
  }
  return false;
}

export async function prepareDueReportOutcome(
  params: RunDueReportParams,
): Promise<PreparedDueReportOutcome> {
  const buckets = params.trend.buckets();
  const snapshot = buildDueSnapshot(params, buckets);
  if (snapshot.totals.calls === 0) return noDataOutcome(params, snapshot);
  const generated = await generateForDue(params, snapshot);
  const attemptNumber = params.attemptNumber ?? 1;
  if (generated.status === "failure") {
    return failureOutcomeAfterGenerate(params, generated, attemptNumber);
  }
  return successOutcomeAfterGenerate(params, generated, snapshot, attemptNumber);
}

/**
 * 窗口统计快照组装。
 * 目录维度日汇总行进快照（trend.dirRows 含今日桶，口径见 aggregator.dirRows）。残差投影后
 * 旧数据（无 dir 行的分片）不再得到空数组——其「无目录信息」的用量经残差归入
 * (unidentified) 桶，故 byDirectory 与 totals 同口径（实测旧分片：
 * byDirectory=[{unidentified,31,7481}] = totals）。真正无任何用量时 dirRows 才为空数组
 * （报告链路另有 totals.calls===0 的空窗口短路）。报告配置目录范围非空时，byDirectory
 * 只含所选目录（目录维度投影可精确过滤）；totals/byDay/byProvider 保持全量口径——
 * 压实后的 agg 行无 dir 键（明细行的 dir×provider 关联在日切压实即收敛为两个独立
 * 投影），provider/day 维度按目录精确归属在本数据面上不可行（既定数据边界，非实现
 * 缺口）。占比口径自洽：模板目录占比 = byDirectory[i].total ÷ totals.total，报告呈
 * 「全量统计 + 所选目录分布」口径；缺省「全部」（空数组）零过滤。
 *
 * 小时维度日汇总行进快照（trend.hourRows 内存单源快照，含今日桶）。覆盖度守卫在
 * buildStatsSnapshot 内完成：coveredDays < windowDays 时 byHour/byPeriod/peakHour 整体
 * 置 null（升级期部分天缺 hour 事实 → 时段段降级）。
 */
function buildDueSnapshot(
  params: RunDueReportParams,
  buckets: ReturnType<TrendTracker["buckets"]>,
): ReportStatsSnapshot {
  const { due, trend, reportCfg } = params;
  const scopeDirs = reportCfg.directories ?? [];
  const dirRows = trend.dirRows();
  return buildStatsSnapshot({
    period: due.period,
    startDay: due.startDay,
    endDay: due.endDay,
    buckets,
    dirRows: scopeDirs.length === 0 ? dirRows : dirRows.filter((r) => scopeDirs.includes(r.dir)),
    hourRows: trend.hourRows(),
    prevTotal: prevWindowTotal(buckets, due.startDay, due.endDay),
  });
}

/** 空窗口短路：不调模型、不落盘正文，只回 noData 元数据（调度侧据此正常推进 lastRun）。 */
function noDataOutcome(
  params: RunDueReportParams,
  snapshot: ReportStatsSnapshot,
): PreparedDueReportOutcome {
  const { due, reportCfg } = params;
  const priorUsage = params.getUsage?.() ?? null;
  const noDataResult: ReportResult = {
    body: "",
    meta: {
      period: due.period,
      key: due.key,
      startDay: due.startDay,
      endDay: due.endDay,
      provider: reportCfg.provider,
      model: reportCfg.model,
      generatedAt: Date.now(),
      durationMs: priorUsage?.durationMs ?? 0,
      ok: true,
      noData: true,
    },
  };
  return preparedSuccess(
    params,
    priorUsage === null
      ? noDataResult
      : withCumulativeUsage(noDataResult, {
          ...priorUsage,
          durationMs: priorUsage.durationMs ?? 0,
        }),
    snapshot,
  );
}

/** 生成调用（route 已解析时复用 claim 快照，effort 以 route 优先）。 */
function generateForDue(
  params: RunDueReportParams,
  snapshot: ReportStatsSnapshot,
): Promise<Awaited<ReturnType<typeof generateReportOutcome>>> {
  const { due, ctx, reportCfg, promptTemplate } = params;
  const route = params.route;
  return generateReportOutcome({
    llm: ctx.llm,
    period: due.period,
    key: due.key,
    startDay: due.startDay,
    endDay: due.endDay,
    statsJson: JSON.stringify(snapshot, null, 2),
    rangeText: `${due.startDay} ~ ${due.endDay}`,
    promptTemplate,
    provider: reportCfg.provider,
    model: reportCfg.model,
    reasoningEffort: route === undefined ? reportCfg.reasoningEffort : route.route.reasoningEffort,
    ...(route === undefined ? {} : { route }),
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  });
}

/** 生成失败后的观测收口（存储失败 / 旧 cycle CAS 失败 / 累计 usage 合并）。 */
async function failureOutcomeAfterGenerate(
  params: RunDueReportParams,
  generated: Extract<Awaited<ReturnType<typeof generateReportOutcome>>, { status: "failure" }>,
  attemptNumber: number,
): Promise<PreparedDueReportOutcome> {
  const observed = await observeAttempt(
    params,
    generated.attempt,
    attemptNumber,
    generated.failure,
  );
  if (observed === "error") {
    return {
      status: "failure",
      failure: REPORT_OBSERVATION_STORAGE_FAILURE,
      result: generated.result,
      attempt: generated.attempt,
    };
  }
  if (params.onAttempt !== undefined && observed === null) {
    // 旧 cycle 的 observation CAS 失败只丢弃观测，不改写原 provider 失败；
    // executor 随后的 recordFailure 也会按旧 claim CAS 静默丢弃。
    return {
      ...generated,
      result: generated.result,
      attempt: generated.attempt,
    };
  }
  return {
    ...generated,
    result: observed === null ? generated.result : withCumulativeUsage(generated.result, observed),
    attempt: generated.attempt,
  };
}

/** 生成成功后的观测收口 + hero 摘要回填（顺序：先摘要，后合并累计 usage）。 */
async function successOutcomeAfterGenerate(
  params: RunDueReportParams,
  generated: Extract<Awaited<ReturnType<typeof generateReportOutcome>>, { status: "success" }>,
  snapshot: ReportStatsSnapshot,
  attemptNumber: number,
): Promise<PreparedDueReportOutcome> {
  let result: ReportResult = {
    ...generated.result,
    meta: { ...generated.result.meta, summary: summaryOf(snapshot) },
  };
  const observed = await observeAttempt(params, generated.attempt, attemptNumber, null);
  if (observed === "error") {
    return {
      status: "failure",
      failure: REPORT_OBSERVATION_STORAGE_FAILURE,
      result,
      attempt: generated.attempt,
    };
  }
  if (params.onAttempt !== undefined && observed === null) {
    return {
      status: "failure",
      failure: REPORT_CYCLE_CONFLICT_FAILURE,
      result,
      attempt: generated.attempt,
    };
  }
  if (observed !== null) result = withCumulativeUsage(result, observed);
  return preparedSuccess(params, result, snapshot, generated.attempt);
}

export async function runDueReportOutcome(
  params: RunDueReportParams,
): Promise<RunDueReportOutcome> {
  const outcome = await prepareDueReportOutcome(params);
  if (outcome.status === "failure") return outcome;
  try {
    await outcome.persist();
  } catch {
    return {
      status: "failure",
      failure: REPORT_STORAGE_FAILURE,
      result: outcome.result,
      attempt: outcome.attempt,
    };
  }
  return { status: "success", result: outcome.result, attempt: outcome.attempt };
}

/** 兼容 wrapper：保留旧 ReportMeta 返回/抛错语义，结构化标签由 executor 消费。 */
export async function runDueReport(params: RunDueReportParams): Promise<ReportMeta> {
  const outcome = await runDueReportOutcome(params);
  if (outcome.status === "success") return outcome.result.meta;
  throw new Error(outcome.result?.meta.error ?? "报告持久化失败");
}

/**
 * 读报告历史索引（读侧投影：按 (period,key) 去重，保留 generatedAt 最新一条
 * ——「一行/窗口=最新版」；index.jsonl 保持 append-only 不改写）。
 * 返回按时间倒序（最新在前），与既有消费方语义一致。
 *
 * 解析记忆化：index.jsonl 为 append-only 单写者（本进程 persistReport），
 * 同版本文件的解析结果必然一致，故按 stat 失效键（size + mtimeMs）缓存「原始全文
 * → 解析+去重+排序投影」。任务执行/手动生成路由每轮复用缓存，不再随 index 行数
 * 线性重解析（文件未变时 O(1)；文件变化只重解析一次并刷新缓存，仍优于逐调用全量）。
 * - 失效以 stat 为唯一事实源，不基于时钟假设——写入方经 appendFile 后 mtime/size
 *   必变，不会读到过期投影；
 * - 文件缺失 → 不缓存（空表），避免 -ENOENT 竞态窗口把「暂不可见」钉死成永久空；
 * - stat 失败（竞态删除/权限）→ 回落全量读+解析（降级路径，语义与原实现一致）；
 * - 单进程内存态缓存，无跨进程共享面（多实例经 DSH_HOME/profile 天然隔离）。
 */
export async function readReportIndex(historyRoot: string): Promise<ReportCycleMeta[]> {
  const file = reportIndexFile(historyRoot);
  let raw: string;
  let stamp: string;
  try {
    const st = await stat(file);
    stamp = `${st.size}:${st.mtimeMs}`;
    const cached = indexCache.get(historyRoot);
    if (cached !== undefined && cached.stamp === stamp) {
      indexCacheHits += 1;
      return [...cached.value]; // 浅拷贝防调用方改写污染缓存（O(n) 拷贝远轻于重解析）
    }
    raw = await readFile(file, "utf8");
  } catch {
    // 文件缺失或 stat 失败：回落全量读+解析（缺失时 readFile 也失败 → 空表），不缓存
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return [];
    }
    stamp = "";
  }
  indexCacheMisses += 1;
  const records = parseReportIndexLines(raw);
  const newest = new Map<string, ReportCycleMeta>();
  for (const r of records) {
    const id = `${r.period}:${r.key}`;
    const cur = newest.get(id);
    if (cur === undefined || r.generatedAt > cur.generatedAt) newest.set(id, r);
  }
  const value = [...newest.values()].sort((a, b) => b.generatedAt - a.generatedAt);
  if (stamp !== "") indexCache.set(historyRoot, { stamp, value });
  return [...value]; // 与命中路径对称：浅拷贝防调用方就地突变污染缓存
}
