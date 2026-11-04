/**
 * schedule 组合根：force queue 的 prepare、串行与 fallback 注册。
 * 测试体保持原父 suite 下的注册顺序与 await/hook 时点。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { pollUntil } from "../../helpers.ts";
import {
  ReportTaskQueue,
  createRetryLedger,
  type ReportTaskInput,
  type RetryLedgerPort,
} from "../../../src/server/schedule/interface.ts";
import { quietWarn } from "./schedule-composition-case-fixtures.ts";

/** 台账条目与 claim 入参：形状由端口签名推导，端口改了这里跟着红（勿手写镜像类型）。 */
type LedgerEntry = NonNullable<Awaited<ReturnType<RetryLedgerPort["get"]>>>;
type BeginAttemptInput = Parameters<RetryLedgerPort["beginAttempt"]>[0];

function claimInputFor(
  input: ReportTaskInput,
  existing: LedgerEntry | undefined,
  route: BeginAttemptInput["route"],
): BeginAttemptInput {
  return {
    period: input.period,
    key: input.key,
    startDay: input.startDay,
    endDay: input.endDay,
    route: existing?.route ?? route,
    ...(existing === undefined ? {} : { cycleId: existing.cycleId }),
  };
}

function signalMilestone(
  input: ReportTaskInput,
  keys: { K0: string; K1: string; K2: string },
  marks: { k0: () => void; k2: () => void; force: () => void },
): void {
  if (input.key === keys.K0) marks.k0();
  if (input.key === keys.K2) marks.k2();
  if (input.key === keys.K1 && input.force === true) marks.force();
}

const dateKeys = {
  K0: "2026-09-01",
  K1: "2026-09-02",
  K2: "2026-09-03",
} as const;

function inputFor(label: keyof typeof dateKeys): ReportTaskInput {
  const key = dateKeys[label];
  return { period: "daily", key, startDay: key, endDay: key };
}

export function registerScheduleForcePrepareOrderCases(): void {
  it("running 任务收到 force 时先 durable prepare，再排后续 cycle", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new ReportTaskQueue({
      executor: async (input) => {
        order.push(`start:${input.key}:${input.force === true ? "force" : "normal"}`);
        if (order.length === 1) await gate;
        order.push(`end:${input.key}:${input.force === true ? "force" : "normal"}`);
        return {};
      },
      prepareForce: async (input) => {
        order.push(`prepare:${input.key}`);
      },
      warn: quietWarn,
    });
    const first = queue.submit({ period: "daily", key: "K1", startDay: "K1", endDay: "K1" });
    await pollUntil(() => order.includes("start:K1:normal"), 3000);
    const forced = await queue.submitForce({
      period: "daily",
      key: "K1",
      startDay: "K1",
      endDay: "K1",
      force: true,
    });
    expect(forced.taskId).not.toBe(first.taskId);
    expect(order).toEqual(["start:K1:normal", "prepare:K1"]);
    release();
    await pollUntil(() => order.includes("end:K1:force"), 3000);
    expect(order).toEqual([
      "start:K1:normal",
      "prepare:K1",
      "end:K1:normal",
      "start:K1:force",
      "end:K1:force",
    ]);
  });
}

export function registerScheduleForcePendingCases(): void {
  it("prepare gate 内同 key normal 不会 claim force cycle；其它 key 仍可运行", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-force-pending-reservation-"));
    try {
      const now = 2_000;
      const claimNow = now + 2;
      const route = { provider: "generic-provider", model: "generic-model" };
      const seed = {
        ...inputFor("K1"),
        route,
      };
      const ledger = createRetryLedger(root, { now: () => now });

      let markK0Started: () => void = () => undefined;
      const k0Started = new Promise<void>((resolve) => {
        markK0Started = resolve;
      });
      let releaseK0: () => void = () => undefined;
      const k0Gate = new Promise<void>((resolve) => {
        releaseK0 = resolve;
      });
      let markK0Done: () => void = () => undefined;
      const k0Done = new Promise<void>((resolve) => {
        markK0Done = resolve;
      });
      let markK2Done: () => void = () => undefined;
      const k2Done = new Promise<void>((resolve) => {
        markK2Done = resolve;
      });
      let markPrepareStarted: () => void = () => undefined;
      const prepareStarted = new Promise<void>((resolve) => {
        markPrepareStarted = resolve;
      });
      let releaseBeginForce: () => void = () => undefined;
      const beginForceGate = new Promise<void>((resolve) => {
        releaseBeginForce = resolve;
      });
      let markForceEntryCreated: () => void = () => undefined;
      const forceEntryCreated = new Promise<void>((resolve) => {
        markForceEntryCreated = resolve;
      });
      let releaseFinishForce: () => void = () => undefined;
      const finishForceGate = new Promise<void>((resolve) => {
        releaseFinishForce = resolve;
      });
      let markForceDone: () => void = () => undefined;
      const forceDone = new Promise<void>((resolve) => {
        markForceDone = resolve;
      });
      const executorCalls: Array<{ key: string; force: boolean; cycleId?: string }> = [];
      let forceCycleId: string | undefined;

      const queue = new ReportTaskQueue({
        executor: async (input) => {
          if (input.key === dateKeys.K0 && input.force !== true) {
            markK0Started();
            await k0Gate;
          }
          const existing = await ledger.get(input.period, input.key);
          const claim = await ledger.beginAttempt(claimInputFor(input, existing, route), claimNow);
          executorCalls.push({
            key: input.key,
            force: input.force === true,
            cycleId: claim?.cycleId,
          });
          if (claim === null) throw new Error("expected ledger claim");
          signalMilestone(input, dateKeys, {
            k0: markK0Done,
            k2: markK2Done,
            force: markForceDone,
          });
          return {};
        },
        prepareForce: async () => {
          markPrepareStarted();
          await beginForceGate;
          const forced = await ledger.beginForce(seed, now);
          forceCycleId = forced.cycleId;
          markForceEntryCreated();
          await finishForceGate;
        },
        warn: quietWarn,
      });

      queue.submit(inputFor("K0"));
      await k0Started;
      const queuedNormal = queue.submit(inputFor("K1"));
      const forcePromise = queue.submitForce({ ...inputFor("K1"), force: true });
      await prepareStarted;

      const normalDuringPrepare = queue.submit(inputFor("K1"));
      expect(normalDuringPrepare.taskId).toBe(queuedNormal.taskId);
      expect(normalDuringPrepare.existing).toBe(true);
      expect(queue.get(normalDuringPrepare.taskId)?.status).toBe("queued");
      const other = queue.submit(inputFor("K2"));
      expect(other.existing).toBe(false);

      // The ledger force entry exists before prepare resolves. A queued normal
      // task must not get a chance to read and consume that cycle.
      releaseBeginForce();
      await forceEntryCreated;
      expect(forceCycleId).toBeDefined();
      releaseK0();
      await k0Done;
      await k2Done;
      expect(executorCalls).toHaveLength(2);
      expect(executorCalls[0]).toMatchObject({ key: dateKeys.K0, force: false });
      expect(executorCalls[1]).toMatchObject({ key: dateKeys.K2, force: false });
      expect(executorCalls.some((call) => call.key === dateKeys.K1)).toBe(false);
      expect(executorCalls[0]?.cycleId).not.toBe(forceCycleId);

      releaseFinishForce();
      const forced = await forcePromise;
      expect(forced).toEqual({ taskId: queuedNormal.taskId, existing: true });
      await forceDone;
      await pollUntil(() => queue.get(queuedNormal.taskId)?.status === "done", 3000);
      expect(executorCalls).toHaveLength(3);
      expect(executorCalls[2]).toEqual({ key: dateKeys.K1, force: true, cycleId: forceCycleId });
      expect((await ledger.get("daily", dateKeys.K1))?.cycleId).toBe(forceCycleId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

export function registerScheduleForceTailCases(): void {
  it("不同 key 的 force prepare 仍按 forceTail 串行", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const queue = new ReportTaskQueue({
      executor: async (input) => {
        order.push(`execute:${input.key}`);
        return {};
      },
      prepareForce: async (input) => {
        order.push(`prepare-start:${input.key}`);
        if (input.key === "A") {
          markFirstStarted();
          await firstGate;
        }
        order.push(`prepare-end:${input.key}`);
      },
      warn: quietWarn,
    });
    const input = (key: string): ReportTaskInput => ({
      period: "daily",
      key,
      startDay: key,
      endDay: key,
      force: true,
    });

    const first = queue.submitForce(input("A"));
    await firstStarted;
    const second = queue.submitForce(input("B"));
    await Promise.resolve();
    await Promise.resolve();
    expect(order.filter((item) => item.startsWith("prepare-"))).toEqual(["prepare-start:A"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order.filter((item) => item.startsWith("prepare-"))).toEqual([
      "prepare-start:A",
      "prepare-end:A",
      "prepare-start:B",
      "prepare-end:B",
    ]);
    await pollUntil(() => order.filter((item) => item.startsWith("execute:")).length === 2, 3000);
    expect(order.filter((item) => item.startsWith("execute:"))).toEqual(["execute:A", "execute:B"]);
  });
}

export function registerScheduleForceFallbackCases(): void {
  it("force prepare rejection 后 normal fallback 解锁且 placeholder 不残留", async () => {
    const calls: Array<{ force: boolean }> = [];
    let releasePrepare: () => void = () => undefined;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    let markPrepareStarted: () => void = () => undefined;
    const prepareStarted = new Promise<void>((resolve) => {
      markPrepareStarted = resolve;
    });
    let markNormalDone: () => void = () => undefined;
    const normalDone = new Promise<void>((resolve) => {
      markNormalDone = resolve;
    });
    const queue = new ReportTaskQueue({
      executor: async (input) => {
        calls.push({ force: input.force === true });
        markNormalDone();
        return {};
      },
      prepareForce: async () => {
        markPrepareStarted();
        await prepareGate;
        throw new Error("prepare rejected");
      },
      warn: quietWarn,
    });
    const input: ReportTaskInput = {
      period: "daily",
      key: "fallback",
      startDay: "fallback",
      endDay: "fallback",
    };

    const forcePromise = queue.submitForce({ ...input, force: true });
    const outcome = forcePromise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await prepareStarted;
    const normal = queue.submit(input);
    await Promise.resolve();
    await Promise.resolve();
    expect(normal.existing).toBe(true);
    expect(queue.get(normal.taskId)?.status).toBe("queued");
    expect(calls).toEqual([]);

    releasePrepare();
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected force preparation rejection");
    expect(result.error).toMatchObject({ message: "prepare rejected" });
    await normalDone;
    await pollUntil(() => queue.get(normal.taskId)?.status === "done", 3000);
    expect(queue.get(normal.taskId)?.force).toBe(false);
    expect(calls).toEqual([{ force: false }]);

    const retry = queue.submit(input);
    expect(retry.taskId).not.toBe(normal.taskId);
    expect(retry.existing).toBe(false);
    await pollUntil(() => queue.get(retry.taskId)?.status === "done", 3000);
    expect(calls).toEqual([{ force: false }, { force: false }]);
  });
}
