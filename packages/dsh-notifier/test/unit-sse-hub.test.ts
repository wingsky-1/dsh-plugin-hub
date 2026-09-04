// @ts-nocheck
/**
 * dsh-notifier — unit：shared/sse-hub.js 共享 SSE 枢纽（#515 主动回收）。
 *
 * 覆盖（#515 方案 P0 的核心行为，独立于包装配直接测共享层）：
 * - 上限淘汰：超限收敛 + 最老被 destroy（对齐 #330 既有语义，抽取零漂移）
 * - close/error 幂等清理（多次触发只 evict 一次）
 * - 背压不误杀：write 返回 false 不立即清（对齐既有用例 (c) 锁定语义）
 * - stalled 超窗回收：write false 持续超 stalledTimeoutMs → 心跳 evict
 * - 抛错 failStreak≥3 判死（对齐原版语义）
 * - maxAge 轮换：超 maxAgeMs 且空闲 → evict；活跃连接（lastWriteAt 刷新）不误杀
 * - evictStats 原因计数 / connHealth 观测字段
 *
 * 直接 import 共享源（不经 lib 产物）：本文件测的是 shared 层模块本身。
 */
import assert from "node:assert/strict";
import { createSseHub } from "../../../shared/sse-hub.js";

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.log("FAIL:", name);
  }
}

/** 可触发 close/error、可配置 write 行为的 fake res（对齐 routes.test.ts sseRes 桩）。 */
function sseRes(opts = {}) {
  const listeners = {};
  const state = { destroyed: false, writes: 0, destroyCalls: 0 };
  if (opts.presetDestroyed) state.destroyed = true;
  return {
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
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- (a) 上限淘汰最老（对齐 #330 既有语义，抽取零漂移） ----
{
  const hub = createSseHub({ getMaxConnections: () => 2, heartbeatMs: 60_000 });
  try {
    const r1 = sseRes();
    const r2 = sseRes();
    const r3 = sseRes();
    hub.register(r1);
    hub.register(r2);
    hub.register(r3);
    ok(hub.size() === 2, "上限 2，注册 3 收敛到 2");
    ok(r1.state.destroyed === true, "最老 r1 被淘汰");
    ok(r2.state.destroyed === false && r3.state.destroyed === false, "r2/r3 保留");
    const stats = hub.evictStats();
    ok(stats.limit === 1, "evict 原因计数 limit=1");
  } finally {
    hub.dispose();
  }
}

// ---- (b) close/error 幂等清理 ----
{
  const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
  try {
    const r = sseRes();
    hub.register(r);
    r.emit("close");
    r.emit("error");
    r.emit("close");
    ok(hub.size() === 0, "close/error 多次触发只移除一次");
    ok(r.state.destroyCalls === 1, "destroy 幂等（只一次）");
  } finally {
    hub.dispose();
  }
}

// ---- (c) 背压不误杀：write 返回 false 不立即清（对齐既有用例锁定语义） ----
{
  const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000, stalledTimeoutMs: 90_000 });
  try {
    const r = sseRes({ falseAfter: 0 });
    hub.register(r);
    for (let i = 0; i < 5; i += 1) hub.broadcast("data: x\n\n");
    ok(hub.size() === 1, "5 次 write false 不立即清（背压不误杀）");
    ok(r.state.destroyed === false, "背压连接未销毁");
  } finally {
    hub.dispose();
  }
}

// ---- (d) stalled 超窗回收：write false 持续超窗 → 心跳 evict（#515 核心新增） ----
{
  const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 20, stalledTimeoutMs: 50 });
  try {
    const r = sseRes({ falseAfter: 0 });
    hub.register(r);
    hub.broadcast("data: x\n\n"); // write false → 置 stalledAt
    ok(hub.size() === 1, "背压后仍在表（未超窗）");
    await sleep(120); // 跨多心跳，超 stalledTimeoutMs
    ok(hub.size() === 0, "stalled 超窗被心跳 evict");
    ok(r.state.destroyed === true, "stalled 连接被 destroy");
    const stats = hub.evictStats();
    ok(stats.stalled === 1, "evict 原因计数 stalled=1");
  } finally {
    hub.dispose();
  }
}

// ---- (e) 抛错 failStreak≥3 判死（对齐原版语义） ----
{
  const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
  try {
    const r = sseRes({ throwAfter: 0 });
    hub.register(r);
    hub.broadcast("data: x\n\n"); // 抛错 1
    ok(hub.size() === 1, "1 次抛错不清除（防偶发误杀）");
    hub.broadcast("data: x\n\n"); // 抛错 2
    hub.broadcast("data: x\n\n"); // 抛错 3 → evict
    ok(hub.size() === 0, "连续 3 次抛错判死 evict");
    ok(r.state.destroyed === true, "判死连接被销毁");
  } finally {
    hub.dispose();
  }
}

// ---- (f) maxAge 轮换：超 maxAgeMs 且空闲 → evict（#515 核心新增） ----
{
  const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 20, maxAgeMs: 40, idleTimeoutMs: 15 });
  try {
    const r = sseRes();
    hub.register(r);
    await sleep(120); // 跨多心跳，超 maxAgeMs
    ok(hub.size() === 0, "maxAge 超限且空闲被轮换 evict");
    ok(r.state.destroyed === true, "maxAge 轮换 destroy");
    const stats = hub.evictStats();
    ok(stats.maxage === 1, "evict 原因计数 maxage=1");
  } finally {
    hub.dispose();
  }
}

// ---- (g) maxAge 不误杀活跃连接（广播刷新 lastWriteAt） ----
{
  const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 20, maxAgeMs: 40, idleTimeoutMs: 200 });
  try {
    const r = sseRes();
    hub.register(r);
    for (let i = 0; i < 8; i += 1) {
      hub.broadcast("data: x\n\n");
      await sleep(15);
    }
    ok(hub.size() === 1, "活跃连接不被 maxAge 轮换（lastWriteAt 刷新）");
  } finally {
    hub.dispose();
  }
}

// ---- (g2) maxAge 假活动陷阱回归：仅心跳写（无业务帧）不算活动，超 maxAge 仍轮换 ----
{
  const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 15, maxAgeMs: 60, idleTimeoutMs: 30 });
  try {
    const r = sseRes();
    hub.register(r);
    // 不 broadcast，仅靠心跳写（activity=false，不刷 lastWriteAt）：
    // 若心跳被误算为活动，lastWriteAt 恒新鲜 → 永不轮换（bug）。
    await sleep(200); // 跨多心跳 + 超 maxAgeMs(60) + 超 idleTimeoutMs(30)
    ok(hub.size() === 0, "仅心跳写的静默连接超 maxAge 被轮换（心跳不算活动）");
    ok(r.state.destroyed === true, "假活动陷阱连接被 destroy");
    const stats = hub.evictStats();
    ok(stats.maxage === 1, "evict 原因计数 maxage=1");
  } finally {
    hub.dispose();
  }
}

// ---- (h) connHealth 观测字段（#515 P0-1：先量化再调参） ----
{
  const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
  try {
    const r = sseRes({ falseAfter: 0 });
    hub.register(r);
    const health = hub.connHealth();
    ok(health.length === 1, "connHealth 返回 1 条");
    ok(typeof health[0].ageMs === "number" && health[0].ageMs >= 0, "ageMs 存在");
    ok(typeof health[0].lastWriteAgoMs === "number", "lastWriteAgoMs 存在");
    ok(health[0].stalledMs === -1, "未 stalled 时 stalledMs=-1");
    hub.broadcast("data: x\n\n"); // write false → stalled
    const health2 = hub.connHealth();
    ok(health2[0].stalledMs >= 0, "stalled 后 stalledMs>=0");
  } finally {
    hub.dispose();
  }
}

// ---- (i) destroyed/writableEnded 兜底（preset destroyed → 广播即 evict） ----
{
  const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
  try {
    const r = sseRes({ presetDestroyed: true });
    hub.register(r);
    ok(hub.size() === 1, "preset destroyed 注册后仍在表（注册路径不预判）");
    hub.broadcast("data: x\n\n"); // writeFrame 命中 destroyed 兜底 → 立即 evict
    ok(hub.size() === 0, "广播命中 destroyed 兜底分支立即 evict");
    ok(r.state.destroyCalls === 1, "兜底 evict 只销毁一次");
  } finally {
    hub.dispose();
  }
}

console.log(`  ok   unit-sse-hub: 共享 SSE 枢纽（#515 主动回收）${pass} 断言通过`);
if (fail > 0) {
  console.log(`  FAIL unit-sse-hub: ${fail} 断言失败`);
  process.exit(1);
}
