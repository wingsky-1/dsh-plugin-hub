import { beforeAll, describe, expect, it } from "vitest";
import { TrendAggregator } from "../../../src/server/aggregate/interface.ts";
import { TREND_DONE_MAX, type TrendCallRecord } from "../../../src/server/collect/interface.ts";
import {
  DAY0,
  HEADER,
  MESSAGE,
  T0,
  USAGE,
  callsOf,
  correctsOf,
  ev,
  makeCollector,
  snapshot,
} from "./collector-test-support.ts";

describe("collector：attempt 口径（Q1/Q2）", () => {
  describe("Q1：attempt 的 usage 只在 stream 里（无顶层 usage 字段）", () => {
    let calls: TrendCallRecord[];

    beforeAll(() => {
      const { emitted, send } = makeCollector();
      const s = { id: "s1" };
      send(s, ev("request/header", HEADER(), T0, 1));
      const usage = { inputTokens: 12, outputTokens: 3 };
      send(
        s,
        ev(
          "assistant/attempt",
          {
            turn: 1,
            step: 1,
            stream: [{ type: "chunk", time: T0, chunk: { type: "usage", usage } }],
          },
          T0,
          2,
        ),
      );
      calls = snapshot(callsOf(emitted));
    });

    it("有 usage 的 attempt 计入调用", () => {
      expect(calls.length).toBe(1);
    });

    it("token 取自 stream 内裸 usage chunk", () => {
      expect(calls[0].tokens).toEqual({ input: 12, output: 3, cacheRead: null, cacheWrite: null });
    });
  });

  describe("Q2：无 usage 的 attempt 不入账（packed run 形态也不承载 usage）", () => {
    let callCount: number;

    beforeAll(() => {
      const { emitted, send } = makeCollector();
      const s = { id: "s1" };
      send(s, ev("request/header", HEADER(), T0, 1));
      send(
        s,
        ev(
          "assistant/attempt",
          {
            turn: 1,
            step: 1,
            stream: [{ type: "text-chunks", time0: T0, index: 0, dt: [], texts: ["hi"] }],
          },
          T0,
          2,
        ),
      );
      callCount = callsOf(emitted).length;
    });

    it("无 usage 的 attempt 无调用证据", () => {
      expect(callCount).toBe(0);
    });
  });
});

describe("0.1.5 迁移：校正路径退役（同键两次结算 = 两次尝试）", () => {
  let calls: TrendCallRecord[];
  let correctCount: number;
  let cellCalls: number;
  let cellInput: number | null;

  beforeAll(() => {
    // message 结算 + 同键后续结算 = 两次尝试（token 不互相覆盖）
    const { emitted, send } = makeCollector();
    const agg = new TrendAggregator();
    const s = { id: "s1" };
    send(s, ev("request/header", HEADER(), T0, 1));
    send(s, ev("assistant/message", MESSAGE({ inputTokens: 30, outputTokens: 20 }), T0 + 100, 2));
    send(s, ev("assistant/chunk", USAGE(300, 150), T0 + 200, 3));
    calls = snapshot(callsOf(emitted));
    correctCount = correctsOf(emitted).length;
    for (const e of emitted) agg.apply(e);
    const cell = agg.buckets().find((d) => d.day === DAY0)!.providers[0].cell;
    cellCalls = cell.calls;
    cellInput = cell.input;
  });

  it("同键两次结算各自入账", () => {
    expect(calls.length).toBe(2);
  });

  it("retry = 结算序数", () => {
    expect(calls.map((c) => c.retry)).toEqual([1, 2]);
  });

  it("两次 token 各自保留", () => {
    expect(calls.map((c) => c.tokens!.input)).toEqual([30, 300]);
  });

  it("结算自带完整 token，无校正事件", () => {
    expect(correctCount).toBe(0);
  });

  it("aggregator calls=2（两次尝试累加）", () => {
    expect(cellCalls).toBe(2);
  });

  it("aggregator token 求和", () => {
    expect(cellInput).toBe(330);
  });
});

describe("done 记忆语义：结算序数跨 header 与 TTL 连续", () => {
  let calls: TrendCallRecord[];

  beforeAll(() => {
    // 序数记忆跨 header 与宽松 TTL 保持连续：三次同键结算 → retry 1/2/3
    let nowMs = T0;
    const { emitted, send } = makeCollector(() => nowMs);
    const s = { id: "s1" };
    send(s, ev("request/header", HEADER(), T0, 1));
    send(s, ev("assistant/chunk", USAGE(100, 50), T0, 2));
    send(s, ev("assistant/chunk", USAGE(70, 30), T0 + 6000, 3));
    nowMs = T0 + 11 * 60 * 1000;
    send(
      s,
      ev("tool/call", { turn: 1, step: 1, callId: "c", name: "bash", arguments: "{}" }, nowMs, 4),
    );
    send(s, ev("assistant/message", MESSAGE({ inputTokens: 88, outputTokens: 66 }), nowMs, 5));
    calls = snapshot(callsOf(emitted));
  });

  it("三次同键结算各自入账", () => {
    expect(calls.length).toBe(3);
  });

  it("retry 序数连续，不因 header/时间回落", () => {
    expect(calls.map((c) => c.retry)).toEqual([1, 2, 3]);
  });
});

describe("done 记忆语义：超 TREND_DONE_MAX 按插入序淘汰最旧键", () => {
  let doneMax: number;
  let settled: number;
  let afterEvictedCount: number;
  let evictedRetry: number;
  let notEvictedRetry: number;

  beforeAll(() => {
    // done 超 TREND_DONE_MAX 按插入序淘汰最旧键（长命会话防无界增长）。
    // 序数语义下的可观测行为：被淘汰键的后续结算 retry 从 1 重启，未淘汰键继续递增。
    doneMax = TREND_DONE_MAX;
    const { emitted, send } = makeCollector();
    const s = { id: "s1" };
    const usageAt = (turn: number) => ({
      turn,
      step: 1,
      chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
    });
    for (let turn = 1; turn <= TREND_DONE_MAX + 1; turn++) {
      send(s, ev("assistant/chunk", usageAt(turn), T0, turn));
      send(s, ev("turn/end", { turn, reason: { kind: "completed" } }, T0, turn));
    }
    settled = callsOf(emitted).length;
    // 被淘汰键（turn=1）再次结算 → 无记忆 → retry 重启为 1
    send(s, ev("assistant/message", MESSAGE({ inputTokens: 9, outputTokens: 9 }), T0, 999));
    afterEvictedCount = callsOf(emitted).length;
    evictedRetry = callsOf(emitted).at(-1)!.retry;
    // 未淘汰键（turn=MAX+1）再次结算 → 序数递增为 2
    const late = { ...MESSAGE({ inputTokens: 8, outputTokens: 8 }), turn: TREND_DONE_MAX + 1 };
    send(s, ev("assistant/message", late, T0, 1000));
    notEvictedRetry = callsOf(emitted).at(-1)!.retry;
  });

  it("done 记忆上限常量", () => {
    expect(doneMax).toBe(200);
  });

  it("每 turn 一条结算", () => {
    expect(settled).toBe(TREND_DONE_MAX + 1);
  });

  it("被淘汰键的结算照常入账", () => {
    expect(afterEvictedCount).toBe(settled + 1);
  });

  it("被淘汰键 retry 重启为 1", () => {
    expect(evictedRetry).toBe(1);
  });

  it("未淘汰键 retry 递增", () => {
    expect(notEvictedRetry).toBe(2);
  });
});

describe("#655：同键多次尝试陆续结算（token 各自入账）", () => {
  let calls: TrendCallRecord[];
  let correctCount: number;

  beforeAll(() => {
    // 真实数据形态：同一 (session,turn,step) 的多次尝试陆续结算，token 各自入账
    let nowT = new Date(2026, 8, 8, 4, 22, 7).getTime();
    const { emitted, send } = makeCollector(() => nowT);
    const U = (input: number, output: number) =>
      ev(
        "assistant/chunk",
        {
          turn: 1,
          step: 9,
          chunk: { type: "usage", usage: { inputTokens: input, outputTokens: output } },
        },
        nowT,
        1,
      );
    send("s1", ev("request/header", HEADER("commandcode", "z-ai/glm-5.3-flash"), nowT, 0));
    send("s1", U(0, 0));
    nowT += 13 * 60_000;
    send("s1", U(0, 0));
    nowT += 13 * 60_000;
    send("s1", U(0, 0));
    nowT += 12 * 60_000;
    send("s1", U(118593, 41240));
    calls = snapshot(callsOf(emitted));
    correctCount = correctsOf(emitted).length;
  });

  it("同键四次结算逐次入账（每次尝试独立）", () => {
    expect(calls.length).toBe(4);
  });

  it("retry = 结算序数，跨时间连续", () => {
    expect(calls.map((c) => c.retry)).toEqual([1, 2, 3, 4]);
  });

  it("末次 token 为真实值", () => {
    expect(calls.at(-1)!.tokens).toEqual({
      input: 118593,
      output: 41240,
      cacheRead: null,
      cacheWrite: null,
    });
  });

  it("无校正路径", () => {
    expect(correctCount).toBe(0);
  });
});

describe("#655：同键结算中途新 header 仍按结算序数递增", () => {
  let calls: TrendCallRecord[];

  beforeAll(() => {
    // 同键结算中途出现新 header：仍按结算序数递增（header 只影响归属，不影响序数）
    let nowT = T0;
    const { emitted, send } = makeCollector(() => nowT);
    const U = (input: number, output: number) =>
      ev(
        "assistant/chunk",
        {
          turn: 1,
          step: 9,
          chunk: { type: "usage", usage: { inputTokens: input, outputTokens: output } },
        },
        nowT,
        1,
      );
    send("s1", ev("request/header", HEADER(), nowT, 0));
    send("s1", U(10, 5));
    nowT += 13 * 60_000;
    send("s1", ev("request/header", HEADER(), nowT, 2));
    send("s1", U(20, 6));
    calls = snapshot(callsOf(emitted));
  });

  it("同键两次结算 = 两次尝试", () => {
    expect(calls.length).toBe(2);
  });

  it("retry 取序数记忆递增（不回落为 1 重号）", () => {
    expect(calls[1].retry).toBe(2);
  });
});
