// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — e2e（证据面域）：单源证据收敛（session/event push 主源 +
 * lastTurnEndOf 快照仅 push 缺失兜底 + runningBaseline 冻结）、跳过路径 warn
 * 留痕、畸形载荷不毒化记忆、重载窗口后首轮 live turn 仍通知。
 *
 * 拆法：原 e2e-done.test.ts 的块 5（证据面单源收敛 + 跳过路径 warn）与块 12
 * （重载窗口）落在此文件——两者同属「状态机记忆与证据来源」域。
 *
 * 迁移说明：块 5 是「动作 → 累计 countDone() 断言 → 新动作」交错序列，整体
 * 执行一次并物化各检查点计数与 warn 行快照；块 12 两个子场景互相独立，
 * 各自实例分别捕获。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier, agentWithTitle, turnEndEvent, turnPair } from "../helpers.ts";
import { lastTurnEndOf } from "../../src/index.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-e2e-done-evidence-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("证据面单源收敛 + 跳过路径 warn 兜底", () => {
  let c: Record<string, number>;
  let warnLine: string | undefined;
  let malWarn: string | undefined;
  let warns: string[];
  let snapshotLast: unknown;
  let malformedOnly: unknown;

  beforeAll(async () => {
    const infos: string[] = [];
    warns = [];
    // 关闭完成聚合：本块聚焦单源证据合并语义，每条完成即时通知便于计数
    // （doneMergeWindowMs 是运行时配置，经组合层 entry 传入）
    const { listeners } = await makeNotifier(
      work,
      { doneMergeWindowMs: 0 },
      { logger: { info: (t) => infos.push(t), warn: (t) => warns.push(t) } }
    );
    const status = listeners.get("agent/status")[0];
    const sessionEvent = listeners.get("session/event")[0];
    const disposed = listeners.get("agent/disposed")[0];
    const countDone = () => infos.filter((t) => /dsh-notifier: done /.test(t)).length;
    c = {};

    // (a) push 恒定新鲜为主证据（报告场景反证）：agent.session
    //     .events 冻结在 turn=1（快照一次性读滞后被 lastEndedTurn 固化的形态——
    //     running/idle 同构造恰模拟 events 停滞），session/event 推送流正常逐轮
    //     派发。单源收敛后判定只采信 push（不读快照）→ 逐轮通知 4 条，不再
    //     依赖双源按 turn 取新。
    for (let turn = 1; turn <= 4; turn += 1) {
      status({ agent: agentWithTitle("stuck-a", "停滞会话", { turnEnd: 1 }), status: "running" });
      sessionEvent({ id: "stuck-a" }, turnEndEvent(turn));
      status({ agent: agentWithTitle("stuck-a", "停滞会话", { turnEnd: 1 }), status: "idle" });
    }
    c.pushMain = countDone();

    // (b) 同 turn 去重：push 与快照指向同一 append-only 日志的同一事件，
    //     turn 相同即同一证据——采信 push 后合并为单次通知；已记忆 turn 的重复
    //     派发不重复通知。
    status({ agent: agentWithTitle("dedup-1", "去重会话", { turnEnd: 2 }), status: "running" });
    sessionEvent({ id: "dedup-1" }, turnEndEvent(2));
    status({ agent: agentWithTitle("dedup-1", "去重会话", { turnEnd: 2 }), status: "idle" });
    c.dedupFirst = countDone();
    sessionEvent({ id: "dedup-1" }, turnEndEvent(2)); // 已记忆 turn 的重复派发不再触发
    status({ agent: agentWithTitle("dedup-1", "去重会话", { turnEnd: 2 }), status: "running" });
    status({ agent: agentWithTitle("dedup-1", "去重会话", { turnEnd: 2 }), status: "idle" });
    c.dedupRepeat = countDone();

    // (c) 跳过路径 warn 兜底：无新证据的 idle 判定跳过必须可观测，且
    //     warn 字段标识证据来源（单源语义：证据源=push / 快照兜底 / 快照冻结）。
    //     首轮为真实完成时序（running 无 closure → idle turn=1 completed 通知），
    //     第二轮 events 仍停 turn=1（abort-early 形态）→ 快照 ≤ running 基线
    //     被冻结 → 跳过 + warn（证据源=快照冻结）。
    const w1 = turnPair("warn-1", "静默会话", {}, { turn: 1 });
    status({ agent: w1.running, status: "running" });
    status({ agent: w1.idle, status: "idle" }); // 首轮正常通知，lastEndedTurn=1
    const beforeWarn = countDone();
    c.beforeWarn = beforeWarn;
    status({ agent: agentWithTitle("warn-1", "静默会话", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("warn-1", "静默会话", { turnEnd: 1 }), status: "idle" }); // 无新 closure → 快照冻结 + warn
    c.frozen = countDone();
    warnLine = warns.find((t) => t.includes("warn-1"));

    // 设计内静默同样留痕：aborted 中断不发 done，但 warn 带 kind=aborted 可核对
    // （真实时序：本轮 aborted closure 落盘 → 白名单拒绝，非快照冻结）。
    const a1 = turnPair("abort-1", "中断会话", {}, { turn: 1, kind: "aborted" });
    status({ agent: a1.running, status: "running" });
    status({ agent: a1.idle, status: "idle" });
    c.aborted = countDone();

    // disposed 清理辅源记忆：销毁后推送残留 turn 不再参与判定（防 Map 无界增长）。
    status({ agent: agentWithTitle("gc-1", "清理会话", { turnEnd: 3 }), status: "running" });
    sessionEvent({ id: "gc-1" }, turnEndEvent(3));
    disposed({ agent: agentWithTitle("gc-1", "清理会话") });
    status({ agent: agentWithTitle("gc-1", "清理会话", { turnEnd: 3 }), status: "idle" }); // 状态机+辅源已清零：不通知
    c.gc = countDone();

    // (d) 畸形载荷不毒化记忆：turn 非数字的推送 turn/end
    //     直接 skip 不落记忆——任何畸形证据既不能成 best、也不能推进记忆。
    status({ agent: agentWithTitle("mal-1", "畸形会话"), status: "running" }); // 无快照 turn/end（pushed/快照均缺失形态）
    sessionEvent({ id: "mal-1" }, { type: "turn/end", data: { turn: "x", reason: { kind: "completed" } } });
    sessionEvent({ id: "mal-1" }, { type: "turn/end", data: { turn: Number.NaN, reason: { kind: "completed" } } });
    status({ agent: agentWithTitle("mal-1", "畸形会话"), status: "idle" });
    c.malformed = countDone();
    malWarn = warns.find((t) => t.includes("mal-1"));
    // 毒化回归反证：随后真实 turn=2 push completed 照常通知（修复前被 NaN 记忆吞掉）。
    status({ agent: agentWithTitle("mal-1", "畸形会话", { turnEnd: 2 }), status: "running" });
    sessionEvent({ id: "mal-1" }, turnEndEvent(2));
    status({ agent: agentWithTitle("mal-1", "畸形会话", { turnEnd: 2 }), status: "idle" });
    c.afterMalformed = countDone();

    // lastTurnEndOf 快照侧同款加固：畸形条目跳过继续倒序扫描，取上一条合法证据。
    const snapshotAgent = {
      id: "mal-2",
      session: {
        header: undefined,
        snapshotEvents: () => [
          { type: "turn/end", data: { turn: 7, reason: { kind: "completed" } } },
          { type: "turn/end", data: { turn: "x", reason: { kind: "completed" } } },
          { type: "session/title", data: { title: "T" } },
        ],
      },
    };
    snapshotLast = lastTurnEndOf(snapshotAgent);
    malformedOnly = lastTurnEndOf({ id: "mal-3", session: { header: undefined, snapshotEvents: () => [{ type: "turn/end", data: { turn: null, reason: { kind: "completed" } } }] } });
  });

  it("(a) events 停滞形态下 push 主证据逐轮通知（快照冻结不影响）", () => {
    expect(c.pushMain).toBe(4);
  });

  it("(b) push+快照同 turn 合并为单次通知", () => {
    expect(c.dedupFirst).toBe(5);
  });

  it("(b) 已记忆 turn 的重复到达不重复通知", () => {
    expect(c.dedupRepeat).toBe(5);
  });

  it("(c) 无新证据轮不发 done", () => {
    expect(c.frozen).toBe(c.beforeWarn);
  });

  it("(c) 跳过路径输出 warn 日志", () => {
    expect(warnLine !== undefined).toBeTruthy();
  });

  it("(c) warn 标识跳过动作", () => {
    expect(warnLine).toMatch(/完成判定跳过/);
  });

  it("(c) warn 证据源标识快照冻结（abort-early 陈旧快照）", () => {
    expect(warnLine).toMatch(/证据源=快照冻结/);
  });

  it("(c) warn 含快照源检测到的 turn", () => {
    expect(warnLine).toMatch(/快照turn=1/);
  });

  it("(c) warn 含推送源检测值（无则为 -）", () => {
    expect(warnLine).toMatch(/推送turn=-/);
  });

  it("(c) warn 含记忆的 lastEndedTurn", () => {
    expect(warnLine).toMatch(/记忆turn=1/);
  });

  it("aborted 中断不发 done", () => {
    expect(c.aborted).toBe(c.beforeWarn);
  });

  it("aborted 静默留痕 kind=aborted", () => {
    expect(warns.some((t) => t.includes("abort-1") && /kind=aborted/.test(t))).toBeTruthy();
  });

  it("disposed 清理后辅源残留不误报", () => {
    expect(c.gc).toBe(c.beforeWarn);
  });

  it("(d) 畸形载荷不误报 done", () => {
    expect(c.malformed).toBe(c.beforeWarn);
  });

  it("(d) 畸形证据不可用走跳过路径 warn", () => {
    expect(malWarn !== undefined && /完成判定跳过/.test(malWarn)).toBeTruthy();
  });

  it("(d) 无任何可信证据（记忆未被毒化）", () => {
    expect(malWarn).toMatch(/证据源=无 快照turn=- 推送turn=- 记忆turn=-/);
  });

  it("(d) 畸形载荷之后真实完成照常通知", () => {
    expect(c.afterMalformed).toBe(c.beforeWarn + 1);
  });

  it("(d) lastTurnEndOf 跳过非有限 turn 条目", () => {
    expect(snapshotLast).toEqual({ turn: 7, kind: "completed" });
  });

  it("(d) 仅畸形条目时返回 undefined", () => {
    expect(malformedOnly).toBe(undefined);
  });
});

// ── 重载窗口后首轮 live turn 仍通知与重载不引入假阳性——独立实例模拟插件
//    重载（新 fiber 的 agentStates / eventStreamEnds 记忆为空）──
describe("重载窗口：首轮 live turn 仍通知、abort-early 仍静默", () => {
  let infos1: string[];
  let warns1: string[];
  let infos2: string[];
  let warns2: string[];
  let d2Warn: string | undefined;

  beforeAll(async () => {
    // 重载窗口后首轮 live turn 仍通知（快照兜底补证）。
    // 构造：上一轮 turn=1 已落盘（重载前已派发、新 fiber 未记忆，push 缺失），
    // 本轮 live turn=2 completed 落盘后 running→idle——快照较 running 基线推进，
    // 走快照兜底补证 → 恰一条 done，不因记忆重置静默。
    const d1Cfg = join(work, "d1-reload.json");
    writeFileSync(d1Cfg, JSON.stringify({ doneMergeWindowMs: 0 }));
    infos1 = [];
    warns1 = [];
    const { listeners: l1 } = await makeNotifier(
      work,
      { configFile: d1Cfg, historyFile: join(work, "d1-hist.jsonl") },
      { logger: { info: (t) => infos1.push(t), warn: (t) => warns1.push(t) } }
    );
    const status1 = l1.get("agent/status")[0];
    const d1 = turnPair("d1-1", "重载后任务", {}, { turn: 2 }, { turn: 1 }); // prev=1（重载前 closure）、this=2（本轮 live）
    status1({ agent: d1.running, status: "running" });
    status1({ agent: d1.idle, status: "idle" });

    // 重载后 abort-early（本轮无新 closure）idle 仍静默——running 基线
    // 捕获上一轮 turn=1 completed，idle 时快照仍 turn=1（≤ 基线）→ 冻结，
    // 不因记忆重置把旧证据当新轮完成。
    const d2Cfg = join(work, "d2-reload-abort.json");
    writeFileSync(d2Cfg, JSON.stringify({ doneMergeWindowMs: 0 }));
    infos2 = [];
    warns2 = [];
    const { listeners: l2 } = await makeNotifier(
      work,
      { configFile: d2Cfg, historyFile: join(work, "d2-hist.jsonl") },
      { logger: { info: (t) => infos2.push(t), warn: (t) => warns2.push(t) } }
    );
    const status2 = l2.get("agent/status")[0];
    status2({ agent: agentWithTitle("d2-1", "重载后中断", { turnEnd: 1 }), status: "running" });
    status2({ agent: agentWithTitle("d2-1", "重载后中断", { turnEnd: 1 }), status: "idle" });
    d2Warn = warns2.find((t) => t.includes("d2-1"));
  });

  it("D-1：重载后首轮 live turn 经快照兜底通知（恰一条）", () => {
    expect(infos1.filter((t) => /: done /.test(t)).length).toBe(1);
  });

  it("D-1：重载后首轮 live turn 不走跳过路径（无 warn）", () => {
    expect(!warns1.some((t) => t.includes("d1-1"))).toBeTruthy();
  });

  it("D-2：重载后 abort-early 静默（不把旧证据当新轮完成）", () => {
    expect(infos2.filter((t) => /: done /.test(t)).length).toBe(0);
  });

  it("D-2：重载后 abort-early 跳过路径 warn 留痕", () => {
    expect(d2Warn !== undefined && /完成判定跳过/.test(d2Warn)).toBeTruthy();
  });

  it("D-2：warn 标识快照冻结（陈旧快照拦截）", () => {
    expect(d2Warn).toMatch(/证据源=快照冻结/);
  });
});
