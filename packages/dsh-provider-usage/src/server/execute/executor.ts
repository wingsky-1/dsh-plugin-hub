/**
 * dsh-provider-usage — server/execute 域：报告生成执行器工厂
 * （#768 D3，由 domain2/execute/executor.ts 搬入，零行为变更）。
 *
 * 执行接线器：幂等下沉（执行前重查 index，已有成功记录且非 force → 复用）、
 * LLM 生成、lastRun 推进——全部在 ReportTaskQueue 临界区内串行执行。
 * 失败不推进 lastRun（下轮按幂等重试/补跑）；错误经 sanitizeDiagnostic 脱敏后
 * 再抛（status 路由回客户端，防本地路径泄露——脱敏为工厂契约字段）。
 * 推进经 deps.advanceLastRun 注入（per-root 临界区链唯一实现留
 * server/schedule 域 store.ts，本域不直引 schedule 门面值边，#768 B1；
 * 提示词模板经 deps.getPromptTemplate 注入（组合根算好字符串传入，
 * 本域不直引 config 门面值边，#768 B2；
 * 任务类型经 server/schedule 门面以 type 复用，配置形态经
 * server/config 门面以 type 复用）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ReportConfig, ReportPeriod } from "../config/interface.ts";
import {
  prepareDueReportOutcome,
  readReportIndex,
  runDueReportOutcome,
  type RunDueReportOutcome,
} from "./runner.ts";
import type {
  GenerateRouteOutcome,
  ReportLlmService,
  ReportMeta,
  ReportResult,
} from "./generate.ts";
import type {
  ReportTaskInput,
  ReportTaskResult,
  RetryClaim,
  RetryFailure,
  RetryLedgerPort,
  RetryRouteSnapshot,
} from "../schedule/interface.ts";
import type { TrendTracker } from "../aggregate/interface.ts";

const UNRESOLVED_ROUTE_ID = "__dsh_provider_usage_unresolved__";

function unresolvedRouteSnapshot(): RetryRouteSnapshot {
  return { provider: UNRESOLVED_ROUTE_ID, model: UNRESOLVED_ROUTE_ID };
}

function isUnresolvedRoute(route: RetryRouteSnapshot): boolean {
  return (
    route.provider === UNRESOLVED_ROUTE_ID ||
    route.model === UNRESOLVED_ROUTE_ID ||
    route.provider.length === 0 ||
    route.model.length === 0
  );
}

function isResolvedRouteSnapshot(route: RetryRouteSnapshot): boolean {
  return !isUnresolvedRoute(route);
}

export interface RetrySuccessCommitInput {
  claim: RetryClaim;
  result: ReportResult;
  /** 仅在 coordinator 确认 current claim 后、持 per-root 锁执行。 */
  persist: () => Promise<void>;
}

/** B2b 装配的 per-root coordinator：落盘、单调推进 lastRun、CAS clear 当前 claim。 */
export interface RetrySuccessCommitPort {
  commitSuccess(input: RetrySuccessCommitInput): Promise<boolean>;
}

export interface DueExecutorRetryOptions {
  ledger: RetryLedgerPort;
  resolveRoute: (input: {
    llm: ReportLlmService;
    provider: string;
    model: string;
    reasoningEffort?: string;
  }) => Promise<GenerateRouteOutcome>;
  commitSuccess: RetrySuccessCommitPort;
  /** 内部 coordinator seam：index-reuse 只在 ledger 命中时补写并清理。 */
  reconcileIndex?: (input: {
    period: ReportPeriod;
    key: string;
    indexed: boolean;
    cycleId?: string;
  }) => Promise<boolean>;
  now?: () => number;
}

export interface DueExecutorDeps {
  trend: TrendTracker;
  ctx: Context;
  getReportCfg: () => ReportConfig;
  /** 提示词模板解析（#768 B2：promptFor 不下沉 shared，DueReport 语义外；组合根在已持 reportCfg 处算好字符串传入，执行域不直引 config 门面值边）。 */
  getPromptTemplate: (period: ReportPeriod) => string;
  historyRoot: string;
  sanitizeDiagnostic: (s: string) => string;
  /**
   * lastRun 推进能力（per-root 临界区链唯一实现留 schedule 域 store.ts：
   * 读-改-写按 root 串行 + 写前重读；组合根注入 updateLastRun 引用，
   * 本域不直引 schedule 门面值边，#768 B1）。
   */
  advanceLastRun: (
    root: string,
    patch: (
      prev: Partial<Record<ReportPeriod, string>>,
    ) => Partial<Record<ReportPeriod, string>> | Promise<Partial<Record<ReportPeriod, string>>>,
  ) => Promise<void>;
  /** B2a 包内事务端口；B2b 组合根负责注入真实 ledger 与单锁 coordinator。 */
  retry?: DueExecutorRetryOptions;
}

function stableCode(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(code)) return code;
  }
  return fallback;
}

function taggedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function outcomeError(outcome: Extract<RunDueReportOutcome, { status: "failure" }>): string {
  return outcome.result?.meta.error ?? "报告持久化失败";
}

const ROUTE_RESOLUTION_FAILURE = {
  kind: "transient",
  code: "route-resolution-failed",
} as const;

function routeFailureMessage(failure: RetryFailure): string {
  return failure.code === "route-resolution-failed"
    ? "模型路由解析失败"
    : "无可用的已注册 provider/model（须先在 dsh 注册适配器路由）";
}

function normalizeRouteOutcome(outcome: GenerateRouteOutcome): GenerateRouteOutcome {
  if (outcome.status === "success" && isResolvedRouteSnapshot(outcome.route)) return outcome;
  if (outcome.status === "success") {
    return {
      status: "failure",
      route: unresolvedRouteSnapshot(),
      failure: ROUTE_RESOLUTION_FAILURE,
      unresolved: true,
    };
  }
  return {
    status: outcome.status,
    route: unresolvedRouteSnapshot(),
    failure: outcome.failure,
  };
}

function advanceLastRun(deps: DueExecutorDeps, meta: ReportMeta): Promise<void> {
  return deps.advanceLastRun(deps.historyRoot, (current) => {
    const previous = current[meta.period];
    return previous === undefined || meta.key > previous
      ? { ...current, [meta.period]: meta.key }
      : current;
  });
}

async function runWithoutRetry(
  deps: DueExecutorDeps,
  input: ReportTaskInput,
  reportCfg: ReportConfig,
): Promise<ReportTaskResult> {
  const outcome = await runDueReportOutcome({
    due: input,
    trend: deps.trend,
    ctx: deps.ctx,
    reportCfg,
    promptTemplate: deps.getPromptTemplate(input.period),
    historyRoot: deps.historyRoot,
    sanitizeDiagnostic: deps.sanitizeDiagnostic,
  });
  if (outcome.status === "failure") throw new Error(outcomeError(outcome));
  await advanceLastRun(deps, outcome.result.meta);
  return { meta: outcome.result.meta };
}

async function claimRoute(
  deps: DueExecutorDeps,
  retry: DueExecutorRetryOptions,
  input: ReportTaskInput,
  reportCfg: ReportConfig,
): Promise<{ claim: RetryClaim; route: GenerateRouteOutcome }> {
  const existing = await retry.ledger.get(input.period, input.key);
  const resolve = async (): Promise<GenerateRouteOutcome> =>
    normalizeRouteOutcome(
      await retry.resolveRoute({
        llm: deps.ctx.llm,
        provider: reportCfg.provider,
        model: reportCfg.model,
        reasoningEffort: reportCfg.reasoningEffort,
      }),
    );
  const resolved: GenerateRouteOutcome =
    existing === undefined
      ? await resolve()
      : existing.terminal
        ? {
            status: "failure",
            route: existing.route,
            failure: { kind: "permanent", code: "retry-terminal" },
          }
        : isUnresolvedRoute(existing.route)
          ? await resolve()
          : { status: "success", route: existing.route };
  const now = retry.now?.() ?? Date.now();
  const claim = await retry.ledger.beginAttempt(
    {
      period: input.period,
      key: input.key,
      startDay: input.startDay,
      endDay: input.endDay,
      route: resolved.route,
      ...(existing === undefined ? {} : { cycleId: existing.cycleId }),
    },
    now,
  );
  if (claim === null) throw new Error("报告重试状态不允许执行");
  return { claim, route: resolved };
}

async function runWithRetry(
  deps: DueExecutorDeps,
  retry: DueExecutorRetryOptions,
  input: ReportTaskInput,
  reportCfg: ReportConfig,
): Promise<ReportTaskResult> {
  const { claim, route } = await claimRoute(deps, retry, input, reportCfg);
  if (route.status !== "success") {
    await retry.ledger.recordFailure(claim, route.failure, retry.now?.() ?? Date.now());
    throw taggedError(route.failure.code, routeFailureMessage(route.failure));
  }
  const outcome = await prepareDueReportOutcome({
    due: input,
    trend: deps.trend,
    ctx: deps.ctx,
    reportCfg,
    promptTemplate: deps.getPromptTemplate(input.period),
    historyRoot: deps.historyRoot,
    sanitizeDiagnostic: deps.sanitizeDiagnostic,
    route,
  });
  if (outcome.status === "failure") {
    await retry.ledger.recordFailure(claim, outcome.failure, retry.now?.() ?? Date.now());
    throw taggedError(outcome.failure.code, outcomeError(outcome));
  }
  try {
    const committed = await retry.commitSuccess.commitSuccess({
      claim,
      result: outcome.result,
      persist: () => outcome.persist(claim.cycleId),
    });
    if (!committed) throw taggedError("retry-cycle-conflict", "报告重试周期已变化");
  } catch (error: unknown) {
    // 真实 coordinator 已在根锁内 terminalize；此 CAS 兜底只服务窄 commit port，
    // 且旧 claim 不得清除后来 force 创建的新 cycle。
    if (stableCode(error, "") === "report-persist-failed") {
      await retry.ledger.recordFailure(
        claim,
        { kind: "storage", code: "report-persist-failed" },
        retry.now?.() ?? Date.now(),
      );
    }
    throw error;
  }
  return { meta: outcome.result.meta };
}

/** 构造串行执行器（幂等/claim/生成/提交/脱敏行为在此固化）。 */
export function makeDueReportExecutor(
  deps: DueExecutorDeps,
): (input: ReportTaskInput) => Promise<ReportTaskResult> {
  return async (input) => {
    try {
      if (input.force !== true) {
        const existing = (await readReportIndex(deps.historyRoot)).find(
          (m) => m.period === input.period && m.key === input.key && m.ok === true,
        );
        if (existing !== undefined) {
          if (deps.retry?.reconcileIndex !== undefined) {
            await deps.retry.reconcileIndex({
              period: input.period,
              key: input.key,
              indexed: true,
              cycleId: existing.cycleId,
            });
          }
          return { meta: existing, reused: true };
        }
      }
      const reportCfg = deps.getReportCfg();
      return deps.retry === undefined
        ? await runWithoutRetry(deps, input, reportCfg)
        : await runWithRetry(deps, deps.retry, input, reportCfg);
    } catch (e: unknown) {
      const message = deps.sanitizeDiagnostic(e instanceof Error ? e.message : String(e));
      const code = stableCode(e, "generation-failed");
      throw taggedError(code, message);
    }
  };
}
