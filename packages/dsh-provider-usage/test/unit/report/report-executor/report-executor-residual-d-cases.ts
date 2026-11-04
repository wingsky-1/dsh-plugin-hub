// Shape-only support module; all executable assertion bodies are moved verbatim.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createRetryLedger,
  readLastRun,
  type RetryLedgerPort,
} from "../../../../src/server/schedule/interface.ts";
import type { TrendTracker } from "../../../../src/server/aggregate/interface.ts";
import { type RetrySuccessCommitPort } from "../../../../src/server/execute/interface.ts";
import {
  RETRY_DAY,
  RETRY_NOW,
  retryDue,
  retryTrend,
  retryContext,
  retryLedger,
  commitCurrentThenClear,
  retryExecutor,
  SUCCESS_CHUNKS,
} from "./report-executor-support.ts";

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

export function registerResidualDRejectCases(): void {
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
}

export function registerResidualDStorageCases(): void {
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
}

export function registerResidualDSuite(): void {
  describe("runner/executor：#1010 残余 D outcome reject 必须有终态不留 in-flight", () => {
    registerResidualDRejectCases();
    registerResidualDStorageCases();
  });
}
