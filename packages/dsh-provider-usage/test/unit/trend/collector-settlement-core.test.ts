import { beforeAll, describe, expect, it } from "vitest";
import type { TrendCallRecord } from "../../../src/server/collect/interface.ts";
import {
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

describe("collector：定稿主信号——usage 到达即定稿", () => {
  let calls: TrendCallRecord[];
  let correctCount: number;

  beforeAll(() => {
    const { emitted, send } = makeCollector();
    const s = { id: "s1" };
    send(s, ev("request/header", HEADER(), T0, 1));
    send(
      s,
      ev(
        "assistant/chunk",
        { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "hi" } },
        T0,
        2,
      ),
    );
    send(s, ev("assistant/chunk", USAGE(100, 50, 10, 5), T0 + 1000, 3));
    calls = snapshot(callsOf(emitted));
    correctCount = emitted.filter((e) => e.type === "correct").length;
  });

  it("usage chunk 到达即定稿：一次调用", () => {
    expect(calls.length).toBe(1);
  });

  it("归属主源 = request/header 折叠", () => {
    expect(calls[0].provider).toBe("deepseek");
  });

  it("归属 model", () => {
    expect(calls[0].model).toBe("deepseek-chat");
  });

  it("token 计量", () => {
    expect(calls[0].tokens).toEqual({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 });
  });

  it("首调用 retry=1", () => {
    expect(calls[0].retry).toBe(1);
  });

  it("定稿时间 = 事件 time", () => {
    expect(calls[0].time).toBe(T0 + 1000);
  });

  it("text-delta 与首定稿不产生校正", () => {
    expect(correctCount).toBe(0);
  });
});

describe("collector：结算事件防双计——两处 usage 同时在场只记一份", () => {
  let calls: TrendCallRecord[];

  beforeAll(() => {
    const { emitted, send } = makeCollector();
    const s = { id: "s1" };
    const tokens = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
    send(s, ev("request/header", HEADER(), T0, 1));
    send(
      s,
      ev(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: {
            role: "assistant",
            source: { kind: "model", provider: "deepseek", model: "deepseek-chat" },
          },
          usage: tokens,
          stream: [{ type: "chunk", time: T0, chunk: { type: "usage", usage: tokens } }],
        },
        T0,
        2,
      ),
    );
    calls = snapshot(callsOf(emitted));
  });

  it("两处 usage 只记一次调用", () => {
    expect(calls.length).toBe(1);
  });

  it("token 不翻倍（须 ?? 二选一）", () => {
    expect(calls[0].tokens).toEqual({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("collector：retry 逐次计", () => {
  let calls: TrendCallRecord[];

  beforeAll(() => {
    const { emitted, send } = makeCollector();
    const s = { id: "s1" };
    send(s, ev("request/header", HEADER(), T0, 1));
    send(s, ev("assistant/chunk", USAGE(100, 50), T0, 2));
    // 中间夹一次无 usage 的失败 attempt：不构成调用证据，也不影响序数连续性
    send(s, ev("assistant/attempt", { turn: 1, step: 1, stream: [] }, T0 + 3000, 3));
    send(s, ev("assistant/chunk", USAGE(70, 30), T0 + 6000, 4));
    calls = snapshot(callsOf(emitted));
  });

  it("重试消耗逐次独立入账", () => {
    expect(calls.length).toBe(2);
  });

  it("第一次 retry=1", () => {
    expect(calls[0].retry).toBe(1);
  });

  it("第二次 retry=2", () => {
    expect(calls[1].retry).toBe(2);
  });

  it("两次消耗各自保留", () => {
    expect([calls[0].tokens!.input, calls[1].tokens!.input]).toEqual([100, 70]);
  });
});

describe("collector：message 补记/校正/interrupted", () => {
  describe("补记：usage chunk 缺失，message.usage 到达", () => {
    let calls: TrendCallRecord[];

    beforeAll(() => {
      const { emitted, send } = makeCollector();
      const s = { id: "s1" };
      send(s, ev("request/header", HEADER(), T0, 1));
      send(s, ev("assistant/message", MESSAGE({ inputTokens: 30, outputTokens: 20 }), T0 + 100, 2));
      calls = snapshot(callsOf(emitted));
    });

    it("message 补记一次调用", () => {
      expect(calls.length).toBe(1);
    });

    it("补记 token 来自 message.usage", () => {
      expect(calls[0].tokens).toEqual({ input: 30, output: 20, cacheRead: null, cacheWrite: null });
    });

    it("补记时间 = 事件 time", () => {
      expect(calls[0].time).toBe(T0 + 100);
    });
  });

  describe("补记：无 usage（零 usage 语义）", () => {
    let calls: TrendCallRecord[];

    beforeAll(() => {
      const { emitted, send } = makeCollector();
      const s = { id: "s1" };
      send(s, ev("request/header", HEADER(), T0, 1));
      send(s, ev("assistant/message", MESSAGE(null), T0, 2));
      calls = snapshot(callsOf(emitted));
    });

    it("零 usage 仍计一次调用", () => {
      expect(calls.length).toBe(1);
    });

    it("token 记 null 非 0", () => {
      expect(calls[0].tokens).toBe(null);
    });
  });

  describe("interrupted 补记", () => {
    let interrupted: boolean | undefined;

    beforeAll(() => {
      const { emitted, send } = makeCollector();
      const s = { id: "s1" };
      send(s, ev("request/header", HEADER(), T0, 1));
      send(
        s,
        ev(
          "assistant/message",
          MESSAGE({ inputTokens: 5, outputTokens: 3 }, { interrupted: true }),
          T0,
          2,
        ),
      );
      interrupted = callsOf(emitted)[0].interrupted;
    });

    it("interrupted 标记保留", () => {
      expect(interrupted).toBe(true);
    });
  });

  describe("同键「usage 结算 + message 结算」= 两次尝试（0.1.5 起结算自带完整 token）", () => {
    let calls: TrendCallRecord[];
    let correctCount: number;

    beforeAll(() => {
      const { emitted, send } = makeCollector();
      const s = { id: "s1" };
      send(s, ev("request/header", HEADER(), T0, 1));
      send(s, ev("assistant/chunk", USAGE(100, 50), T0, 2));
      send(s, ev("assistant/message", MESSAGE({ inputTokens: 120, outputTokens: 60 }), T0 + 50, 3));
      calls = snapshot(callsOf(emitted));
      correctCount = correctsOf(emitted).length;
    });

    it("同键两次结算各自入账", () => {
      expect(calls.length).toBe(2);
    });

    it("第二次结算 retry=2", () => {
      expect(calls[1].retry).toBe(2);
    });

    it("结算自带完整 token，无校正路径", () => {
      expect(correctCount).toBe(0);
    });
  });
});
