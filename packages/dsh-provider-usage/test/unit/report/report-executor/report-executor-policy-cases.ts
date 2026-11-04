// Shape-only support module; all executable assertion bodies are moved verbatim.
import { describe, expect, it } from "vitest";
import {
  beginAttempt,
  beginForce,
  createInitialEntry,
  recordFailure,
  recover,
  shouldReconcileRetry,
  type RetryEntry,
  type RetryFailure,
  type RetrySeed,
} from "../../../../src/server/schedule/interface.ts";

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

export function registerRetryPolicyInitialCases(): void {
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
}

export function registerRetryPolicyTerminalCases(): void {
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
}

export function registerRetryPolicyForceRecoverCases(): void {
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
}

export function registerRetryPolicyReconcileCase(): void {
  it("reconcile 纯判定：key<=lastRun 或 index 同 period/key 均应清理", () => {
    const older = createInitialEntry({ ...seed, key: "2026-09-22" }, 0, "cycle-old");
    const newer = createInitialEntry({ ...seed, key: "2026-09-24" }, 0, "cycle-new");
    const indexed = [{ period: "daily" as const, key: "2026-09-24" }];

    expect(shouldReconcileRetry(older, { daily: "2026-09-23" }, [])).toBe(true);
    expect(shouldReconcileRetry(newer, { daily: "2026-09-23" }, [])).toBe(false);
    expect(shouldReconcileRetry(newer, {}, indexed)).toBe(true);
    expect(shouldReconcileRetry(newer, {}, [{ period: "weekly", key: "2026-09-24" }])).toBe(false);
  });
}

export function registerRetryPolicySuite(): void {
  describe("retry-policy：纯状态机（0..5 / 固定退避 / cycle fencing / recover）", () => {
    registerRetryPolicyInitialCases();
    registerRetryPolicyTerminalCases();
    registerRetryPolicyForceRecoverCases();
    registerRetryPolicyReconcileCase();
  });
}
