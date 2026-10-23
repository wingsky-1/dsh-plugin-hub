import { beforeAll, describe, expect, it } from "vitest";
import type { TrendCallRecord } from "../../../src/server/collect/interface.ts";
import { HEADER, T0, callsOf, ev, makeCollector, snapshot } from "./collector-test-support.ts";

const usage = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
const usageChunk = (u: Record<string, unknown>, time: number) => ({
  type: "chunk",
  time,
  chunk: { type: "usage", usage: u },
});
const msgSource = () => ({
  role: "assistant",
  source: { kind: "model", provider: "deepseek", model: "deepseek-chat" },
});

describe("collector：用量二选一回归——顶层 usage ?? stream 末条", () => {
  let topCalls: TrendCallRecord[];
  let lastCalls: TrendCallRecord[];
  let topOnlyCalls: TrendCallRecord[];
  let streamOnlyCalls: TrendCallRecord[];

  beforeAll(() => {
    const { emitted, send } = makeCollector();
    // (a) 两处不同值 → 取顶层（优先级钉）
    const a = { id: "s-either-top" };
    send(a, ev("request/header", HEADER(), T0, 1));
    send(
      a,
      ev(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: msgSource(),
          usage: usage(1000, 2000),
          stream: [usageChunk(usage(1, 2), T0)],
        },
        T0,
        2,
      ),
    );
    topCalls = snapshot(callsOf(emitted).filter((r) => r.session === "s-either-top"));
    // (b) stream 多条 usage → 取末条
    const b = { id: "s-either-last" };
    send(b, ev("request/header", HEADER(), T0, 1));
    send(
      b,
      ev(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: msgSource(),
          stream: [
            usageChunk(usage(10, 1), T0),
            { type: "chunk", time: T0, chunk: { type: "text-delta", index: 0, text: "hi" } },
            usageChunk(usage(70, 30), T0 + 1),
          ],
        },
        T0,
        2,
      ),
    );
    lastCalls = snapshot(callsOf(emitted).filter((r) => r.session === "s-either-last"));
    // (c) 仅顶层（无 stream 键）→ 取顶层
    const c = { id: "s-either-toponly" };
    send(c, ev("request/header", HEADER(), T0, 1));
    send(
      c,
      ev(
        "assistant/message",
        { turn: 1, step: 1, message: msgSource(), usage: usage(5, 6) },
        T0,
        2,
      ),
    );
    topOnlyCalls = snapshot(callsOf(emitted).filter((r) => r.session === "s-either-toponly"));
    // (d) 仅 stream（无顶层键，message 形态；attempt 形态已有 Q1 覆盖）→ 取末条
    const d = { id: "s-either-streamonly" };
    send(d, ev("request/header", HEADER(), T0, 1));
    send(
      d,
      ev(
        "assistant/message",
        { turn: 1, step: 1, message: msgSource(), stream: [usageChunk(usage(12, 3), T0)] },
        T0,
        2,
      ),
    );
    streamOnlyCalls = snapshot(callsOf(emitted).filter((r) => r.session === "s-either-streamonly"));
  });

  it("两处同时在场只记一次调用（不相加）", () => {
    expect(topCalls.length).toBe(1);
  });

  it("两处不同值取顶层（?? 优先级）", () => {
    expect(topCalls[0].tokens).toEqual({ input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 });
  });

  it("stream 多条 usage 只记一次调用", () => {
    expect(lastCalls.length).toBe(1);
  });

  it("stream 多条 usage 取末条", () => {
    expect(lastCalls[0].tokens).toEqual({ input: 70, output: 30, cacheRead: 0, cacheWrite: 0 });
  });

  it("仅顶层（无 stream）计入一次", () => {
    expect(topOnlyCalls.length).toBe(1);
  });

  it("仅顶层取顶层值", () => {
    expect(topOnlyCalls[0].tokens).toEqual({ input: 5, output: 6, cacheRead: 0, cacheWrite: 0 });
  });

  it("仅 stream（message 形态）计入一次", () => {
    expect(streamOnlyCalls.length).toBe(1);
  });

  it("仅 stream 取末条值", () => {
    expect(streamOnlyCalls[0].tokens).toEqual({
      input: 12,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("collector：用量二选一回归——顶层 usage ?? stream 末条", () => {
  let packedCalls: TrendCallRecord[];

  beforeAll(() => {
    const { emitted, send } = makeCollector();
    // 非裸形态（packed text-chunks 内夹带 usage 状 chunk）不认——调用照计、token null
    const session = { id: "s-either-packed" };
    send(session, ev("request/header", HEADER(), T0, 1));
    send(
      session,
      ev(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: msgSource(),
          stream: [
            {
              type: "text-chunks",
              time0: T0,
              index: 0,
              dt: [],
              texts: ["hi"],
              chunk: { type: "usage", usage: usage(999, 999) },
            },
          ],
        },
        T0,
        2,
      ),
    );
    packedCalls = snapshot(callsOf(emitted).filter((r) => r.session === "s-either-packed"));
  });

  it("非裸形态 usage 不认但调用照计", () => {
    expect(packedCalls.length).toBe(1);
  });

  it("非裸形态 token 记 null（零 usage 语义）", () => {
    expect(packedCalls[0].tokens).toBeNull();
  });
});
