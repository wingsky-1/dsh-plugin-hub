/**
 * dsh-provider-usage — unit：D8 报告面组合收敛
 *
 * L2 契约（refactor-implementation-plan.md §2）：
 * - makeDueReportExecutor：幂等短路（index 已有成功记录且非 force → 复用，不推进
 *   lastRun）；失败/脱敏路径由 unit-apply 集成（HTTP 手动生成）覆盖
 * - ReportConfigService：内存权威 + 串行写链（并发 update 不交错）、onUpdate 回调
 *   在写盘后触发、磁盘文件 roundtrip
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// 白盒直连深路径（#768 B波续批）：读面经域门面，不走组合根转发。
import {
  DEFAULT_REPORT_CONFIG,
  ReportConfigService,
  readReportConfig,
} from "../../../src/server/config/interface.ts";
import {
  beginAttempt,
  beginForce,
  createInitialEntry,
  createReportStateCoordinator,
  createRetryLedger,
  readLastRun,
  retryFenceFile,
  recordFailure,
  recover,
  retryLedgerFile,
  shouldReconcileRetry,
  updateLastRun,
  type ReportTaskInput,
  type ReportTaskResult,
  type RetryAttemptInput,
  type RetryEntry,
  type RetryFailure,
  type RetryLedgerPort,
  type RetrySeed,
} from "../../../src/server/schedule/interface.ts";
import type { TrendTracker } from "../../../src/server/aggregate/interface.ts";
import type { Context } from "@deepseek-ai/cordis";
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  ReasoningEffortId,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import {
  makeDueReportExecutor,
  persistReport,
  reportHtmlFile,
  reportMetaFile,
  resolveGenerateRoute,
  runDueReport,
  runDueReportOutcome,
  type DueExecutorRetryOptions,
  type RetrySuccessCommitInput,
  type RetrySuccessCommitPort,
  generateReportOutcome,
} from "../../../src/server/execute/interface.ts";
import { makeListDirs } from "../../../src/server/execute/list-dirs.ts";

describe("ReportConfigService：串行写链 / 内存权威 / 回调顺序 / 磁盘 roundtrip", () => {
  let root: string;
  let updates: Array<{ daily: { time: string } }>;
  let svc: ReportConfigService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "u-report-cfg-"));
    updates = [];
    svc = new ReportConfigService({
      root,
      initial: normalizeCfg({}),
      onUpdate: (c) => updates.push(c),
    });
  });

  const concurrentUpdates = () =>
    Promise.all([
      svc.update(normalizeCfg({ daily: { enabled: true, time: "09:00" } })),
      svc.update(normalizeCfg({ daily: { enabled: true, time: "18:00" } })),
    ]);

  it("初始内存权威（默认 daily 08:00）", () => {
    expect(svc.get().daily.time).toBe("08:00");
  });

  it("并发 update 串行后内存为最后一次", async () => {
    await concurrentUpdates();
    expect(svc.get().daily.time).toBe("18:00");
  });

  it("onUpdate 按提交序触发（不交错）", async () => {
    await concurrentUpdates();
    expect(updates.map((c) => c.daily.time)).toEqual(["09:00", "18:00"]);
  });

  it("磁盘 roundtrip 为最后一次（串行写链）", async () => {
    await concurrentUpdates();
    const disk = await readReportConfig(root);
    expect(disk.daily.time).toBe("18:00");
  });
});

describe("ReportConfigService：update 失败（写盘拒绝）不污染内存权威", () => {
  let svc: ReportConfigService;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "u-report-cfg-fail-"));
    // 用目录占用模拟写失败：把 reports 位置占为普通文件
    writeFileSync(join(root, "reports"), "x");
    svc = new ReportConfigService({ root, initial: normalizeCfg({}) });
  });

  it("写盘失败向外抛（调用方转 500）", async () => {
    await expect(svc.update(normalizeCfg({ weekly: { enabled: true } }))).rejects.toThrow();
  });

  it("失败不落内存（内存权威保持旧值）", async () => {
    await svc.update(normalizeCfg({ weekly: { enabled: true } })).catch(() => {});
    expect(svc.get().weekly.enabled).toBe(false);
  });
});

describe("executor 幂等短路：index 已有成功记录且非 force → 复用，不推进 lastRun", () => {
  let meta: Record<string, unknown>;
  let res: ReportTaskResult;
  let lastRun: Record<string, unknown>;

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-idem-"));
    const reportsDir = join(root, "reports");
    mkdirSync(reportsDir, { recursive: true });
    meta = {
      period: "daily",
      key: "2026-09-05",
      startDay: "2026-09-05",
      endDay: "2026-09-05",
      generatedAt: 1,
      ok: true,
    };
    writeFileSync(join(reportsDir, "index.jsonl"), `${JSON.stringify(meta)}\n`);

    const executor = makeDueReportExecutor({
      // 幂等短路路径不触达 trend/ctx（命中既有成功记录即复用返回），空对象断言仅为过构造面。
      trend: {} as TrendTracker,
      ctx: {} as Context,
      getReportCfg: () => normalizeCfg({}),
      getPromptTemplate: () => "prompt",
      historyRoot: root,
      sanitizeDiagnostic: (s) => `SAN:${s}`,
      advanceLastRun: updateLastRun,
    });
    res = await executor({
      period: "daily",
      key: "2026-09-05",
      startDay: "2026-09-05",
      endDay: "2026-09-05",
    });
    lastRun = await readLastRun(root);
  });

  it("index 已有成功记录 → 幂等复用", () => {
    expect(res.reused).toBe(true);
  });

  it("复用记录原样返回", () => {
    expect(res.meta).toEqual(meta);
  });

  it("幂等短路不推进 lastRun（下轮不再重跑同一窗口）", () => {
    expect(lastRun).toEqual({});
  });
});

describe("makeListDirs：目录候选查询面（净化出口 + 未识别桶归位）", () => {
  let list: Array<{ dir: string; calls: number; total: number | null }>;

  beforeEach(() => {
    // null 行超出真实 TrendTracker.dirTotals 的窄类型（防御性覆盖：makeListDirs 须把无目录归未识别桶）。
    const trend = {
      dirTotals: (): Array<{ dir: string | null; calls: number; total: number | null }> => [
        { dir: "/home/u/proj-a", calls: 3, total: 10 },
        { dir: "x/y", calls: 1, total: 2 },
        { dir: null, calls: 0, total: null },
      ],
    };
    list = makeListDirs(trend as unknown as TrendTracker)();
  });

  it("全量返回", () => {
    expect(list.length).toBe(3);
  });

  it("绝对路径净化为 basename", () => {
    expect(list[0].dir).toBe("proj-a");
  });

  it("多级路径取 basename", () => {
    expect(list[1].dir).toBe("y");
  });

  it("无目录归未识别桶", () => {
    expect(list[2].dir).toBe("(unidentified)");
  });

  it("calls 透传", () => {
    expect(list[0].calls).toBe(3);
  });

  it("total 透传", () => {
    expect(list[0].total).toBe(10);
  });
});

describe("runner：reportCfg.reasoningEffort 透传到生成边界", () => {
  it("先按 exact model 校验，再把 branded ID 传入唯一 stream 调用", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-runner-reasoning-effort-"));
    const streamCalls: GenerateOptions[] = [];
    const resolveCalls: Array<{ provider: string; model: string }> = [];
    const effort = "vendor::deep" as ReasoningEffortId;
    const capability: LlmResolvedModelInfo = {
      provider: "generic-provider",
      id: "generic-model",
      name: "Generic Model",
      reasoning: {
        efforts: [{ id: effort, name: "Deep" }],
        defaultEffort: effort,
      },
    };
    const chunks: StreamChunk[] = [
      { type: "text-delta", index: 0, text: "runner report" },
      { type: "finish", reason: { kind: "stop" } },
    ];
    const ctx = {
      llm: {
        stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          streamCalls.push({ ...options, messages: [...options.messages] });
          return (async function* (): AsyncGenerator<StreamChunk> {
            yield* chunks;
          })();
        },
        listProviders: () => [{ id: "generic-provider", name: "Generic" }],
        listModels: async () => [
          { provider: "generic-provider", id: "generic-model", name: "Generic Model" },
        ],
        resolveModelInfo: async (provider: string, model: string) => {
          resolveCalls.push({ provider, model });
          return capability;
        },
      },
    } as unknown as Context;
    const trend = {
      buckets: () => [
        {
          day: "2026-09-05",
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
    const due: ReportTaskInput = {
      period: "daily",
      key: "2026-09-05",
      startDay: "2026-09-05",
      endDay: "2026-09-05",
      force: false,
    };
    const reportCfg = normalizeCfg({
      provider: "generic-provider",
      model: "generic-model",
      reasoningEffort: "vendor::deep",
      push: { enabled: false },
    });

    try {
      const result = await runDueReport({
        due,
        trend,
        ctx,
        reportCfg,
        promptTemplate: "prompt",
        historyRoot: root,
        sanitizeDiagnostic: (value) => value,
      });

      expect(result.ok).toBe(true);
      expect(resolveCalls).toEqual([{ provider: "generic-provider", model: "generic-model" }]);
      expect(streamCalls).toHaveLength(1);
      expect(streamCalls[0]!.reasoningEffort).toBe("vendor::deep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const RETRY_DAY = "2026-09-23";
const RETRY_NOW = Date.UTC(2026, 8, 24, 0, 0, 0);

function retryDue(overrides: Partial<ReportTaskInput> = {}): ReportTaskInput {
  return {
    period: "daily",
    key: RETRY_DAY,
    startDay: RETRY_DAY,
    endDay: RETRY_DAY,
    ...overrides,
  };
}

function retryConfig() {
  return normalizeCfg({
    provider: "generic-provider",
    model: "generic-model",
    push: { enabled: false },
  });
}

function retryTrend(calls: number): TrendTracker {
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

function retryContext(
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

function retryLedger(root: string, createCycleId: () => string): RetryLedgerPort {
  return createRetryLedger(root, { now: () => RETRY_NOW, createCycleId });
}

class RecordingCommitPort implements RetrySuccessCommitPort {
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

function commitCurrentThenClear(root: string, ledger: RetryLedgerPort): RecordingCommitPort {
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

function retryExecutor(input: {
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

const SUCCESS_CHUNKS: StreamChunk[] = [
  { type: "text-delta", index: 0, text: "报告正文" },
  { type: "finish", reason: { kind: "stop" } },
];

describe("B3a：报告 attempt token 观测红灯", () => {
  it("保留 reasoningTokens、缺失 token 字段为 null，并记录 fake-clock durationMs", async () => {
    const { ctx } = retryContext([
      { type: "text-delta", index: 0, text: "报告正文" },
      {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 7 },
      },
      { type: "finish", reason: { kind: "stop" } },
    ]);
    let tick = 1_000;
    const result = await generateReportOutcome({
      llm: ctx.llm,
      period: "daily",
      key: RETRY_DAY,
      startDay: RETRY_DAY,
      endDay: RETRY_DAY,
      statsJson: "{}",
      promptTemplate: "prompt",
      provider: "generic-provider",
      model: "generic-model",
      now: () => {
        const value = tick;
        tick += 125;
        return value;
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected successful generation");
    expect(result.result.meta.tokens).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 7,
      totalTokens: 15,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
    expect(result.result.meta.durationMs).toBe(125);
  });

  it("abort 记录稳定终态 code，不把取消异常原文写入观测", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx } = retryContext([], async () => {
      throw new Error("raw abort secret must stay hidden");
    });
    const result = await generateReportOutcome({
      llm: ctx.llm,
      period: "daily",
      key: RETRY_DAY,
      startDay: RETRY_DAY,
      endDay: RETRY_DAY,
      statsJson: "{}",
      promptTemplate: "prompt",
      provider: "generic-provider",
      model: "generic-model",
      signal: controller.signal,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") throw new Error("expected aborted generation");
    expect(result.failure).toEqual({ kind: "aborted", code: "request-aborted" });
    expect(result.attempt).toMatchObject({ durationMs: expect.any(Number), tokens: null });
    expect(JSON.stringify(result)).not.toContain("raw");
  });
});

describe("runner/executor：#1010 B2a retry ledger 执行事务", () => {
  it("runner 生成失败返回 tagged outcome，不压成普通 Error", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-runner-outcome-"));
    const { ctx, calls } = retryContext([{ type: "finish", reason: { kind: "stop" } }]);

    try {
      const outcome = await runDueReportOutcome({
        due: retryDue(),
        trend: retryTrend(1),
        ctx,
        reportCfg: retryConfig(),
        promptTemplate: "prompt",
        historyRoot: root,
        sanitizeDiagnostic: (value) => value,
      });

      expect(outcome).toMatchObject({
        status: "failure",
        failure: { kind: "empty-output", code: "empty-output" },
        result: { body: "", meta: { ok: false, error: "模型未产出任何正文" } },
      });
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("unresolved transient route 首次进入 waiting；到期重新 listModels，resolved 后才 stream", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-route-unresolved-"));
    let now = RETRY_NOW;
    let listModelsCalls = 0;
    const ledger = createRetryLedger(root, {
      now: () => now,
      createCycleId: () => "cycle-route-unresolved",
    });
    const commit = commitCurrentThenClear(root, ledger);
    const messages: string[] = [];
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS, undefined, async () => {
      listModelsCalls += 1;
      if (listModelsCalls === 1) {
        throw { code: "TIMEOUT", message: "raw listModels failure must stay hidden" };
      }
      return [{ provider: "generic-provider", id: "generic-model", name: "Generic Model" }];
    });
    const executor = retryExecutor({
      root,
      trend: retryTrend(1),
      ctx,
      ledger,
      commit,
      config: () => normalizeCfg({ provider: "", model: "", push: { enabled: false } }),
      now: () => now,
      warn: (message) => messages.push(message),
    });

    try {
      await expect(executor(retryDue())).rejects.toThrow("模型路由解析失败");
      expect(listModelsCalls).toBe(1);
      expect(calls).toHaveLength(0);
      const waiting = await ledger.get("daily", RETRY_DAY);
      expect(waiting).toMatchObject({ phase: "waiting", attempts: 1, terminal: false });
      expect(waiting?.route.provider).not.toBe("");
      expect(waiting?.route.model).not.toBe("");
      expect(JSON.parse(messages[0]!)).toMatchObject({
        event: "report_attempt",
        code: "route-resolution-failed",
        result: "failure",
      });

      now = RETRY_NOW + 60_000;
      const result = await executor(retryDue());

      expect(result.meta).toMatchObject({
        ok: true,
        provider: "generic-provider",
        model: "generic-model",
      });
      expect(listModelsCalls).toBe(2);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ provider: "generic-provider", model: "generic-model" });
      expect(await ledger.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("unresolved cycle 固定 reasoningEffort 快照，配置变更不漂移", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-effort-snapshot-"));
    let now = RETRY_NOW;
    let configuredEffort = "vendor::A";
    let resolveCalls = 0;
    const effortCalls: Array<string | undefined> = [];
    const ledger = retryLedger(root, () => "cycle-effort-snapshot");
    const commit = commitCurrentThenClear(root, ledger);
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    Object.assign(ctx.llm, {
      resolveModelInfo: async (): Promise<LlmResolvedModelInfo> => ({
        provider: "generic-provider",
        id: "generic-model",
        name: "Generic Model",
        reasoning: {
          efforts: [
            { id: "vendor::A" as ReasoningEffortId, name: "A" },
            { id: "vendor::B" as ReasoningEffortId, name: "B" },
          ],
          defaultEffort: "vendor::A" as ReasoningEffortId,
        },
      }),
    });
    const executor = retryExecutor({
      root,
      trend: retryTrend(1),
      ctx,
      ledger,
      commit,
      config: () => normalizeCfg({ reasoningEffort: configuredEffort }),
      resolveRoute: async (input) => {
        effortCalls.push(input.reasoningEffort);
        resolveCalls += 1;
        if (resolveCalls === 1) {
          return {
            status: "failure",
            route: { provider: "", model: "" },
            failure: { kind: "transient", code: "route-resolution-failed" },
            unresolved: true,
          };
        }
        return {
          status: "success",
          route: {
            provider: "generic-provider",
            model: "generic-model",
            ...(input.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: input.reasoningEffort }),
          },
        };
      },
      now: () => now,
    });

    try {
      await expect(executor(retryDue())).rejects.toThrow("模型路由解析失败");
      expect(effortCalls).toEqual(["vendor::A"]);
      expect((await ledger.get("daily", RETRY_DAY))?.route.reasoningEffort).toBe("vendor::A");

      configuredEffort = "vendor::B";
      now = RETRY_NOW + 60_000;
      const result = await executor(retryDue());
      expect(result.meta?.provider).toBe("generic-provider");
      expect(effortCalls).toEqual(["vendor::A", "vendor::A"]);
      expect(calls[0]?.reasoningEffort).toBe("vendor::A");
      expect(await ledger.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "permanent", failure: { kind: "permanent" as const, code: "route-unavailable" } },
    { name: "unknown", failure: { kind: "unknown" as const, code: "route-unknown" } },
  ])("$name route failure 直接 terminal，stream=0", async ({ failure }) => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-route-terminal-"));
    const ledger = retryLedger(root, () => "cycle-route-terminal");
    const commit = commitCurrentThenClear(root, ledger);
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    const executor = retryExecutor({
      root,
      trend: retryTrend(1),
      ctx,
      ledger,
      commit,
      resolveRoute: async () => ({
        status: "failure",
        route: { provider: "", model: "" },
        failure,
      }),
    });

    try {
      await expect(executor(retryDue())).rejects.toThrow();
      expect(calls).toHaveLength(0);
      expect(await ledger.list()).toMatchObject([
        { terminal: true, reason: failure, phase: "terminal" },
      ]);
      expect(commit.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("noData 仍返回成功 ReportResult，提交 lastRun 并清 claim，模型调用为 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-nodata-"));
    const ledger = retryLedger(root, () => "cycle-nodata");
    const commit = commitCurrentThenClear(root, ledger);
    const messages: string[] = [];
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    const executor = retryExecutor({
      root,
      trend: retryTrend(0),
      ctx,
      ledger,
      commit,
      warn: (message) => messages.push(message),
    });

    try {
      const result = await executor(retryDue());

      expect(result.meta).toMatchObject({ ok: true, noData: true, key: RETRY_DAY, durationMs: 0 });
      expect(calls).toHaveLength(0);
      expect((await readLastRun(root)).daily).toBe(RETRY_DAY);
      expect(await ledger.list()).toEqual([]);
      expect(commit.calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("成功报告使用整个 cycle 的累计 usage，而非只取最后 attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-cumulative-"));
    const ledger = retryLedger(root, () => "cycle-cumulative");
    const commit = commitCurrentThenClear(root, ledger);
    let current = RETRY_NOW;
    const firstCtx = retryContext([
      { type: "usage", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
      { type: "finish", reason: { kind: "stop" } },
    ]);
    const executor = retryExecutor({
      root,
      trend: retryTrend(1),
      ctx: firstCtx.ctx,
      ledger,
      commit,
      now: () => current,
    });

    try {
      await expect(executor(retryDue())).rejects.toThrow("模型未产出任何正文");
      current += 60_000;
      const second = retryContext([
        { type: "text-delta", index: 0, text: "第二次正文" },
        { type: "usage", usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
        { type: "finish", reason: { kind: "stop" } },
      ]);
      const secondExecutor = retryExecutor({
        root,
        trend: retryTrend(1),
        ctx: second.ctx,
        ledger,
        commit,
        now: () => current,
      });
      const result = await secondExecutor(retryDue());
      if (result.meta === undefined) throw new Error("expected report meta");
      expect(result.meta.tokens).toEqual({
        inputTokens: 15,
        outputTokens: 5,
        reasoningTokens: null,
        totalTokens: 20,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      });
      expect(commit.calls[0]?.result.meta.tokens).toEqual(result.meta.tokens);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cycle 任一 attempt 缺失 duration 时累计与最终报告保持 null", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-duration-null-"));
    const ledger = retryLedger(root, () => "cycle-duration-null");
    const route = { provider: "generic-provider", model: "generic-model" };
    const seed = { ...retryDue(), route };
    const firstClaim = await ledger.beginAttempt(seed, RETRY_NOW);
    if (firstClaim === null) throw new Error("expected first claim");
    const firstObserved = await ledger.recordAttempt(
      firstClaim,
      {
        attempt: 1,
        result: "failure",
        code: "empty-output",
        status: "retry",
        durationMs: null,
        tokens: {
          inputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          totalTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        },
      },
      RETRY_NOW,
    );
    if (firstObserved === null) throw new Error("expected first observation");
    const waiting = await ledger.recordFailure(
      firstObserved,
      { code: "empty-output", kind: "empty-output" },
      RETRY_NOW,
    );
    if (waiting === null) throw new Error("expected waiting entry");
    const commit = new RecordingCommitPort(async () => true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(RETRY_NOW);
    const { ctx } = retryContext(SUCCESS_CHUNKS, async () => {
      vi.setSystemTime(RETRY_NOW + 125);
    });
    const executor = retryExecutor({
      root,
      trend: retryTrend(1),
      ctx,
      ledger,
      commit,
      now: () => RETRY_NOW + 60_000,
    });

    try {
      const result = await executor(retryDue());
      expect(result.meta?.durationMs).toBeNull();
      expect(commit.calls[0]?.result.meta.durationMs).toBeNull();

      const current = await ledger.get(seed.period, seed.key);
      expect(current?.usage.durationMs).toBeNull();
      expect(current?.attemptObservations.map(({ durationMs }) => durationMs)).toEqual([null, 125]);
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("成功只提交一次，lastRun 前进且 ledger clear", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-success-"));
    const ledger = retryLedger(root, () => "cycle-success");
    const commit = commitCurrentThenClear(root, ledger);
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    const executor = retryExecutor({ root, trend: retryTrend(1), ctx, ledger, commit });

    try {
      const result = await executor(retryDue());

      expect(result.meta).toMatchObject({ ok: true, key: RETRY_DAY });
      expect(calls).toHaveLength(1);
      expect((await readLastRun(root)).daily).toBe(RETRY_DAY);
      expect(await ledger.list()).toEqual([]);
      expect(commit.calls[0]?.claim.cycleId).toBe("cycle-success");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("空输出按 empty-output 记 failure，attempts 消耗但不推进 lastRun", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-empty-"));
    const ledger = retryLedger(root, () => "cycle-empty");
    const commit = commitCurrentThenClear(root, ledger);
    const { ctx, calls } = retryContext([{ type: "finish", reason: { kind: "stop" } }]);
    const executor = retryExecutor({ root, trend: retryTrend(1), ctx, ledger, commit });

    try {
      await expect(executor(retryDue())).rejects.toThrow("模型未产出任何正文");

      expect(calls).toHaveLength(1);
      expect(await readLastRun(root)).toEqual({});
      expect(await ledger.list()).toEqual([
        expect.objectContaining({
          cycleId: "cycle-empty",
          attempts: 1,
          phase: "waiting",
          terminal: false,
        }),
      ]);
      expect(commit.calls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persist 失败保留 provider success observation，并将 cycle 标记 storage terminal", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-storage-"));
    mkdirSync(join(root, "reports", "index.jsonl"), { recursive: true });
    const ledger = retryLedger(root, () => "cycle-storage");
    const commit = commitCurrentThenClear(root, ledger);
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    const messages: string[] = [];
    const executor = retryExecutor({
      root,
      trend: retryTrend(1),
      ctx,
      ledger,
      commit,
      warn: (message) => messages.push(message),
    });

    try {
      await expect(executor(retryDue())).rejects.toThrow("报告持久化失败");

      expect(messages).toHaveLength(1);
      const event = JSON.parse(messages[0]!) as Record<string, unknown>;
      expect(event).toMatchObject({
        event: "report_attempt",
        period: "daily",
        key: RETRY_DAY,
        attempt: 1,
        result: "failure",
        code: "report-persist-failed",
        status: "terminal",
      });
      expect(messages[0]).not.toContain("raw");
      expect(messages[0]).not.toContain("prompt");
      expect(messages[0]).not.toContain("secret");
      expect(calls).toHaveLength(1);
      expect(await readLastRun(root)).toEqual({});
      expect(await ledger.list()).toEqual([
        expect.objectContaining({
          attempts: 0,
          phase: "terminal",
          terminal: true,
          reason: { kind: "storage", code: "report-persist-failed" },
          attemptObservations: [
            expect.objectContaining({
              attempt: 1,
              result: "success",
              code: null,
              status: "success",
            }),
          ],
          usage: expect.objectContaining({ durationMs: expect.any(Number) }),
        }),
      ]);
      expect(commit.calls).toHaveLength(1);

      await expect(executor(retryDue())).rejects.toThrow("报告重试状态不允许执行");
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("abort 在 retry executor 中落 terminal/aborted，不重试且不推进 lastRun", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-abort-"));
    const ledger = retryLedger(root, () => "cycle-abort");
    const commit = commitCurrentThenClear(root, ledger);
    const controller = new AbortController();
    controller.abort();
    const { ctx, calls } = retryContext([], async () => {
      throw new Error("raw abort secret must stay hidden");
    });
    const executor = retryExecutor({
      root,
      trend: retryTrend(1),
      ctx,
      ledger,
      commit,
      signal: controller.signal,
    });

    try {
      await expect(executor(retryDue())).rejects.toThrow("模型请求已取消");
      expect(calls).toHaveLength(0);
      expect(await readLastRun(root)).toEqual({});
      expect(commit.calls).toEqual([]);
      expect(await ledger.list()).toEqual([
        expect.objectContaining({
          attempts: 0,
          phase: "terminal",
          terminal: true,
          reason: { kind: "aborted", code: "request-aborted" },
          attemptObservations: [
            expect.objectContaining({
              attempt: 1,
              result: "failure",
              code: "request-aborted",
              status: "aborted",
            }),
          ],
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("index-reuse 命中 ledger 时由 coordinator 推进并清账", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-index-reconcile-"));
    const reports = join(root, "reports");
    mkdirSync(reports, { recursive: true });
    const meta = {
      period: "daily",
      key: RETRY_DAY,
      startDay: RETRY_DAY,
      endDay: RETRY_DAY,
      generatedAt: RETRY_NOW,
      ok: true,
      cycleId: "cycle-index-reuse",
    };
    writeFileSync(join(reports, "index.jsonl"), JSON.stringify(meta) + "\n");
    const ledger = retryLedger(root, () => "cycle-index-reuse");
    const coordinator = createReportStateCoordinator({ root, ledger });
    const claim = await coordinator.beginAttempt(
      {
        ...retryDue(),
        route: { provider: "generic-provider", model: "generic-model" },
      },
      RETRY_NOW,
    );
    if (claim === null) throw new Error("expected index claim");
    await updateLastRun(root, () => ({ daily: "2026-09-22" }));
    const commit = commitCurrentThenClear(root, ledger);
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    const executor = retryExecutor({
      root,
      trend: retryTrend(1),
      ctx,
      ledger,
      commit,
      reconcileIndex: coordinator.reconcileIndex,
    });
    try {
      const result = await executor(retryDue());
      expect(result).toMatchObject({ reused: true, meta });
      expect(calls).toEqual([]);
      expect((await readLastRun(root)).daily).toBe(RETRY_DAY);
      expect(await ledger.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("旧 key 成功不回退 lastRun，commit 后 claim 仍清除", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-monotonic-"));
    await updateLastRun(root, () => ({ daily: "2026-09-24" }));
    const ledger = retryLedger(root, () => "cycle-old");
    const commit = commitCurrentThenClear(root, ledger);
    const { ctx } = retryContext(SUCCESS_CHUNKS);
    const executor = retryExecutor({ root, trend: retryTrend(1), ctx, ledger, commit });

    try {
      await executor(retryDue());

      expect((await readLastRun(root)).daily).toBe("2026-09-24");
      expect(await ledger.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("未装配 retry port 的旧 key 成功也不回退 lastRun", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-legacy-monotonic-"));
    await updateLastRun(root, () => ({ daily: "2026-09-24" }));
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    const executor = makeDueReportExecutor({
      trend: retryTrend(1),
      ctx,
      getReportCfg: retryConfig,
      getPromptTemplate: () => "prompt {stats}",
      historyRoot: root,
      sanitizeDiagnostic: (value) => value,
      advanceLastRun: updateLastRun,
    });

    try {
      await executor(retryDue({ force: true }));

      expect(calls).toHaveLength(1);
      expect((await readLastRun(root)).daily).toBe("2026-09-24");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("claim 前 force 插入新 cycle：旧普通 task 被拒，新 cycle 仍可被 force claim", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-claim-cas-"));
    let sequence = 0;
    const ledger = retryLedger(root, () => `cycle-${(sequence += 1)}`);
    const coordinator = createReportStateCoordinator({ root, ledger, now: () => RETRY_NOW });
    const commit = commitCurrentThenClear(root, ledger);
    let releaseResolve: () => void = () => undefined;
    let markResolveEntered: () => void = () => undefined;
    const resolveGate = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const resolveEntered = new Promise<void>((resolve) => {
      markResolveEntered = resolve;
    });
    const resolveRoute = async () => {
      markResolveEntered();
      await resolveGate;
      return {
        status: "success" as const,
        route: { provider: "generic-provider", model: "generic-model" },
      };
    };
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    const executor = retryExecutor({
      root,
      trend: retryTrend(1),
      ctx,
      ledger,
      commit,
      resolveRoute,
    });

    try {
      const pending = executor(retryDue());
      await resolveEntered;
      const forced = await coordinator.beginForce(
        {
          ...retryDue(),
          route: { provider: "generic-provider", model: "generic-model" },
        },
        RETRY_NOW,
      );
      releaseResolve();

      await expect(pending).rejects.toMatchObject({ code: "retry-cycle-conflict" });
      expect(await ledger.get("daily", RETRY_DAY)).toMatchObject({
        cycleId: forced.cycleId,
        phase: "waiting",
        attempts: 0,
      });

      const forcedResult = await executor(retryDue({ force: true }));
      expect(forcedResult.meta).toMatchObject({ ok: true, key: RETRY_DAY });
      expect(calls).toHaveLength(1);
      expect(await ledger.list()).toEqual([]);
      expect(await readLastRun(root)).toEqual({ daily: RETRY_DAY });
    } finally {
      releaseResolve();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("旧 cycle 成功回调 CAS 丢弃，不清新 cycle、不推进 lastRun", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-cas-success-"));
    const ledger = retryLedger(
      root,
      (() => {
        let sequence = 0;
        return () => `cycle-${(sequence += 1)}`;
      })(),
    );
    const commit = commitCurrentThenClear(root, ledger);
    let release = (): void => undefined;
    let entered = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const streamEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { ctx } = retryContext(SUCCESS_CHUNKS, async () => {
      entered();
      await gate;
    });
    const executor = retryExecutor({ root, trend: retryTrend(1), ctx, ledger, commit });

    try {
      const pending = executor(retryDue());
      await streamEntered;
      const inFlight = await ledger.get("daily", RETRY_DAY);
      if (inFlight === undefined) throw new Error("expected in-flight entry");
      await ledger.beginForce(
        {
          period: "daily",
          key: RETRY_DAY,
          startDay: RETRY_DAY,
          endDay: RETRY_DAY,
          route: inFlight.route,
        },
        RETRY_NOW + 1,
      );
      release();

      await expect(pending).rejects.toThrow("报告重试周期已变化");
      expect(await readLastRun(root)).toEqual({});
      expect(await ledger.list()).toEqual([
        expect.objectContaining({ cycleId: "cycle-2", phase: "waiting", attempts: 0 }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("force 插入 generate 与 persist 之间时旧产物落盘被 fence，最终 cycle 仅含新 body", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-persist-fence-"));
    const ledger = retryLedger(
      root,
      (() => {
        let sequence = 0;
        return () => `cycle-${(sequence += 1)}`;
      })(),
    );
    const coordinator = createReportStateCoordinator({ root, ledger, now: () => RETRY_NOW });
    let releaseCommit = (): void => undefined;
    let markCommitEntered = (): void => undefined;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const commitEntered = new Promise<void>((resolve) => {
      markCommitEntered = resolve;
    });
    const commit: RetrySuccessCommitPort = {
      async commitSuccess(input) {
        markCommitEntered();
        await commitGate;
        return coordinator.commitSuccess(input);
      },
    };
    const { ctx } = retryContext(SUCCESS_CHUNKS);
    const executor = retryExecutor({ root, trend: retryTrend(1), ctx, ledger, commit });
    const htmlFile = reportHtmlFile(root, "daily", RETRY_DAY);
    const metaFile = reportMetaFile(root, "daily", RETRY_DAY);
    const indexFile = join(root, "reports", "index.jsonl");

    try {
      const oldCycle = executor(retryDue());
      await commitEntered;
      const inFlight = await coordinator.get("daily", RETRY_DAY);
      if (inFlight === undefined) throw new Error("expected in-flight cycle");
      await coordinator.beginForce(
        {
          period: "daily",
          key: RETRY_DAY,
          startDay: RETRY_DAY,
          endDay: RETRY_DAY,
          route: inFlight.route,
        },
        RETRY_NOW + 1,
      );
      releaseCommit();

      await expect(oldCycle).rejects.toThrow("报告重试周期已变化");
      expect(await readLastRun(root)).toEqual({});
      expect(await coordinator.get("daily", RETRY_DAY)).toMatchObject({
        cycleId: "cycle-2",
        phase: "waiting",
      });
      expect(existsSync(htmlFile)).toBe(false);
      expect(existsSync(metaFile)).toBe(false);
      expect(existsSync(indexFile)).toBe(false);

      const forced = await coordinator.get("daily", RETRY_DAY);
      if (forced === undefined) throw new Error("expected forced cycle");
      const newClaim = await coordinator.beginAttempt(
        {
          ...retryDue(),
          cycleId: forced.cycleId,
          route: forced.route,
        },
        RETRY_NOW + 2,
      );
      if (newClaim === null) throw new Error("expected forced claim");
      const newResult = {
        body: "cycle-2 新正文",
        meta: {
          period: "daily" as const,
          key: RETRY_DAY,
          startDay: RETRY_DAY,
          endDay: RETRY_DAY,
          provider: "generic-provider",
          model: "generic-model",
          generatedAt: RETRY_NOW + 2,
          durationMs: 1,
          ok: true,
        },
      };
      expect(
        await coordinator.commitSuccess({
          claim: newClaim,
          result: newResult,
          persist: () => persistReport(root, newResult.meta, newResult.body, newClaim.cycleId),
        }),
      ).toBe(true);

      expect(readFileSync(htmlFile, "utf8")).toContain("cycle-2 新正文");
      expect(readFileSync(htmlFile, "utf8")).not.toContain("报告正文");
      expect(JSON.parse(readFileSync(metaFile, "utf8"))).toMatchObject({
        generatedAt: RETRY_NOW + 2,
      });
      const indexText = readFileSync(indexFile, "utf8");
      expect(indexText).toContain('"cycleId":"cycle-2"');
      expect(indexText).not.toContain("报告正文");
      expect(readFileSync(retryLedgerFile(root), "utf8")).not.toContain("报告正文");
      expect(await readLastRun(root)).toEqual({ daily: RETRY_DAY });
      expect(await coordinator.list()).toEqual([]);
    } finally {
      releaseCommit();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("旧 cycle 失败回调 CAS 丢弃，不污染新 cycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-cas-failure-"));
    const ledger = retryLedger(
      root,
      (() => {
        let sequence = 0;
        return () => `cycle-${(sequence += 1)}`;
      })(),
    );
    const commit = commitCurrentThenClear(root, ledger);
    let release = (): void => undefined;
    let entered = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const streamEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { ctx } = retryContext(SUCCESS_CHUNKS, async () => {
      entered();
      await gate;
      throw new Error("raw provider failure must stay hidden");
    });
    const executor = retryExecutor({ root, trend: retryTrend(1), ctx, ledger, commit });

    try {
      const pending = executor(retryDue());
      await streamEntered;
      const inFlight = await ledger.get("daily", RETRY_DAY);
      if (inFlight === undefined) throw new Error("expected in-flight entry");
      await ledger.beginForce(
        {
          period: "daily",
          key: RETRY_DAY,
          startDay: RETRY_DAY,
          endDay: RETRY_DAY,
          route: inFlight.route,
        },
        RETRY_NOW + 1,
      );
      release();

      await expect(pending).rejects.toThrow("模型请求失败");
      expect(commit.calls).toEqual([]);
      expect(await ledger.list()).toEqual([
        expect.objectContaining({ cycleId: "cycle-2", phase: "waiting", attempts: 0 }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("retry-policy：纯状态机（0..5 / 固定退避 / cycle fencing / recover）", () => {
  const seed: RetrySeed = {
    period: "daily",
    key: "2026-09-23",
    startDay: "2026-09-23",
    endDay: "2026-09-23",
    route: {
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "vendor::deep",
    },
  };
  const transient: RetryFailure = { code: "upstream-unavailable", kind: "transient" };

  function claimed(entry: RetryEntry, now: number, cycleId = entry.cycleId) {
    const value = beginAttempt(entry, now, cycleId);
    if (value === null) throw new Error("expected retry claim");
    return value;
  }

  it("initial claim 保存窗口与路由快照，初次调用 attempts 仍为 0", () => {
    const entry = createInitialEntry(seed, 1_000, "cycle-1");

    expect(entry).toEqual({
      period: "daily",
      key: "2026-09-23",
      startDay: "2026-09-23",
      endDay: "2026-09-23",
      route: {
        provider: "deepseek",
        model: "deepseek-chat",
        reasoningEffort: "vendor::deep",
      },
      attempts: 0,
      maxAttempts: 5,
      nextRetryAt: 1_000,
      terminal: false,
      reason: null,
      cycleId: "cycle-1",
      phase: "initial",
      attemptObservations: [],
      usage: {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        durationMs: null,
      },
    });
    expect(claimed(entry, 1_000).entry.phase).toBe("in-flight");
  });

  it("初轮后第 1..5 次 retry 退避严格为 1/2/4/8/16 分钟", () => {
    let entry = createInitialEntry(seed, 0, "cycle-1");
    const observed: Array<{ attempts: number; delay: number }> = [];

    for (let retry = 0; retry < 5; retry += 1) {
      const claim = claimed(entry, entry.nextRetryAt ?? 0);
      const failedAt = 10_000 + retry * 1_000;
      const next = recordFailure(claim, transient, failedAt);
      if (next === null) throw new Error("expected retry transition");
      expect(next.attempts).toBe(retry + 1);
      expect(next.nextRetryAt).toBe(
        failedAt + [60_000, 120_000, 240_000, 480_000, 960_000][retry]!,
      );
      observed.push({ attempts: next.attempts, delay: next.nextRetryAt! - failedAt });
      entry = next;
    }

    expect(observed).toEqual([
      { attempts: 1, delay: 60_000 },
      { attempts: 2, delay: 120_000 },
      { attempts: 3, delay: 240_000 },
      { attempts: 4, delay: 480_000 },
      { attempts: 5, delay: 960_000 },
    ]);
  });

  it("第 5 次 retry 仍 transient 失败即 terminal，attempts 不越界", () => {
    let entry = createInitialEntry(seed, 0, "cycle-1");
    for (let retry = 0; retry < 5; retry += 1) {
      const next = recordFailure(claimed(entry, entry.nextRetryAt ?? 0), transient, retry);
      if (next === null) throw new Error("expected retry transition");
      entry = next;
    }
    const fifth = claimed(entry, entry.nextRetryAt ?? 0);
    const terminal = recordFailure(fifth, transient, 10_000);
    if (terminal === null) throw new Error("expected terminal state");

    expect(terminal).toEqual({
      ...fifth.entry,
      attempts: 5,
      maxAttempts: 5,
      nextRetryAt: null,
      terminal: true,
      reason: { code: "upstream-unavailable", kind: "transient" },
      phase: "terminal",
    });
    expect(beginAttempt(terminal, 10_000, "cycle-1")).toBeNull();
  });

  it.each([
    ["permanent", "auth-failed"],
    ["aborted", "aborted"],
    ["unknown", "unknown-finish"],
    ["storage", "persist-failed"],
  ] as const)("%s 类别首轮直接 terminal", (kind, code) => {
    const claim = claimed(createInitialEntry(seed, 0, "cycle-1"), 0);
    const next = recordFailure(claim, { kind, code }, 10_000);

    expect(next).toMatchObject({
      attempts: 0,
      nextRetryAt: null,
      terminal: true,
      reason: { code, kind },
      phase: "terminal",
    });
  });

  it("empty-output 可重试；reason 只保留稳定 code/kind，不存 raw message", () => {
    const claim = claimed(createInitialEntry(seed, 0, "cycle-1"), 0);
    const raw = {
      code: "empty-output",
      kind: "empty-output" as const,
      message: "secret upstream body must never persist",
    };
    const next = recordFailure(claim, raw, 10_000);

    expect(next).toMatchObject({
      attempts: 1,
      terminal: false,
      reason: null,
      phase: "waiting",
    });
    expect(
      JSON.stringify(
        recordFailure(
          claimed(createInitialEntry(seed, 0, "cycle-2"), 0),
          {
            ...raw,
            kind: "permanent",
          },
          10_000,
        ),
      ),
    ).not.toContain(raw.message);
  });

  it("force 以新 cycle 和当前路由快照重置 attempts/terminal/nextRetryAt", () => {
    const old = recordFailure(
      claimed(createInitialEntry(seed, 0, "cycle-old"), 0),
      { code: "auth-failed", kind: "permanent" },
      10,
    );
    if (old === null) throw new Error("expected terminal");

    const forced = beginForce(
      {
        ...seed,
        route: { provider: "new-provider", model: "new-model", reasoningEffort: undefined },
      },
      20,
      "cycle-new",
    );

    expect(forced).toEqual({
      ...seed,
      route: { provider: "new-provider", model: "new-model" },
      attempts: 0,
      maxAttempts: 5,
      nextRetryAt: 20,
      terminal: false,
      reason: null,
      cycleId: "cycle-new",
      phase: "waiting",
      attemptObservations: [],
      usage: {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        durationMs: null,
      },
    });
    expect(claimed(forced, 20, "cycle-new").entry.cycleId).toBe("cycle-new");
  });

  it("in-flight recover 回 waiting 且不消耗 attempt；waiting/terminal 保持原调度", () => {
    const initial = createInitialEntry(seed, 0, "cycle-1");
    const inFlightClaim = claimed(initial, 0);
    const inFlight = inFlightClaim.entry;
    const recovered = recover(inFlight, 50);
    expect(recovered).toEqual({ ...inFlight, phase: "waiting", nextRetryAt: 50 });

    const waiting = recordFailure(inFlightClaim, transient, 10);
    if (waiting === null) throw new Error("expected waiting");
    expect(recover(waiting, 999)).toEqual(waiting);

    const terminal = recordFailure(inFlightClaim, { code: "aborted", kind: "aborted" }, 10);
    if (terminal === null) throw new Error("expected terminal");
    expect(recover(terminal, 999)).toEqual(terminal);
    expect(recover(initial, 99)).toEqual({ ...initial, phase: "waiting", nextRetryAt: 99 });
  });

  it("旧 cycle 的 claim 不能推进新 cycle", () => {
    const oldClaim = claimed(createInitialEntry(seed, 0, "cycle-old"), 0);
    const forced = beginForce(seed, 10, "cycle-new");

    expect(beginAttempt(forced, 10, "cycle-old")).toBeNull();
    expect(recordFailure(oldClaim, transient, 20)).toEqual({
      ...oldClaim.entry,
      attempts: 1,
      nextRetryAt: 60_020,
      phase: "waiting",
    });
    expect(forced.cycleId).toBe("cycle-new");
  });

  it("reconcile 纯判定：key<=lastRun 或 index 同 period/key 均应清理", () => {
    const older = createInitialEntry({ ...seed, key: "2026-09-22" }, 0, "cycle-old");
    const newer = createInitialEntry({ ...seed, key: "2026-09-24" }, 0, "cycle-new");
    const indexed = [{ period: "daily" as const, key: "2026-09-24" }];

    expect(shouldReconcileRetry(older, { daily: "2026-09-23" }, [])).toBe(true);
    expect(shouldReconcileRetry(newer, { daily: "2026-09-23" }, [])).toBe(false);
    expect(shouldReconcileRetry(newer, {}, indexed)).toBe(true);
    expect(shouldReconcileRetry(newer, {}, [{ period: "weekly", key: "2026-09-24" }])).toBe(false);
  });
});

describe("retry-ledger：durable JSON / CAS / recover / per-root 串行", () => {
  const seed: RetrySeed = {
    period: "daily",
    key: "2026-09-23",
    startDay: "2026-09-23",
    endDay: "2026-09-23",
    route: {
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "vendor::deep",
    },
  };
  const transient: RetryFailure = { code: "upstream-unavailable", kind: "transient" };
  let savedDshHome: string | undefined;
  let home: string;
  let root: string;
  let now: number;
  let cycleSequence: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    now = Date.UTC(2026, 8, 24, 0, 0, 0);
    vi.setSystemTime(now);
    savedDshHome = process.env.DSH_HOME;
    home = mkdtempSync(join(tmpdir(), "u-retry-ledger-home-"));
    process.env.DSH_HOME = home;
    root = join(home, "dsh-provider-usage");
    cycleSequence = 0;
  });

  afterEach(() => {
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
    rmSync(home, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function newLedger(
    options: {
      renameFile?: (from: string, to: string) => Promise<void>;
      createCycleId?: () => string;
    } = {},
  ): RetryLedgerPort {
    return createRetryLedger(root, {
      now: () => now,
      createCycleId:
        options.createCycleId ??
        (() => {
          cycleSequence += 1;
          return `cycle-${cycleSequence}`;
        }),
      ...(options.renameFile === undefined ? {} : { renameFile: options.renameFile }),
    });
  }

  async function makeTerminal(
    ledger: RetryLedgerPort,
    input: RetryAttemptInput,
    failedAt: number,
  ): Promise<RetryEntry> {
    const claim = await ledger.beginAttempt(input, failedAt);
    if (claim === null) throw new Error("expected retry claim");
    const terminal = await ledger.recordFailure(
      claim,
      { code: "auth-failed", kind: "permanent" },
      failedAt,
    );
    if (terminal === null) throw new Error("expected terminal entry");
    return terminal;
  }

  it("两 attempt 按字段累计，缺失字段保持 null，重启读取观测事实", async () => {
    const first = newLedger();
    const firstClaim = await first.beginAttempt(seed, now);
    if (firstClaim === null) throw new Error("expected first claim");
    const firstEntry = await first.recordAttempt(firstClaim, {
      attempt: 1,
      result: "failure",
      code: "empty-output",
      status: "retry",
      durationMs: 125,
      tokens: {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: null,
        totalTokens: 15,
        cacheReadTokens: 2,
        cacheWriteTokens: null,
      },
    });
    if (firstEntry === null) throw new Error("expected first observation");
    const waiting = await first.recordFailure(
      firstEntry,
      { code: "empty-output", kind: "empty-output" },
      now,
    );
    if (waiting === null) throw new Error("expected waiting entry");
    const secondClaim = await first.beginAttempt(
      { ...seed, cycleId: waiting.cycleId },
      waiting.nextRetryAt!,
    );
    if (secondClaim === null) throw new Error("expected second claim");
    const secondEntry = await first.recordAttempt(secondClaim, {
      attempt: 2,
      result: "success",
      code: null,
      status: "success",
      durationMs: 75,
      tokens: {
        inputTokens: 4,
        outputTokens: null,
        reasoningTokens: 3,
        totalTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: 1,
      },
    });
    if (secondEntry === null) throw new Error("expected second observation");
    const persisted = await newLedger().get(seed.period, seed.key);
    expect(persisted?.attemptObservations).toHaveLength(2);
    expect(persisted?.usage).toEqual({
      inputTokens: 14,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      durationMs: 200,
    });
  });

  it("缺文件为空；initial claim 写 schema=1 + records[period][key]，目录/文件私有", async () => {
    const ledger = newLedger();
    expect(await ledger.list()).toEqual([]);

    const claim = await ledger.beginAttempt(seed, now);
    expect(claim).toMatchObject({
      cycleId: "cycle-1",
      entry: {
        phase: "in-flight",
        attempts: 0,
        maxAttempts: 5,
        route: seed.route,
      },
    });

    const file = retryLedgerFile(root);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw).toEqual({
      schema: 1,
      records: {
        daily: {
          "2026-09-23": {
            period: "daily",
            key: "2026-09-23",
            startDay: "2026-09-23",
            endDay: "2026-09-23",
            route: seed.route,
            attempts: 0,
            maxAttempts: 5,
            nextRetryAt: null,
            terminal: false,
            reason: null,
            cycleId: "cycle-1",
            phase: "in-flight",
            attemptObservations: [],
            usage: {
              inputTokens: null,
              outputTokens: null,
              reasoningTokens: null,
              totalTokens: null,
              cacheReadTokens: null,
              cacheWriteTokens: null,
              durationMs: null,
            },
          },
        },
      },
    });
    expect(statSync(join(root, "reports")).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, "reports")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("1/2/4/8/16 分钟跨 factory 重建保持 attempts；第 5 次 retry 失败 terminal", async () => {
    let ledger = newLedger();
    let claim = await ledger.beginAttempt(seed, now);
    if (claim === null) throw new Error("expected initial claim");
    const delays = [60_000, 120_000, 240_000, 480_000, 960_000];

    for (let index = 0; index < delays.length; index += 1) {
      const failedAt = now + index * 1_000;
      const failed = await ledger.recordFailure(claim, transient, failedAt);
      if (failed === null) throw new Error("expected waiting entry");
      expect(failed.attempts).toBe(index + 1);
      expect(failed.nextRetryAt).toBe(failedAt + delays[index]);

      ledger = newLedger();
      claim = await ledger.beginAttempt({ ...seed, cycleId: failed.cycleId }, failed.nextRetryAt!);
      if (claim === null) throw new Error("expected persisted claim");
    }

    const terminal = await ledger.recordFailure(claim, transient, now + 10_000);
    expect(terminal).toMatchObject({
      attempts: 5,
      maxAttempts: 5,
      nextRetryAt: null,
      terminal: true,
      reason: { code: "upstream-unavailable", kind: "transient" },
      phase: "terminal",
    });
    expect(await newLedger().list()).toEqual([terminal]);
  });

  it("force durable reset 新 cycle；旧 cycle 的 claim/failure/clear 均 CAS 丢弃", async () => {
    const ledger = newLedger();
    const oldClaim = await ledger.beginAttempt(seed, now);
    if (oldClaim === null) throw new Error("expected old claim");
    const forced = await ledger.beginForce(
      {
        ...seed,
        route: { provider: "new-provider", model: "new-model" },
      },
      now + 1,
    );

    expect(forced).toMatchObject({
      attempts: 0,
      terminal: false,
      reason: null,
      nextRetryAt: now + 1,
      phase: "waiting",
      cycleId: "cycle-2",
    });
    expect(await ledger.beginAttempt({ ...seed, cycleId: oldClaim.cycleId }, now + 1)).toBeNull();
    expect(await ledger.beginAttempt(seed, now + 1)).toBeNull();
    expect(await ledger.recordFailure(oldClaim, transient, now + 2)).toBeNull();
    expect(await ledger.clear(oldClaim)).toBe(false);
    expect(await ledger.get(seed.period, seed.key)).toEqual(forced);

    const newClaim = await ledger.beginAttempt({ ...seed, cycleId: forced.cycleId }, now + 1);
    if (newClaim === null) throw new Error("expected forced claim");
    expect(await ledger.clear(oldClaim)).toBe(false);
    expect(await ledger.clear(newClaim)).toBe(true);
    expect(await ledger.list()).toEqual([]);
  });

  it("同 cycle 旧 attempt 的延迟 failure/clear 不得污染当前 attempt", async () => {
    const ledger = newLedger();
    const first = await ledger.beginAttempt(seed, now);
    if (first === null) throw new Error("expected first claim");
    const waiting = await ledger.recordFailure(first, transient, now);
    if (waiting === null) throw new Error("expected waiting entry");
    expect(await ledger.clear(first)).toBe(false);

    const second = await ledger.beginAttempt(
      { ...seed, cycleId: waiting.cycleId },
      waiting.nextRetryAt!,
    );
    if (second === null) throw new Error("expected second claim");
    expect(await ledger.recordFailure(first, transient, waiting.nextRetryAt!)).toBeNull();
    expect(await ledger.clear(first)).toBe(false);
    expect(await ledger.get(seed.period, seed.key)).toEqual(second.entry);
    expect(await ledger.clear(second)).toBe(true);
  });

  it("listDue 只返回已到期非终态且 key>lastRun 的跨日 retry", async () => {
    const ledger = newLedger();
    const dueClaim = await ledger.beginAttempt(seed, now);
    if (dueClaim === null) throw new Error("expected due claim");
    const due = await ledger.recordFailure(dueClaim, transient, now);
    if (due === null) throw new Error("expected waiting entry");
    await ledger.beginForce(
      {
        ...seed,
        key: "2026-09-24",
        startDay: "2026-09-24",
        endDay: "2026-09-24",
      },
      now + 120_000,
    );
    await makeTerminal(
      ledger,
      { ...seed, key: "2026-09-25", startDay: "2026-09-25", endDay: "2026-09-25" },
      now,
    );

    expect(
      (await ledger.listDue(due.nextRetryAt!, { daily: "2026-09-22" })).map(({ key }) => key),
    ).toEqual([seed.key]);
  });

  it("recover 只把 initial/in-flight 转 waiting；waiting 保留 nextRetryAt 且不增 attempts", async () => {
    let ledger = newLedger();
    const waitingFailure = await ledger.recordFailure(
      (await ledger.beginAttempt(seed, now))!,
      transient,
      now,
    );
    if (waitingFailure === null) throw new Error("expected waiting");
    const inFlight = await ledger.beginAttempt(
      { ...seed, key: "2026-09-22", startDay: "2026-09-22", endDay: "2026-09-22" },
      now,
    );
    if (inFlight === null) throw new Error("expected in-flight claim");

    ledger = newLedger();
    const recovered = await ledger.recover(now + 10_000);
    expect(recovered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: seed.key,
          phase: "waiting",
          attempts: 1,
          nextRetryAt: waitingFailure.nextRetryAt,
        }),
        expect.objectContaining({
          key: "2026-09-22",
          phase: "waiting",
          attempts: 0,
          nextRetryAt: now + 10_000,
        }),
      ]),
    );
    expect((await ledger.get(seed.period, seed.key))?.nextRetryAt).toBe(waitingFailure.nextRetryAt);
  });

  it("坏 JSON 先 no-clobber 取证隔离，再 fail-closed；后续调用绝不把缺失文件当空", async () => {
    const reports = join(root, "reports");
    mkdirSync(reports, { recursive: true, mode: 0o700 });
    const file = retryLedgerFile(root);
    writeFileSync(file, "{ definitely-not-json", { mode: 0o600 });

    const ledger = newLedger();
    await expect(ledger.list()).rejects.toMatchObject({ code: "retry-ledger-corrupt" });
    expect(existsSync(file)).toBe(false);
    const backups = readdirSync(reports).filter((name) =>
      name.startsWith("retry-ledger.json.bak-"),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(reports, backups[0]!), "utf8")).toBe("{ definitely-not-json");
    expect(statSync(join(reports, backups[0]!)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(reports, "retry-ledger.json.corrupt"))).toBe(true);

    await expect(newLedger().list()).rejects.toMatchObject({ code: "retry-ledger-corrupt" });
    expect(readdirSync(reports).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("损坏隔离 no-clobber 且取证备份有界为 5 份", async () => {
    const reports = join(root, "reports");
    mkdirSync(reports, { recursive: true, mode: 0o700 });
    for (let age = 5; age >= 1; age -= 1) {
      writeFileSync(join(reports, `retry-ledger.json.bak-${now - age}`), `old-${age}`, {
        mode: 0o600,
      });
    }
    const protectedCandidate = join(reports, `retry-ledger.json.bak-${now}`);
    writeFileSync(protectedCandidate, "existing-evidence", { mode: 0o600 });
    writeFileSync(retryLedgerFile(root), "not-json", { mode: 0o600 });

    await expect(newLedger().list()).rejects.toMatchObject({ code: "retry-ledger-corrupt" });

    expect(readFileSync(protectedCandidate, "utf8")).toBe("existing-evidence");
    const newBackup = `retry-ledger.json.bak-${now}-1`;
    expect(readFileSync(join(reports, newBackup), "utf8")).toBe("not-json");
    expect(
      readdirSync(reports).filter((name) => name.startsWith("retry-ledger.json.bak-")),
    ).toHaveLength(5);
  });

  it("rename 前失败会删除已 fsync 的 0600 临时文件", async () => {
    let temporaryObserved = "";
    const ledger = newLedger({
      renameFile: async (from) => {
        temporaryObserved = from;
        expect(existsSync(from)).toBe(true);
        expect(statSync(from).mode & 0o777).toBe(0o600);
        throw new Error("injected rename failure");
      },
    });

    await expect(ledger.beginAttempt(seed, now)).rejects.toMatchObject({
      code: "retry-ledger-storage",
    });
    expect(temporaryObserved).not.toBe("");
    expect(readdirSync(join(root, "reports")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("同 root 写操作串行；同 key 的 daily/weekly 记录互不覆盖", async () => {
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let renameCalls = 0;
    let activeRenames = 0;
    let maxActiveRenames = 0;
    const renameFile = async (from: string, to: string): Promise<void> => {
      renameCalls += 1;
      activeRenames += 1;
      maxActiveRenames = Math.max(maxActiveRenames, activeRenames);
      if (renameCalls === 1) {
        firstEntered();
        await gate;
      }
      try {
        await rename(from, to);
      } finally {
        activeRenames -= 1;
      }
    };
    const dailyLedger = newLedger({ renameFile });
    const weeklyLedger = newLedger({ renameFile });

    const daily = dailyLedger.beginAttempt(seed, now);
    await entered;
    const weekly = weeklyLedger.beginAttempt(
      { ...seed, period: "weekly", startDay: "2026-09-23", endDay: "2026-09-23" },
      now,
    );
    await Promise.resolve();
    expect(renameCalls).toBe(1);
    releaseFirst();
    await Promise.all([daily, weekly]);

    expect(maxActiveRenames).toBe(1);
    expect((await dailyLedger.list()).map(({ period, key }) => ({ period, key }))).toEqual([
      { period: "daily", key: "2026-09-23" },
      { period: "weekly", key: "2026-09-23" },
    ]);
  });

  it("terminal 每 period 只留最新 key；reconcile 按 lastRun/index 精确清理", async () => {
    const ledger = newLedger();
    await makeTerminal(
      ledger,
      { ...seed, key: "2026-09-21", startDay: "2026-09-21", endDay: "2026-09-21" },
      now,
    );
    const newestDaily = await makeTerminal(
      ledger,
      { ...seed, key: "2026-09-23", startDay: "2026-09-23", endDay: "2026-09-23" },
      now,
    );
    const weeklyTerminal = await makeTerminal(
      ledger,
      {
        ...seed,
        period: "weekly",
        key: "2026-09-17",
        startDay: "2026-09-17",
        endDay: "2026-09-23",
      },
      now,
    );

    expect((await ledger.list()).map(({ period, key }) => ({ period, key }))).toEqual([
      { period: "daily", key: newestDaily.key },
      { period: "weekly", key: weeklyTerminal.key },
    ]);

    const indexed: Array<{ period: "daily" | "weekly" | "monthly"; key: string }> = [
      { period: "weekly", key: weeklyTerminal.key },
    ];
    const removed = await ledger.reconcile({ daily: "2026-09-23" }, indexed);
    expect(removed).toEqual([newestDaily, weeklyTerminal]);
    expect(await ledger.list()).toEqual([]);
  });

  it("ledger 只持久化稳定 reason，不落 raw message", async () => {
    const ledger = newLedger();
    const claim = await ledger.beginAttempt(seed, now);
    if (claim === null) throw new Error("expected claim");
    const failureWithRawMessage = {
      code: "persist-failed",
      kind: "storage" as const,
      message: "secret path /tmp/token and raw provider response",
    };
    await ledger.recordFailure(claim, failureWithRawMessage, now);

    const text = readFileSync(retryLedgerFile(root), "utf8");
    expect(text).toContain('"code":"persist-failed"');
    expect(text).toContain('"kind":"storage"');
    expect(text).not.toContain("secret path");
    expect(text).not.toContain("token");
  });
});

// ---------------------------------------------------------------- #1010 残余 D：outcome closure

const RAW_SECRET = "key=sk-test-not-a-real-key path=/home/private/report.json prompt=秘密提示词";

/** trend 桩：指定方法抛错，模拟未结构化同步异常（含 key/path/prompt 原文）。 */
function trendThrowing(method: "buckets" | "dirRows" | "hourRows"): TrendTracker {
  const boom = (): never => {
    throw new Error(RAW_SECRET);
  };
  const base = {
    buckets: () => [
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
  };
  return { ...base, [method]: boom } as unknown as TrendTracker;
}

/** commit 端口：进入后直接抛指定错误（模拟 coordinator 内部 reject）。 */
function commitRejecting(error: () => Error): RetrySuccessCommitPort {
  return {
    async commitSuccess() {
      throw error();
    },
  };
}

describe("runner/executor：#1010 残余 D outcome reject 必须有终态不留 in-flight", () => {
  it.each(["buckets", "dirRows", "hourRows"] as const)(
    "trend.%s() 抛错 → unknown failure 且 cycle 进入 terminal（不留 in-flight）",
    async (method) => {
      const root = mkdtempSync(join(tmpdir(), "u-closure-trend-"));
      const ledger = retryLedger(root, () => "cycle-closure");
      const commit = commitCurrentThenClear(root, ledger);
      const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
      const messages: string[] = [];
      const executor = retryExecutor({
        root,
        trend: trendThrowing(method),
        ctx,
        ledger,
        commit,
        warn: (message) => messages.push(message),
      });

      try {
        await expect(executor(retryDue())).rejects.toThrow();

        const entries = await ledger.list();
        expect(entries).toEqual([
          expect.objectContaining({
            cycleId: "cycle-closure",
            phase: "terminal",
            terminal: true,
            reason: { kind: "unknown", code: "report-outcome-failed" },
          }),
        ]);
        expect(calls).toHaveLength(0);
        expect(await readLastRun(root)).toEqual({});
        for (const message of messages) expect(message).not.toContain("sk-test-not-a-real-key");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("commit reject（非 persist）同样收敛为 typed failure 并记录终态", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-closure-commit-"));
    const ledger = retryLedger(root, () => "cycle-commit-reject");
    const commit = commitRejecting(() => new Error(RAW_SECRET));
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    const executor = retryExecutor({ root, trend: retryTrend(1), ctx, ledger, commit });

    try {
      await expect(executor(retryDue())).rejects.toThrow();

      expect(await ledger.list()).toEqual([
        expect.objectContaining({
          phase: "terminal",
          terminal: true,
          reason: { kind: "unknown", code: "report-outcome-failed" },
        }),
      ]);
      expect(calls).toHaveLength(1);
      expect(await readLastRun(root)).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restart 后 terminal cycle 不被 recover 转回 waiting（不自动重跑）", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-closure-restart-"));
    let cycleSequence = 0;
    const makeLedger = (): RetryLedgerPort =>
      createRetryLedger(root, {
        now: () => RETRY_NOW,
        createCycleId: () => `cycle-${(cycleSequence += 1)}`,
      });
    const commit = commitCurrentThenClear(root, makeLedger());
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    const executor = retryExecutor({
      root,
      trend: trendThrowing("buckets"),
      ctx,
      ledger: makeLedger(),
      commit,
    });

    try {
      await expect(executor(retryDue())).rejects.toThrow();
      expect(calls).toHaveLength(0);

      // 模拟进程重启：新建 ledger 实例执行 recover。
      const recovered = await makeLedger().recover(RETRY_NOW + 120_000);

      expect(recovered).toEqual([expect.objectContaining({ phase: "terminal", terminal: true })]);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("coordinator storage code 的 reject 记为 storage 终态（不伪装 unknown）", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-closure-storage-code-"));
    const ledger = retryLedger(root, () => "cycle-storage-code");
    const commit = commitRejecting(() =>
      Object.assign(new Error("report state storage operation failed"), {
        code: "report-state-storage",
      }),
    );
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    const executor = retryExecutor({ root, trend: retryTrend(1), ctx, ledger, commit });

    try {
      await expect(executor(retryDue())).rejects.toThrow();

      expect(await ledger.list()).toEqual([
        expect.objectContaining({
          phase: "terminal",
          terminal: true,
          reason: { kind: "storage", code: "report-state-storage" },
        }),
      ]);
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("outcome reject 不重复调用模型（storage 侧不重调 provider）", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-closure-norecall-"));
    const ledger = retryLedger(root, () => "cycle-norecall");
    const commit = commitRejecting(() => new Error("报告持久化失败"));
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    const executor = retryExecutor({ root, trend: retryTrend(1), ctx, ledger, commit });

    try {
      await expect(executor(retryDue())).rejects.toThrow();
      expect(calls).toHaveLength(1);

      await expect(executor(retryDue())).rejects.toThrow("报告重试状态不允许执行");
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- #1010 残余 E：storage 事务恢复

/** 报告成功 meta + 正文（commit persist 用）。 */
function commitFixtureResult() {
  return {
    body: "报告正文",
    meta: {
      period: "daily" as const,
      key: RETRY_DAY,
      startDay: RETRY_DAY,
      endDay: RETRY_DAY,
      provider: "generic-provider",
      model: "generic-model",
      generatedAt: RETRY_NOW,
      durationMs: 1,
      ok: true as const,
    },
  };
}

/** 一次性失败的端口包装（注入真实 I/O 失败，不改生产代码）。 */
function failingPort(base: RetryLedgerPort, overrides: Partial<RetryLedgerPort>): RetryLedgerPort {
  return { ...base, ...overrides };
}

/** 读围栏文件；未落盘即空围栏（无 marker 是合法状态）。 */
function fenceEntries(root: string): {
  commits: Array<{ period: string; key: string; cycleId: string }>;
  storageTerminals: Array<{ period: string; key: string; cycleId: string }>;
} {
  const file = retryFenceFile(root);
  if (!existsSync(file)) return { commits: [], storageTerminals: [] };
  return JSON.parse(readFileSync(file, "utf8")) as {
    commits: Array<{ period: string; key: string; cycleId: string }>;
    storageTerminals: Array<{ period: string; key: string; cycleId: string }>;
  };
}

describe("coordinator：#1010 残余 E 半提交与 storage 失败的可恢复协议", () => {
  it("ledger.clear 失败：lastRun 已推进不回滚，落半提交 marker，重启后幂等补完", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-recover-clear-"));
    let sequence = 0;
    const newLedger = (): RetryLedgerPort =>
      createRetryLedger(root, {
        now: () => RETRY_NOW,
        createCycleId: () => `cycle-${(sequence += 1)}`,
      });
    const seed = newLedger();
    const claim = await seed.beginAttempt(
      { ...retryDue(), route: { provider: "generic-provider", model: "generic-model" } },
      RETRY_NOW,
    );
    if (claim === null) throw new Error("expected seed claim");
    let clearCalls = 0;
    const flaky = failingPort(seed, {
      clear: async (target) => {
        clearCalls += 1;
        if (clearCalls === 1) throw new Error("EIO: simulated ledger clear failure");
        return seed.clear(target);
      },
    });
    const coordinator = createReportStateCoordinator({
      root,
      ledger: flaky,
      now: () => RETRY_NOW,
    });
    const result = commitFixtureResult();

    try {
      await expect(
        coordinator.commitSuccess({
          claim,
          result,
          persist: () => persistReport(root, result.meta, result.body, claim.cycleId),
        }),
      ).rejects.toThrow();

      expect(clearCalls).toBe(1);
      expect(await readLastRun(root)).toEqual({ daily: RETRY_DAY });
      expect(existsSync(reportHtmlFile(root, "daily", RETRY_DAY))).toBe(true);
      expect(fenceEntries(root).commits).toEqual([
        { period: "daily", key: RETRY_DAY, cycleId: claim.cycleId },
      ]);
      expect(await seed.get("daily", RETRY_DAY)).toMatchObject({ phase: "in-flight" });

      // 重启：新 ledger + 新 coordinator 执行 recover。
      const restarted = createReportStateCoordinator({
        root,
        ledger: newLedger(),
        now: () => RETRY_NOW + 1_000,
      });
      await restarted.recover(RETRY_NOW + 1_000);

      expect(await newLedger().get("daily", RETRY_DAY)).toBeUndefined();
      expect(await readLastRun(root)).toEqual({ daily: RETRY_DAY });
      expect(fenceEntries(root).commits).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lastRun 写失败：半提交 marker 保留，重启后补写 lastRun 并清账", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-recover-lastrun-"));
    let sequence = 0;
    const newLedger = (): RetryLedgerPort =>
      createRetryLedger(root, {
        now: () => RETRY_NOW,
        createCycleId: () => `cycle-${(sequence += 1)}`,
      });
    const seed = newLedger();
    const claim = await seed.beginAttempt(
      { ...retryDue(), route: { provider: "generic-provider", model: "generic-model" } },
      RETRY_NOW,
    );
    if (claim === null) throw new Error("expected seed claim");
    let writeCalls = 0;
    const coordinator = createReportStateCoordinator({
      root,
      ledger: seed,
      now: () => RETRY_NOW,
      updateLastRun: async (_root, patch) => {
        writeCalls += 1;
        if (writeCalls === 1) throw new Error("EIO: simulated last-run write failure");
        await updateLastRun(_root, patch);
      },
    });
    const result = commitFixtureResult();

    try {
      await expect(
        coordinator.commitSuccess({
          claim,
          result,
          persist: () => persistReport(root, result.meta, result.body, claim.cycleId),
        }),
      ).rejects.toThrow();

      expect(writeCalls).toBe(1);
      expect(await readLastRun(root)).toEqual({});
      expect(fenceEntries(root).commits).toEqual([
        { period: "daily", key: RETRY_DAY, cycleId: claim.cycleId },
      ]);

      const restarted = createReportStateCoordinator({
        root,
        ledger: newLedger(),
        now: () => RETRY_NOW + 1_000,
      });
      await restarted.recover(RETRY_NOW + 1_000);

      expect(await newLedger().get("daily", RETRY_DAY)).toBeUndefined();
      expect(await readLastRun(root)).toEqual({ daily: RETRY_DAY });
      expect(fenceEntries(root).commits).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persist 失败且 terminalize 写失败：落 storage-terminal marker，重启不转 waiting", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-recover-terminal-write-"));
    mkdirSync(join(root, "reports", "index.jsonl"), { recursive: true });
    let sequence = 0;
    const newLedger = (): RetryLedgerPort =>
      createRetryLedger(root, {
        now: () => RETRY_NOW,
        createCycleId: () => `cycle-${(sequence += 1)}`,
      });
    const seed = newLedger();
    const claim = await seed.beginAttempt(
      { ...retryDue(), route: { provider: "generic-provider", model: "generic-model" } },
      RETRY_NOW,
    );
    if (claim === null) throw new Error("expected seed claim");
    const flaky = failingPort(seed, {
      recordFailure: async () => {
        throw new Error("EIO: simulated terminal write failure");
      },
    });
    const coordinator = createReportStateCoordinator({
      root,
      ledger: flaky,
      now: () => RETRY_NOW,
    });
    const result = commitFixtureResult();

    try {
      await expect(
        coordinator.commitSuccess({
          claim,
          result,
          persist: () => persistReport(root, result.meta, result.body, claim.cycleId),
        }),
      ).rejects.toThrow();

      expect(await seed.get("daily", RETRY_DAY)).toMatchObject({ phase: "in-flight" });
      expect(fenceEntries(root).storageTerminals).toEqual([
        { period: "daily", key: RETRY_DAY, cycleId: claim.cycleId },
      ]);
      expect(fenceEntries(root).commits).toEqual([]);

      const restarted = newLedger();
      const recovered = await createReportStateCoordinator({
        root,
        ledger: restarted,
        now: () => RETRY_NOW + 1_000,
      }).recover(RETRY_NOW + 1_000);

      expect(recovered).toEqual([expect.objectContaining({ phase: "in-flight" })]);
      expect(await restarted.listDue(RETRY_NOW + 1_000, {})).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persist 失败且 terminalize 成功：entry 为 storage terminal 且无半提交 marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-recover-persist-fail-"));
    mkdirSync(join(root, "reports", "index.jsonl"), { recursive: true });
    const ledger = retryLedger(root, () => "cycle-persist-fail");
    const claim = await ledger.beginAttempt(
      { ...retryDue(), route: { provider: "generic-provider", model: "generic-model" } },
      RETRY_NOW,
    );
    if (claim === null) throw new Error("expected seed claim");
    const coordinator = createReportStateCoordinator({
      root,
      ledger,
      now: () => RETRY_NOW,
    });
    const result = commitFixtureResult();

    try {
      await expect(
        coordinator.commitSuccess({
          claim,
          result,
          persist: () => persistReport(root, result.meta, result.body, claim.cycleId),
        }),
      ).rejects.toThrow("报告持久化失败");

      expect(await ledger.get("daily", RETRY_DAY)).toMatchObject({
        phase: "terminal",
        terminal: true,
        reason: { kind: "storage", code: "report-persist-failed" },
      });
      expect(await readLastRun(root)).toEqual({});
      expect(fenceEntries(root)).toEqual({ commits: [], storageTerminals: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("旧 cycle 的 index 不得清理或推进更新的 force cycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-recover-force-fence-"));
    const ledger = retryLedger(
      root,
      (() => {
        let sequence = 0;
        return () => `cycle-${(sequence += 1)}`;
      })(),
    );
    const coordinator = createReportStateCoordinator({
      root,
      ledger,
      now: () => RETRY_NOW,
    });

    try {
      const forced = await coordinator.beginForce(
        {
          ...retryDue(),
          route: { provider: "generic-provider", model: "generic-model" },
        },
        RETRY_NOW,
      );

      expect(
        await coordinator.reconcileIndex({
          period: "daily",
          key: RETRY_DAY,
          indexed: true,
          cycleId: "cycle-old",
        }),
      ).toBe(false);
      expect(await readLastRun(root)).toEqual({});
      expect(await ledger.get("daily", RETRY_DAY)).toMatchObject({
        cycleId: forced.cycleId,
        phase: "waiting",
        terminal: false,
      });

      expect(
        await coordinator.reconcile({}, [
          { period: "daily", key: RETRY_DAY, cycleId: "cycle-old" },
        ]),
      ).toEqual([]);
      expect(await readLastRun(root)).toEqual({});
      expect(await ledger.get("daily", RETRY_DAY)).toMatchObject({
        cycleId: forced.cycleId,
        phase: "waiting",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- #1010 残余 F：noData 与 terminal ledger

describe("executor/retry-ledger：#1010 残余 F noData 与 terminal key 语义", () => {
  it("noData 窗口不因路由解析失败而卡住：仍推进 lastRun、清 claim、模型调用 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-f7-nodata-route-"));
    const ledger = retryLedger(root, () => "cycle-nodata-route");
    const commit = commitCurrentThenClear(root, ledger);
    let listModelsCalls = 0;
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS, undefined, async () => {
      listModelsCalls += 1;
      throw new Error("raw listModels failure must stay hidden");
    });
    const executor = retryExecutor({
      root,
      trend: retryTrend(0),
      ctx,
      ledger,
      commit,
      config: () => normalizeCfg({ provider: "", model: "", push: { enabled: false } }),
    });

    try {
      const result = await executor(retryDue());

      expect(result.meta).toMatchObject({ ok: true, noData: true, key: RETRY_DAY });
      expect(listModelsCalls).toBe(0);
      expect(calls).toHaveLength(0);
      expect((await readLastRun(root)).daily).toBe(RETRY_DAY);
      expect(await ledger.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("40 个 daily terminal key 全量留墓碑；最老 key 跨重启不执行，manual force 仍可开新 cycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-f7-terminal-tombstones-"));
    let now = Date.UTC(2026, 8, 24, 0, 0, 0);
    let sequence = 0;
    const route = { provider: "generic-provider", model: "generic-model" };
    const terminalKeys = Array.from({ length: 40 }, (_, offset) =>
      new Date(Date.UTC(2026, 6, 1 + offset)).toISOString().slice(0, 10),
    );
    const oldestKey = terminalKeys[0]!;
    const newestKey = terminalKeys.at(-1)!;
    const newLedger = (): RetryLedgerPort =>
      createRetryLedger(root, {
        now: () => now,
        createCycleId: () => `cycle-${(sequence += 1)}`,
      });
    const ledger = newLedger();
    const seedFor = (key: string): RetryAttemptInput => ({
      period: "daily",
      key,
      startDay: key,
      endDay: key,
      route,
    });
    let oldestCycleId = "";

    try {
      for (const key of terminalKeys) {
        const claim = await ledger.beginAttempt(seedFor(key), now);
        if (claim === null) throw new Error(`expected terminal seed claim for ${key}`);
        const done = await ledger.recordFailure(
          claim,
          { code: "auth-failed", kind: "permanent" },
          now,
        );
        if (done === null) throw new Error(`expected terminal transition for ${key}`);
        if (key === oldestKey) oldestCycleId = done.cycleId;
        now += 60_000;
      }

      const persisted = JSON.parse(readFileSync(retryLedgerFile(root), "utf8")) as {
        records: { daily: Record<string, unknown> };
        terminalKeys?: { daily?: Record<string, string> };
      };
      expect(Object.keys(persisted.records.daily)).toEqual([newestKey]);
      expect(persisted.terminalKeys?.daily).toEqual(
        Object.fromEntries(terminalKeys.slice(0, -1).map((key) => [key, "auth-failed"])),
      );
      expect(
        [
          ...Object.keys(persisted.terminalKeys?.daily ?? {}),
          ...Object.keys(persisted.records.daily),
        ].sort(),
      ).toEqual(terminalKeys);
      expect(
        (await ledger.list()).map(({ key, phase, terminal }) => ({ key, phase, terminal })),
      ).toEqual([{ key: newestKey, phase: "terminal", terminal: true }]);

      const persistedBeforeBlockedAttempts = readFileSync(retryLedgerFile(root), "utf8");
      for (const key of terminalKeys) {
        expect(await ledger.beginAttempt(seedFor(key), now)).toBeNull();
      }
      expect(readFileSync(retryLedgerFile(root), "utf8")).toBe(persistedBeforeBlockedAttempts);
      expect(await ledger.get("daily", oldestKey)).toBeUndefined();

      const reopened = newLedger();
      const coordinator = createReportStateCoordinator({ root, ledger: reopened, now: () => now });
      expect(await reopened.beginAttempt(seedFor(oldestKey), now)).toBeNull();
      expect(await coordinator.beginAttempt(seedFor(oldestKey), now)).toBeNull();
      expect(await reopened.get("daily", oldestKey)).toBeUndefined();

      const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
      const oldestTrend = {
        buckets: () => [
          {
            day: oldestKey,
            providers: [
              {
                provider: route.provider,
                model: route.model,
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
      const executor = retryExecutor({
        root,
        trend: oldestTrend,
        ctx,
        ledger: reopened,
        commit: commitCurrentThenClear(root, reopened),
        now: () => now,
      });

      await expect(
        executor({
          period: "daily",
          key: oldestKey,
          startDay: oldestKey,
          endDay: oldestKey,
        }),
      ).rejects.toThrow("报告重试状态不允许执行");
      expect(calls).toEqual([]);
      expect(await reopened.get("daily", oldestKey)).toBeUndefined();

      const forced = await reopened.beginForce(seedFor(oldestKey), now);
      expect(forced).toMatchObject({
        period: "daily",
        key: oldestKey,
        route,
        phase: "waiting",
        terminal: false,
        attempts: 0,
      });
      expect(forced.cycleId).not.toBe(oldestCycleId);
      expect(
        await reopened.beginAttempt({ ...seedFor(oldestKey), cycleId: forced.cycleId }, now),
      ).toMatchObject({
        cycleId: forced.cycleId,
        entry: { phase: "in-flight", terminal: false, attempts: 0 },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- #1010 残余 G：outer catch 不外泄原文

const OUTER_RAW_SECRET =
  "key=sk-test-not-a-real-key path=/home/private/report.json prompt=提示词原文";

describe("executor：#1010 残余 G 外层 catch 只输出稳定安全文案", () => {
  it("trend 抛错时 executor 抛出的 code/message 均不含 key/path/prompt 原文", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-outer-safe-"));
    const ledger = retryLedger(root, () => "cycle-outer-safe");
    const commit = commitCurrentThenClear(root, ledger);
    const { ctx } = retryContext(SUCCESS_CHUNKS);
    const executor = retryExecutor({
      root,
      trend: {
        buckets: () => {
          throw new Error(OUTER_RAW_SECRET);
        },
        dirRows: () => [],
        hourRows: () => [],
      } as unknown as TrendTracker,
      ctx,
      ledger,
      commit,
      // 组合根的脱敏接缝故意「什么都不改」，用于证明 executor 自身已结构化。
      sanitize: (value) => value,
    });

    try {
      let caught: unknown;
      try {
        await executor(retryDue());
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & { code?: unknown };
      expect(error.code).toBe("report-outcome-failed");
      expect(error.message).not.toContain("sk-test-not-a-real-key");
      expect(error.message).not.toContain("/home/private/report.json");
      expect(error.message).not.toContain("提示词原文");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("带稳定 code 的第三方异常也不外泄原文（只保留 code + 安全文案）", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-outer-coded-"));
    const { ctx } = retryContext(SUCCESS_CHUNKS);
    const executor = makeDueReportExecutor({
      trend: {
        buckets: () => {
          throw Object.assign(new Error(OUTER_RAW_SECRET), { code: "enoent" });
        },
        dirRows: () => [],
        hourRows: () => [],
      } as unknown as TrendTracker,
      ctx,
      getReportCfg: () => normalizeCfg({ provider: "", model: "", push: { enabled: false } }),
      getPromptTemplate: () => "prompt",
      historyRoot: root,
      // 组合根脱敏接缝故意恒等：证明 executor 外层自身已结构化，而非依赖前缀替换。
      sanitizeDiagnostic: (value) => value,
      advanceLastRun: updateLastRun,
    });

    try {
      let caught: unknown;
      try {
        await executor(retryDue());
      } catch (error: unknown) {
        caught = error;
      }

      const error = caught as Error & { code?: unknown };
      expect(caught).toBeInstanceOf(Error);
      expect(error.code).toBe("enoent");
      expect(error.message).toBe("报告生成失败");
      expect(error.message).not.toContain(OUTER_RAW_SECRET);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("通知失败（notifier.send reject）不外泄原文且不影响报告成功", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-outer-notify-"));
    const ledger = retryLedger(root, () => "cycle-notify");
    const commit = commitCurrentThenClear(root, ledger);
    const { ctx: baseCtx, calls } = retryContext(SUCCESS_CHUNKS);
    const ctx = {
      ...baseCtx,
      get: () => ({
        send: async () => {
          throw new Error(OUTER_RAW_SECRET);
        },
      }),
    } as unknown as Context;
    const executor = retryExecutor({
      root,
      trend: retryTrend(1),
      ctx,
      ledger,
      commit,
      config: () => normalizeCfg({ push: { enabled: true } }),
    });

    try {
      const result = await executor(retryDue());

      expect(result.meta?.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(await ledger.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- #1010 残余 H：交互面回归

describe("残余 H：新收敛逻辑与既有不变量的交互", () => {
  it("探测为 noData 但快照阶段出现数据：占位 route 永不 stream，fail closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-h-route-race-"));
    const ledger = retryLedger(root, () => "cycle-route-race");
    const commit = commitCurrentThenClear(root, ledger);
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    let bucketReads = 0;
    const executor = retryExecutor({
      root,
      trend: {
        buckets: () => {
          bucketReads += 1;
          return bucketReads === 1 ? [] : retryTrend(1).buckets();
        },
        dirRows: () => [],
        hourRows: () => [],
      } as unknown as TrendTracker,
      ctx,
      ledger,
      commit,
      config: () => normalizeCfg({ provider: "", model: "", push: { enabled: false } }),
    });

    try {
      await expect(executor(retryDue())).rejects.toThrow();

      expect(calls).toHaveLength(0);
      expect(existsSync(reportHtmlFile(root, "daily", RETRY_DAY))).toBe(false);
      expect(await readLastRun(root)).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("storage-terminal 围栏不阻塞 force 打开的新 cycle（可再次自动执行）", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-h-fence-force-"));
    mkdirSync(join(root, "reports", "index.jsonl"), { recursive: true });
    let sequence = 0;
    const newLedger = (): RetryLedgerPort =>
      createRetryLedger(root, {
        now: () => RETRY_NOW,
        createCycleId: () => `cycle-${(sequence += 1)}`,
      });
    const seed = newLedger();
    const claim = await seed.beginAttempt(
      { ...retryDue(), route: { provider: "generic-provider", model: "generic-model" } },
      RETRY_NOW,
    );
    if (claim === null) throw new Error("expected seed claim");
    const flaky = failingPort(seed, {
      recordFailure: async () => {
        throw new Error("EIO: simulated terminal write failure");
      },
    });
    const result = commitFixtureResult();

    try {
      await expect(
        createReportStateCoordinator({ root, ledger: flaky, now: () => RETRY_NOW }).commitSuccess({
          claim,
          result,
          persist: () => persistReport(root, result.meta, result.body, claim.cycleId),
        }),
      ).rejects.toThrow();
      expect(fenceEntries(root).storageTerminals).toHaveLength(1);

      const reopened = newLedger();
      const forced = await reopened.beginForce(
        { ...retryDue(), route: { provider: "generic-provider", model: "generic-model" } },
        RETRY_NOW + 1,
      );
      const recovered = await createReportStateCoordinator({
        root,
        ledger: reopened,
        now: () => RETRY_NOW + 2,
      }).recover(RETRY_NOW + 2);

      expect(recovered).toEqual([expect.objectContaining({ cycleId: forced.cycleId })]);
      expect(fenceEntries(root).storageTerminals).toEqual([]);
      expect(await reopened.listDue(RETRY_NOW + 2, {})).toEqual([
        expect.objectContaining({ cycleId: forced.cycleId, phase: "waiting" }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// 工具：顶层平铺结构（daily/weekly/monthly 为 ReportConfig 顶层字段）
function normalizeCfg(overrides: Record<string, unknown>) {
  return { ...JSON.parse(JSON.stringify(DEFAULT_REPORT_CONFIG)), ...overrides };
}
