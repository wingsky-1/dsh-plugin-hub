// Shape-only support module; all executable assertion bodies are moved verbatim.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { readLastRun } from "../../../../src/server/schedule/interface.ts";
import {
  RETRY_DAY,
  RETRY_NOW,
  retryDue,
  retryTrend,
  retryContext,
  retryLedger,
  RecordingCommitPort,
  commitCurrentThenClear,
  retryExecutor,
  SUCCESS_CHUNKS,
} from "./report-executor-support.ts";

export function registerExecutorUsageCases(): void {
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
}

export function registerExecutorCommitCases(): void {
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
}

export function registerExecutorPersistCase(): void {
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
}

export function registerExecutorAbortCase(): void {
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
}
