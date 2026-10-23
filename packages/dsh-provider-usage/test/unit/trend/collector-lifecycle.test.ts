import { beforeAll, describe, expect, it } from "vitest";
import type { TrendCallRecord, TrendCounterRecord } from "../../../src/server/collect/interface.ts";
import {
  HEADER,
  MESSAGE,
  T0,
  USAGE,
  callsOf,
  countersOf,
  ev,
  makeCollector,
  snapshot,
} from "./collector-test-support.ts";

describe("collector：turn/end 与计数", () => {
  describe("turn/end 与 tool/call 计数", () => {
    let counters: TrendCounterRecord[];
    let callCount: number;

    beforeAll(() => {
      const { emitted, send } = makeCollector();
      const s = { id: "s1" };
      send(s, ev("request/header", HEADER(), T0, 1));
      send(s, ev("assistant/chunk", USAGE(100, 50), T0, 2));
      send(
        s,
        ev("tool/call", { turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{}" }, T0, 3),
      );
      send(
        s,
        ev("tool/call", { turn: 1, step: 1, callId: "c2", name: "bash", arguments: "{}" }, T0, 4),
      );
      send(s, ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0 + 1000, 5));
      counters = snapshot(countersOf(emitted));
      callCount = callsOf(emitted).length;
    });

    it("turn/end 计一轮", () => {
      expect(counters.filter((c) => c.turns === 1).length).toBe(1);
    });

    it("tool/call 计两次", () => {
      expect(counters.filter((c) => c.toolCalls === 1).length).toBe(2);
    });

    it("turn/end 不影响已定稿调用", () => {
      expect(callCount).toBe(1);
    });
  });

  describe("turn/end 后同键迟到结算：仍是真实尝试 → 入账且序数连续", () => {
    let calls: TrendCallRecord[];
    let turnCounters: number;

    beforeAll(() => {
      const { emitted, send } = makeCollector();
      const s = { id: "s1" };
      send(s, ev("request/header", HEADER(), T0, 1));
      send(s, ev("assistant/chunk", USAGE(100, 50), T0, 2));
      send(s, ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0 + 1000, 3));
      send(
        s,
        ev("assistant/message", MESSAGE({ inputTokens: 999, outputTokens: 999 }), T0 + 2000, 4),
      );
      calls = snapshot(callsOf(emitted));
      turnCounters = countersOf(emitted).filter((c) => c.turns === 1).length;
    });

    it("turn/end 后同键迟到结算仍入账", () => {
      expect(calls.length).toBe(2);
    });

    it("序数记忆不按 turn 清，retry 连续", () => {
      expect(calls[1].retry).toBe(2);
    });

    it("turn 计数独立不受影响", () => {
      expect(turnCounters).toBe(1);
    });
  });
});

describe("collector：TTL 与销毁", () => {
  describe("会话状态未到龄：序数记忆保留 → retry 连续", () => {
    let calls: TrendCallRecord[];

    beforeAll(() => {
      let nowMs = T0;
      const { emitted, send } = makeCollector(() => nowMs);
      const s = { id: "s1" };
      send(s, ev("request/header", HEADER(), T0, 1));
      send(s, ev("assistant/chunk", USAGE(100, 50), T0, 2));
      nowMs = T0 + 11 * 60 * 1000;
      send(s, ev("assistant/message", MESSAGE({ inputTokens: 42, outputTokens: 42 }), nowMs, 3));
      calls = snapshot(callsOf(emitted));
    });

    it("TTL 内迟到结算照常入账", () => {
      expect(calls.length).toBe(2);
    });

    it("retry 取序数记忆（连续）", () => {
      expect(calls[1].retry).toBe(2);
    });
  });

  describe("会话状态被清扫回收：序数记忆一并丢弃 → 同键结算视为全新会话", () => {
    let afterFirst: number;
    let afterSecond: number;
    let calls: TrendCallRecord[];

    beforeAll(() => {
      let nowMs = T0;
      const { emitted, send } = makeCollector(() => nowMs);
      const s1 = { id: "s1" };
      send(s1, ev("request/header", HEADER(), T0, 1));
      send(s1, ev("assistant/chunk", USAGE(100, 50), T0, 2));
      afterFirst = callsOf(emitted).length;
      // 闲置 61min 后由**别的**会话触发全局清扫 → s1 被回收
      nowMs = T0 + 61 * 60 * 1000;
      send({ id: "s2" }, ev("assistant/chunk", USAGE(1, 1), nowMs, 3));
      afterSecond = callsOf(emitted).length;
      send(
        s1,
        ev("assistant/message", MESSAGE({ inputTokens: 7, outputTokens: 7 }), nowMs + 1000, 4),
      );
      calls = snapshot(callsOf(emitted));
    });

    it("首条入账", () => {
      expect(afterFirst).toBe(1);
    });

    it("s2 入账", () => {
      expect(afterSecond).toBe(2);
    });

    it("回收后的 s1 结算照常入账", () => {
      expect(calls.length).toBe(3);
    });

    it("回收后 retry 从 1 重启（60min 窗口外不追溯，口径文档化）", () => {
      expect(calls.at(-1)!.retry).toBe(1);
    });
  });

  describe("非法 payload 防御", () => {
    let callCount: number;

    beforeAll(() => {
      const { emitted, send } = makeCollector();
      const s = { id: "s1" };
      send(s, ev("request/header", HEADER(), T0, 1));
      send(s, ev("assistant/chunk", USAGE(100, 50), T0, 2));
      send(s, null); // 非法 session 不崩
      send({ id: "s1" }, null); // 非法 event 不崩
      send(
        { id: "s1" },
        ev("assistant/chunk", { turn: "x", step: 1, chunk: { type: "usage" } }, T0, 3),
      ); // 非法字段不崩
      callCount = callsOf(emitted).length;
    });

    it("非法 payload 防御跳过，正常记账不受连坐", () => {
      expect(callCount).toBe(1);
    });
  });
});

describe("collector：非结算事件走 default 忽略", () => {
  let lens: number[];

  beforeAll(() => {
    const { emitted, send } = makeCollector();
    const s = { id: "s-default" };
    const snap: number[] = [];
    const step = (type: string, data: Record<string, unknown>) => {
      send(s, ev(type, data, T0 + snap.length, snap.length + 2));
      snap.push(emitted.length);
    };
    step("request/header", HEADER());
    step("developer/message", { turn: 1, step: 1 });
    step("session/end-seed", { inherited: true });
    step("session/end-seed", {});
    step("user/message", { turn: 1, step: 1 });
    step("system/message", { turn: 1, step: 1 });
    step("tool/result", { turn: 1, step: 1 });
    step("request/context", { provider: "deepseek", model: "deepseek-chat" });
    step("turn/start", { turn: 1 });
    step("step/start", { turn: 1, step: 1 });
    step("step/end", { turn: 1, step: 1 });
    lens = snapshot(snap);
  });

  it("request/header 只折叠归属（零产出）", () => {
    expect(lens[0]).toBe(0);
  });

  it("developer/message（0.1.7 新类型前瞻）走 default 忽略", () => {
    expect(lens[1]).toBe(0);
  });

  it("forked closer（end-seed inherited:true）走 default 忽略", () => {
    expect(lens[2]).toBe(0);
  });

  it("合成 closer（end-seed 无 tag）走 default 忽略", () => {
    expect(lens[3]).toBe(0);
  });

  it("user/message 非结算（零产出）", () => {
    expect(lens[4]).toBe(0);
  });

  it("system/message 非结算（零产出）", () => {
    expect(lens[5]).toBe(0);
  });

  it("tool/result 非结算（零产出）", () => {
    expect(lens[6]).toBe(0);
  });

  it("request/context 非结算（零产出）", () => {
    expect(lens[7]).toBe(0);
  });

  it("turn/start 非结算（零产出）", () => {
    expect(lens[8]).toBe(0);
  });

  it("step/start 非结算（零产出）", () => {
    expect(lens[9]).toBe(0);
  });

  it("step/end 非结算（零产出）", () => {
    expect(lens[10]).toBe(0);
  });
});

describe("collector：fork 口径——仅计 live 新增", () => {
  let parentCalls: TrendCallRecord[];
  let replayCalls: TrendCallRecord[];
  let childCalls: TrendCallRecord[];
  let markerDelta: number;
  let afterMarkerCalls: TrendCallRecord[];

  const usage = (input: number, output: number) => ({
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  const settled = (turn: number, step: number, u: Record<string, unknown>) => ({
    turn,
    step,
    message: {
      role: "assistant",
      source: { kind: "model", provider: "deepseek", model: "deepseek-chat" },
    },
    usage: u,
    stream: [],
  });

  beforeAll(() => {
    const { emitted, send } = makeCollector();
    // 父会话 live 结算（turn=1 step=1）：计入
    const p = { id: "s-fork-parent" };
    send(p, ev("request/header", HEADER(), T0, 1));
    send(p, ev("assistant/message", settled(1, 1, usage(100, 50)), T0 + 1, 2));
    parentCalls = snapshot(callsOf(emitted));
    // 同一 (turn,step) 再次到达（重放形态：仅当 firehose 契约被违反时可见）——
    // 仍按重试计入：collector 不读 seq，无过滤分支（契约钉，见块注释）
    send(p, ev("assistant/message", settled(1, 1, usage(100, 50)), T0 + 2, 2));
    replayCalls = snapshot(callsOf(emitted));
    // fork 子会话（新 session id）live 新增：同 (turn,step) 独立起算 retry=1，
    // 不继承父会话重试链（per-session done 记忆隔离 = fork 边界）
    const c = { id: "s-fork-child" };
    send(c, ev("request/header", HEADER(), T0 + 3, 1));
    send(c, ev("assistant/message", settled(1, 1, usage(7, 3)), T0 + 4, 2));
    childCalls = snapshot(callsOf(emitted).filter((r) => r.session === "s-fork-child"));
    // seed 边界标记后首个 live 结算：标记零产出，结算照常计 retry=1
    const r = { id: "s-fork-resume" };
    const markerBefore = emitted.length;
    send(r, ev("session/end-seed", { inherited: true }, T0 + 5, 1));
    markerDelta = emitted.length - markerBefore;
    send(r, ev("request/header", HEADER(), T0 + 6, 2));
    send(r, ev("assistant/message", settled(1, 1, usage(9, 9)), T0 + 7, 3));
    afterMarkerCalls = snapshot(callsOf(emitted).filter((x) => x.session === "s-fork-resume"));
  });

  it("父会话 live 结算计入一次", () => {
    expect(parentCalls.length).toBe(1);
  });

  it("父会话首结 retry=1", () => {
    expect(parentCalls[0].retry).toBe(1);
  });

  it("重放形态到达仍按重试计（契约钉：去重在 firehose 层）", () => {
    expect(replayCalls.length).toBe(2);
  });

  it("重放按序 retry=2（非去重非丢弃）", () => {
    expect(replayCalls[1].retry).toBe(2);
  });

  it("fork 子会话 live 新增独立计入", () => {
    expect(childCalls.length).toBe(1);
  });

  it("子会话同键独立起算 retry=1（不继承父链）", () => {
    expect(childCalls[0].retry).toBe(1);
  });

  it("seed 边界标记零产出", () => {
    expect(markerDelta).toBe(0);
  });

  it("标记后首个 live 结算照常计", () => {
    expect(afterMarkerCalls.length).toBe(1);
  });

  it("标记后首结 retry=1（标记不占序数）", () => {
    expect(afterMarkerCalls[0].retry).toBe(1);
  });
});
