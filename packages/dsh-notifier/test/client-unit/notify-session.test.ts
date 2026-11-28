/**
 * dsh-notifier — SSE 会话的判据（#769 阶段 2 / #1143 hello 三态）。
 *
 * 连接/看门狗/重连原先直接 new EventSource 并用真实时钟，因此断线窗口里丢通知的三个成因
 * （重连不带 since、重复帧没被丢、半开连接没被发现）全都测不到。这里用假连接与假计时器逐条钉住。
 *
 * hello 三态（#1143 v2）的判据也在这里：fresh 用 hello.seq 播种、resume 不把水位抬到 hello.seq
 * （否则回放帧会被当成旧帧丢掉）、gap 抬水位并只提示一次。旧服务端不发 hello 时回落既有语义。
 */
import { describe, expect, it } from "vitest";

import {
  startNotifySession,
  WATCHDOG_MS,
  type EventSourceLike,
} from "../../src/client/notify/session.ts";

interface FakeSource extends EventSourceLike {
  url: string;
  closed: number;
}

function harness() {
  const sources: FakeSource[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const frames: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const gaps: number[] = [];
  let clock = 1_000_000;
  let nextTimer = 1;

  const ports = {
    url: "/api/dsh-notifier/events",
    createSource: (url: string): EventSourceLike => {
      const source: FakeSource = {
        url,
        closed: 0,
        onmessage: null,
        onerror: null,
        close(): void {
          this.closed += 1;
        },
      };
      sources.push(source);
      return source;
    },
    now: () => clock,
    setTimer: (fn: () => void, ms: number): number => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (handle: number): void => {
      timers.delete(handle);
    },
    warn: (message: string): void => {
      warnings.push(message);
    },
  };

  const session = startNotifySession(
    ports,
    (frame) => frames.push(frame),
    () => gaps.push(clock),
  );
  return {
    session,
    ports,
    sources,
    timers,
    frames,
    warnings,
    gaps,
    current: () => sources[sources.length - 1]!,
    advance: (ms: number) => {
      clock += ms;
    },
    emit: (payload: unknown) => {
      sources[sources.length - 1]!.onmessage?.({ data: JSON.stringify(payload) });
    },
    emitRaw: (data: string) => {
      sources[sources.length - 1]!.onmessage?.({ data });
    },
    error: () => {
      sources[sources.length - 1]!.onerror?.();
    },
    fireTimers: () => {
      const due = [...timers.entries()].sort((a, b) => a[0] - b[0]);
      for (const [id, timer] of due) {
        if (!timers.has(id)) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

describe("SSE 会话：连接与 since 补拉", () => {
  it("首次连接不带 since（无已见水位 = 新会话：服务端不回放旧缓冲）", () => {
    const h = harness();
    expect(h.sources).toHaveLength(1);
    expect(h.current().url).toBe("/api/dsh-notifier/events");
  });

  it("重连带 since=<已见最大 seq>（EventSource 自动重连不带 query，不带就丢事件）", () => {
    const h = harness();
    h.emit({ type: "notify", seq: 7, kind: "done" });
    h.error();
    expect(h.sources).toHaveLength(2);
    expect(h.current().url).toBe("/api/dsh-notifier/events?since=7");
  });

  it("fresh 后首次自重连必带 since（hello 播种的水位就是 since 起点；原生重连裸奔会丢帧）", () => {
    const h = harness();
    h.emit({ type: "hello", seq: 7, covered: true });
    h.error();
    expect(h.sources).toHaveLength(2);
    expect(h.current().url).toBe("/api/dsh-notifier/events?since=7");
  });

  it("每次重连都先关掉旧连接（不留半开句柄）", () => {
    const h = harness();
    h.error();
    expect(h.sources[0]!.closed).toBe(1);
  });

  it("onerror 在节流窗口内也先关旧连接，节流只延迟、不把重连让给 EventSource 原生裸奔", () => {
    const h = harness();
    h.emit({ type: "hello", seq: 7, covered: true });
    // 第一次 onerror 立即自调度重连，窗口从这次重连起算。
    h.error();
    expect(h.sources).toHaveLength(2);

    h.emit({ type: "hello", seq: 7, covered: true });
    // 追平（lastSeq === hello.seq）没有要补的帧，不算缺口。
    expect(h.gaps).toEqual([]);
    h.error();
    // 旧连接当场关闭；新连接要等窗口到点，而不是由 EventSource 自己重连。
    expect(h.sources).toHaveLength(2);
    expect(h.current().closed).toBe(1);
    expect([...h.timers.values()].some((timer) => timer.ms === 5_000)).toBe(true);

    h.advance(5_000);
    h.fireTimers();
    expect(h.sources).toHaveLength(3);
    expect(h.current().url).toBe("/api/dsh-notifier/events?since=7");
  });
});

describe("SSE 会话：hello 三态", () => {
  it("fresh（lastSeq=0）：用 hello.seq 播种，随后到达的回放帧被丢弃，新帧放行", () => {
    const h = harness();
    h.emit({ type: "hello", seq: 5, covered: true });
    h.emit({ type: "notify", seq: 4, kind: "replay-4" });
    h.emit({ type: "notify", seq: 5, kind: "replay-5" });
    h.emit({ type: "notify", seq: 6, kind: "live" });

    expect(h.frames.map((frame) => frame.kind)).toEqual(["live"]);
    expect(h.gaps).toEqual([]);
  });

  it("resume（covered=true）：不把 lastSeq 抬到 hello.seq，回放帧按 seq>lastSeq 全部补上", () => {
    const h = harness();
    // 首连播种 2，已见 3；重连时服务端高水位 5，回放 4、5。
    h.emit({ type: "hello", seq: 2, covered: true });
    h.emit({ type: "notify", seq: 3, kind: "live" });
    h.error();
    h.emit({ type: "hello", seq: 5, covered: true });
    h.emit({ type: "notify", seq: 4, kind: "replay-4" });
    h.emit({ type: "notify", seq: 5, kind: "replay-5" });

    expect(h.frames.map((frame) => frame.kind)).toEqual(["live", "replay-4", "replay-5"]);
    expect(h.gaps).toEqual([]);
  });

  it("gap（covered=false）：抬到 hello.seq、丢弃回放帧，并只提示一次「可能错过」", () => {
    const h = harness();
    h.emit({ type: "hello", seq: 2, covered: true });
    h.emit({ type: "notify", seq: 3, kind: "live" });
    h.error();
    h.emit({ type: "hello", seq: 9, covered: false });
    h.emit({ type: "notify", seq: 8, kind: "missing" });
    h.emit({ type: "notify", seq: 9, kind: "missing" });
    h.emit({ type: "notify", seq: 10, kind: "after" });

    expect(h.frames.map((frame) => frame.kind)).toEqual(["live", "after"]);
    // 一次缺口一次提示；不是一帧一条，也不拉 /history 计数（会话手里没有这个入口）。
    expect(h.gaps).toHaveLength(1);
  });

  it("gap 即使一条回放帧都没有也提示（history 为空不能成为不告警的开关）", () => {
    const h = harness();
    h.emit({ type: "hello", seq: 2, covered: true });
    h.emit({ type: "notify", seq: 3, kind: "seen" });
    h.error();
    // 服务端高水位已到 5，但回放窗口一条都拿不出来：缺口必须显式提示。
    h.emit({ type: "hello", seq: 5, covered: false });

    expect(h.frames.map((frame) => frame.kind)).toEqual(["seen"]);
    expect(h.gaps).toHaveLength(1);
  });

  it("序号回退（hello.seq < lastSeq）：按缺口处理，抬到服务端新水位后继续接新帧", () => {
    const h = harness();
    h.emit({ type: "hello", seq: 10, covered: true });
    h.emit({ type: "notify", seq: 11, kind: "before" });
    h.error();
    h.emit({ type: "hello", seq: 4, covered: false });
    h.emit({ type: "notify", seq: 3, kind: "stale" });
    h.emit({ type: "notify", seq: 5, kind: "after" });

    expect(h.frames.map((frame) => frame.kind)).toEqual(["before", "after"]);
    expect(h.gaps).toHaveLength(1);
  });

  it("旧服务端无 hello：回落既有水位语义，不提示缺口", () => {
    const h = harness();
    h.emit({ type: "notify", seq: 1, kind: "a" });
    h.emit({ type: "notify", seq: 2, kind: "b" });
    expect(h.frames.map((frame) => frame.kind)).toEqual(["a", "b"]);
    expect(h.gaps).toEqual([]);
    h.error();
    expect(h.current().url).toBe("/api/dsh-notifier/events?since=2");
  });

  it("畸形 hello（负数 / 非数字）当没收到：不改水位、不提示", () => {
    const h = harness();
    h.emit({ type: "notify", seq: 3, kind: "seen" });
    h.emit({ type: "hello", seq: -1, covered: false });
    h.emit({ type: "hello", seq: "9", covered: false });
    expect(h.gaps).toEqual([]);
    h.emit({ type: "notify", seq: 4, kind: "after" });
    expect(h.frames.map((frame) => frame.kind)).toEqual(["seen", "after"]);
  });
});

describe("SSE 会话：帧分发与去重", () => {
  it("ping 不进分发（它是心跳，不是通知）", () => {
    const h = harness();
    h.emit({ type: "ping" });
    expect(h.frames).toEqual([]);
  });

  it("hello 不进分发（它是连接前导，不是通知）", () => {
    const h = harness();
    h.emit({ type: "hello", seq: 1, covered: true });
    expect(h.frames).toEqual([]);
  });

  it("notify 帧进分发", () => {
    const h = harness();
    h.emit({ type: "notify", seq: 1, kind: "done" });
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]!.kind).toBe("done");
  });

  it("重复与更旧的 seq 被丢弃，更大的放行（补拉会重发已见帧）", () => {
    const h = harness();
    h.emit({ type: "notify", seq: 3, kind: "a" });
    h.emit({ type: "notify", seq: 3, kind: "b" });
    h.emit({ type: "notify", seq: 2, kind: "c" });
    h.emit({ type: "notify", seq: 4, kind: "d" });
    expect(h.frames.map((f) => f.kind)).toEqual(["a", "d"]);
  });

  it("没有 seq 的帧一律放行（无法比较先后，丢掉才是错的）", () => {
    const h = harness();
    h.emit({ type: "notify", seq: 5, kind: "a" });
    h.emit({ type: "notify", kind: "no-seq" });
    expect(h.frames.map((f) => f.kind)).toEqual(["a", "no-seq"]);
  });

  it("畸形帧只留痕、不进分发，也不抛", () => {
    const h = harness();
    h.emitRaw("{not json");
    expect(h.frames).toEqual([]);
    expect(h.warnings).toContain("帧解析失败");
  });

  it("未知 type 静默忽略", () => {
    const h = harness();
    h.emit({ type: "something-else", seq: 9 });
    expect(h.frames).toEqual([]);
  });
});

describe("SSE 会话：看门狗", () => {
  it("WATCHDOG_MS 是字面量锚（防静默漂移，不是行为判据）", () => {
    // 行为用例都把常量当输入喂进去，改这个数字不会红；这条锚让「改数字」必须在测试里显式改一次。
    expect(WATCHDOG_MS).toBe(60000);
  });

  it("看门狗按「窗口 + 5s」起表", () => {
    const h = harness();
    expect([...h.timers.values()].map((t) => t.ms)).toEqual([65000]);
  });

  it("距最后一帧恰好等于窗口（60000ms，判定是严格大于）→ 只重新计时，不重连", () => {
    const h = harness();
    h.advance(60000);
    h.fireTimers();
    expect(h.sources).toHaveLength(1);
    expect(h.timers.size).toBe(1);
  });

  it("窗口内有过任何帧（含 ping）就不算半开", () => {
    const h = harness();
    // 起表延迟是「窗口 + 5s」，所以这里要让定时器在 ping 之后 20s 触发：
    // 距最后一帧 20s ≤ 60s → 判定连接仍然健康，只重新计时
    h.advance(50000);
    h.emit({ type: "ping" });
    h.advance(20000);
    h.fireTimers();
    expect(h.sources).toHaveLength(1);
    expect(h.timers.size).toBe(1);
  });

  it("距最后一帧超过窗口 1ms（60001ms）→ 判半开并主动重连", () => {
    const h = harness();
    h.advance(60001);
    h.fireTimers();
    expect(h.sources).toHaveLength(2);
  });

  it("距最后一帧超过窗口（哪怕中过 ping）→ 重连", () => {
    const h = harness();
    h.advance(50000);
    h.emit({ type: "ping" });
    h.advance(61000);
    h.fireTimers();
    expect(h.sources).toHaveLength(2);
  });
});

describe("SSE 会话：重连风暴抑制与关闭", () => {
  it("5 秒内的第二次重连被抑制（onerror 与看门狗会互相触发）", () => {
    const h = harness();
    h.error();
    h.error();
    h.error();
    // 第一次立即重连；后两次只关连接并把重连排进节流窗口，不叠加连接。
    expect(h.sources).toHaveLength(2);
    expect([...h.timers.values()].some((timer) => timer.ms === 5_000)).toBe(true);
  });

  it("间隔足够后可以再次重连", () => {
    const h = harness();
    h.error();
    h.advance(5000);
    h.error();
    expect(h.sources).toHaveLength(3);
  });

  it("close 关掉连接并清掉看门狗与待执行的重连（不留定时器）", () => {
    const h = harness();
    h.error();
    h.error();
    h.session.close();
    expect(h.current().closed).toBe(1);
    expect(h.timers.size).toBe(0);
  });

  it("关闭抛错只留痕，不阻塞后续重连", () => {
    const h = harness();
    // 让第一个连接在 close 时抛错
    h.sources[0]!.close = () => {
      throw new Error("already gone");
    };
    expect(() => h.session.close()).not.toThrow();
    expect(h.warnings).toContain("关闭旧 SSE 连接失败");
  });

  it("连接构造抛错只留痕（EventSource 不可用不该炸掉挂载）", () => {
    const sources: FakeSource[] = [];
    const ports = {
      url: "/x",
      createSource: (): EventSourceLike => {
        throw new Error("no EventSource");
      },
      now: () => 1,
      setTimer: () => 1,
      clearTimer: () => undefined,
      warn: () => undefined,
    };
    const warnings: string[] = [];
    expect(() =>
      startNotifySession({ ...ports, warn: (m: string) => warnings.push(m) }, () => undefined),
    ).not.toThrow();
    expect(warnings).toContain("EventSource 不可用");
    expect(sources).toHaveLength(0);
  });
});
