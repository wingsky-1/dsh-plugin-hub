/**
 * schedule 组合根：D2 门面收口同一引用 + D2三-锁 队列串行/去重 + 朴素队列对照。
 *
 * 由原入口 composition-root.test.ts 在原顺序同步注册；父 suite/title/each/expect/fixture 与
 * cache 生命周期、hook/await 时点完全保持（拆分为注册调用，零行为变更）。
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pollUntil } from "../../helpers.ts";
import {
  ReportScheduler,
  ReportTaskQueue,
  beginAttempt as ImplBeginAttempt,
  readLastRun,
  writeLastRun,
  updateLastRun,
  candidateWindow,
  pendingReports,
  createRetryLedger,
  LAST_RUN_SCHEMA,
  type RetryLedgerOptions,
  type RetryLedgerPort,
} from "../../../src/server/schedule/interface.ts";
import { ReportScheduler as ImplScheduler } from "../../../src/server/schedule/scheduler.ts";
import { ReportTaskQueue as ImplQueue } from "../../../src/server/schedule/tasks.ts";
import {
  readLastRun as ImplRead,
  writeLastRun as ImplWrite,
  updateLastRun as ImplUpdate,
} from "../../../src/server/schedule/store.ts";
import {
  candidateWindow as ImplCandidate,
  pendingReports as ImplPending,
} from "../../../src/server/schedule/due.ts";
import { beginAttempt as RetryPolicyBeginAttempt } from "../../../src/server/schedule/retry-policy.ts";
import { createRetryLedger as ImplCreateRetryLedger } from "../../../src/server/schedule/retry-ledger.ts";
import { LAST_RUN_SCHEMA as ImplSchema } from "../../../src/server/shared/last-run.ts";
import type { ScheduleClock, ScheduleWarn } from "../../../src/server/schedule/deps.ts";
import * as scheduleDepsNs from "../../../src/server/schedule/deps.ts";
import type { ReportTaskInput } from "../../../src/server/schedule/interface.ts";

/** 命名接缝消费（类型链接由 tsc 编译面校验可赋值性）：块 Options 用内联双生子，名称在此复用。 */
const quietWarn: ScheduleWarn = () => undefined;
const testClock: ScheduleClock = () => Date.now();

/** 门面收口段仍须原入口读出的 src 文本（判据 = 根入口不导出 retry ledger）。 */
export interface ScheduleIdentitySources {
  indexSrc: string;
  applyIndexSrc: string;
  retryPolicySrc: string;
  retryLedgerSrc: string;
}

export function registerScheduleIdentityCases(src: ScheduleIdentitySources): void {
  const { indexSrc, applyIndexSrc, retryPolicySrc, retryLedgerSrc } = src;
  describe("D2 门面收口：interface 与实现同一引用（包装即红）", () => {
    it("ReportScheduler 同一引用", () => {
      expect(ReportScheduler).toBe(ImplScheduler);
    });

    it("ReportTaskQueue 同一引用", () => {
      expect(ReportTaskQueue).toBe(ImplQueue);
    });

    it("readLastRun 同一引用", () => {
      expect(readLastRun).toBe(ImplRead);
    });

    it("writeLastRun 同一引用", () => {
      expect(writeLastRun).toBe(ImplWrite);
    });

    it("updateLastRun 同一引用", () => {
      expect(updateLastRun).toBe(ImplUpdate);
    });

    it("candidateWindow 与 pendingReports 同一引用", () => {
      expect(candidateWindow).toBe(ImplCandidate);
      expect(pendingReports).toBe(ImplPending);
    });

    it("LAST_RUN_SCHEMA 同值（当期版本 2）", () => {
      expect(LAST_RUN_SCHEMA).toBe(ImplSchema);
      expect(LAST_RUN_SCHEMA).toBe(2);
    });

    it("retry policy 同一引用且零 Node 依赖", () => {
      expect(ImplBeginAttempt).toBe(RetryPolicyBeginAttempt);
      expect(retryPolicySrc.includes("node:")).toBe(false);
    });

    it("retry ledger factory 同一引用且可赋给包内 port", () => {
      const factory: (root: string, options?: RetryLedgerOptions) => RetryLedgerPort =
        createRetryLedger;
      const port = factory(join(tmpdir(), "d2-retry-ledger-not-created"));

      expect(factory).toBe(ImplCreateRetryLedger);
      expect(typeof port.beginAttempt).toBe("function");
      expect(typeof port.recordFailure).toBe("function");
      expect(typeof port.reconcile).toBe("function");
    });

    it("schedule ledger 不值引 registry，根入口不导出 retry ledger", () => {
      expect(retryLedgerSrc.includes("server/registry")).toBe(false);
      expect(indexSrc.includes("retry-ledger")).toBe(false);
      expect(indexSrc.includes("RetryLedger")).toBe(false);
      expect(applyIndexSrc.includes("retry-ledger")).toBe(false);
      expect(applyIndexSrc.includes("RetryLedger")).toBe(false);
    });

    it("deps.ts 纯类型面：运行时零出口", () => {
      expect(Object.keys(scheduleDepsNs)).toEqual([]);
    });

    it("命名接缝可用（类型链接 + 运行时形状）", () => {
      expect(typeof quietWarn("x")).toBe("undefined");
      expect(typeof testClock()).toBe("number");
    });
  });

  describe("D2三-锁 队列串行 + 去重（拆坏尾链必须红）", () => {
    it("B 不越过 A：后提交的任务在前任务挂起期间不启动", async () => {
      const order: string[] = [];
      let releaseA: () => void = () => undefined;
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const q = new ReportTaskQueue({
        executor: async (input: ReportTaskInput) => {
          order.push("start-" + input.key);
          if (input.key === "K1") await gateA;
          order.push("end-" + input.key);
          return {};
        },
        warn: quietWarn,
      });
      const ra = q.submit({ period: "daily", key: "K1", startDay: "K1", endDay: "K1" });
      const rb = q.submit({ period: "daily", key: "K2", startDay: "K2", endDay: "K2" });
      expect(rb.existing).toBe(false);
      await pollUntil(() => order.includes("start-K1"), 3000);
      expect(order).toEqual(["start-K1"]);
      releaseA();
      await pollUntil(
        () => q.get(ra.taskId)?.status === "done" && q.get(rb.taskId)?.status === "done",
        5000,
      );
      expect(order).toEqual(["start-K1", "end-K1", "start-K2", "end-K2"]);
    });

    it("同窗口重复提交去重：同一 taskId + 只执行一次", async () => {
      const calls: string[] = [];
      const q = new ReportTaskQueue({
        executor: async (input: ReportTaskInput) => {
          calls.push(input.key);
          return {};
        },
        now: testClock,
        warn: quietWarn,
      });
      const first = q.submit({ period: "weekly", key: "W1", startDay: "W1", endDay: "W1" });
      const second = q.submit({ period: "weekly", key: "W1", startDay: "W1", endDay: "W1" });
      expect(first.existing).toBe(false);
      expect(second.taskId).toBe(first.taskId);
      expect(second.existing).toBe(true);
      await pollUntil(() => q.get(first.taskId)?.status === "done", 5000);
      expect(calls).toEqual(["W1"]);
    });
  });
}
