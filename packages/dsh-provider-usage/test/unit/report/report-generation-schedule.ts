/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CFG,
  ReportScheduler,
  ReportTaskQueue,
  existsSync,
  join,
  mkdtempSync,
  pollUntil,
  readLastRun,
  tmpdir,
  writeLastRun,
  type ReportTaskInput,
} from "./report-generation-support.ts";

describe("scheduler：lastRun 读写 roundtrip", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dou-report-sched-"));
  });

  it("缺失文件 → 空表", async () => {
    expect(await readLastRun(root)).toEqual({});
  });

  it("writeLastRun → readLastRun roundtrip", async () => {
    await writeLastRun(root, { daily: "2026-09-04", monthly: "2026-08" });
    expect(await readLastRun(root)).toEqual({ daily: "2026-09-04", monthly: "2026-08" });
  });

  it("last-run.json 落在 historyRoot/reports/ 下", async () => {
    await writeLastRun(root, { daily: "2026-09-04", monthly: "2026-08" });
    expect(existsSync(join(root, "reports", "last-run.json"))).toBeTruthy();
  });
});

describe("ReportTaskQueue：串行单飞 + 入队去重（#625/#626）", () => {
  let firstId: string;
  let forceUpgraded: boolean;
  let callsAtLeastOne: boolean;
  let fourthId: string;

  beforeAll(async () => {
    let calls = 0;
    const queue = new ReportTaskQueue({
      executor: async () => {
        calls += 1;
        // W4：删 30ms 慢执行（提交经 tail 链解耦，三次 submit 同步完成才执行，交错窗天然存在；等待面由下 pollUntil 覆盖）。
        throw new Error("always-fail"); // 恒失败：任务 failed，不影响串行性
      },
      warn: () => {},
    });
    const due: ReportTaskInput = {
      period: "daily",
      key: "2026-09-04",
      startDay: "2026-09-04",
      endDay: "2026-09-04",
    };
    // 同一窗口连续提交（模拟 tick 60s 一次 vs 手动并发）→ 只应有一个 queued/running（P0 入队去重）
    const first = queue.submit(due);
    queue.submit(due); // 第二次同窗提交（去重行为由 schedule D2三-锁钉，此处仅保留场景流量）
    firstId = first.taskId;
    // force 提交命中 queued/running → 既有任务 force 升级（#626：重新生成语义不因去重丢失）
    queue.submit({ ...due, force: true }); // force 提交本身（升级事实由下断言钉）
    forceUpgraded = queue.get(first.taskId)!.force;
    // #629 P3：条件等待替代固定 sleep（执行器入口计数是可观测事件）
    await pollUntil(() => calls >= 1, 5000, 5);
    callsAtLeastOne = calls >= 1;
    await pollUntil(() => queue.get(first.taskId)?.status === "failed", 5000, 5);
    // failed 任务不在 queued/running → 可重新提交（新 taskId）
    const fourth = queue.submit(due);
    fourthId = fourth.taskId;
  });

  it("force 升级既有任务", () => {
    expect(forceUpgraded).toBe(true);
  });

  it("至少执行一轮", () => {
    expect(callsAtLeastOne).toBeTruthy();
  });

  // P2 补齐：failed 后可重新提交 facet——tasks.ts:94 状态检查（failed 不在
  // queued/running）凭此变红；H2 误删后加回，判据为真断言非恒真。
  it("failed 任务后可重新提交（新 taskId）", () => {
    expect(fourthId).not.toBe(firstId);
  });

  it("force prepare pending 时普通 submit 复用 reservation，不提前执行", async () => {
    let markBlockStarted = (): void => {};
    const blockStarted = new Promise<void>((resolve) => {
      markBlockStarted = resolve;
    });
    let releaseBlock = (): void => {};
    const blockGate = new Promise<void>((resolve) => {
      releaseBlock = resolve;
    });
    let markPrepareStarted = (): void => {};
    const prepareStarted = new Promise<void>((resolve) => {
      markPrepareStarted = resolve;
    });
    let releasePrepare = (): void => {};
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    let markForceFinished = (): void => {};
    const forceFinished = new Promise<void>((resolve) => {
      markForceFinished = resolve;
    });
    const executions: Array<{ key: string; force: boolean }> = [];
    const queue = new ReportTaskQueue({
      executor: async (input) => {
        executions.push({ key: input.key, force: input.force === true });
        if (input.key === "block") {
          markBlockStarted();
          await blockGate;
        }
        if (input.key === "target" && input.force === true) markForceFinished();
        return {};
      },
      prepareForce: async () => {
        markPrepareStarted();
        await prepareGate;
      },
      warn: () => {},
    });
    const target: ReportTaskInput = {
      period: "daily",
      key: "target",
      startDay: "target",
      endDay: "target",
    };

    queue.submit({ ...target, key: "block" });
    await blockStarted;
    const normal = queue.submit(target);
    const forcePromise = queue.submitForce({ ...target, force: true });
    await prepareStarted;

    const duringPrepare = queue.submit(target);
    expect(duringPrepare).toEqual({ taskId: normal.taskId, existing: true });
    expect(queue.get(normal.taskId)?.status).toBe("queued");
    expect(executions.filter((item) => item.key === "target")).toEqual([]);

    releasePrepare();
    const forced = await forcePromise;
    releaseBlock();
    await forceFinished;

    expect(forced).toEqual({ taskId: normal.taskId, existing: true });
    expect(executions.filter((item) => item.key === "target")).toEqual([
      { key: "target", force: true },
    ]);
  });
});

it("force reservation 合并重复请求、拒绝后解锁且无 prepare 仍可运行", async () => {
  const input: ReportTaskInput = {
    period: "daily",
    key: "reservation",
    startDay: "2026-09-04",
    endDay: "2026-09-04",
  };
  const noPrepareCalls: string[] = [];
  const noPrepare = new ReportTaskQueue({
    executor: async (task: ReportTaskInput) => {
      noPrepareCalls.push(`${task.key}:${task.force === true}`);
      return {};
    },
  });
  const noPrepareResult = await noPrepare.submitForce({ ...input, force: true });
  await pollUntil(() => noPrepare.get(noPrepareResult.taskId)?.status === "done", 3000);
  expect(noPrepareCalls).toEqual(["reservation:true"]);

  let releasePrepare: () => void = () => undefined;
  let markPrepareStarted: () => void = () => undefined;
  const prepareGate = new Promise<void>((resolve) => {
    releasePrepare = resolve;
  });
  const prepareStarted = new Promise<void>((resolve) => {
    markPrepareStarted = resolve;
  });
  const pending = new ReportTaskQueue({
    executor: async () => ({}),
    prepareForce: async () => {
      markPrepareStarted();
      await prepareGate;
    },
  });
  const first = pending.submitForce({ ...input, force: true });
  await prepareStarted;
  const duplicate = pending.submitForce({ ...input, force: true });
  expect(duplicate).toBe(first);
  releasePrepare();
  const firstResult = await first;
  expect(await duplicate).toEqual(firstResult);

  const failed = new ReportTaskQueue({
    executor: async () => ({}),
    prepareForce: async () => {
      throw new Error("prepare failed");
    },
    sanitizeErrors: true,
    warn: () => {},
  });
  await expect(failed.submitForce({ ...input, force: true })).rejects.toThrow("prepare failed");
  const retry = failed.submit(input);
  expect(retry.existing).toBe(false);
  await pollUntil(() => failed.get(retry.taskId)?.status === "done", 3000);
});

describe("tick→队列：失败不推进 lastRun + 下轮重试同窗", () => {
  let execCallsSnapshot: number;
  let failedKeysSnapshot: string[];
  let lastRunDailySnapshot: string | undefined;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-report-retry-"));
    let execCalls = 0;
    const failedKeys: string[] = [];
    const queue = new ReportTaskQueue({
      executor: async (input) => {
        execCalls += 1;
        if (execCalls < 3) {
          failedKeys.push(input.key);
          throw new Error(`boom-${execCalls}`); // 前两轮失败（失败不推进 lastRun）
        }
        // 第三轮成功：模拟 apply 接线的推进语义（执行器临界区内写 lastRun）
        const lastRun = await readLastRun(root);
        lastRun[input.period] = input.key;
        await writeLastRun(root, lastRun);
        return {
          meta: {
            period: input.period,
            key: input.key,
            startDay: input.startDay,
            endDay: input.endDay,
            generatedAt: Date.now(),
            ok: true,
            provider: "",
            model: "",
            durationMs: 0,
          },
        };
      },
      warn: () => {},
    });
    const scheduler = ReportScheduler.start({
      root,
      config: CFG({
        daily: { enabled: true, time: "00:00" },
        weekly: { enabled: false, time: "09:00", weekStartsOn: 1 },
        monthly: { enabled: false, time: "09:00", dayOfMonth: 1 },
      }),
      onDue: (due) => {
        queue.submit(due);
        return Promise.resolve();
      },
      tickMs: 15,
    });
    // 轮询直到成功路径把 lastRun 落盘（execCalls 计数在 executor 入口自增，
    // 需等写盘完成再断言，防 flake；上限 5s）——#629 P3：pollUntil 条件等待
    const lastRunDaily = await pollUntil(async () => (await readLastRun(root)).daily, 5000, 10);
    scheduler.dispose();
    execCallsSnapshot = execCalls;
    failedKeysSnapshot = [...failedKeys]; // 取拷贝：后续断言不受引用变化影响
    lastRunDailySnapshot = lastRunDaily;
  });

  it("失败后下轮重试", () => {
    expect(execCallsSnapshot >= 3).toBeTruthy();
  });

  it("重试同一窗口", () => {
    expect(new Set(failedKeysSnapshot).size).toBe(1);
  });

  it("成功路径已推进 lastRun", () => {
    expect(lastRunDailySnapshot !== undefined).toBeTruthy();
  });

  it("lastRun.daily === 窗口键", () => {
    expect(lastRunDailySnapshot).toBe(failedKeysSnapshot[0]);
  });
});

describe("scheduler：dispose 停 tick（#629 P3：事件驱动，无固定 sleep）", () => {
  let lastRunFileExists: boolean;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-report-dispose-"));
    let gate: (value?: unknown) => void = () => {};
    const gated = new Promise((r) => {
      gate = r;
    });
    const scheduler = ReportScheduler.start({
      root,
      config: CFG({
        daily: { enabled: true, time: "00:00" },
        weekly: { enabled: false, time: "09:00", weekStartsOn: 1 },
        monthly: { enabled: false, time: "09:00", dayOfMonth: 1 },
      }),
      // 模拟 apply 接线的最小推进语义（onDue 提交 → 执行 → lastRun 推进）
      onDue: async (due) => {
        gate(); // 「首轮 tick 已发生」事件信号（onDue 入口同步触发）
        const lastRun = await readLastRun(root);
        lastRun[due.period] = due.key;
        await writeLastRun(root, lastRun);
      },
      tickMs: 200, // 拉大 tick 间隔：dispose 确定性赶在第二轮 timer 触发前
    });
    await gated; // 事件等待：首轮启动补跑已发生（不假设耗时，慢 runner 下自然延长）
    // 等首轮 lastRun 落盘收尾（在途 onDue 完成）再 dispose，防断言与写盘竞态
    await pollUntil(() => existsSync(join(root, "reports", "last-run.json")), 5000, 5);
    scheduler.dispose();
    // 成功路径推进过 lastRun（首轮启动补跑已生成并落盘）
    lastRunFileExists = existsSync(join(root, "reports", "last-run.json"));
  });

  // 保留：schedule D3 toFake 面只钉「tick 停止」，不覆盖「dispose 前成功生成已推进 lastRun」
  // （其 onDue 不写 lastRun）；并入 schedule 需改集成用例，保留此单元侧推进事实。
  it("dispose 前的成功生成已推进 lastRun", () => {
    expect(lastRunFileExists).toBeTruthy();
  });
});
