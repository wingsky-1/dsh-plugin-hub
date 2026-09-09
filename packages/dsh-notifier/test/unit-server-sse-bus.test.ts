// @ts-nocheck
/**
 * dsh-notifier — unit：server.ts createSseHub 业务包装直测（PR0 红测先行 5）。
 *
 * 与 unit-sse-hub.test.ts 的分工：后者直测 shared/sse-hub.js（连接表/心跳/
 * stalled/maxAge 回收——共享层）；本文件直测 notifier 业务包装（server.ts:80-121）：
 * seq 递增、600 帧 RECENT_LIMIT 滚动缓冲 shift、framesSince 补拉——这三者是
 * 共享层之外的 notifier 专属行为（#515 方案 P0 拆分后业务面），现状零直测
 * （T3-4），本文件锁定基线供 PR2 快照化重构判别。
 *
 * 缓冲与 /history 的独立性：滚动缓冲（600 帧）独立于 history jsonl（200 条
 * 截断）——本文件只测缓冲本身；跨存储独立性由 routes ?since 用例覆盖。
 */
import assert from "node:assert/strict";
// src 直连（与 unit-sse-hub 直连 shared/sse-hub.js 同姿态）：server.ts 业务包装
// 内联进 lib/index.js 无独立产物，且包导出面不含 createSseHub——src 是唯一入口。
import { createSseHub } from "../src/server.ts";

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

console.log(`dsh-notifier server-sse-bus: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
