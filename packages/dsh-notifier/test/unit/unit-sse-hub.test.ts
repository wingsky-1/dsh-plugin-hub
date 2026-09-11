/**
 * dsh-notifier — unit：shared/sse-hub.js 共享 SSE 枢纽（主动回收）。
 *
 * 覆盖（主动回收方案的核心行为，独立于包装配直接测共享层）：
 * - 上限淘汰：超限收敛 + 最老被 destroy（对齐既有语义，抽取零漂移）
 * - close/error 幂等清理（多次触发只 evict 一次）
 * - 背压不误杀：write 返回 false 不立即清（对齐既有用例 (c) 锁定语义）
 * - stalled 超窗回收：write false 持续超 stalledTimeoutMs → 心跳 evict
 * - 抛错 failStreak≥3 判死（对齐原版语义）
 * - maxAge 轮换：超 maxAgeMs 且空闲 → evict；活跃连接（lastWriteAt 刷新）不误杀
 * - evictStats 原因计数 / connHealth 观测字段
 * - 红测：dispose 统一停心跳 + destroy 全部连接
 *
 * 直接 import 共享源（不经 lib 产物）：本文件测的是 shared 层模块本身。
 */
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSseHub } from "../../../../shared/sse-hub.js";

/** fake res 的可配置行为。 */
interface FakeSseResOptions {
  presetDestroyed?: boolean;
  throwAfter?: number;
  falseAfter?: number;
}

/** fake res 观测面（hub 只消费 ServerResponse 子集 + close/error 监听）。 */
interface FakeSseRes {
  state: { destroyed: boolean; writes: number; destroyCalls: number };
  writeHead(): void;
  write(): boolean;
  on(evt: string, cb: () => void): FakeSseRes;
  emit(evt: string): void;
  destroy(): void;
  readonly destroyed: boolean;
  writableEnded: boolean;
  socket: { setKeepAlive(): void };
}

/** 可触发 close/error、可配置 write 行为的 fake res（对齐 routes.test.ts sseRes 桩）。 */
function sseRes(opts: FakeSseResOptions = {}): FakeSseRes & ServerResponse {
  const listeners: Record<string, Array<() => void>> = {};
  const state = { destroyed: false, writes: 0, destroyCalls: 0 };
  if (opts.presetDestroyed) state.destroyed = true;
  const res: FakeSseRes = {
    state,
    writeHead() {},
    write() {
      state.writes += 1;
      if (opts.throwAfter !== undefined && state.writes > opts.throwAfter) throw new Error("EPIPE");
      if (opts.falseAfter !== undefined && state.writes > opts.falseAfter) return false;
      return true;
    },
    on(evt, cb) {
      (listeners[evt] = listeners[evt] || []).push(cb);
      return this;
    },
    emit(evt) {
      for (const cb of listeners[evt] || []) cb();
    },
    destroy() {
      state.destroyed = true;
      state.destroyCalls += 1;
    },
    get destroyed() {
      return state.destroyed;
    },
    writableEnded: false,
    socket: { setKeepAlive() {} },
  };
  return res as unknown as FakeSseRes & ServerResponse;
}

type Hub = ReturnType<typeof createSseHub>;

/** 轮询直到谓词成立（替代固定 sleep：心跳 evict 是异步回调，轮询比等固定毫秒稳）。 */
async function pollUntil(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 轮询「安静期」：谓词持续成立达 quietMs 视为确认（负向断言——验证某事不发生）。 */
async function pollUntilQuiet(predicate: () => boolean, quietMs: number, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  let quiet = 0;
  for (;;) {
    if (!predicate()) return false;
    quiet += 10;
    if (quiet >= quietMs) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("(a) 上限淘汰最老（对齐既有语义，抽取零漂移）", () => {
  let hub: Hub;
  let r1: FakeSseRes & ServerResponse;
  let r2: FakeSseRes & ServerResponse;
  let r3: FakeSseRes & ServerResponse;

  beforeEach(() => {
    hub = createSseHub({ getMaxConnections: () => 2, heartbeatMs: 60_000 });
    r1 = sseRes();
    r2 = sseRes();
    r3 = sseRes();
    hub.register(r1);
    hub.register(r2);
    hub.register(r3);
  });
  afterEach(() => hub.dispose());

  it("上限 2，注册 3 收敛到 2", () => {
    expect(hub.size()).toBe(2);
  });

  it("最老 r1 被淘汰", () => {
    expect(r1.state.destroyed).toBe(true);
  });

  it("r2/r3 保留", () => {
    expect(r2.state.destroyed === false && r3.state.destroyed === false).toBeTruthy();
  });

  it("evict 原因计数 limit=1", () => {
    expect(hub.evictStats().limit).toBe(1);
  });
});

describe("(b) close/error 幂等清理", () => {
  let hub: Hub;
  let r: FakeSseRes & ServerResponse;

  beforeEach(() => {
    hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
    r = sseRes();
    hub.register(r);
    r.emit("close");
    r.emit("error");
    r.emit("close");
  });
  afterEach(() => hub.dispose());

  it("close/error 多次触发只移除一次", () => {
    expect(hub.size()).toBe(0);
  });

  it("destroy 幂等（只一次）", () => {
    expect(r.state.destroyCalls).toBe(1);
  });
});

describe("(c) 背压不误杀：write 返回 false 不立即清（对齐既有用例锁定语义）", () => {
  let hub: Hub;
  let r: FakeSseRes & ServerResponse;

  beforeEach(() => {
    hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000, stalledTimeoutMs: 90_000 });
    r = sseRes({ falseAfter: 0 });
    hub.register(r);
    for (let i = 0; i < 5; i += 1) hub.broadcast("data: x\n\n");
  });
  afterEach(() => hub.dispose());

  it("5 次 write false 不立即清（背压不误杀）", () => {
    expect(hub.size()).toBe(1);
  });

  it("背压连接未销毁", () => {
    expect(r.state.destroyed).toBe(false);
  });
});

describe("(d) stalled 超窗回收：write false 持续超窗 → 心跳 evict（核心新增）", () => {
  let hub: Hub;
  let r: FakeSseRes & ServerResponse;

  beforeEach(() => {
    hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 20, stalledTimeoutMs: 50 });
    r = sseRes({ falseAfter: 0 });
    hub.register(r);
    hub.broadcast("data: x\n\n"); // write false → 置 stalledAt
  });
  afterEach(() => hub.dispose());

  it("背压后仍在表（未超窗）", () => {
    expect(hub.size()).toBe(1);
  });

  it("stalled 超窗被心跳 evict", async () => {
    await pollUntil(() => hub.size() === 0); // 心跳 evict 异步触发，轮询等回收
    expect(hub.size()).toBe(0);
  });

  it("stalled 连接被 destroy", async () => {
    await pollUntil(() => hub.size() === 0);
    expect(r.state.destroyed).toBe(true);
  });

  it("evict 原因计数 stalled=1", async () => {
    await pollUntil(() => hub.size() === 0);
    expect(hub.evictStats().stalled).toBe(1);
  });
});

describe("(e) 抛错 failStreak≥3 判死（对齐原版语义）", () => {
  let hub: Hub;
  let r: FakeSseRes & ServerResponse;

  beforeEach(() => {
    hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
    r = sseRes({ throwAfter: 0 });
    hub.register(r);
    hub.broadcast("data: x\n\n"); // 抛错 1
  });
  afterEach(() => hub.dispose());

  it("1 次抛错不清除（防偶发误杀）", () => {
    expect(hub.size()).toBe(1);
  });

  it("连续 3 次抛错判死 evict", () => {
    hub.broadcast("data: x\n\n"); // 抛错 2
    hub.broadcast("data: x\n\n"); // 抛错 3 → evict
    expect(hub.size()).toBe(0);
  });

  it("判死连接被销毁", () => {
    hub.broadcast("data: x\n\n");
    hub.broadcast("data: x\n\n");
    expect(r.state.destroyed).toBe(true);
  });
});

describe("(f) maxAge 轮换：超 maxAgeMs 且空闲 → evict（核心新增）", () => {
  let hub: Hub;
  let r: FakeSseRes & ServerResponse;

  beforeEach(() => {
    hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 20, maxAgeMs: 40, idleTimeoutMs: 15 });
    r = sseRes();
    hub.register(r);
  });
  afterEach(() => hub.dispose());

  it("maxAge 超限且空闲被轮换 evict", async () => {
    await pollUntil(() => hub.size() === 0); // maxAge 心跳轮换异步触发
    expect(hub.size()).toBe(0);
  });

  it("maxAge 轮换 destroy", async () => {
    await pollUntil(() => hub.size() === 0);
    expect(r.state.destroyed).toBe(true);
  });

  it("evict 原因计数 maxage=1", async () => {
    await pollUntil(() => hub.size() === 0);
    expect(hub.evictStats().maxage).toBe(1);
  });
});

describe("(g) maxAge 不误杀活跃连接（广播刷新 lastWriteAt）", () => {
  let hub: Hub;
  let r: FakeSseRes & ServerResponse;

  beforeEach(() => {
    hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 20, maxAgeMs: 40, idleTimeoutMs: 200 });
    r = sseRes();
    hub.register(r);
    for (let i = 0; i < 8; i += 1) hub.broadcast("data: x\n\n");
  });
  afterEach(() => hub.dispose());

  it("活跃连接不被 maxAge 轮换（lastWriteAt 刷新）", async () => {
    // 负向断言：活跃连接不得被 maxAge 轮换（lastWriteAt 刷新）——安静期确认
    await pollUntilQuiet(() => hub.size() === 1, 130);
    expect(hub.size()).toBe(1);
  });
});

describe("(g2) maxAge 假活动陷阱回归：仅心跳写（无业务帧）不算活动，超 maxAge 仍轮换", () => {
  let hub: Hub;
  let r: FakeSseRes & ServerResponse;

  beforeEach(() => {
    hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 15, maxAgeMs: 60, idleTimeoutMs: 30 });
    r = sseRes();
    hub.register(r);
    // 不 broadcast，仅靠心跳写（activity=false，不刷 lastWriteAt）：
    // 若心跳被误算为活动，lastWriteAt 恒新鲜 → 永不轮换（bug）。
  });
  afterEach(() => hub.dispose());

  it("仅心跳写的静默连接超 maxAge 被轮换（心跳不算活动）", async () => {
    await pollUntil(() => hub.size() === 0); // 静默连接超 maxAge+idle 被轮换
    expect(hub.size()).toBe(0);
  });

  it("假活动陷阱连接被 destroy", async () => {
    await pollUntil(() => hub.size() === 0);
    expect(r.state.destroyed).toBe(true);
  });

  it("evict 原因计数 maxage=1", async () => {
    await pollUntil(() => hub.size() === 0);
    expect(hub.evictStats().maxage).toBe(1);
  });
});

describe("(h) connHealth 观测字段（先量化再调参）", () => {
  let hub: Hub;
  let r: FakeSseRes & ServerResponse;

  beforeEach(() => {
    hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
    r = sseRes({ falseAfter: 0 });
    hub.register(r);
  });
  afterEach(() => hub.dispose());

  it("connHealth 返回 1 条", () => {
    expect(hub.connHealth().length).toBe(1);
  });

  it("ageMs 存在", () => {
    const health = hub.connHealth();
    expect(typeof health[0].ageMs === "number" && health[0].ageMs >= 0).toBeTruthy();
  });

  it("lastWriteAgoMs 存在", () => {
    expect(typeof hub.connHealth()[0].lastWriteAgoMs).toBe("number");
  });

  it("未 stalled 时 stalledMs=-1", () => {
    expect(hub.connHealth()[0].stalledMs).toBe(-1);
  });

  it("stalled 后 stalledMs>=0", () => {
    hub.broadcast("data: x\n\n"); // write false → stalled
    expect(hub.connHealth()[0].stalledMs >= 0).toBeTruthy();
  });
});

describe("(i) destroyed/writableEnded 兜底（preset destroyed → 广播即 evict）", () => {
  let hub: Hub;
  let r: FakeSseRes & ServerResponse;

  beforeEach(() => {
    hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
    r = sseRes({ presetDestroyed: true });
    hub.register(r);
  });
  afterEach(() => hub.dispose());

  it("preset destroyed 注册后仍在表（注册路径不预判）", () => {
    expect(hub.size()).toBe(1);
  });

  it("广播命中 destroyed 兜底分支立即 evict", () => {
    hub.broadcast("data: x\n\n"); // writeFrame 命中 destroyed 兜底 → 立即 evict
    expect(hub.size()).toBe(0);
  });

  it("兜底 evict 只销毁一次", () => {
    hub.broadcast("data: x\n\n");
    expect(r.state.destroyCalls).toBe(1);
  });
});

// ---- (j) 红测：dispose 统一停心跳 + destroy 全部连接 ----
// 现状：dispose() 只清心跳定时器不 destroy 连接（注释/实现不符——mcp-manager
// apply-runtime 注释承诺「hub.dispose() 统一停心跳 + destroy 全部连接」）；
// 修复：dispose 遍历连接表全部 evict（destroy）。红测断言 dispose 后连接被销毁。
describe("(j) 红测：dispose 统一停心跳 + destroy 全部连接", () => {
  let hub: Hub;
  let r1: FakeSseRes & ServerResponse;
  let r2: FakeSseRes & ServerResponse;

  beforeEach(() => {
    hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
    r1 = sseRes();
    r2 = sseRes();
    hub.register(r1);
    hub.register(r2);
  });
  afterEach(() => hub.dispose());

  it("注册 2 条连接", () => {
    expect(hub.size()).toBe(2);
  });

  it("B12：dispose 后 r1 被 destroy（现状只停心跳 → 红测）", () => {
    hub.dispose();
    expect(r1.state.destroyed).toBe(true);
  });

  it("B12：dispose 后 r2 被 destroy（现状只停心跳 → 红测）", () => {
    hub.dispose();
    expect(r2.state.destroyed).toBe(true);
  });

  it("B12：dispose 后连接表清空", () => {
    hub.dispose();
    expect(hub.size()).toBe(0);
  });
});
