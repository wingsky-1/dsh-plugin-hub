// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — e2e（完成状态机域）：agent/status per-agent 状态机、
 * agent/disposed 清理、agent/error 通知与滚动窗口合并、完成风暴聚合。
 *
 * 拆法：原 e2e-done.test.ts 的块 1（per-agent 状态机 + 错误通知/合并 + 完成风暴
 * 聚合，同一实例）、块 2（错误合并窗口过期）、块 3（窗口/聚合 0=关闭）三条独立
 * 前缀重放链落在此文件（文件级最小判据 `--min` 只约束文件数下限，拆多不弱化）。
 *
 * 迁移说明：块 1 是「动作 → 累计计数断言 → 新动作」交错序列，故整体执行一次并把
 * 各检查点的观测值（infos 计数与条目快照）物化，用例只读快照——不会观察到后续
 * 动作改写过的状态。块 3 的两条断言分别观察「仅错误」与「全流程」两个时点，
 * 故拆成两条独立前缀链。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier, agentWithTitle, turnPair, waitMergeWindow } from "../helpers.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-e2e-done-status-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** 带 info 收集的 logger 覆盖。 */
function loggingOverride(infos) {
  return { logger: { warn: () => {}, info: (t) => infos.push(t) } };
}

// per-agent 状态机 + 错误通知/合并 + 完成风暴聚合（同一实例）
describe("per-agent 状态机 + 错误通知合并 + 完成风暴聚合", () => {
  let infos: string[];
  let c: Record<string, number>;
  let info0: string;
  let info1: string;
  let info2: string;
  let info3: string;
  let info5: string;

  beforeAll(async () => {
    infos = [];
    const { listeners } = await makeNotifier(work, { doneMergeWindowMs: 50 }, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    const disposed = listeners.get("agent/disposed")[0];
    const error = listeners.get("agent/error")[0];
    c = {};

    // agent/status：per-agent 状态机，多会话互不误报（真实宿主跑完一轮必有 turn/end，故 idle 断言带 turnEnd）
    status({ agent: agentWithTitle("session-1", "优化 notifier 插件"), status: "running" });
    status({ agent: agentWithTitle("session-2", "并行评审代码"), status: "running" });
    c.running = infos.length;
    status({ agent: agentWithTitle("session-2", "并行评审代码", { turnEnd: 1 }), status: "idle" });
    c.session2Done = infos.length;
    info0 = infos[0];
    // 完成风暴聚合窗口（短窗 50ms）：等上一处完成的窗口结束，保证同 agent 下一轮是独立窗口
    await waitMergeWindow(50);
    status({ agent: agentWithTitle("session-1", "优化 notifier 插件", { turnEnd: 1 }), status: "idle" });
    c.session1Done = infos.length;
    info1 = infos[1];
    status({ agent: agentWithTitle("session-1", "优化 notifier 插件"), status: "idle" });
    c.repeatIdle = infos.length;
    status({ agent: agentWithTitle("session-2", "并行评审代码"), status: "idle" });
    c.session2NoRunning = infos.length;

    // agent/disposed：清理状态机，防会话销毁后残留 idle 误报
    status({ agent: agentWithTitle("session-3", "临时会话"), status: "running" });
    disposed({ agent: agentWithTitle("session-3", "临时会话") });
    status({ agent: agentWithTitle("session-3", "临时会话"), status: "idle" });
    c.disposed = infos.length;

    // agent/error：通知（任务标题/轮次步骤/错误信息）；60 秒窗口内同类错误合并
    error({ agent: agentWithTitle("session-1", "优化 notifier 插件"), turn: 1, step: 1, error: new Error("测试错误信息") });
    c.firstError = infos.length;
    info2 = infos[2];
    error({ agent: agentWithTitle("session-1", "优化 notifier 插件"), turn: 1, step: 2, error: new Error("窗口内错误") });
    c.mergedError = infos.length;
    error({ agent: agentWithTitle("session-2", "并行评审代码"), turn: 1, step: 3, error: new Error("其他会话错误") });
    c.otherSessionError = infos.length;
    info3 = infos[3];

    // 完成风暴聚合：窗口内第二条完成不即时，窗口到点后补发聚合条（防并行收尾刷屏）
    await waitMergeWindow(50); // 窗口清零（error/turn 无完成窗口）
    const stormA = turnPair("storm-1", "并行任务A", {}, { turn: 1 });
    status({ agent: stormA.running, status: "running" });
    status({ agent: stormA.idle, status: "idle" });
    c.stormFirst = infos.length;
    const stormB = turnPair("storm-2", "并行任务B", {}, { turn: 1 });
    status({ agent: stormB.running, status: "running" });
    status({ agent: stormB.idle, status: "idle" });
    c.stormSecond = infos.length;
    await waitMergeWindow(50);
    c.stormFlushed = infos.length;
    info5 = infos[5];
  });

  it("running 不通知", () => {
    expect(c.running).toBe(0);
  });

  it("session-2 完成通知一次", () => {
    expect(c.session2Done).toBe(1);
  });

  it("完成通知含 done", () => {
    expect(info0).toMatch(/done/);
  });

  it("完成通知带任务标题", () => {
    expect(info0).toMatch(/任务「并行评审代码」已完成/);
  });

  it("完成通知带耗时", () => {
    expect(info0).toMatch(/耗时：/);
  });

  it("完成通知不暴露会话 id", () => {
    expect(!info0.includes("session-")).toBeTruthy();
  });

  it("session-1 完成独立通知", () => {
    expect(c.session1Done).toBe(2);
  });

  it("session-1 完成通知带标题", () => {
    expect(info1).toMatch(/任务「优化 notifier 插件」已完成/);
  });

  it("连续 idle 不重复通知", () => {
    expect(c.repeatIdle).toBe(2);
  });

  it("session-2 无 running 记录不通知", () => {
    expect(c.session2NoRunning).toBe(2);
  });

  it("disposed 清理后残留 idle 不误报", () => {
    expect(c.disposed).toBe(2);
  });

  it("错误通知计数 +1", () => {
    expect(c.firstError).toBe(3);
  });

  it("错误通知含 error", () => {
    expect(info2).toMatch(/error/);
  });

  it("错误通知带任务标题", () => {
    expect(info2).toMatch(/任务「优化 notifier 插件」执行出错/);
  });

  it("轮次/步骤与错误信息同行", () => {
    expect(info2).toMatch(/第 1 轮第 1 步：测试错误信息/);
  });

  it("错误通知不暴露会话 id", () => {
    expect(!info2.includes("session-")).toBeTruthy();
  });

  it("窗口内同类错误合并，不重复通知", () => {
    expect(c.mergedError).toBe(3);
  });

  it("不同会话独立合并窗口", () => {
    expect(c.otherSessionError).toBe(4);
  });

  it("其他会话错误通知带标题", () => {
    expect(info3).toMatch(/任务「并行评审代码」执行出错/);
  });

  it("聚合窗口首条即时通知", () => {
    expect(c.stormFirst).toBe(5);
  });

  it("窗口内第二条挂起不即时发", () => {
    expect(c.stormSecond).toBe(5);
  });

  it("窗口到点补发聚合条", () => {
    expect(c.stormFlushed).toBe(6);
  });

  it("聚合条文案带计数", () => {
    expect(info5).toMatch(/另有 1 个任务已完成/);
  });

  it("聚合条带最近标题", () => {
    expect(info5).toMatch(/并行任务B/);
  });
});

// 错误合并窗口过期后通知并携带合并计数（独立实例：20ms 窗口）
describe("错误合并窗口过期后通知并携带合并计数", () => {
  let infos: string[];
  let c: { first: number; merged: number; expired: number };
  let info1: string;

  beforeAll(async () => {
    infos = [];
    const { listeners } = await makeNotifier(work, { errorMergeWindowMs: 20 }, loggingOverride(infos));
    const error = listeners.get("agent/error")[0];
    c = { first: 0, merged: 0, expired: 0 };

    error({ agent: { id: "session-1" }, turn: 1, step: 1, error: new Error("e1") });
    c.first = infos.length;
    error({ agent: { id: "session-1" }, turn: 1, step: 2, error: new Error("e2") });
    c.merged = infos.length;
    // 等 20ms 错误合并窗口过期：负向等待无法正向轮询（后续写入会重置窗口），
    // 故固定等待但留足余量（原 30ms 余量仅 10ms，CI 慢机实测漏窗口 → flake）
    await new Promise((resolve) => setTimeout(resolve, 200));
    error({ agent: { id: "session-1" }, turn: 1, step: 3, error: new Error("e3") });
    c.expired = infos.length;
    info1 = infos[1];
  });

  it("首条错误通知", () => {
    expect(c.first).toBe(1);
  });

  it("窗口内合并", () => {
    expect(c.merged).toBe(1);
  });

  it("窗口过期后恢复通知", () => {
    expect(c.expired).toBe(2);
  });

  it("窗口过期后的通知携带合并计数", () => {
    expect(info1).toMatch(/另有 1 条同类错误/);
  });

  it("被合并错误保留摘要（e1）", () => {
    expect(info1).toMatch(/窗口内其他错误/);
  });
});

// 合并 0=关闭：错误不合并、完成不聚合（每条即时）
describe("errorMergeWindowMs=0：错误不合并", () => {
  it("两条错误都通知", async () => {
    {
      const infos = [];
      const { listeners } = await makeNotifier(work, { errorMergeWindowMs: 0, doneMergeWindowMs: 0 }, loggingOverride(infos));
      const error = listeners.get("agent/error")[0];
      error({ agent: { id: "s0-1" }, turn: 1, step: 1, error: new Error("x1") });
      error({ agent: { id: "s0-1" }, turn: 1, step: 2, error: new Error("x2") });
      expect(infos.length).toBe(2);
    }
  });
});

describe("doneMergeWindowMs=0：完成不聚合，两条都即时", () => {
  it("连续两条完成即时通知", async () => {
    {
      const infos = [];
      const { listeners } = await makeNotifier(work, { errorMergeWindowMs: 0, doneMergeWindowMs: 0 }, loggingOverride(infos));
      const status = listeners.get("agent/status")[0];
      status({ agent: agentWithTitle("s0-a", "任务甲", { turnEnd: 1 }), status: "running" });
      status({ agent: agentWithTitle("s0-a", "任务甲", { turnEnd: 2 }), status: "idle" });
      status({ agent: agentWithTitle("s0-b", "任务乙", { turnEnd: 1 }), status: "running" });
      status({ agent: agentWithTitle("s0-b", "任务乙", { turnEnd: 2 }), status: "idle" });
      expect(infos.filter((t) => /done/.test(t)).length).toBe(2);
    }
  });
});
