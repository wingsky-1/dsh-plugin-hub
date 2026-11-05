// Shape-only support module; all executable assertion bodies are moved verbatim.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createReportStateCoordinator,
  createRetryLedger,
  readLastRun,
  retryLedgerFile,
  updateLastRun,
  type RetryAttemptInput,
  type RetryLedgerPort,
} from "../../../../src/server/schedule/interface.ts";
import type { TrendTracker } from "../../../../src/server/aggregate/interface.ts";
import type { Context } from "@deepseek-ai/cordis";
import {
  makeDueReportExecutor,
  persistReport,
  reportHtmlFile,
} from "../../../../src/server/execute/interface.ts";
import {
  commitFixtureResult,
  failingPort,
  fenceEntries,
} from "./report-executor-residual-support.ts";
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
  normalizeCfg,
} from "./report-executor-support.ts";

const OUTER_RAW_SECRET =
  "key=sk-test-not-a-real-key path=/home/private/report.json prompt=提示词原文";

async function seedTerminalTombstones(root: string): Promise<{
  ledger: RetryLedgerPort;
  terminalKeys: string[];
  oldestKey: string;
  newestKey: string;
  oldestCycleId: string;
  now: number;
  route: { provider: string; model: string };
  newLedger: () => RetryLedgerPort;
  seedFor: (key: string) => RetryAttemptInput;
}> {
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
  for (const key of terminalKeys) {
    const claim = await ledger.beginAttempt(seedFor(key), now);
    if (claim === null) throw new Error(`expected terminal seed claim for ${key}`);
    const done = await ledger.recordFailure(claim, { code: "auth-failed", kind: "permanent" }, now);
    if (done === null) throw new Error(`expected terminal transition for ${key}`);
    if (key === oldestKey) oldestCycleId = done.cycleId;
    now += 60_000;
  }
  return {
    ledger,
    terminalKeys,
    oldestKey,
    newestKey,
    oldestCycleId,
    now,
    route,
    newLedger,
    seedFor,
  };
}

export function registerResidualFNoDataCase(): void {
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
}

export function registerResidualFTombstoneCase(): void {
  it("40 个 daily terminal key 全量留墓碑；最老 key 跨重启不执行，manual force 仍可开新 cycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-f7-terminal-tombstones-"));

    try {
      const {
        ledger,
        terminalKeys,
        oldestKey,
        newestKey,
        oldestCycleId,
        now,
        route,
        newLedger,
        seedFor,
      } = await seedTerminalTombstones(root);

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
}

export function registerResidualFSuite(): void {
  describe("executor/retry-ledger：#1010 残余 F noData 与 terminal key 语义", () => {
    registerResidualFNoDataCase();
    registerResidualFTombstoneCase();
  });
}

export function registerResidualGSuite(): void {
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
}

export function registerResidualHSuite(): void {
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
          createReportStateCoordinator({ root, ledger: flaky, now: () => RETRY_NOW }).commitSuccess(
            {
              claim,
              result,
              persist: () => persistReport(root, result.meta, result.body, claim.cycleId),
            },
          ),
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
}
