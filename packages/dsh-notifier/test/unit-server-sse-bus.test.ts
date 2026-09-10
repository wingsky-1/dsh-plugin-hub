/**
 * dsh-notifier — unit：server.ts createSseHub 业务包装直测（红测先行）。
 *
 * 与 unit-sse-hub.test.ts 的分工：后者直测 shared/sse-hub.js（连接表/心跳/
 * stalled/maxAge 回收——共享层）；本文件直测 notifier 业务包装（server.ts:80-121）：
 * seq 递增、600 帧 RECENT_LIMIT 滚动缓冲 shift、framesSince 补拉——这三者是
 * 共享层之外的 notifier 专属行为（共享 hub 拆分后的业务面），现状零直测
 * 本文件锁定基线供快照化重构判别。
 *
 * 缓冲与 /history 的独立性：滚动缓冲（600 帧）独立于 history jsonl（200 条
 * 截断）——本文件只测缓冲本身；跨存储独立性由 routes ?since 用例覆盖。
 */
import assert from "node:assert/strict";
// src 直连（与 unit-sse-hub 直连 shared/sse-hub.js 同姿态）：server.ts 业务包装
// 内联进 lib/index.js 无独立产物，且包导出面不含 createSseHub——src 是唯一入口。
import { createSseHub } from "../src/server/interface.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.log("FAIL:", name);
  }
}

/** 轮询直到谓词成立（替代固定 sleep：防抖落盘是定时器驱动的异步终态）。 */
async function pollUntil(predicate: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---- (a) seq 递增 + framesSince 补拉 ----
{
  const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
  try {
    hub.broadcast({ type: "notify", kind: "done", title: "t1", message: "m1", ts: 1 });
    hub.broadcast({ type: "notify", kind: "done", title: "t2", message: "m2", ts: 2 });
    ok(hub.size() === 0, "无连接时 broadcast 不建连（纯入缓冲）");
    const since0 = hub.framesSince(0);
    ok(since0.length === 2, "framesSince(0) 返回全部 2 帧");
    ok(since0[0].seq === 1 && since0[1].seq === 2, "seq 从 1 递增");
    ok(since0[1].kind === "done" && since0[1].title === "t2", "帧负载原样保留");
    const since1 = hub.framesSince(1);
    ok(since1.length === 1 && since1[0].seq === 2, "framesSince(1) 只回补 seq>1 的帧");
    const since9 = hub.framesSince(9);
    ok(since9.length === 0, "framesSince 超尾返回空");
  } finally {
    hub.dispose();
  }
}

// ---- (b) RECENT_LIMIT=600 滚动缓冲 shift 边界 ----
{
  const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
  try {
    for (let i = 1; i <= 601; i += 1) hub.broadcast({ type: "notify", kind: "error", title: `t${i}`, message: "x", ts: i });
    const frames = hub.framesSince(0);
    ok(frames.length === 600, "超过 600 帧后缓冲只保留最近 600 帧");
    ok(frames[0].seq === 2, "最旧帧被 shift（首帧 seq=2）");
    ok(frames[599].seq === 601, "最新帧保留（seq=601）");
    // 补拉窗口外的 seq 不再可回放（1 已被 shift 出缓冲；2..601 共 600 帧全部保留）
    const since1 = hub.framesSince(1);
    ok(since1.length === 600 && since1[0].seq === 2, "seq=1 已出窗，补拉从 2 起（600 帧全保留）");
  } finally {
    hub.dispose();
  }
}

// ---- (c) 心跳/注册/上限淘汰委托共享 hub（转发面不丢） ----
{
  const hub = createSseHub({ getMaxConnections: () => 2, heartbeatMs: 60_000, stalledTimeoutMs: 90_000 });
  try {
    // register 面经共享 hub：仅验证转发存在性（连接管理行为由 unit-sse-hub 全覆盖）
    ok(typeof hub.register === "function" && typeof hub.size === "function", "register/size 转发共享 hub");
    ok(typeof hub.evictStats === "function" && typeof hub.connHealth === "function", "观测面转发");
    ok(typeof hub.dispose === "function", "dispose 转发");
  } finally {
    hub.dispose();
  }
}

// ---- (d) 构造时 loadSeq 续计数（缺省内存模式行为不变） ----
{
  const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000, loadSeq: () => 5, saveSeq: () => {}, seqFlushMs: 60_000 });
  try {
    hub.broadcast({ type: "notify", kind: "done", title: "t", message: "m", ts: 1 });
    ok(hub.framesSince(0)[0].seq === 6, "loadSeq=5 续计数：首帧 seq=6");
  } finally {
    hub.dispose();
  }
  const hub0 = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
  try {
    hub0.broadcast({ type: "notify", kind: "done", title: "t", message: "m", ts: 1 });
    ok(hub0.framesSince(0)[0].seq === 1, "缺省 loadSeq=0：首帧 seq=1（内存模式行为不变）");
  } finally {
    hub0.dispose();
  }
}

// ---- (e) broadcast 防抖落盘 + dispose 同步落盘（正常停止零丢失） ----
{
  // 防抖合并：注入短窗（20ms），窗口内多次广播不立即写，到点只写最新 seq
  const saves: number[] = [];
  const hub = createSseHub({
    getMaxConnections: () => 4, heartbeatMs: 60_000, saveSeq: (s) => saves.push(s), seqFlushMs: 20,
  });
  hub.broadcast({ type: "notify", kind: "done", title: "t1", message: "m", ts: 1 });
  hub.broadcast({ type: "notify", kind: "done", title: "t2", message: "m", ts: 2 });
  hub.broadcast({ type: "notify", kind: "done", title: "t3", message: "m", ts: 3 });
  ok(saves.length === 0, "防抖窗口内不立即落盘");
  await pollUntil(() => saves.length >= 1);
  ok(saves.length === 1 && saves[0] === 3, "防抖合并：窗口内多次广播只写一次最新 seq（3）");
  hub.dispose();
  // 长窗（60s）+ 立即 dispose：防抖窗口内未落盘值同步补写（正常停止零丢失）
  const saves2: number[] = [];
  const hub2 = createSseHub({
    getMaxConnections: () => 4, heartbeatMs: 60_000, saveSeq: (s) => saves2.push(s), seqFlushMs: 60_000,
  });
  hub2.broadcast({ type: "notify", kind: "done", title: "t", message: "m", ts: 1 });
  hub2.dispose();
  ok(saves2.length === 1 && saves2[0] === 1, "dispose 同步落盘：防抖窗口内未落盘的 seq 补写（零丢失）");
  // 无 saveSeq（内存模式）：broadcast + dispose 不落盘不炸
  const hub3 = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
  hub3.broadcast({ type: "notify", kind: "done", title: "t", message: "m", ts: 1 });
  hub3.dispose();
  ok(true, "内存模式 broadcast+dispose 无 saveSeq 路径正常");
}

// ---- (f) 重启仿真 hub1→dispose→hub2(loadSeq 续计数) framesSince 返回 seq6 ----
{
  const saved: number[] = [];
  const hub1 = createSseHub({
    getMaxConnections: () => 4, heartbeatMs: 60_000, loadSeq: () => 0, saveSeq: (s) => saved.push(s), seqFlushMs: 60_000,
  });
  for (let i = 0; i < 5; i += 1) {
    hub1.broadcast({ type: "notify", kind: "done", title: `t${i}`, message: "m", ts: i });
  }
  hub1.dispose();
  ok(saved.length === 1 && saved[0] === 5, "hub1 dispose 落盘 seq=5");
  const hub2 = createSseHub({
    getMaxConnections: () => 4, heartbeatMs: 60_000,
    loadSeq: () => (saved.length > 0 ? saved[saved.length - 1] : 0),
    saveSeq: () => {}, seqFlushMs: 60_000,
  });
  try {
    hub2.broadcast({ type: "notify", kind: "done", title: "t2", message: "m", ts: 99 });
    const frames = hub2.framesSince(5);
    ok(frames.length === 1 && frames[0].seq === 6, "重启后续计数：hub2 首帧 seq=6（客户端 lastSeq=5 重连不丢帧）");
  } finally {
    hub2.dispose();
  }
}

// ---- (g) loadSeq 非法值（损坏/越界/非整数）→ 回退 0 ----
{
  for (const bad of [NaN, -5, 1.9, Infinity]) {
    const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000, loadSeq: () => bad, saveSeq: () => {}, seqFlushMs: 60_000 });
    try {
      hub.broadcast({ type: "notify", kind: "done", title: "t", message: "m", ts: 1 });
      ok(hub.framesSince(0)[0].seq === 1, `loadSeq 返回 ${bad} → 回退 0（首帧 seq=1）`);
    } finally {
      hub.dispose();
    }
  }
}

console.log(`dsh-notifier server-sse-bus: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
