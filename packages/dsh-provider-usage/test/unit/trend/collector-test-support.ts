import type { SessionEvent } from "@deepseek-ai/dsh-session/types";
import { dayKey } from "../../../src/shared/interface.ts";
import {
  TrendCollector,
  type TrendCallRecord,
  type TrendCounterRecord,
  type TrendEmit,
} from "../../../src/server/collect/interface.ts";

/** 固定本地时刻：2026-09-04（周五）12:00。 */
export const T0 = new Date(2026, 8, 4, 12, 0, 0).getTime();
export const DAY0 = dayKey(T0); // 2026-09-04

/**
 * 事件工厂。0.1.5 迁移适配：旧用例以 `assistant/chunk` + 内嵌 usage 表达「一次
 * usage 到达」，而官方已移除该事件、usage 改由结算事件承载——这里把 usage chunk
 * 形态映射为 assistant/message 结算形态（token 与时间语义不变），使下方用例的
 * 断言继续在**原口径**上成立。非 usage 的 chunk（text-delta 等）在新形态下不构成
 * 调用证据，映射为空 stream 的 assistant/attempt（collector 对无 usage attempt 不入账）。
 */
// 事件信封经 unknown 断言为 SessionEvent：与生产边界同构（最小 payload + 品牌类型，
// collector 防御性解析——ledger 同款）。
export function ev(
  type: string,
  data: Record<string, unknown>,
  time: number,
  seq = 1,
): SessionEvent {
  if (type === "assistant/chunk") {
    const payload = data as {
      turn?: unknown;
      step?: unknown;
      chunk?: { type?: unknown; usage?: unknown };
    };
    if (payload.chunk?.type !== "usage") {
      return {
        type: "assistant/attempt",
        seq,
        time,
        data: { turn: payload.turn, step: payload.step, stream: [] },
      } as unknown as SessionEvent;
    }
    return {
      type: "assistant/message",
      seq,
      time,
      data: {
        turn: payload.turn,
        step: payload.step,
        usage: payload.chunk.usage,
        stream: [{ type: "chunk", time, chunk: payload.chunk }],
      },
    } as unknown as SessionEvent;
  }
  return { type, seq, time, data } as unknown as SessionEvent;
}

export const HEADER = (provider = "deepseek", model = "deepseek-chat") => ({
  header: { config: { provider, model } },
  reason: "initial",
});

export const USAGE = (input = 100, output = 50, cacheRead = 0, cacheWrite = 0) => ({
  turn: 1,
  step: 1,
  chunk: {
    type: "usage",
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    },
  },
});

export const MESSAGE = (
  usage: Record<string, unknown> | null,
  opts: { interrupted?: boolean } = {},
) => ({
  turn: 1,
  step: 1,
  message: {
    role: "assistant",
    source: { kind: "model", provider: "deepseek", model: "deepseek-chat" },
  },
  ...(usage !== null ? { usage } : {}),
  ...(opts.interrupted ? { interrupted: true } : {}),
});

export function makeCollector(now: () => number = () => T0) {
  const emitted: TrendEmit[] = [];
  const collector = new TrendCollector({ now, emit: (e) => emitted.push(e) });
  // collector 直接吃字符串 session id（id 提取在 tracker 层）；对象/null 经此解包以覆盖非法输入防御
  // null 事件为非法输入防御用例（collector 就地吞掉）：边界断言与 ev 工厂同理。
  const send = (session: string | { id: string }, event: SessionEvent | null) =>
    collector.handleEvent(
      typeof session === "string" ? session : session?.id,
      event as SessionEvent,
    );
  return { collector, emitted, send };
}

export const callsOf = (emitted: TrendEmit[]): TrendCallRecord[] =>
  emitted
    .filter((e): e is Extract<TrendEmit, { type: "call" }> => e.type === "call")
    .map((e) => e.record);

export const correctsOf = (emitted: TrendEmit[]) =>
  emitted
    .filter((e): e is Extract<TrendEmit, { type: "correct" }> => e.type === "correct")
    .map((e) => e.record);

export const countersOf = (emitted: TrendEmit[]): TrendCounterRecord[] =>
  emitted
    .filter((e): e is Extract<TrendEmit, { type: "counter" }> => e.type === "counter")
    .map((e) => e.record);

/**
 * 观测快照：在原断言点结构化复制观测值。原脚本式用例「动作 → 断言 → 新动作 →
 * 新断言」交错执行，断言读到的必须是该时点的值；迁为 it 后动作全部先在 beforeAll
 * 重放，若不复制则后续动作会改写断言读到的引用（兄弟文件曾出现条数漂移）。
 */
export const snapshot = <T>(value: T): T => structuredClone(value);
