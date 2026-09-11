// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — e2e（SSE / seq 域）：events connected 首帧、kind=test 广播、
 * ?since 回放、SSE 连接生命周期（上限淘汰/close 幂等/背压/判死/收缩/兜底）、
 * seq 续计数与损坏回退、maxConnections 写面校验。
 *
 * 拆法：原 routes.test.ts 按功能域拆分，本文件承载「events 与 seq 生命周期」域。
 * 边界依据：这些块各自持有独立 apply 实例（连接表隔离），跨块只共享 work 下的
 * seq 文件——与原脚本顺序一致（?since 块先复位 seq，其余块无绝对 seq 断言）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier, fakeReq, makeRes } from "../helpers.ts";
import { ROUTES } from "../../src/index.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-routes-events-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** 单次路由调用（回收 rec）。 */
async function call(route, req) {
  const { rec, res } = makeRes();
  await route.handler(req, res);
  return rec;
}

/** 可触发 close/error、可配置 write 行为的 fake res（events 路由用）。 */
function sseRes(opts: any = {}) {
  const listeners: Record<string, Array<() => void>> = {};
  const state = { destroyed: false, writes: 0, destroyCalls: 0 };
  // presetDestroyed：模拟「对端已断但 close 事件漏发」的残留连接（兜底分支用）
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
    on(evt: string, cb: () => void) {
      (listeners[evt] = listeners[evt] || []).push(cb);
      return this;
    },
    emit(evt: string) {
      for (const cb of listeners[evt] || []) cb();
    },
    destroy() {
      state.destroyed = true;
      state.destroyCalls += 1; // 调用计数：区分幂等 evict 与重复销毁
    },
    get destroyed() {
      return state.destroyed;
    },
    writableEnded: false,
    socket: { setKeepAlive() {} },
  };
}

/** 独立实例路由查找（每次全新连接表）。 */
async function freshRoutes(mark: string, maxConnections: number) {
  // 配置走 settings 命名空间（configFile 仅作迁移源）：maxConnections
  // 直接经组合层 entry 注入（sanitizeSettings 白名单 → 命名空间 base 层）。
  const out = await makeNotifier(work, { maxConnections, historyFile: join(work, `sse-${mark}.jsonl`) });
  const near = (p) => out.routes.find((r) => r.path === p);
  return { ev: near(ROUTES.events), he: near(ROUTES.health), te: near(ROUTES.test), cfgR: near(ROUTES.config), dispose: out.dispose };
}

/** health 读 SSE 连接数。 */
async function connCount(he) {
  const { rec, res } = makeRes();
  await he.handler(fakeReq({}), res);
  return JSON.parse(rec.text).sseConnections;
}

describe("events SSE：connected 首帧", () => {
  let rec: any;

  beforeAll(async () => {
    const n = makeNotifier(work, { historyFile: join(work, "events-basic.jsonl") });
    try {
      const ev = n.routes.find((r) => r.path === ROUTES.events);
      rec = await call(ev, fakeReq({}));
    } finally {
      n.dispose();
    }
  });

  it("events 返回 200", () => {
    expect(rec.status).toBe(200);
  });

  it("events content-type 为 text/event-stream", () => {
    expect(rec.headers["content-type"]).toBe("text/event-stream");
  });

  it("events 首帧含 connected", () => {
    expect(rec.text).toMatch(/connected/);
  });
});

describe("test：POST 触发通知广播到已连接的 SSE 客户端", () => {
  let rec1: any;
  let rec2: any;

  beforeAll(async () => {
    const n = makeNotifier(work, { historyFile: join(work, "events-broadcast.jsonl") });
    try {
      const ev = n.routes.find((r) => r.path === ROUTES.events);
      const te = n.routes.find((r) => r.path === ROUTES.test);
      rec1 = await call(ev, fakeReq({}));
      rec2 = await call(te, fakeReq({ method: "POST" }));
    } finally {
      n.dispose();
    }
  });

  it("test 路由返回 200", () => {
    expect(rec2.status).toBe(200);
  });

  it("test 路由响应 ok=true", () => {
    expect(JSON.parse(rec2.text).ok).toBe(true);
  });

  it("SSE 客户端收到测试通知帧", () => {
    expect(rec1.text).toMatch(/测试通知/);
  });

  it("测试帧带 kind=test 标记", () => {
    expect(rec1.text).toMatch(/"kind":"test"/);
  });

  it("通知帧带递增 seq", () => {
    expect(rec1.text).toMatch(/"seq":\d+/);
  });
});

// events ?since 回放（独立上下文，seq 从 1 起）：断线补拉不丢尾部事件
// seq 持久化后本文件各实例共享 work 目录的 seq 文件，
// 先清复位保证「本块独立、seq 从 1 起」语义不变（其余块无绝对 seq 断言不受影响）
describe("events ?since 回放", () => {
  let notifyFrames: string[];
  let rec3: any;
  let rec4: any;

  beforeAll(async () => {
    rmSync(join(work, "notifier-seq.json"), { force: true });
    const notifier2 = makeNotifier(work, { historyFile: join(work, "history-since.jsonl") });
    try {
      const routes2 = notifier2.routes;
      const eventsRoute2 = routes2.find((r) => r.path === ROUTES.events);
      const testRoute2 = routes2.find((r) => r.path === ROUTES.test);
      await call(testRoute2, fakeReq({ method: "POST" })); // seq=1
      await call(testRoute2, fakeReq({ method: "POST" })); // seq=2
      // since=1 的连接：只回放 seq=2
      const rec = await call(eventsRoute2, fakeReq({ url: "/api/dsh-notifier/events?since=1" }));
      notifyFrames = rec.text.split("data: ").filter((s) => s.includes('"type":"notify"'));
      // since 超出缓冲 → 无回放，仅 connected 注释
      rec3 = await call(eventsRoute2, fakeReq({ url: "/api/dsh-notifier/events?since=99" }));
      // 非法 since 静默回退为 0
      rec4 = await call(eventsRoute2, fakeReq({ url: "/api/dsh-notifier/events?since=abc" }));
    } finally {
      notifier2.dispose();
    }
  });

  it("since=1 只回放 1 条", () => {
    expect(notifyFrames.length).toBe(1);
  });

  it("回放帧带正确 seq", () => {
    expect(notifyFrames[0]).toMatch(/"seq":2/);
  });

  it("since 超出无回放", () => {
    expect(!rec3.text.includes('"type":"notify"')).toBeTruthy();
  });

  it("非法 since 按 0 处理", () => {
    expect(!rec4.text.includes('"type":"notify"')).toBeTruthy();
  });
});

// SSE 连接生命周期：上限淘汰最老 / close+error 幂等清理 /
// write-false 背压不误杀 / 写失败连续 3 次判死 / 配置改小实时生效（下次注册收缩）。
// 每个场景独立 makeNotifier 实例（隔离连接表，防跨块串扰）。
describe("SSE 生命周期 (a) 上限淘汰最老", () => {
  let c: Record<string, number>;
  let r1: any;
  let r2: any;
  let r3: any;

  let disposeFn: () => void;

  beforeAll(async () => {
    const { ev, he, dispose } = await freshRoutes("a", 2);
    disposeFn = dispose;
    {
      r1 = sseRes();
      r2 = sseRes();
      r3 = sseRes();
      await ev.handler(fakeReq({}), r1);
      await ev.handler(fakeReq({}), r2);
      await ev.handler(fakeReq({}), r3);
      c = { conns: await connCount(he) };
    }
  });

  it("注册 3 条超上限，连接数收敛到 2", () => {
    expect(c.conns).toBe(2);
  });

  it("最老连接被 destroy（淘汰）", () => {
    expect(r1.state.destroyed).toBe(true);
  });

  it("较新连接保留", () => {
    expect(r2.state.destroyed).toBe(false);
  });

  it("最新连接保留", () => {
    expect(r3.state.destroyed).toBe(false);
  });

  it("淘汰只销毁一次（evict 幂等）", () => {
    expect(r1.state.destroyCalls).toBe(1);
  });

  afterAll(() => disposeFn());
});

describe("SSE 生命周期 (b) close/error 幂等清理", () => {
  let c: { afterRegister: number; afterClose: number };
  let r: any;

  let disposeFn: () => void;

  beforeAll(async () => {
    const { ev, he, dispose } = await freshRoutes("b", 4);
    disposeFn = dispose;
    {
      r = sseRes();
      await ev.handler(fakeReq({}), r);
      const afterRegister = await connCount(he);
      r.emit("close");
      r.emit("error");
      r.emit("close"); // 重复触发，幂等
      c = { afterRegister, afterClose: await connCount(he) };
    }
  });

  it("注册后连接数为 1", () => {
    expect(c.afterRegister).toBe(1);
  });

  it("close/error 多次触发只移除一次", () => {
    expect(c.afterClose).toBe(0);
  });

  it("close 后连接被销毁", () => {
    expect(r.state.destroyed).toBe(true);
  });

  it("幂等：close/error/close 只触发一次 destroy", () => {
    expect(r.state.destroyCalls).toBe(1);
  });

  afterAll(() => disposeFn());
});

describe("SSE 生命周期 (c) write 返回 false（背压）不误杀", () => {
  let c: { conns: number };
  let r: any;

  let disposeFn: () => void;

  beforeAll(async () => {
    const { ev, he, te, dispose } = await freshRoutes("c", 4);
    disposeFn = dispose;
    {
      r = sseRes({ falseAfter: 1 }); // 初始 connected 写成功，之后均返回 false
      await ev.handler(fakeReq({}), r);
      for (let i = 0; i < 5; i += 1) await te.handler(fakeReq({ method: "POST" }), makeRes().res);
      c = { conns: await connCount(he) };
    }
  });

  it("write 返回 false 视为背压，5 次广播不误杀", () => {
    expect(c.conns).toBe(1);
  });

  it("背压连接未被销毁", () => {
    expect(r.state.destroyed).toBe(false);
  });

  afterAll(() => disposeFn());
});

describe("SSE 生命周期 (d) 写失败连续 3 次判死", () => {
  let c: { afterTwo: number; afterThree: number };
  let r: any;

  let disposeFn: () => void;

  beforeAll(async () => {
    const { ev, he, te, dispose } = await freshRoutes("d", 4);
    disposeFn = dispose;
    {
      r = sseRes({ throwAfter: 1 }); // 初始 connected 写成功，之后每次写抛错
      await ev.handler(fakeReq({}), r);
      await te.handler(fakeReq({ method: "POST" }), makeRes().res); // failStreak=1
      await te.handler(fakeReq({ method: "POST" }), makeRes().res); // failStreak=2
      const afterTwo = await connCount(he);
      await te.handler(fakeReq({ method: "POST" }), makeRes().res); // failStreak=3 → 销毁
      c = { afterTwo, afterThree: await connCount(he) };
    }
  });

  it("连续 2 次写失败未达阈值，连接保留", () => {
    expect(c.afterTwo).toBe(1);
  });

  it("连续 3 次写失败判死销毁", () => {
    expect(c.afterThree).toBe(0);
  });

  it("判死连接被销毁", () => {
    expect(r.state.destroyed).toBe(true);
  });

  afterAll(() => disposeFn());
});

describe("SSE 生命周期 (e) maxConnections 配置改小实时生效", () => {
  let c: { registered: number; putOk: boolean; userMax: number; shrunk: number };
  let r1: any;
  let r2: any;
  let r4: any;

  let disposeFn: () => void;

  beforeAll(async () => {
    const { ev, he, cfgR, dispose } = await freshRoutes("e", 16);
    disposeFn = dispose;
    {
      r1 = sseRes();
      const r2x = sseRes();
      const r3 = sseRes();
      r2 = r2x;
      await ev.handler(fakeReq({}), r1);
      await ev.handler(fakeReq({}), r2);
      await ev.handler(fakeReq({}), r3);
      const registered = await connCount(he);
      // PUT {patch:{maxConnections:2}} → settings user 层
      const text = JSON.stringify({ patch: { maxConnections: 2 } });
      const putReq = {
        method: "PUT",
        url: "/",
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
        on(event, cb) {
          if (event === "data") setTimeout(() => cb(Buffer.from(text)), 0);
          else if (event === "end") setTimeout(cb, 1);
          return this;
        },
        destroy() {},
      };
      const rec = await call(cfgR, putReq);
      // 新注册触发 enforceLimit → 收缩到 2（淘汰最老 r1、r2）
      r4 = sseRes();
      await ev.handler(fakeReq({}), r4);
      c = {
        registered,
        putOk: JSON.parse(rec.text).ok,
        userMax: JSON.parse(rec.text).user.maxConnections,
        shrunk: await connCount(he),
      };
    }
  });

  it("默认上限 16 下注册 3 条不淘汰", () => {
    expect(c.registered).toBe(3);
  });

  it("PUT 后配置生效", () => {
    expect(c.putOk).toBe(true);
  });

  it("PUT 写 settings user 层", () => {
    expect(c.userMax).toBe(2);
  });

  it("配置改小后下次注册即收缩到新上限 2", () => {
    expect(c.shrunk).toBe(2);
  });

  it("最老连接被淘汰", () => {
    expect(r1.state.destroyed).toBe(true);
  });

  it("次老连接同样被淘汰（收缩到上限 2）", () => {
    expect(r2.state.destroyed).toBe(true);
  });

  it("新注册保留", () => {
    expect(r4.state.destroyed).toBe(false);
  });

  afterAll(() => disposeFn());
});

describe("SSE 生命周期 (f) destroyed/writableEnded 兜底分支", () => {
  let c: { afterRegister: number; afterBroadcast: number };
  let r: any;

  let disposeFn: () => void;

  beforeAll(async () => {
    const { ev, he, te, dispose } = await freshRoutes("f", 4);
    disposeFn = dispose;
    {
      r = sseRes({ presetDestroyed: true }); // 对端已断但 close 事件漏发的残留
      await ev.handler(fakeReq({}), r);
      const afterRegister = await connCount(he);
      await te.handler(fakeReq({ method: "POST" }), makeRes().res); // 广播 → writeFrame 命中兜底分支
      c = { afterRegister, afterBroadcast: await connCount(he) };
    }
  });

  it("preset destroyed 注册后仍在表（注册路径不做预判）", () => {
    expect(c.afterRegister).toBe(1);
  });

  it("广播命中 destroyed 兜底分支，立即 evict", () => {
    expect(c.afterBroadcast).toBe(0);
  });

  it("兜底分支销毁连接", () => {
    expect(r.state.destroyed).toBe(true);
  });

  it("兜底 evict 只销毁一次", () => {
    expect(r.state.destroyCalls).toBe(1);
  });

  afterAll(() => disposeFn());
});

// 服务端重启后 seq 续计数——已打开页面重连不丢帧。
// 独立子目录隔离 seq 文件（防与其余实例共用 work/notifier-seq.json 的多写者
// 串扰——生产单实例单进程无此问题，测试多实例需各归其位）。
describe("N-22：服务端重启后 seq 续计数", () => {
  let rec: any;

  beforeAll(async () => {
    const n22Dir = join(work, "n22");
    mkdirSync(n22Dir, { recursive: true });
    const shared = { historyFile: join(n22Dir, "history.jsonl"), statusFile: join(n22Dir, "status.json") };
    // hub1：5 条测试通知广播（seq 1..5）
    const n1 = makeNotifier(work, shared);
    const test1 = n1.routes.find((r) => r.path === ROUTES.test);
    for (let i = 0; i < 5; i += 1) {
      await test1.handler(fakeReq({ method: "POST" }), makeRes().res);
    }
    n1.dispose(); // 正常停止：dispose 同步落盘 seq=5（零丢失）
    // hub2 重启：loadSeq=5 → 新广播 seq=6（> 已打开页面 lastSeq=5，客户端
    // 判重 data.seq <= lastSeq 不丢弃；修复前重启归零 → seq=1 → 永久静默）
    const n2 = makeNotifier(work, shared);
    const events2 = n2.routes.find((r) => r.path === ROUTES.events);
    const test2 = n2.routes.find((r) => r.path === ROUTES.test);
    rec = await call(events2, fakeReq({ url: "/api/dsh-notifier/events?since=5" }));
    await test2.handler(fakeReq({ method: "POST" }), makeRes().res);
    n2.dispose();
  });

  it("N-22：重启后新广播帧 seq=6（续计数，lastSeq=5 的页面不丢帧）", () => {
    expect(rec.text).toMatch(/"seq":6/);
  });
});

// 级联场景：seq 文件损坏/缺文件 → 回退 0（损坏 warn + 首帧 seq=1；缺文件
// = 首启静默无 warn）
describe("TDD④：seq 文件损坏回退与缺文件首启", () => {
  let c: { corruptSeq: boolean; corruptWarn: boolean; missingSeq: boolean; missingWarn: boolean };

  beforeAll(async () => {
    const n22bDir = join(work, "n22b");
    mkdirSync(n22bDir, { recursive: true });
    const shared = { historyFile: join(n22bDir, "history.jsonl"), statusFile: join(n22bDir, "status.json") };
    writeFileSync(join(n22bDir, "notifier-seq.json"), "{corrupt", "utf8");
    const warns: string[] = [];
    const n3 = makeNotifier(work, shared, { logger: { warn: (m) => warns.push(m), info: () => {} } });
    const events3 = n3.routes.find((r) => r.path === ROUTES.events);
    const test3 = n3.routes.find((r) => r.path === ROUTES.test);
    const rec = await call(events3, fakeReq({}));
    await test3.handler(fakeReq({ method: "POST" }), makeRes().res);
    const corruptSeq = /"seq":1/.test(rec.text);
    const corruptWarn = warns.some((w) => w.includes("seq"));
    n3.dispose();
    // 缺文件（首启）：静默回退 0，不 warn
    rmSync(join(n22bDir, "notifier-seq.json"), { force: true });
    const warns4: string[] = [];
    const n4 = makeNotifier(work, shared, { logger: { warn: (m) => warns4.push(m), info: () => {} } });
    const events4 = n4.routes.find((r) => r.path === ROUTES.events);
    const test4 = n4.routes.find((r) => r.path === ROUTES.test);
    const rec4 = await call(events4, fakeReq({}));
    await test4.handler(fakeReq({ method: "POST" }), makeRes().res);
    c = {
      corruptSeq,
      corruptWarn,
      missingSeq: /"seq":1/.test(rec4.text),
      missingWarn: warns4.some((w) => w.includes("seq")),
    };
    n4.dispose();
  });

  it("TDD④：seq 文件损坏 → 回退 0（首帧 seq=1）", () => {
    expect(c.corruptSeq).toBeTruthy();
  });

  it("TDD④：损坏回退有 warn 日志", () => {
    expect(c.corruptWarn).toBeTruthy();
  });

  it("TDD④：seq 文件缺失（首启）→ 从 0 起", () => {
    expect(c.missingSeq).toBeTruthy();
  });

  it("TDD④：缺文件不 warn（首启正常路径）", () => {
    expect(c.missingWarn).toBe(false);
  });
});

// 服务端侧不变锁：maxConnections:0 → 400（客户端 clamp 是唯一守卫；
// 服务端写面校验现状正确勿动——防未来"顺手放宽"回归）
describe("N-23：maxConnections:0 → 400（服务端写面校验不变）", () => {
  let rec: any;

  beforeAll(async () => {
    const n23 = makeNotifier(work, { historyFile: join(work, "history-n23.jsonl") });
    try {
      const cfgN23 = n23.routes.find((r) => r.path === ROUTES.config);
      const text = JSON.stringify({ patch: { maxConnections: 0 } });
      rec = await call(cfgN23, {
        method: "PUT",
        url: "/",
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
        on(event, cb) {
          if (event === "data") setTimeout(() => cb(Buffer.from(text)), 0);
          else if (event === "end") setTimeout(cb, 1);
          return this;
        },
        destroy() {},
      });
    } finally {
      n23.dispose();
    }
  });

  it("N-23：maxConnections:0 → 400（服务端写面校验不变，客户端 clamp 是唯一守卫）", () => {
    expect(rec.status).toBe(400);
  });

  it("N-23：400 hint 提示 1-1024 范围", () => {
    expect(JSON.parse(rec.text).error.hint.includes("1-1024")).toBeTruthy();
  });
});
