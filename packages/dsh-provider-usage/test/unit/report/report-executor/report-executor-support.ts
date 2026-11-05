// Shape-only support module; all executable assertion bodies are moved verbatim.
import { DEFAULT_REPORT_CONFIG } from "../../../../src/server/config/interface.ts";
import {
  createRetryLedger,
  updateLastRun,
  type ReportTaskInput,
  type RetryLedgerPort,
} from "../../../../src/server/schedule/interface.ts";
import type { TrendTracker } from "../../../../src/server/aggregate/interface.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import {
  makeDueReportExecutor,
  resolveGenerateRoute,
  type DueExecutorRetryOptions,
  type RetrySuccessCommitInput,
  type RetrySuccessCommitPort,
} from "../../../../src/server/execute/interface.ts";

export const RETRY_DAY = "2026-09-23";
export const RETRY_NOW = Date.UTC(2026, 8, 24, 0, 0, 0);

export function retryDue(overrides: Partial<ReportTaskInput> = {}): ReportTaskInput {
  return {
    period: "daily",
    key: RETRY_DAY,
    startDay: RETRY_DAY,
    endDay: RETRY_DAY,
    ...overrides,
  };
}

export function retryConfig() {
  return normalizeCfg({
    provider: "generic-provider",
    model: "generic-model",
    push: { enabled: false },
  });
}

export function retryTrend(calls: number): TrendTracker {
  return {
    buckets: () =>
      calls === 0
        ? []
        : [
            {
              day: RETRY_DAY,
              providers: [
                {
                  provider: "generic-provider",
                  model: "generic-model",
                  cell: {
                    input: 2,
                    output: 3,
                    cacheRead: null,
                    cacheWrite: null,
                    calls: 1,
                    turns: 1,
                    toolCalls: 0,
                  },
                },
              ],
            },
          ],
    dirRows: () => [],
    hourRows: () => [],
  } as unknown as TrendTracker;
}

export function retryContext(
  chunks: StreamChunk[],
  onStream?: () => Promise<void>,
  listModels?: () => Promise<Array<{ provider: string; id: string; name: string }>>,
): { ctx: Context; calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = [];
  const llm = {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push({ ...options, messages: [...options.messages] });
      return (async function* (): AsyncGenerator<StreamChunk> {
        if (onStream !== undefined) await onStream();
        yield* chunks;
      })();
    },
    listProviders: () => [{ id: "generic-provider", name: "Generic" }],
    listModels:
      listModels ??
      (async () => [{ provider: "generic-provider", id: "generic-model", name: "Generic Model" }]),
  };
  return { ctx: { llm } as unknown as Context, calls };
}

export function retryLedger(root: string, createCycleId: () => string): RetryLedgerPort {
  return createRetryLedger(root, { now: () => RETRY_NOW, createCycleId });
}

export class RecordingCommitPort implements RetrySuccessCommitPort {
  readonly calls: RetrySuccessCommitInput[] = [];

  constructor(private readonly handler: (input: RetrySuccessCommitInput) => Promise<boolean>) {}

  async commitSuccess(input: RetrySuccessCommitInput): Promise<boolean> {
    this.calls.push({
      claim: {
        cycleId: input.claim.cycleId,
        entry: { ...input.claim.entry, route: { ...input.claim.entry.route } },
      },
      result: { ...input.result, meta: { ...input.result.meta } },
      persist: input.persist,
    });
    return this.handler(input);
  }
}

export function commitCurrentThenClear(root: string, ledger: RetryLedgerPort): RecordingCommitPort {
  return new RecordingCommitPort(async ({ claim, result, persist }) => {
    const current = await ledger.get(result.meta.period, result.meta.key);
    if (current?.cycleId !== claim.cycleId || current.phase !== "in-flight") return false;
    await persist();
    await updateLastRun(root, (previous) => {
      const previousKey = previous[result.meta.period];
      return previousKey !== undefined && previousKey >= result.meta.key
        ? previous
        : { ...previous, [result.meta.period]: result.meta.key };
    });
    return ledger.clear(claim);
  });
}

export function retryExecutor(input: {
  root: string;
  trend: TrendTracker;
  ctx: Context;
  ledger: RetryLedgerPort;
  commit: RetrySuccessCommitPort;
  reconcileIndex?: DueExecutorRetryOptions["reconcileIndex"];
  resolveRoute?: DueExecutorRetryOptions["resolveRoute"];
  config?: () => ReturnType<typeof retryConfig>;
  warn?: DueExecutorRetryOptions["warn"];
  signal?: DueExecutorRetryOptions["signal"];
  now?: () => number;
  /** 测试用：覆盖 executor 工厂的脱敏接缝（默认恒等）。 */
  sanitize?: (value: string) => string;
}) {
  return makeDueReportExecutor({
    trend: input.trend,
    ctx: input.ctx,
    getReportCfg: input.config ?? retryConfig,
    getPromptTemplate: () => "prompt {stats}",
    historyRoot: input.root,
    sanitizeDiagnostic: input.sanitize ?? ((value) => value),
    advanceLastRun: updateLastRun,
    retry: {
      ledger: input.ledger,
      resolveRoute: input.resolveRoute ?? resolveGenerateRoute,
      commitSuccess: input.commit,
      now: input.now ?? (() => RETRY_NOW),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.warn === undefined ? {} : { warn: input.warn }),
      ...(input.reconcileIndex === undefined ? {} : { reconcileIndex: input.reconcileIndex }),
    },
  });
}

export const SUCCESS_CHUNKS: StreamChunk[] = [
  { type: "text-delta", index: 0, text: "报告正文" },
  { type: "finish", reason: { kind: "stop" } },
];
export function normalizeCfg(overrides: Record<string, unknown>) {
  return { ...JSON.parse(JSON.stringify(DEFAULT_REPORT_CONFIG)), ...overrides };
}
