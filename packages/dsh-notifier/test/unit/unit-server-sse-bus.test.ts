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
// src 直连（与 unit-sse-hub 直连 shared/sse-hub.js 同姿态）：server.ts 业务包装
// 内联进 lib/index.js 无独立产物，且包导出面不含 createSseHub——src 是唯一入口。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSseHub } from "../../src/server/interface.ts";

type Hub = ReturnType<typeof createSseHub>;

/** 轮询直到谓词成立（替代固定 sleep：防抖落盘是定时器驱动的异步终态）。 */
async function pollUntil(predicate: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("(a) seq 递增 + framesSince 补拉", () => {
  let hub: Hub;

  beforeEach(() => {
    hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
    hub.broadcast({ type: "notify", kind: "done", title: "t1", message: "m1", ts: 1 });
    hub.broadcast({ type: "notify", kind: "done", title: "t2", message: "m2", ts: 2 });
  });
  afterEach(() => hub.dispose());

  it("无连接时 broadcast 不建连（纯入缓冲）", () => {
    expect(hub.size()).toBe(0);
  });

  it("framesSince(0) 返回全部 2 帧", () => {
    expect(hub.framesSince(0).length).toBe(2);
  });

  it("seq 从 1 递增", () => {
    const since0 = hub.framesSince(0);
    expect(since0[0].seq === 1 && since0[1].seq === 2).toBeTruthy();
  });

  it("帧负载原样保留", () => {
    const since0 = hub.framesSince(0);
    expect(since0[1].kind === "done" && since0[1].title === "t2").toBeTruthy();
  });

  it("framesSince(1) 只回补 seq>1 的帧", () => {
    const since1 = hub.framesSince(1);
    expect(since1.length === 1 && since1[0].seq === 2).toBeTruthy();
  });

  it("framesSince 超尾返回空", () => {
    expect(hub.framesSince(9).length).toBe(0);
  });
});

describe("(b) RECENT_LIMIT=600 滚动缓冲 shift 边界", () => {
  let hub: Hub;

  beforeEach(() => {
    hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
    for (let i = 1; i <= 601; i += 1) hub.broadcast({ type: "notify", kind: "error", title: `t${i}`, message: "x", ts: i });
  });
  afterEach(() => hub.dispose());

  it("超过 600 帧后缓冲只保留最近 600 帧", () => {
    expect(hub.framesSince(0).length).toBe(600);
  });

  it("最旧帧被 shift（首帧 seq=2）", () => {
    expect(hub.framesSince(0)[0].seq).toBe(2);
  });

  it("最新帧保留（seq=601）", () => {
    expect(hub.framesSince(0)[599].seq).toBe(601);
  });

  it("seq=1 已出窗，补拉从 2 起（600 帧全保留）", () => {
    // 补拉窗口外的 seq 不再可回放（1 已被 shift 出缓冲；2..601 共 600 帧全部保留）
    const since1 = hub.framesSince(1);
    expect(since1.length === 600 && since1[0].seq === 2).toBeTruthy();
  });
});

describe("(c) 心跳/注册/上限淘汰委托共享 hub（转发面不丢）", () => {
  let hub: Hub;

  beforeEach(() => {
    hub = createSseHub({ getMaxConnections: () => 2, heartbeatMs: 60_000, stalledTimeoutMs: 90_000 });
  });
  afterEach(() => hub.dispose());

  it("register/size 转发共享 hub", () => {
    // register 面经共享 hub：仅验证转发存在性（连接管理行为由 unit-sse-hub 全覆盖）
    expect(typeof hub.register === "function" && typeof hub.size === "function").toBeTruthy();
  });

  it("观测面转发", () => {
    expect(typeof hub.evictStats === "function" && typeof hub.connHealth === "function").toBeTruthy();
  });

  it("dispose 转发", () => {
    expect(typeof hub.dispose === "function").toBeTruthy();
  });
});

describe("(d) 构造时 loadSeq 续计数（缺省内存模式行为不变）", () => {
  it("loadSeq=5 续计数：首帧 seq=6", () => {
    const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000, loadSeq: () => 5, saveSeq: () => {}, seqFlushMs: 60_000 });
    try {
      hub.broadcast({ type: "notify", kind: "done", title: "t", message: "m", ts: 1 });
      expect(hub.framesSince(0)[0].seq).toBe(6);
    } finally {
      hub.dispose();
    }
  });

  it("缺省 loadSeq=0：首帧 seq=1（内存模式行为不变）", () => {
    const hub0 = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
    try {
      hub0.broadcast({ type: "notify", kind: "done", title: "t", message: "m", ts: 1 });
      expect(hub0.framesSince(0)[0].seq).toBe(1);
    } finally {
      hub0.dispose();
    }
  });
});

describe("(e) broadcast 防抖落盘 + dispose 同步落盘（正常停止零丢失）", () => {
  it("防抖窗口内不立即落盘", () => {
    // 防抖合并：注入短窗（20ms），窗口内多次广播不立即写，到点只写最新 seq
    const saves: number[] = [];
    const hub = createSseHub({
      getMaxConnections: () => 4, heartbeatMs: 60_000, saveSeq: (s) => saves.push(s), seqFlushMs: 20,
    });
    try {
      hub.broadcast({ type: "notify", kind: "done", title: "t1", message: "m", ts: 1 });
      hub.broadcast({ type: "notify", kind: "done", title: "t2", message: "m", ts: 2 });
      hub.broadcast({ type: "notify", kind: "done", title: "t3", message: "m", ts: 3 });
      expect(saves.length).toBe(0);
    } finally {
      hub.dispose();
    }
  });

  it("防抖合并：窗口内多次广播只写一次最新 seq（3）", async () => {
    const saves: number[] = [];
    const hub = createSseHub({
      getMaxConnections: () => 4, heartbeatMs: 60_000, saveSeq: (s) => saves.push(s), seqFlushMs: 20,
    });
    try {
      hub.broadcast({ type: "notify", kind: "done", title: "t1", message: "m", ts: 1 });
      hub.broadcast({ type: "notify", kind: "done", title: "t2", message: "m", ts: 2 });
      hub.broadcast({ type: "notify", kind: "done", title: "t3", message: "m", ts: 3 });
      await pollUntil(() => saves.length >= 1);
      expect(saves.length === 1 && saves[0] === 3).toBeTruthy();
    } finally {
      hub.dispose();
    }
  });

  it("dispose 同步落盘：防抖窗口内未落盘的 seq 补写（零丢失）", () => {
    // 长窗（60s）+ 立即 dispose：防抖窗口内未落盘值同步补写（正常停止零丢失）
    const saves2: number[] = [];
    const hub2 = createSseHub({
      getMaxConnections: () => 4, heartbeatMs: 60_000, saveSeq: (s) => saves2.push(s), seqFlushMs: 60_000,
    });
    hub2.broadcast({ type: "notify", kind: "done", title: "t", message: "m", ts: 1 });
    hub2.dispose();
    expect(saves2.length === 1 && saves2[0] === 1).toBeTruthy();
  });

  it("内存模式 broadcast+dispose 无 saveSeq 路径正常", () => {
    // 无 saveSeq（内存模式）：broadcast + dispose 不落盘不炸
    const hub3 = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
    expect(() => {
      hub3.broadcast({ type: "notify", kind: "done", title: "t", message: "m", ts: 1 });
      hub3.dispose();
    }).not.toThrow();
  });
});

describe("(f) 重启仿真 hub1→dispose→hub2(loadSeq 续计数) framesSince 返回 seq6", () => {
  it("hub1 dispose 落盘 seq=5", () => {
    const saved: number[] = [];
    const hub1 = createSseHub({
      getMaxConnections: () => 4, heartbeatMs: 60_000, loadSeq: () => 0, saveSeq: (s) => saved.push(s), seqFlushMs: 60_000,
    });
    for (let i = 0; i < 5; i += 1) {
      hub1.broadcast({ type: "notify", kind: "done", title: `t${i}`, message: "m", ts: i });
    }
    hub1.dispose();
    expect(saved.length === 1 && saved[0] === 5).toBeTruthy();
  });

  it("重启后续计数：hub2 首帧 seq=6（客户端 lastSeq=5 重连不丢帧）", () => {
    const saved: number[] = [];
    const hub1 = createSseHub({
      getMaxConnections: () => 4, heartbeatMs: 60_000, loadSeq: () => 0, saveSeq: (s) => saved.push(s), seqFlushMs: 60_000,
    });
    for (let i = 0; i < 5; i += 1) {
      hub1.broadcast({ type: "notify", kind: "done", title: `t${i}`, message: "m", ts: i });
    }
    hub1.dispose();
    const hub2 = createSseHub({
      getMaxConnections: () => 4, heartbeatMs: 60_000,
      loadSeq: () => (saved.length > 0 ? saved[saved.length - 1] : 0),
      saveSeq: () => {}, seqFlushMs: 60_000,
    });
    try {
      hub2.broadcast({ type: "notify", kind: "done", title: "t2", message: "m", ts: 99 });
      const frames = hub2.framesSince(5);
      expect(frames.length === 1 && frames[0].seq === 6).toBeTruthy();
    } finally {
      hub2.dispose();
    }
  });
});

describe("(g) loadSeq 非法值（损坏/越界/非整数）→ 回退 0", () => {
  for (const bad of [NaN, -5, 1.9, Infinity]) {
    it(`loadSeq 返回 ${bad} → 回退 0（首帧 seq=1）`, () => {
      const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000, loadSeq: () => bad, saveSeq: () => {}, seqFlushMs: 60_000 });
      try {
        hub.broadcast({ type: "notify", kind: "done", title: "t", message: "m", ts: 1 });
        expect(hub.framesSince(0)[0].seq).toBe(1);
      } finally {
        hub.dispose();
      }
    });
  }
});

// #733 M1-F2：dispose 顺序要求「sse.dispose() 最前」，而 ctx.effect 的 disposer
// 在某些生命周期路径下可能被重复触发——dispose 必须幂等（重复调用不重复落盘、
// 不抛错），否则「正常停止零丢失」会退化为「重复补写」或卸载期异常。
describe("(j) dispose 幂等（重复调用不重复落盘、不抛错）", () => {
  it("连续两次 dispose：saveSeq 只被调用一次（seqDirty 已清）", () => {
    const saves: number[] = [];
    const hub = createSseHub({
      getMaxConnections: () => 4, heartbeatMs: 60_000, saveSeq: (s) => saves.push(s), seqFlushMs: 60_000,
    });
    hub.broadcast({ type: "notify", kind: "done", title: "t", message: "m", ts: 1 });
    hub.dispose();
    hub.dispose();
    expect(saves).toEqual([1]);
  });

  it("连续三次 dispose 不抛错", () => {
    const hub = createSseHub({
      getMaxConnections: () => 4, heartbeatMs: 60_000, saveSeq: () => {}, seqFlushMs: 60_000,
    });
    hub.broadcast({ type: "notify", kind: "done", title: "t", message: "m", ts: 1 });
    expect(() => {
      hub.dispose();
      hub.dispose();
      hub.dispose();
    }).not.toThrow();
  });

  it("无未落盘变更时 dispose 不触发 saveSeq（重复 dispose 的零写路径）", () => {
    const saves: number[] = [];
    const hub = createSseHub({
      getMaxConnections: () => 4, heartbeatMs: 60_000, saveSeq: (s) => saves.push(s), seqFlushMs: 60_000,
    });
    hub.dispose();
    hub.dispose();
    expect(saves).toEqual([]);
  });

  it("内存模式（无 saveSeq）重复 dispose 不抛错", () => {
    const hub = createSseHub({ getMaxConnections: () => 4, heartbeatMs: 60_000 });
    hub.broadcast({ type: "notify", kind: "done", title: "t", message: "m", ts: 1 });
    expect(() => {
      hub.dispose();
      hub.dispose();
    }).not.toThrow();
  });

  it("dispose 后 framesSince 仍可读（滚动缓冲不随 dispose 清空，?since 补拉语义不变）", () => {
    const hub = createSseHub({
      getMaxConnections: () => 4, heartbeatMs: 60_000, saveSeq: () => {}, seqFlushMs: 60_000,
    });
    hub.broadcast({ type: "notify", kind: "done", title: "t", message: "m", ts: 1 });
    hub.dispose();
    expect(hub.framesSince(0).length).toBe(1);
  });
});
