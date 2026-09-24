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
import { readReportIndex, runDueReportOutcome, type RunDueReportOutcome } from "./runner.ts";
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
  RetryLedgerPort,
} from "../schedule/interface.ts";
import type { TrendTracker } from "../aggregate/interface.ts";

export interface RetrySuccessCommitInput {
  claim: RetryClaim;
  result: ReportResult;
}

/** B2b 装配的 per-root coordinator：单调推进 lastRun 后 CAS clear 当前 claim。 */
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

function outcomeError(outcome: Extract<RunDueReportOutcome, { status: "failure" }>): string {
  return outcome.result?.meta.error ?? "报告持久化失败";
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
  const resolved: GenerateRouteOutcome =
    existing === undefined
      ? await retry.resolveRoute({
          llm: deps.ctx.llm,
          provider: reportCfg.provider,
          model: reportCfg.model,
          reasoningEffort: reportCfg.reasoningEffort,
        })
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
  return {
    claim,
    route:
      resolved.status === "failure"
        ? { status: "failure", route: claim.entry.route, failure: resolved.failure }
        : { status: "success", route: claim.entry.route },
  };
}

async function runWithRetry(
  deps: DueExecutorDeps,
  retry: DueExecutorRetryOptions,
  input: ReportTaskInput,
  reportCfg: ReportConfig,
): Promise<ReportTaskResult> {
  const { claim, route } = await claimRoute(deps, retry, input, reportCfg);
  const outcome = await runDueReportOutcome({
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
    throw new Error(outcomeError(outcome));
  }
  if (!(await retry.commitSuccess.commitSuccess({ claim, result: outcome.result }))) {
    throw new Error("报告重试周期已变化");
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
        if (existing !== undefined) return { meta: existing, reused: true };
      }
      const reportCfg = deps.getReportCfg();
      return deps.retry === undefined
        ? await runWithoutRetry(deps, input, reportCfg)
        : await runWithRetry(deps, deps.retry, input, reportCfg);
    } catch (e: unknown) {
      throw new Error(deps.sanitizeDiagnostic(e instanceof Error ? e.message : String(e)));
    }
  };
}
