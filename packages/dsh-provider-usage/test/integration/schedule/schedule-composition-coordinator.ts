/**
 * schedule 组合根：状态协调、恢复与 force cycle 注册。
 * 测试体保持原父 suite 下的注册顺序与 await/hook 时点。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { pollUntil } from "../../helpers.ts";
import {
  LAST_RUN_SCHEMA,
  ReportScheduler,
  createReportStateCoordinator,
  createRetryLedger,
  readLastRun,
  writeLastRun,
  updateLastRun,
} from "../../../src/server/schedule/interface.ts";
import { normalizeReportConfig } from "../../../src/server/config/interface.ts";
import {
  __clearReportIndexCacheForTests,
  readReportIndex,
} from "../../../src/server/execute/interface.ts";
import { apply } from "../../../src/apply/index.ts";
import { makeApplyTestContext, quietWarn } from "./schedule-composition-case-fixtures.ts";

export function registerScheduleCommitCases(): void {
  it("commitSuccess 在同一 root 锁内单调推进 lastRun 并清理 claim", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-coordinator-"));
    try {
      const now = 1_000;
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => "cycle-b2b",
      });
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });
      const claim = await coordinator.beginAttempt(
        {
          period: "daily",
          key: "2026-09-23",
          startDay: "2026-09-23",
          endDay: "2026-09-23",
          route: { provider: "generic-provider", model: "generic-model" },
        },
        now,
      );
      if (claim === null) throw new Error("expected claim");
      await writeLastRun(root, { daily: "2026-09-24" });
      expect(
        await coordinator.commitSuccess({
          claim,
          result: { meta: { period: "daily", key: "2026-09-23" } },
          persist: async () => undefined,
        }),
      ).toBe(true);
      expect((await readLastRun(root)).daily).toBe("2026-09-24");
      expect(await ledger.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconcileIndex 只让同 cycle 成功事实清 waiting；异 cycle token 丢弃", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-index-cycle-"));
    try {
      const now = 1_000;
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => "cycle-index-success",
      });
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });
      const seed = {
        period: "daily" as const,
        key: "2026-09-23",
        startDay: "2026-09-23",
        endDay: "2026-09-23",
        route: { provider: "generic-provider", model: "generic-model" },
      };
      const claim = await coordinator.beginAttempt(seed, now);
      if (claim === null) throw new Error("expected claim");
      const waiting = await coordinator.recordFailure(
        claim,
        { code: "transient", kind: "transient" },
        now,
      );
      if (waiting === null) throw new Error("expected waiting claim");

      expect(
        await coordinator.reconcileIndex({
          period: seed.period,
          key: seed.key,
          indexed: true,
          cycleId: "cycle-other",
        }),
      ).toBe(false);
      expect(await coordinator.get(seed.period, seed.key)).toEqual(waiting);
      expect(await readLastRun(root)).toEqual({});

      expect(
        await coordinator.reconcileIndex({
          period: seed.period,
          key: seed.key,
          indexed: true,
          cycleId: waiting.cycleId,
        }),
      ).toBe(true);
      expect((await readLastRun(root)).daily).toBe(seed.key);
      expect(await coordinator.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

export function registerScheduleStateReconcileCases(): void {
  it("周期 reconcile 的旧 index token 不能清新 force；同 cycle token 才能清", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-reconcile-cycle-"));
    try {
      const now = 1_000;
      let sequence = 0;
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => `cycle-${(sequence += 1)}`,
      });
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });
      const seed = {
        period: "daily" as const,
        key: "2026-09-23",
        startDay: "2026-09-23",
        endDay: "2026-09-23",
        route: { provider: "generic-provider", model: "generic-model" },
      };
      const oldClaim = await coordinator.beginAttempt(seed, now);
      if (oldClaim === null) throw new Error("expected old claim");
      const forced = await coordinator.beginForce(seed, now + 1);
      const before = { daily: "2026-09-22" };
      await updateLastRun(root, () => before);

      await coordinator.reconcile(before, [
        { period: seed.period, key: seed.key, cycleId: oldClaim.cycleId },
      ]);
      expect(await coordinator.get(seed.period, seed.key)).toEqual(forced);
      expect(await readLastRun(root)).toEqual(before);

      await coordinator.reconcile(before, [
        { period: seed.period, key: seed.key, cycleId: forced.cycleId },
      ]);
      expect(await coordinator.list()).toEqual([]);
      expect((await readLastRun(root)).daily).toBe(seed.key);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconcile 在锁内基于最新 lastRun 合并，旧快照不能回退较新窗口", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-reconcile-monotonic-"));
    try {
      const now = 1_000;
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => "cycle-reconcile",
      });
      const seed = {
        period: "daily" as const,
        key: "2026-09-23",
        startDay: "2026-09-23",
        endDay: "2026-09-23",
        route: { provider: "generic-provider", model: "generic-model" },
      };
      const claim = await ledger.beginAttempt(seed, now);
      if (claim === null) throw new Error("expected claim");
      let current: Partial<Record<"daily" | "weekly" | "monthly", string>> = {
        daily: "2026-09-24",
      };
      const coordinator = createReportStateCoordinator({
        root,
        ledger,
        readLastRun: async () => current,
        updateLastRun: async (_root, patch) => {
          current = await patch(current);
        },
        now: () => now,
      });
      await coordinator.reconcile({ daily: "2026-09-22" }, [
        { period: "daily", key: "2026-09-23" },
      ]);
      expect(current.daily).toBe("2026-09-24");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

export function registerScheduleApplyReconcileCases(): void {
  it.each([
    {
      label: "同 cycle",
      indexCycleId: "cycle-apply-current",
      ledgerCycleId: "cycle-apply-current",
      cleared: true,
    },
    {
      label: "异 cycle",
      indexCycleId: "cycle-apply-old",
      ledgerCycleId: "cycle-apply-current",
      cleared: false,
    },
    {
      label: "无 cycleId 的旧 index",
      indexCycleId: undefined,
      ledgerCycleId: "cycle-apply-legacy",
      cleared: false,
    },
  ])(
    "真实 apply 组合根恢复 $label：lastRun 推进且只清同 cycle",
    async ({ indexCycleId, ledgerCycleId, cleared }) => {
      const root = mkdtempSync(join(tmpdir(), "b2b-apply-index-cycle-"));
      let disposers: Array<() => void | Promise<void>> = [];
      try {
        const now = Date.UTC(2026, 8, 24, 0, 0, 0);
        const ledger = createRetryLedger(root, {
          now: () => now,
          createCycleId: () => ledgerCycleId,
        });
        const seed = {
          period: "daily" as const,
          key: "2026-09-23",
          startDay: "2026-09-23",
          endDay: "2026-09-23",
          route: { provider: "generic-provider", model: "generic-model" },
        };
        const claim = await ledger.beginAttempt(seed, now);
        if (claim === null) throw new Error("expected in-flight claim");
        expect(claim.entry.phase).toBe("in-flight");

        mkdirSync(join(root, "reports"), { recursive: true });
        // 已完成存储升级，避免 upgrade 链先行按历史 index 校准 last-run；
        // 本用例只钉 ReportScheduler recovery → coordinator.reconcile 的 cycle 门。
        writeFileSync(join(root, ".upgrade-version"), "0.2.5\n");
        writeFileSync(
          join(root, "reports", "last-run.json"),
          JSON.stringify({ schema: LAST_RUN_SCHEMA }),
        );
        writeFileSync(
          join(root, "reports", "index.jsonl"),
          `${JSON.stringify({
            period: seed.period,
            key: seed.key,
            startDay: seed.startDay,
            endDay: seed.endDay,
            provider: seed.route.provider,
            model: seed.route.model,
            generatedAt: now + 1,
            durationMs: 0,
            ok: true,
            cycleId: indexCycleId,
          })}\n`,
        );
        __clearReportIndexCacheForTests();
        expect((await readReportIndex(root))[0]?.cycleId).toBe(indexCycleId);

        const context = makeApplyTestContext();
        disposers = context.disposers;
        await apply(context.ctx, {
          autoReload: false,
          apiKey: "sk-test",
          apiEndpoint: "http://127.0.0.1:9",
          historyDir: root,
        });

        const entries = await ledger.list();
        if (cleared) {
          expect(await readLastRun(root)).toEqual({ daily: seed.key });
          expect(entries).toEqual([]);
        } else {
          expect(await readLastRun(root)).toEqual({});
          expect(entries).toHaveLength(1);
          expect(entries[0]?.cycleId).toBe(ledgerCycleId);
          expect(entries[0]?.phase).toBe("waiting");
          expect(entries[0]?.terminal).toBe(false);
        }
      } finally {
        for (const dispose of [...disposers].reverse()) {
          try {
            await dispose();
          } catch {
            // 组合根清理不应掩盖恢复断言
          }
        }
        __clearReportIndexCacheForTests();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

export function registerScheduleSchedulerReconcileCases(): void {
  it("legacy index 无 cycleId 且无 live ledger 时只推进一次 lastRun", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-legacy-index-only-"));
    const now = Date.UTC(2026, 8, 24, 0, 0, 0);
    const key = "2026-09-23";
    try {
      mkdirSync(join(root, "reports"), { recursive: true });
      writeFileSync(
        join(root, "reports", "index.jsonl"),
        `${JSON.stringify({
          period: "daily",
          key,
          startDay: key,
          endDay: key,
          provider: "generic-provider",
          model: "generic-model",
          generatedAt: now,
          durationMs: 0,
          ok: true,
        })}\n`,
      );
      const ledger = createRetryLedger(root, { now: () => now });
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });
      const seen: string[] = [];
      const scheduler = ReportScheduler.start({
        root,
        config: normalizeReportConfig({
          daily: { enabled: true, time: "00:00" },
          weekly: { enabled: false },
          monthly: { enabled: false },
        }),
        coordinator,
        listIndexed: async () => [{ period: "daily", key }],
        now: () => now,
        onDue: async (due) => {
          seen.push(due.key);
        },
        tickMs: 60_000,
        warn: quietWarn,
      });
      try {
        await scheduler.ready;
        await scheduler.tick();
        expect(seen).toEqual([]);
        expect(await readLastRun(root)).toEqual({ daily: key });
        expect(await ledger.list()).toEqual([]);
      } finally {
        scheduler.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciliation 清掉 indexed key 后不重复提交当前候选", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-indexed-stale-"));
    try {
      const now = Date.UTC(2026, 8, 24, 0, 0, 0);
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => "cycle-indexed",
      });
      const seed = {
        period: "daily" as const,
        key: "2026-09-23",
        startDay: "2026-09-23",
        endDay: "2026-09-23",
        route: { provider: "generic-provider", model: "generic-model" },
      };
      const claim = await ledger.beginAttempt(seed, now);
      if (claim === null) throw new Error("expected claim");
      const waiting = await ledger.recordFailure(
        claim,
        { code: "transient", kind: "transient" },
        now,
      );
      if (waiting === null) throw new Error("expected waiting");
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });
      const seen: Array<{ key: string }> = [];
      const scheduler = ReportScheduler.start({
        root,
        config: normalizeReportConfig({
          daily: { enabled: true, time: "00:00" },
          weekly: { enabled: false },
          monthly: { enabled: false },
        }),
        coordinator,
        listIndexed: async () => [{ period: "daily", key: "2026-09-23", cycleId: "cycle-indexed" }],
        now: () => now + 60_000,
        onDue: async (due) => {
          seen.push({ key: due.key });
        },
        tickMs: 60_000,
        warn: quietWarn,
      });
      try {
        await scheduler.ready;
        expect(seen).toEqual([]);
        await scheduler.tick();
        expect(seen).toEqual([]);
      } finally {
        scheduler.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

export function registerScheduleReadyRecoveryCases(): void {
  it("recovery 完成前 tick 不提交；ready 后跨日 waiting ledger 与当前候选合并", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-scheduler-ready-"));
    try {
      const now = Date.UTC(2026, 8, 24, 0, 0, 0);
      let cycle = 0;
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => `cycle-${(cycle += 1)}`,
      });
      const seed = {
        period: "daily" as const,
        key: "2026-09-22",
        startDay: "2026-09-22",
        endDay: "2026-09-22",
        route: { provider: "generic-provider", model: "generic-model" },
      };
      const first = await ledger.beginAttempt(seed, now);
      if (first === null) throw new Error("expected first claim");
      const failed = await ledger.recordFailure(
        first,
        { code: "transient", kind: "transient" },
        now,
      );
      if (failed === null) throw new Error("expected waiting");
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });
      const seen: Array<{ key: string }> = [];
      const scheduler = ReportScheduler.start({
        root,
        config: normalizeReportConfig({
          daily: { enabled: true, time: "00:00" },
          weekly: { enabled: false },
          monthly: { enabled: false },
        }),
        coordinator,
        listIndexed: async () => [],
        now: () => now + 60_000,
        onDue: async (due) => {
          seen.push({ key: due.key });
        },
        tickMs: 60_000,
        warn: quietWarn,
      });
      try {
        await scheduler.tick();
        expect(seen).toEqual([]);
        await scheduler.ready;
        await pollUntil(() => seen.length >= 1, 3000);
        expect(seen.map((item) => item.key)).toEqual(["2026-09-23", "2026-09-22"]);
      } finally {
        scheduler.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

export function registerScheduleForceCycleCases(): void {
  it("无 cycleId 的旧 task 不能消费 force cycle；force task 以真实 cycle 唯一单飞", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-force-cycle-race-"));
    try {
      const now = 1_000;
      const seed = {
        period: "daily" as const,
        key: "2026-09-23",
        startDay: "2026-09-23",
        endDay: "2026-09-23",
        route: { provider: "generic-provider", model: "generic-model" },
      };
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => "cycle-force",
      });
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });

      const oldTaskExisting = await coordinator.get(seed.period, seed.key);
      expect(oldTaskExisting).toBeUndefined();
      const forced = await coordinator.beginForce(seed, now);
      expect(forced).toMatchObject({ cycleId: "cycle-force", phase: "waiting" });

      const resolved = {
        status: "success" as const,
        route: { provider: "resolved-provider", model: "resolved-model" },
      };
      expect(
        await coordinator.beginAttempt(
          {
            period: seed.period,
            key: seed.key,
            startDay: seed.startDay,
            endDay: seed.endDay,
            route: resolved.route,
          },
          now + 1,
        ),
      ).toBeNull();
      expect(await coordinator.get(seed.period, seed.key)).toEqual(forced);

      const forceTaskExisting = await coordinator.get(seed.period, seed.key);
      if (forceTaskExisting === undefined) throw new Error("expected forced cycle");
      const forceClaim = await coordinator.beginAttempt(
        {
          period: seed.period,
          key: seed.key,
          startDay: seed.startDay,
          endDay: seed.endDay,
          route: forceTaskExisting.route,
          cycleId: forceTaskExisting.cycleId,
        },
        now + 1,
      );
      if (forceClaim === null) throw new Error("expected forced claim");
      expect(forceClaim.cycleId).toBe(forced.cycleId);
      expect(forceClaim.entry.phase).toBe("in-flight");
      expect(await coordinator.get(seed.period, seed.key)).toEqual(forceClaim.entry);
      expect((await coordinator.list()).filter((entry) => entry.phase === "in-flight")).toEqual([
        forceClaim.entry,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("force 覆盖后旧 task 携带旧 cycle token 仍被真实 CAS 拒绝", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-old-cycle-cas-"));
    try {
      const now = 1_000;
      let sequence = 0;
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => `cycle-${(sequence += 1)}`,
      });
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });
      const seed = {
        period: "daily" as const,
        key: "2026-09-23",
        startDay: "2026-09-23",
        endDay: "2026-09-23",
        route: { provider: "generic-provider", model: "generic-model" },
      };
      const oldClaim = await coordinator.beginAttempt(seed, now);
      if (oldClaim === null) throw new Error("expected old claim");
      const forced = await coordinator.beginForce(seed, now + 1);
      expect(oldClaim.cycleId).toBe("cycle-1");
      expect(forced.cycleId).toBe("cycle-2");

      expect(
        await coordinator.beginAttempt({ ...seed, cycleId: oldClaim.cycleId }, now + 1),
      ).toBeNull();
      expect(await coordinator.get(seed.period, seed.key)).toEqual(forced);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
