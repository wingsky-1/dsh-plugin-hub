// Shape-only support module; all executable assertion bodies are moved verbatim.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createReportStateCoordinator,
  createRetryLedger,
  readLastRun,
  updateLastRun,
  type RetryLedgerPort,
} from "../../../../src/server/schedule/interface.ts";
import { persistReport, reportHtmlFile } from "../../../../src/server/execute/interface.ts";
import {
  commitFixtureResult,
  failingPort,
  fenceEntries,
} from "./report-executor-residual-support.ts";
import { RETRY_DAY, RETRY_NOW, retryDue, retryLedger } from "./report-executor-support.ts";

export function registerResidualERecoveryCases(): void {
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
}

export function registerResidualETerminalCases(): void {
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
}

export function registerResidualECycleCase(): void {
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
}

export function registerResidualESuite(): void {
  describe("coordinator：#1010 残余 E 半提交与 storage 失败的可恢复协议", () => {
    registerResidualERecoveryCases();
    registerResidualETerminalCases();
    registerResidualECycleCase();
  });
}
