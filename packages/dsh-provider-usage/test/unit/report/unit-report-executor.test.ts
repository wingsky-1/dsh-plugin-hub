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
  createRetryLedger,
  readLastRun,
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
import { makeDueReportExecutor, runDueReport } from "../../../src/server/execute/interface.ts";
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

// 工具：顶层平铺结构（daily/weekly/monthly 为 ReportConfig 顶层字段）
function normalizeCfg(overrides: Record<string, unknown>) {
  return { ...JSON.parse(JSON.stringify(DEFAULT_REPORT_CONFIG)), ...overrides };
}
