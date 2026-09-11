// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — e2e（提交后置三态 / 聚合批处理域）：开关禁用时的三态提交、
 * 免打扰拦截后的同 turn 去重、批次按「入队成功」提交、flush 时序不回退。
 *
 * 拆法：原 e2e-done.test.ts 的块 7（B-1 开关禁用三态）、块 8（B-2 免打扰）、
 * 块 9（B-4 入队即提交）、块 10（B-4 flush 时序）落在此文件。
 *
 * 迁移说明：每块都是「动作 → 累计计数断言 → 新动作 → 断言」的交错序列，
 * 故整体执行一次并物化各检查点计数（同 turn 再现 idle 前后、flush 前后），
 * 用例只读快照。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier, agentWithTitle, turnPair, waitMergeWindow, waitForHistory, quietWindowNow } from "../helpers.ts";
import { ROUTES } from "../../src/index.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-e2e-done-commit-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** 带 info 收集的 logger 覆盖。 */
function loggingOverride(infos) {
  return { logger: { warn: () => {}, info: (t) => infos.push(t) } };
}

// 开关禁用三态提交——notifyTaskDone=false 时 completed idle 不通知，
// 但 lastEndedTurn 照常提交，同 turn 再现 idle 不重复处理。
describe("B-1：notifyTaskDone=false 的三态提交", () => {
  let infos: string[];
  let warns: string[];
  let c: { afterPair: number; afterRepeat: number };

  beforeAll(async () => {
    infos = [];
    warns = [];
    const { listeners } = await makeNotifier(work, { doneMergeWindowMs: 0, notifyTaskDone: false }, { logger: { info: (t) => infos.push(t), warn: (t) => warns.push(t) } });
    const status = listeners.get("agent/status")[0];
    const pair = turnPair("b1-1", "开关禁用任务", {}, { turn: 1 });
    status({ agent: pair.running, status: "running" });
    status({ agent: pair.idle, status: "idle" });
    const afterPair = infos.filter((t) => /: done /.test(t)).length;
    // 同 turn 再现 idle：lastEndedTurn 已提交 → 无新证据 → skip（不重复处理）；
    // 构造为「events 仍停 turn=1」的 abort-early 形态（快照 ≤ running 基线冻结）
    status({ agent: agentWithTitle("b1-1", "开关禁用任务", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("b1-1", "开关禁用任务", { turnEnd: 1 }), status: "idle" });
    c = { afterPair, afterRepeat: infos.filter((t) => /: done /.test(t)).length };
  });

  it("B-1：notifyTaskDone=false 主任务不通知", () => {
    expect(c.afterPair).toBe(0);
  });

  it("B-1：开关禁用后同 turn 再现 idle 不重复", () => {
    expect(c.afterRepeat).toBe(0);
  });

  it("B-1：再现 idle 走跳过路径 warn 留痕", () => {
    expect(warns.some((t) => t.includes("b1-1") && /完成判定跳过/.test(t))).toBeTruthy();
  });
});

// 免打扰拦截后同 turn 再现 idle 不重复——quietHours 命中且 done 不在
// allowKinds 时，idle completed → 仅一条 suppressed 历史、无系统通知；
// 同 turn 再现 idle → 不重复通知、不新增记录。
describe("B-2：免打扰拦截后同 turn 再现 idle 不重复", () => {
  let infos: string[];
  let records: Array<Record<string, unknown>>;
  let after: Array<Record<string, unknown>>;

  beforeAll(async () => {
    // 动态窗口：写死 "00:00"/"23:59" 在半开区间镜下 23:59 这一分钟不命中
    // （UTC 边缘必炸，run 33282203798 根因）；围绕当前时间 ±2 分钟恒命中。
    const qhAll = quietWindowNow();
    infos = [];
    const { listeners, routes } = await makeNotifier(work, { doneMergeWindowMs: 0, quietHours: { ...qhAll, allowKinds: ["ask"] }, historyFile: join(work, "b2-hist.jsonl") }, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    const historyRoute = routes.find((r) => r.path === ROUTES.history);
    const pair = turnPair("b2-1", "免打扰完成", {}, { turn: 1 });
    status({ agent: pair.running, status: "running" });
    status({ agent: pair.idle, status: "idle" });
    records = await waitForHistory(historyRoute, (r) => r.some((e) => e.kind === "done" && e.suppressed === "quiet"));
    // 同 turn 再现 idle：免打扰拦截也是三态提交之一（lastEndedTurn 已推进）→ 不重复
    status({ agent: agentWithTitle("b2-1", "免打扰完成", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("b2-1", "免打扰完成", { turnEnd: 1 }), status: "idle" });
    after = await waitForHistory(historyRoute, (r) => r.length > records.length, 500);
  });

  it("B-2：免打扰拦截不发出系统通知", () => {
    expect(!infos.some((t) => /dsh-notifier: done /.test(t) && !t.includes("被免打扰拦截"))).toBeTruthy();
  });

  it("B-2：拦截记录日志", () => {
    expect(infos.some((t) => t.includes("被免打扰拦截"))).toBeTruthy();
  });

  it("B-2：仅一条 suppressed:quiet 历史", () => {
    expect(records.filter((e) => e.kind === "done" && e.suppressed === "quiet").length).toBe(1);
  });

  it("B-2：同 turn 再现 idle 不新增历史记录", () => {
    expect(after.length).toBe(records.length);
  });
});

// 批次按「入队成功」提交、与聚合 flush 成败解耦——doneMergeWindowMs>0
// 时首条完成入队即推进 lastEndedTurn（窗口内同 turn 再现不重复）。
describe("B-4：入队即提交（窗口内同 turn 再现 idle 不重复）", () => {
  let infos: string[];
  let c: { afterPair: number; afterRepeat: number };

  beforeAll(async () => {
    infos = [];
    const { listeners } = await makeNotifier(work, { doneMergeWindowMs: 5000 }, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    const pair = turnPair("b4-1", "合并窗口任务", {}, { turn: 1 });
    status({ agent: pair.running, status: "running" });
    status({ agent: pair.idle, status: "idle" });
    const afterPair = infos.filter((t) => /: done /.test(t)).length;
    // 窗口未 flush 时同 turn 再现 idle：入队成功已提交 lastEndedTurn → 不重复
    status({ agent: agentWithTitle("b4-1", "合并窗口任务", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("b4-1", "合并窗口任务", { turnEnd: 1 }), status: "idle" });
    c = { afterPair, afterRepeat: infos.filter((t) => /: done /.test(t)).length };
  });

  it("B-4：首条完成即时通知并入队", () => {
    expect(c.afterPair).toBe(1);
  });

  it("B-4：窗口内同 turn 再现 idle 不重复（入队即提交）", () => {
    expect(c.afterRepeat).toBe(1);
  });
});

// flush 时序：首条入队即提交（不依赖 flush 结果）——窗口到点正常 flush
// 补发聚合条后，已提交 turn 不回退（再现 idle 不重复）。
// （「flush 阶段 notify 抛错」路径为产品 setTimeout 异步回调的既有行为，
// 触发会 uncaught、使 Stryker 测试宿主判 Error（vitest runner 下 uncaught 计入
// errorsSet），故以「提交点先于 flush」的时序验证覆盖。）
describe("B-4：flush 补发聚合条且已提交 turn 不回退", () => {
  let infos: string[];
  let c: { windowed: number; flushed: number; afterRepeat: number };

  beforeAll(async () => {
    infos = [];
    const { listeners } = await makeNotifier(work, { doneMergeWindowMs: 30 }, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    const doneCount = () => infos.filter((t) => /: done /.test(t)).length;
    const pairA = () => turnPair("b4f-a", "flush 后 A", {}, { turn: 1 });
    const pairB = () => turnPair("b4f-b", "flush 后 B", {}, { turn: 1 });
    // 两条完成进入同一聚合窗口（首条即时、第二条入队挂起）
    status({ agent: pairA().running, status: "running" });
    status({ agent: pairA().idle, status: "idle" });
    status({ agent: pairB().running, status: "running" });
    status({ agent: pairB().idle, status: "idle" });
    const windowed = doneCount();
    // 等窗口到点：flush 补发聚合条（正常路径；短窗 30ms 已注入）
    await waitMergeWindow(30);
    const flushed = doneCount();
    // 已提交 turn 不回退：flush 完成后再现 idle（无新 closure 形态）不重复
    status({ agent: agentWithTitle("b4f-a", "flush 后 A", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("b4f-a", "flush 后 A", { turnEnd: 1 }), status: "idle" });
    status({ agent: agentWithTitle("b4f-b", "flush 后 B", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("b4f-b", "flush 后 B", { turnEnd: 1 }), status: "idle" });
    c = { windowed, flushed, afterRepeat: doneCount() };
  });

  it("B-4：窗口内首条即时、第二条挂起", () => {
    expect(c.windowed).toBe(1);
  });

  it("B-4：flush 补发聚合条", () => {
    expect(c.flushed).toBe(2);
  });

  it("B-4：聚合条文案带计数", () => {
    expect(infos.some((t) => /: done /.test(t) && t.includes("另有 1 个任务已完成"))).toBeTruthy();
  });

  it("B-4：flush 后已提交 turn 不回退重发", () => {
    expect(c.afterRepeat).toBe(2);
  });
});
