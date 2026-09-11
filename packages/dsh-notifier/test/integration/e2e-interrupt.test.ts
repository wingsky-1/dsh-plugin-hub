// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — e2e：中断抑制与完成判定白名单。
 *
 * 覆盖：用户停止生成/中断（turn/end reason aborted）固定静默；
 * 本轮无新 turn/end closure 宁可静默；失败（error）/阻塞（blocked）/
 * 截断（max-tokens）/未知 kind 不误报「任务完成」；中断与失败后新一轮
 * 正常恢复通知；重载后首次 idle + abort-early
 * 陈旧快照经 runningBaseline 冻结静默（不把旧证据当新轮完成）。
 *
 * 时序约定（helpers.turnPair / agentWithTitle 联用）：「本轮完成」用例区分
 * running/idle 两态事件面（running = 上一轮 closure 或空，idle = 本轮 closure）；
 * 「running 与 idle 同构造（idle 无推进）」= abort-early 无新 closure 形态，
 * 在单源 runningBaseline 冻结语义下必须静默（见 helpers.turnPair 注释）。
 *
 * 迁移说明：原脚本块是一条连续状态机序列（infos 计数在每一步被观测）。
 * 结构化后整体仍只执行一次，各检查点的观测值（计数与 info 条目）在序列中被
 * 物化，用例只读这些快照——不会观察到后续动作改写过的状态。
 */
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier, agentWithTitle, waitMergeWindow, turnPair } from "../helpers.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-e2e-interrupt-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** 完成判定白名单序列（单次执行，物化各检查点计数）。 */
async function completionSequence() {
  const infos = [];
  const { listeners } = await makeNotifier(work, { doneMergeWindowMs: 50 }, { logger: { warn: () => {}, info: (t) => infos.push(t) } });
  const status = listeners.get("agent/status")[0];
  const count = () => infos.length;

  // 用户停止生成（turn/end aborted）：不通知完成（本轮 aborted closure 落盘，
  // 白名单拒绝；非快照冻结形态）
  const int1 = turnPair("int-1", "被打断的任务", {}, { turn: 1, kind: "aborted" });
  status({ agent: int1.running, status: "running" });
  status({ agent: int1.idle, status: "idle" });
  const cAborted = count();

  // 本轮无新 turn/end：abort 早于本轮 turn/start 落盘，读到的还是
  // 上一次的 completed → 必须静默（不能误报完成）。
  // 首轮为真实完成时序（running 无 closure → idle turn=1 completed 通知）。
  const s1First = turnPair("s1-1", "任务S1", {}, { turn: 1 });
  status({ agent: s1First.running, status: "running" });
  status({ agent: s1First.idle, status: "idle" });
  const cFirstDone = count();
  const firstInfo = infos[0];

  // 第二轮被提前中断：events 无新 turn/end（仍停在 turn=1 completed），idle
  // 照发 → 快照 ≤ running 基线被冻结 → 静默
  status({ agent: agentWithTitle("s1-1", "任务S1", { turnEnd: 1 }), status: "running" });
  status({ agent: agentWithTitle("s1-1", "任务S1", { turnEnd: 1 }), status: "idle" });
  const cNoNewClosure = count();

  // 全新 agent 从未跑完一轮即 idle（首建即中断）：无 turn/end → 静默
  status({ agent: agentWithTitle("s1-2", "首建即中断"), status: "running" });
  status({ agent: agentWithTitle("s1-2", "首建即中断"), status: "idle" });
  const cNoTurnEnd = count();

  // 中断后继续：新一轮 turn/end completed（turn 号递增）正常通知
  // （先等 s1-1 场景的完成聚合窗口（短窗 50ms）结束，避免本轮完成被并入旧窗口挂起）
  await waitMergeWindow(50);
  const int2a = turnPair("int-2", "中断后继续", {}, { turn: 1, kind: "aborted" });
  status({ agent: int2a.running, status: "running" });
  status({ agent: int2a.idle, status: "idle" });
  const cAbortedQuiet = count();
  const int2b = turnPair("int-2", "中断后继续", {}, { turn: 2 }, { turn: 1, kind: "aborted" }); // 上一轮 aborted 已落盘
  status({ agent: int2b.running, status: "running" });
  status({ agent: int2b.idle, status: "idle" });
  const cResumed = count();
  const resumedInfo = infos[1];

  // 子代理被中断（interrupt_agent → 子代理 turn/end aborted）：同样静默
  const int3 = turnPair("int-3", "子代理中断", { depth: 1 }, { turn: 1, kind: "aborted" });
  status({ agent: int3.running, status: "running" });
  status({ agent: int3.idle, status: "idle" });
  const cSubagentAborted = count();

  // 任务失败（turn/end reason error）：idle 不得误报「任务完成」——
  // 失败由 agent/error 单独负责「任务出错」，同一轮不得叠加「完成」。
  const err1 = turnPair("err-1", "失败的任务", {}, { turn: 1, kind: "error" });
  status({ agent: err1.running, status: "running" });
  status({ agent: err1.idle, status: "idle" });
  const cError = count();

  // 任务被阻塞（turn/end reason blocked，如等待用户问题）：idle 也不得误报完成
  const blk1 = turnPair("blk-1", "被阻塞的任务", {}, { turn: 1, kind: "blocked" });
  status({ agent: blk1.running, status: "running" });
  status({ agent: blk1.idle, status: "idle" });
  const cBlocked = count();

  // 失败后继续：新一轮 turn/end completed（turn 号递增）正常通知
  // （先等 int-2 完成聚合窗口（短窗 50ms）结束，避免本轮完成被并入旧窗口挂起）
  await waitMergeWindow(50);
  const err2a = turnPair("err-2", "失败后继续", {}, { turn: 1, kind: "error" });
  status({ agent: err2a.running, status: "running" });
  status({ agent: err2a.idle, status: "idle" });
  const cErrorQuiet = count();
  const err2b = turnPair("err-2", "失败后继续", {}, { turn: 2 }, { turn: 1, kind: "error" }); // 上一轮 error 已落盘
  status({ agent: err2b.running, status: "running" });
  status({ agent: err2b.idle, status: "idle" });
  const cRecovered = count();
  const recoveredInfo = infos[2];

  // max-tokens：模型输出被截断（答案不完整）——白名单判定「不通知完成」
  const mt1 = turnPair("mt-1", "截断的任务", {}, { turn: 1, kind: "max-tokens" });
  status({ agent: mt1.running, status: "running" });
  status({ agent: mt1.idle, status: "idle" });
  const cMaxTokens = count();

  // 未知 kind（未来扩展）：白名单对齐 DSH 保守语义，同样静默
  const uk1 = turnPair("uk-1", "未知结束", {}, { turn: 1, kind: "mystery-kind" });
  status({ agent: uk1.running, status: "running" });
  status({ agent: uk1.idle, status: "idle" });
  const cUnknownKind = count();

  return {
    cAborted, cFirstDone, firstInfo, cNoNewClosure, cNoTurnEnd, cAbortedQuiet, cResumed, resumedInfo,
    cSubagentAborted, cError, cBlocked, cErrorQuiet, cRecovered, recoveredInfo, cMaxTokens, cUnknownKind,
  };
}

describe("完成判定白名单：中断 / 无新 closure / 失败 / 阻塞 / 截断 / 未知 kind", () => {
  let s: Awaited<ReturnType<typeof completionSequence>>;

  beforeAll(async () => {
    s = await completionSequence();
  });

  it("中断（turn/end aborted）不通知完成", () => {
    expect(s.cAborted).toBe(0);
  });

  it("正常完成一轮", () => {
    expect(s.cFirstDone).toBe(1);
  });

  it("正常完成通知含 done", () => {
    expect(s.firstInfo).toMatch(/done/);
  });

  it("S1：本轮无新 turn/end closure 宁可静默", () => {
    expect(s.cNoNewClosure).toBe(1);
  });

  it("S1：无 turn/end 静默", () => {
    expect(s.cNoTurnEnd).toBe(1);
  });

  it("中断静默", () => {
    expect(s.cAbortedQuiet).toBe(1);
  });

  it("中断后新一轮完成正常通知", () => {
    expect(s.cResumed).toBe(2);
  });

  it("中断恢复通知含 done", () => {
    expect(s.resumedInfo).toMatch(/done/);
  });

  it("子代理中断不通知", () => {
    expect(s.cSubagentAborted).toBe(2);
  });

  it("失败（turn/end error）不通知完成", () => {
    expect(s.cError).toBe(2);
  });

  it("阻塞（turn/end blocked）不通知完成", () => {
    expect(s.cBlocked).toBe(2);
  });

  it("失败静默", () => {
    expect(s.cErrorQuiet).toBe(2);
  });

  it("失败后新一轮完成正常通知", () => {
    expect(s.cRecovered).toBe(3);
  });

  it("失败恢复通知含 done", () => {
    expect(s.recoveredInfo).toMatch(/done/);
  });

  it("max-tokens 不通知完成", () => {
    expect(s.cMaxTokens).toBe(3);
  });

  it("未知 kind 不通知完成", () => {
    expect(s.cUnknownKind).toBe(3);
  });
});

describe("重载后首次 idle + abort-early 变体（runningBaseline 冻结）", () => {
  // 独立实例模拟插件重载（新 fiber 状态机记忆为空）。重载后 agent 跑了一轮
  // 但 abort 早于本轮 turn/start 落盘：running 基线捕获上一轮 turn=1 completed，
  // idle 时快照仍 turn=1（≤ 基线）→ 冻结静默，不把旧证据当新轮完成。
  let warns: string[];
  let c1Warn: string | undefined;

  beforeAll(async () => {
    warns = [];
    const { listeners } = await makeNotifier(
      work,
      { configFile: join(work, "c1-reload-abort.json"), historyFile: join(work, "c1-hist.jsonl") },
      { logger: { warn: (t) => warns.push(t), info: () => {} } }
    );
    const statusR = listeners.get("agent/status")[0];
    statusR({ agent: agentWithTitle("c1-1", "重载后中断", { turnEnd: 1 }), status: "running" });
    statusR({ agent: agentWithTitle("c1-1", "重载后中断", { turnEnd: 1 }), status: "idle" });
    c1Warn = warns.find((t) => t.includes("c1-1"));
  });

  it("C-1：重载后 abort-early 不抛处理失败 warn", () => {
    expect(!warns.some((t) => t.includes("c1-1") && !t.includes("完成判定跳过"))).toBeTruthy();
  });

  it("C-1：重载后首次 idle + abort-early 走跳过路径 warn 留痕", () => {
    expect(c1Warn !== undefined && /完成判定跳过/.test(c1Warn)).toBeTruthy();
  });

  it("C-1：warn 标识快照冻结（陈旧快照拦截）", () => {
    expect(c1Warn).toMatch(/证据源=快照冻结/);
  });
});
