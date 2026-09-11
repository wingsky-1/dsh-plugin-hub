/**
 * dsh-notifier — unit：event-handlers 核心判定直测（红测先行）。
 *
 * 现状 resolveTurnEvidence（push 优先/快照兜底/stale 冻结/rememberedTurn）是
 * 模块私有函数（event-handlers.ts），行为只有 e2e 黑盒覆盖——失败定位只能靠
 * 黑盒。本文件导出并锁定判定矩阵基线；adjudicate 拆分时是
 * 行为对等判别网。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveTurnEvidence } from "../../src/events/interface.ts";
import type { AgentState } from "../../src/events/interface.ts";
import { agentWithTitle } from "../helpers.ts";

type EvidenceAgent = ReturnType<typeof agentWithTitle>;
type EventStreamEnds = Parameters<typeof resolveTurnEvidence>[2];
type Evidence = ReturnType<typeof resolveTurnEvidence>;

function run(agent: EvidenceAgent, state: AgentState, streamEnds: EventStreamEnds = new Map()) {
  return resolveTurnEvidence(agent, state, streamEnds);
}

describe("1：push 优先（session/event 推送条目胜于快照）", () => {
  let ev: Evidence;

  beforeEach(() => {
    const agent = agentWithTitle("a1", "任务X", { turnEnd: 5 });
    const state = { runningSeen: false, startedAt: 0, runningBaseline: { turn: 3, kind: "completed" } };
    ev = run(agent, state, new Map([["a1", { turn: 6, kind: "completed" }]]));
  });

  it("push 条目取回", () => {
    expect(ev.pushed!.turn).toBe(6);
  });

  it("证据源 = push", () => {
    expect(ev.evidenceSource).toBe("push");
  });

  it("best = push（胜过快照 5）", () => {
    expect(ev.best!.turn).toBe(6);
  });

  it("push turn6 > 记忆 undefined → 新 closure", () => {
    expect(ev.hasNewEnd).toBe(true);
  });

  it("push 命中时不读快照（快照仅兜底，防御侧零 IO）", () => {
    expect(ev.snapshot).toBeUndefined();
  });
});

describe("2：快照兜底（无 push、无基线 → 快照为准）", () => {
  let ev: Evidence;

  beforeEach(() => {
    const agent = agentWithTitle("a2", "任务Y", { turnEnd: 4 });
    const state = { runningSeen: false, startedAt: 0, runningBaseline: undefined };
    ev = run(agent, state);
  });

  it("无 push", () => {
    expect(ev.pushed).toBeUndefined();
  });

  it("证据源 = 快照兜底", () => {
    expect(ev.evidenceSource).toBe("快照兜底");
  });

  it("best = 快照 turn4", () => {
    expect(ev.best!.turn).toBe(4);
  });

  it("快照 turn4 > 记忆 undefined → 新 closure", () => {
    expect(ev.hasNewEnd).toBe(true);
  });
});

describe("3：stale 冻结（快照 ≤ running 基线 → abort-early 陈旧，冻结不误报）", () => {
  let ev: Evidence;

  beforeEach(() => {
    const agent = agentWithTitle("a3", "任务Z", { turnEnd: 3 });
    const state = { runningSeen: false, startedAt: 0, runningBaseline: { turn: 3, kind: "completed" } };
    ev = run(agent, state);
  });

  it("证据源 = 快照冻结", () => {
    expect(ev.evidenceSource).toBe("快照冻结");
  });

  it("best 为空（陈旧快照不推进）", () => {
    expect(ev.best).toBeUndefined();
  });

  it("不当作新 closure", () => {
    expect(ev.hasNewEnd).toBe(false);
  });

  it("snapshot 保留供日志", () => {
    expect(ev.snapshot!.turn).toBe(3);
  });
});

describe("4：rememberedTurn 去重（hasNewEnd = best.turn > 记忆）", () => {
  let agent: EvidenceAgent;

  beforeEach(() => {
    agent = agentWithTitle("a4", "任务W", { turnEnd: 5 });
  });

  it("best.turn 5 = 记忆 5 → 不算新 closure", () => {
    const base = { runningSeen: false, startedAt: 0, runningBaseline: undefined };
    expect(run(agent, { ...base, lastEndedTurn: 5 }).hasNewEnd).toBe(false);
  });

  it("best.turn 5 > 记忆 4 → 新 closure", () => {
    const base = { runningSeen: false, startedAt: 0, runningBaseline: undefined };
    expect(run(agent, { ...base, lastEndedTurn: 4 }).hasNewEnd).toBe(true);
  });

  it("记忆为空 → 首轮即新 closure", () => {
    expect(run(agent, { runningSeen: false, startedAt: 0, runningBaseline: undefined }).hasNewEnd).toBe(true);
  });
});

describe("5：无证据（pushed 与快照皆无 → 保守静默）", () => {
  let ev: Evidence;

  beforeEach(() => {
    const agent = agentWithTitle("a5", undefined); // 无 turn/end 事件
    ev = run(agent, { runningSeen: false, startedAt: 0 });
  });

  it("best 为空", () => {
    expect(ev.best).toBeUndefined();
  });

  it("证据源 = 无", () => {
    expect(ev.evidenceSource).toBe("无");
  });

  it("不当作新 closure（S1：无证据静默）", () => {
    expect(ev.hasNewEnd).toBe(false);
  });
});
