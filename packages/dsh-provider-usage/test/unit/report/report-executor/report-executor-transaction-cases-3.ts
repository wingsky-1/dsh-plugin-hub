// Shape-only support module; all executable assertion bodies are moved verbatim.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  createReportStateCoordinator,
  readLastRun,
  retryLedgerFile,
  updateLastRun,
} from "../../../../src/server/schedule/interface.ts";
import {
  makeDueReportExecutor,
  persistReport,
  reportHtmlFile,
  reportMetaFile,
  type RetrySuccessCommitPort,
} from "../../../../src/server/execute/interface.ts";
import {
  RETRY_DAY,
  RETRY_NOW,
  retryDue,
  retryConfig,
  retryTrend,
  retryContext,
  retryLedger,
  commitCurrentThenClear,
  retryExecutor,
  SUCCESS_CHUNKS,
} from "./report-executor-support.ts";

export function registerExecutorIndexCases(): void {
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
}

export function registerExecutorClaimBeforeForceCase(): void {
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
}

export function registerExecutorSuccessCasCase(): void {
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
}

export function registerExecutorPersistFenceCase(): void {
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
}

export function registerExecutorFailureCasCase(): void {
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
}
