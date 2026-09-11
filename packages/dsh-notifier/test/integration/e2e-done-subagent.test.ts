// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — e2e（子代理分流域）：fork 型委派归属判定、spawn 型 origin 信号、
 * notifySubagentDone 开关联动、agents 服务缺位时的保守分流。
 *
 * 拆法：原 e2e-done.test.ts 的块 4（子代理完成：独立开关 + 独立事件类型，内含
 * 8 个互相独立的子场景）、块 6（A-2 无 agents 走 done）、块 7（A-3 agents 缺位
 * fork/spawn 分流）落在此文件。每个子场景都是独立 makeNotifier 实例 + 一段
 * 动作序列 → 断言，天然成 describe。
 *
 * 时序约定（helpers.turnPair）：所有「本轮完成」用例区分 running/idle 两态事件面
 * （running 态 events 为上一轮 closure 或空，idle 态为本轮 closure）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier, agentWithTitle, fakeAgents, waitMergeWindow, fakeReq, makeRes, turnPair } from "../helpers.ts";
import { ROUTES } from "../../src/index.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-e2e-done-subagent-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** 带 info 收集的 logger 覆盖。 */
function loggingOverride(infos) {
  return { logger: { warn: () => {}, info: (t) => infos.push(t) } };
}

// ── fork 型委派子代理完成不再误报主任务 kind=done ──
// fork 型委派（parentSession + seedLength、无 origin、depth=0）与用户 fork
// 主线在持久化 header 上不可区分，判定补运行时归属（ctx.agents.get /
// isOwnedBy）。原反例 1「仅 parentSession 无 origin 必须 walk done」与新
// 验收冲突，已按归属成立/不成立拆分改写（旧语义不保留）。
describe("A1：fork 型委派归属成立且 notifySubagentDone 默认关 → 完全静默", () => {
  let infos: string[];
  let records: Array<Record<string, unknown>>;

  beforeAll(async () => {
    // 归属成立（父 live 且 isOwnedBy true）
    const agents = fakeAgents(["main-parent", "fork-worker"], [["fork-worker", "main-parent"]]);
    infos = [];
    const { listeners, routes } = await makeNotifier(
      work,
      { historyFile: join(work, "history-a1.jsonl") },
      { agents, ...loggingOverride(infos) }
    );
    const status = listeners.get("agent/status")[0];
    // fork 型委派完整持久化 header 形态：parentSession + seedLength、无 origin、depth=0
    // 本轮完成时序：running 态无 closure（首轮）、idle 态 turn=1 completed（helpers.turnPair）
    const forkPair = () => turnPair("fork-worker", "fork 委派子任务", { parentSession: "main-parent", seedLength: 3, depth: 0 }, { turn: 1 });
    status({ agent: forkPair().running, status: "running" });
    status({ agent: forkPair().idle, status: "idle" });
    // 通知历史复核（AC 验证入口）：静默路径不触发任何 appendHistory，读全量应为空
    const historyRoute = routes.find((r) => r.path === ROUTES.history);
    const { rec, res } = makeRes();
    await historyRoute.handler(fakeReq({}), res);
    records = JSON.parse(rec.text).records || [];
  });

  it("A1：fork 型委派归属成立且默认关时完全静默", () => {
    expect(infos.length).toBe(0);
  });

  it("A1：通知历史无新增 done 记录", () => {
    expect(records.length).toBe(0);
  });
});

describe("A2：同一场景开启 notifySubagentDone=true → 恰一条 subagent-done", () => {
  let infos: string[];

  beforeAll(async () => {
    const agents = fakeAgents(["main-parent2", "fork-worker2"], [["fork-worker2", "main-parent2"]]);
    infos = [];
    const { listeners } = await makeNotifier(work, { notifySubagentDone: true }, { agents, ...loggingOverride(infos) });
    const status = listeners.get("agent/status")[0];
    // 同上：完整持久化 header 形态含 seedLength + 本轮完成时序
    const forkPair = () => turnPair("fork-worker2", "fork 委派子任务B", { parentSession: "main-parent2", seedLength: 3, depth: 0 }, { turn: 1 });
    status({ agent: forkPair().running, status: "running" });
    status({ agent: forkPair().idle, status: "idle" });
  });

  it("A2：开启开关时恰产生一条通知", () => {
    expect(infos.length).toBe(1);
  });

  it("A2：事件类型为 subagent-done", () => {
    expect(infos[0]).toMatch(/subagent-done/);
  });

  it("A2：文案带任务标题", () => {
    expect(infos[0]).toMatch(/子任务「fork 委派子任务B」已完成/);
  });

  it("A2：文案带耗时", () => {
    expect(infos[0]).toMatch(/耗时：/);
  });

  it("A2：不得同时出现 kind=done", () => {
    expect(!infos.some((t) => /dsh-notifier: done /.test(t))).toBeTruthy();
  });
});

// 分支 1：header 含 parentSession 但父 id 不在 live registry（父已销毁/
// 冷 resume 脱离）→ 归属不成立，必须走主任务分支 kind=done（保护用户
// fork 主线，#7 语义不回归），不得被静默或误报 subagent-done。
describe("B1：父 id 不存在时归属不成立 → 走主任务 done", () => {
  let infos: string[];

  beforeAll(async () => {
    const agents = fakeAgents(["fork-orphan"], []);
    infos = [];
    const { listeners } = await makeNotifier(work, { }, { agents, ...loggingOverride(infos) });
    const status = listeners.get("agent/status")[0];
    const mk = () => turnPair("fork-orphan", "孤儿 fork 会话", { parentSession: "ghost-parent" }, { turn: 1 });
    status({ agent: mk().running, status: "running" });
    status({ agent: mk().idle, status: "idle" });
  });

  it("B1：父 id 不存在时不被静默", () => {
    expect(infos.length).toBe(1);
  });

  it("B1：发 kind=done 而非 subagent-done", () => {
    expect(infos[0]).toMatch(/dsh-notifier: done /);
  });
});

// 分支 2：父 id live 但运行时不持有该 agent（isOwnedBy false，如无关
// provider 复用 id）→ 归属不成立，同样走主任务分支 kind=done。
describe("B1：isOwnedBy=false 时归属不成立 → 走主任务 done", () => {
  let infos: string[];

  beforeAll(async () => {
    const agents = fakeAgents(["unrelated-parent", "fork-x"], []); // 无 (fork-x, unrelated-parent) 归属对
    infos = [];
    const { listeners } = await makeNotifier(work, { }, { agents, ...loggingOverride(infos) });
    const status = listeners.get("agent/status")[0];
    const mk = () => turnPair("fork-x", "无归属 fork 会话", { parentSession: "unrelated-parent", seedLength: 3 }, { turn: 1 });
    status({ agent: mk().running, status: "running" });
    status({ agent: mk().idle, status: "idle" });
  });

  it("B1：isOwnedBy=false 时归属不成立，不被静默", () => {
    expect(infos.length).toBe(1);
  });

  it("B1：发 kind=done 而非 subagent-done", () => {
    expect(infos[0]).toMatch(/dsh-notifier: done /);
  });
});

// headless CLI 会话（header 仅 {cwd}，无 origin 无 parentSession）两信号
// 皆否，保持现状按主任务分支处理（本 issue 不改变其分类）。
describe("D1：headless 会话保持主任务分支现状", () => {
  let infos: string[];

  beforeAll(async () => {
    infos = [];
    const { listeners } = await makeNotifier(work, { }, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    const mk = () => turnPair("headless-1", "headless CLI 会话", { cwd: "/tmp/dsh-cli" }, { turn: 1 });
    status({ agent: mk().running, status: "running" });
    status({ agent: mk().idle, status: "idle" });
  });

  it("D1：headless 会话保持主任务分支现状", () => {
    expect(infos.length).toBe(1);
  });

  it("D1：发 kind=done", () => {
    expect(infos[0]).toMatch(/dsh-notifier: done /);
  });
});

// 反例 2（原 #7 回归防护保留）：主会话（无 header / 无 origin）必须走 done。
describe("主会话（无 header / 无 origin）必须走 done", () => {
  let infos: string[];

  beforeAll(async () => {
    infos = [];
    const { listeners } = await makeNotifier(work, { }, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    const pair = turnPair("main-x", "主任务", {}, { turn: 1 });
    status({ agent: pair.running, status: "running" });
    status({ agent: pair.idle, status: "idle" });
  });

  it("主会话完成走 done", () => {
    expect(infos.length).toBe(1);
  });

  it("主会话完成通知含 done", () => {
    expect(infos[0]).toMatch(/dsh-notifier: done /);
  });
});

// 默认关：子代理完成不通知，主任务完成不受影响
describe("notifySubagentDone 默认关：子代理完成不通知，主任务不受影响", () => {
  let infos: string[];
  let c: { afterSub: number; afterMain: number };

  beforeAll(async () => {
    infos = [];
    const { listeners } = await makeNotifier(work, { }, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    const subPair = turnPair("sub-1", "子任务A", { subagent: true }, { turn: 1 });
    status({ agent: subPair.running, status: "running" });
    status({ agent: subPair.idle, status: "idle" });
    const afterSub = infos.length;
    const mainPair = turnPair("main-1", "主任务", {}, { turn: 1 });
    status({ agent: mainPair.running, status: "running" });
    status({ agent: mainPair.idle, status: "idle" });
    c = { afterSub, afterMain: infos.length };
  });

  it("notifySubagentDone 默认关：子代理完成不通知", () => {
    expect(c.afterSub).toBe(0);
  });

  it("主任务完成不受子代理开关影响", () => {
    expect(c.afterMain).toBe(1);
  });

  it("主任务完成通知含 done", () => {
    expect(infos[0]).toMatch(/done/);
  });
});

// 开启 notifySubagentDone：子代理完成用独立事件类型 subagent-done（标题/耗时）
describe("开启 notifySubagentDone：子代理用独立事件类型 subagent-done", () => {
  let infos: string[];
  let c: { afterSub: number; afterMain: number };

  beforeAll(async () => {
    infos = [];
    const { listeners } = await makeNotifier(work, { notifySubagentDone: true, doneMergeWindowMs: 50 }, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    const subPair = turnPair("sub-2", "子任务B", { subagent: true }, { turn: 1 });
    status({ agent: subPair.running, status: "running" });
    status({ agent: subPair.idle, status: "idle" });
    const afterSub = infos.length;
    // 等 subagent-done 的聚合窗口（短窗 50ms）结束（否则主任务完成会被聚合挂起）
    await waitMergeWindow(50);
    const mainPair = turnPair("main-2", "主任务2", {}, { turn: 1 });
    status({ agent: mainPair.running, status: "running" });
    status({ agent: mainPair.idle, status: "idle" });
    c = { afterSub, afterMain: infos.length };
  });

  it("子代理完成恰一条通知", () => {
    expect(c.afterSub).toBe(1);
  });

  it("子代理完成用独立事件类型", () => {
    expect(infos[0]).toMatch(/subagent-done/);
  });

  it("subagent-done 文案带任务标题", () => {
    expect(infos[0]).toMatch(/子任务「子任务B」已完成/);
  });

  it("subagent-done 带耗时", () => {
    expect(infos[0]).toMatch(/耗时：/);
  });

  it("子代理完成通知不暴露会话 id", () => {
    expect(!infos[0].includes("sub-2")).toBeTruthy();
  });

  it("主任务仍走 done 类型", () => {
    expect(c.afterMain).toBe(2);
  });

  it("主任务完成通知含 done", () => {
    expect(infos[1]).toMatch(/done/);
  });
});

// 回归：notifyTaskDone=false + notifySubagentDone=true 时子代理完成仍通知
describe("notifyTaskDone=false + notifySubagentDone=true：子代理仍通知", () => {
  let infos: string[];
  let c: { afterSub: number; afterMain: number; afterRunning: number };

  beforeAll(async () => {
    infos = [];
    const { listeners } = await makeNotifier(work, { notifyTaskDone: false, notifySubagentDone: true }, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    const subPair = turnPair("sub-3", "子任务C", { subagent: true }, { turn: 1 });
    status({ agent: subPair.running, status: "running" });
    status({ agent: subPair.idle, status: "idle" });
    const afterSub = infos.length;
    const mainPair = turnPair("main-3", "主任务3", {}, { turn: 1 });
    status({ agent: mainPair.running, status: "running" });
    status({ agent: mainPair.idle, status: "idle" });
    const afterMain = infos.length;
    // 既有 bug 修复回归：notifyTaskDone=false 时 idle 无条件重置状态，
    // 之后重开开关不会把旧的 running 误报为完成
    status({ agent: agentWithTitle("main-3", "主任务3"), status: "running" });
    c = { afterSub, afterMain, afterRunning: infos.length };
  });

  it("notifyTaskDone=false 不拦截子代理完成（S2）", () => {
    expect(c.afterSub).toBe(1);
  });

  it("子代理完成通知含 subagent-done", () => {
    expect(infos[0]).toMatch(/subagent-done/);
  });

  it("notifyTaskDone=false 主任务不通知", () => {
    expect(c.afterMain).toBe(1);
  });

  it("running 仍不通知", () => {
    expect(c.afterRunning).toBe(1);
  });
});

// ── 根因 A 安全化与提交后置三态化 ──
// 未提供 agents 时 completed 仍走 done 主分支且不抛（logger 无「处理失败」warn）
describe("A-2：未提供 agents 时 completed 仍走 done 主分支且不抛", () => {
  let infos: string[];
  let warns: string[];

  beforeAll(async () => {
    infos = [];
    warns = [];
    const { listeners } = await makeNotifier(
      work,
      { doneMergeWindowMs: 0 },
      { logger: { info: (t) => infos.push(t), warn: (t) => warns.push(t) } }
    );
    const status = listeners.get("agent/status")[0];
    const pair = turnPair("a2-1", "无 agents 主任务", {}, { turn: 1 });
    status({ agent: pair.running, status: "running" });
    status({ agent: pair.idle, status: "idle" });
  });

  it("A-2：无 agents 时 completed 走 done 主分支", () => {
    expect(infos.filter((t) => /: done /.test(t)).length).toBe(1);
  });

  it("A-2：无 'agent/status 处理失败' warn", () => {
    expect(!warns.some((t) => t.includes("agent/status 处理失败"))).toBeTruthy();
  });
});

// agents 缺位时 fork 型（parentSession 无 origin、seedLength>0）保守走
// 主任务 done（即使 notifySubagentDone=true 也不误判 subagent-done）；
// spawn 型（origin=subagent）仍按 origin 信号走 subagent 分支。
describe("A-3：agents 缺位时 fork 型保守走 done", () => {
  let infos: string[];

  beforeAll(async () => {
    infos = [];
    const { listeners } = await makeNotifier(work, { doneMergeWindowMs: 0, notifySubagentDone: true }, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    // fork 型：无 origin、带 parentSession + seedLength，归属服务缺位 → 保守走 done
    const forkPair = () => turnPair("a3-fork", "fork 型无 agents", { parentSession: "ghost-parent", seedLength: 3 }, { turn: 1 });
    status({ agent: forkPair().running, status: "running" });
    status({ agent: forkPair().idle, status: "idle" });
  });

  it("A-3：agents 缺位 fork 型保守走 done", () => {
    expect(infos.filter((t) => /: done /.test(t)).length).toBe(1);
  });

  it("A-3：不误判 subagent-done", () => {
    expect(!infos.some((t) => /: subagent-done /.test(t))).toBeTruthy();
  });
});

describe("A-3：agents 缺位时 spawn 型（origin=subagent）仍走 subagent 分支", () => {
  let infos: string[];

  beforeAll(async () => {
    infos = [];
    const { listeners } = await makeNotifier(work, { doneMergeWindowMs: 0, notifySubagentDone: true }, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    const forkPair = () => turnPair("a3-fork2", "fork 型无 agents", { parentSession: "ghost-parent", seedLength: 3 }, { turn: 1 });
    status({ agent: forkPair().running, status: "running" });
    status({ agent: forkPair().idle, status: "idle" });
    // spawn 型：origin 信号不依赖 agents，仍走 subagent 分支
    const spawnPair = () => turnPair("a3-spawn", "spawn 子任务", { subagent: true }, { turn: 2 });
    status({ agent: spawnPair().running, status: "running" });
    status({ agent: spawnPair().idle, status: "idle" });
  });

  it("A-3：spawn 型 origin 信号仍走 subagent 分支", () => {
    expect(infos.filter((t) => /: subagent-done /.test(t)).length).toBe(1);
  });
});
