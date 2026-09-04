// @ts-nocheck
/**
 * dsh-mcp-manager — unit：SSE 推送帧 / 健康检查 / 路由边界补齐。
 *
 * 覆盖：
 * - sseData / uiConfigChangedFrame 帧格式
 * - broadcastFrame：空集合、正常写、单连接抛错吞掉继续广播其余
 * - events 路由：403 围栏 / 405 / writeHead 头 / 连接登记与 close 清理
 * - health 路由：403 / 405 / 计数聚合
 * - servers PATCH|DELETE 缺 name 400、未知 method 405
 * - session 路由：body 校验 400、cwd 切换 200
 * - import/json：缺 json 字段 400、同名 skip 与 overwrite 更新
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callHandler, pollUntil, assertNoGrowth } from "./helpers.ts";

const {
  makeRoutes,
  makeEventsRoute,
  makeHealthRoute,
  sseData,
  uiConfigChangedFrame,
  broadcastFrame,
  ROUTES,
  McpStore,
  McpManager,
  normalizeServer,
  SSE_HEARTBEAT_MS,
  SSE_PING_FRAME,
} = await import("../lib/index.js");

// ---- 帧格式 ----

{
  const frame = sseData({ a: 1 });
  assert.equal(frame, 'data: {"a":1}\n\n');
  assert.equal(uiConfigChangedFrame(), 'data: {"type":"ui-config-changed"}\n\n');
}

// ---- broadcastFrame ----

{
  broadcastFrame(undefined, "data: x\n\n");
  const written = [];
  const boom = { write: () => { throw new Error("EPIPE"); } };
  const good1 = { write: (f) => written.push(["g1", f]) };
  const good2 = { write: (f) => written.push(["g2", f]) };
  assert.doesNotThrow(() => broadcastFrame(new Set([boom, good1, good2]), "f1"), "单连接断开不影响其余");
  assert.deepEqual(written.map((x) => x[0]), ["g1", "g2"]);
}

// ---- fake req/res 工具 ----

const fakeReq = (method, url, body, opts = {}) => ({
  method,
  url,
  socket: { remoteAddress: opts.remote ?? "127.0.0.1" },
  headers: { host: "localhost:3080", origin: "http://localhost:3080", "sec-fetch-site": "same-origin" },
  async *[Symbol.asyncIterator]() {
    if (body !== undefined) yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  },
  on: () => {},
});

const fakeRes = () => {
  const state = { status: 200, body: "", headers: {}, destroyed: false, writableEnded: false };
  return {
    state,
    // routes.ts 心跳回调读 res.destroyed / res.writableEnded 判定自愈清理。
    get destroyed() {
      return state.destroyed;
    },
    get writableEnded() {
      return state.writableEnded;
    },
    writeHead: (s, h) => {
      state.status = s;
      state.headers = h ?? {};
    },
    write: (chunk) => {
      state.body += chunk.toString();
    },
    end: (chunk) => {
      if (chunk) state.body += chunk.toString();
      state.writableEnded = true;
    },
    setHeader: () => {},
    on: (event, cb) => {
      if (event === "close") state.onClose = cb;
    },
    destroy: () => {
      state.destroyed = true;
    },
  };
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-sse-"));
  const store = new McpStore(join(dir, "mcp.json"));
  store.data = { version: 1, servers: [] };
  store.upsert(normalizeServer({ name: "dup-a", transport: "stdio", command: "echo" }));
  const manager = new McpManager({ logger: { warn: () => {}, info: () => {}, error: () => {} } }, store);
  manager.catalogCache.set("cached", { summary: "s" });
  return { dir, store, manager };
}

const loopbackMethods = ["GET", "POST"];

// ---- events 路由 ----

{
  const { dir, manager } = setup();
  try {
    const route = makeEventsRoute(manager);
    // 非 loopback → 403。
    const resForeign = fakeRes();
    route.handler(fakeReq("GET", ROUTES.events, undefined, { remote: "8.8.8.8" }), resForeign);
    assert.equal(resForeign.state.status, 403);
    assert.match(resForeign.state.body, /loopback-only/);
    // 非 GET → 405。
    const resWrongMethod = fakeRes();
    route.handler(fakeReq("POST", ROUTES.events), resWrongMethod);
    assert.equal(resWrongMethod.state.status, 405);
    // 成功订阅：头、初始帧、登记。
    const resOk = fakeRes();
    route.handler(fakeReq("GET", ROUTES.events), resOk);
    assert.equal(resOk.state.status, 200);
    assert.equal(resOk.state.headers["content-type"], "text/event-stream");
    assert.ok(resOk.state.body.startsWith(": connected"));
    assert.equal(manager.sseHub?.size(), 1, "连接已登记（hub 惰性创建）");
    // 广播经 onStatus 到达已登记连接（apply 内即此组合）。
    // emitStatus 是 coalesce 异步（setTimeout 0），需等待宏任务落定。
    let frames = 0;
    resOk.write = () => {
      frames += 1;
    };
    const unsubscribe = manager.onStatus(() => {
      manager.sseHub?.broadcast(sseData({ type: "summary" }));
    });
    manager.emitStatus();
    // emitStatus 是 coalesce 异步（setTimeout 0）：轮询等广播落定（事件驱动替代固定 sleep）。
    await pollUntil("广播落定 frames===1", () => frames === 1);
    // close 注销。
    resOk.state.onClose();
    assert.equal(manager.sseHub?.size(), 0, "close 后注销");
    // 二次广播应执行但不再写帧（连接已注销）——哨兵确认广播落定后断言帧数不变。
    let landed = 0;
    const offSentinel = manager.onStatus(() => {
      landed += 1;
    });
    manager.emitStatus();
    await pollUntil("二次广播落定", () => landed >= 1);
    offSentinel();
    assert.equal(frames, 1, "close 注销后广播不再写帧");
    unsubscribe();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- #515：mcp 补齐连接上限 + 淘汰（对齐 notifier；取代旧裸 Set 无上限） ----

{
  const { dir, manager } = setup();
  try {
    // 上限 2：注册 3 条 → 最老被淘汰，表收敛 2。
    const route = makeEventsRoute(manager, { heartbeatMs: 60_000, maxConnections: 2 });
    const r1 = fakeRes();
    const r2 = fakeRes();
    const r3 = fakeRes();
    route.handler(fakeReq("GET", ROUTES.events), r1);
    route.handler(fakeReq("GET", ROUTES.events), r2);
    route.handler(fakeReq("GET", ROUTES.events), r3);
    assert.equal(manager.sseHub?.size(), 2, "上限 2，注册 3 收敛到 2");
    assert.equal(r1.state.destroyed, true, "最老 r1 被淘汰 destroy");
    assert.equal(r2.state.destroyed, false, "r2 保留");
    assert.equal(r3.state.destroyed, false, "r3 保留");
    const stats = manager.sseHub?.evictStats();
    assert.equal(stats?.limit, 1, "evict 原因计数 limit=1");
  } finally {
    manager.sseHub?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- SSE 心跳（#268）：data ping 帧 / 间隔常量 / close 与卸载 disposer 清理 ----

const countPing = (res) => (res.state.body.match(/data: \{"type":"ping"\}/g) ?? []).length;

{
  // 常量契约：间隔对齐 dsh-notifier HEARTBEAT_MS（30s）；心跳必须是 data 帧而非
  // 注释帧——注释帧不触发客户端 onmessage，watchdog 无失活信号可依。
  assert.equal(SSE_HEARTBEAT_MS, 30_000, "心跳间隔 30s（对齐 notifier）");
  assert.equal(SSE_PING_FRAME, 'data: {"type":"ping"}\n\n', "心跳为 data ping 帧");

  const { dir, manager } = setup();
  try {
    const route = makeEventsRoute(manager, { heartbeatMs: 10 });
    const res = fakeRes();
    route.handler(fakeReq("GET", ROUTES.events), res);
    assert.equal(manager.sseHub?.size(), 1, "连接已登记（hub）");
    // 等心跳帧到达阈值（事件驱动轮询替代固定 sleep 等后台数据）。
    await pollUntil("心跳 data ping 帧到达", () => countPing(res) >= 1);
    const pingsAtClose = countPing(res);
    // close：hub 内部 evict（出表 + 停对该连接写心跳），此后不再有新帧。
    res.state.onClose();
    assert.equal(manager.sseHub?.size(), 0, "close 后注销");
    await assertNoGrowth("close 后心跳停止", () => countPing(res), pingsAtClose);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // 卸载路径：插件 disposer 显式执行全部 cleanups（index.ts apply 清理同款），
  // 不依赖 res.destroy() 触发 close 的异步时序。
  const { dir, manager } = setup();
  try {
    const route = makeEventsRoute(manager, { heartbeatMs: 10 });
    const resA = fakeRes();
    const resB = fakeRes();
    route.handler(fakeReq("GET", ROUTES.events), resA);
    route.handler(fakeReq("GET", ROUTES.events), resB);
    assert.equal(manager.sseHub?.size(), 2, "两条连接已登记");
    // 卸载路径：hub.dispose() 统一停心跳 + destroy 全部连接（apply disposer 同款），
    // 不依赖 res.destroy() 触发 close 的异步时序。
    const hub = manager.sseHub;
    hub?.dispose();
    // dispose 后 hub 仍可用（destroy 由 dispose 语义外/或调用方负责）——此处模拟
    // apply disposer 语义：dispose 停心跳；连接由 register 的 close 清理或路由卸载 destroy。
    await assertNoGrowth("dispose 后连接 A 心跳停止", () => countPing(resA), 0);
    await assertNoGrowth("dispose 后连接 B 心跳停止", () => countPing(resB), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // 自愈路径：destroy() 后（模拟 close 事件丢失的极端场景）下一跳心跳看到
  // destroyed 即自杀清理——不再写帧，且从 disposer 注册表自删。
  const { dir, manager } = setup();
  try {
    const route = makeEventsRoute(manager, { heartbeatMs: 10 });
    const res = fakeRes();
    route.handler(fakeReq("GET", ROUTES.events), res);
    await pollUntil("destroy 前心跳在写帧", () => countPing(res) >= 1);
    const pingsAtDestroy = countPing(res);
    res.destroy(); // 不触发 onClose：hub 心跳 tick 看到 destroyed 即 evict（自愈）
    await assertNoGrowth("destroy 后心跳停止写帧", () => countPing(res), pingsAtDestroy);
    // 心跳 tick 是异步的：轮询等 hub 自愈出表（事件驱动替代固定 sleep）。
    await pollUntil("hub 自愈 evict destroyed 连接", () => (manager.sseHub?.size() ?? 0) === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- health 路由 ----

{
  const { dir, manager } = setup();
  try {
    const route = makeHealthRoute(manager);
    const resForeign = fakeRes();
    route.handler(fakeReq("GET", ROUTES.health, undefined, { remote: "10.0.0.1" }), resForeign);
    assert.equal(resForeign.state.status, 403);

    const resWrong = fakeRes();
    route.handler(fakeReq("POST", ROUTES.health), resWrong);
    assert.equal(resWrong.state.status, 405);

    manager.supervisors.set("a", { status: "connected", tools: ["t1", "t2"] });
    manager.supervisors.set("b", { status: "failed", tools: [] });
    // 中间层连接池计数（#228）：项目级连接不在 supervisors，health 单独投影。
    manager.middlewareMode = "project";
    manager.middleware = {
      units: new Map([
        ["/root-a", { connections: new Map([["x", { status: "connected" }], ["y", { status: "failed" }]]) }],
        ["/root-b", { connections: new Map() }],
      ]),
    };
    const resOk = fakeRes();
    route.handler(fakeReq("GET", ROUTES.health), resOk);
    assert.equal(resOk.state.status, 200);
    const payload = JSON.parse(resOk.state.body);
    assert.equal(payload.ok, true, "health ok 标志为 true");
    assert.equal(payload.plugin, "dsh-mcp-manager");
    assert.equal(payload.servers, 2);
    assert.equal(payload.connected, 1);
    assert.equal(payload.tools, 2);
    assert.equal(payload.catalogCacheEntries, 1);
    assert.deepEqual(
      payload.middleware,
      { mode: "project", units: 2, connections: 2, connected: 1 },
      "health 补中间层连接计数",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- session / servers 边界 ----

{
  const { dir, manager } = setup();
  try {
    const routes = makeRoutes(manager);
    const find = (path) => routes.find((r) => r.path === path);

    // session：非 POST 405。
    const sesGuard = await callHandler(find(ROUTES.session), fakeReq("GET", ROUTES.session));
    assert.equal(sesGuard.status, 405);

    // session：body 无 cwd 字符串 → 400。
    const sesBad = await callHandler(find(ROUTES.session), fakeReq("POST", ROUTES.session, {}));
    assert.equal(sesBad.status, 400);
    const sesNoBody = await callHandler(find(ROUTES.session), fakeReq("POST", ROUTES.session));
    assert.equal(sesNoBody.status, 400);

    // servers：PATCH 缺 name → 400；DELETE 缺 name → 400。
    for (const method of ["PATCH", "DELETE"]) {
      const res = await callHandler(find(ROUTES.servers), fakeReq(method, ROUTES.servers));
      assert.equal(res.status, 400, `${method} 缺 name → 400`);
      assert.match(JSON.stringify(res.payload), /name query parameter is required/);
    }

    // servers：PUT → 405。
    const resPut = await callHandler(find(ROUTES.servers), fakeReq("PUT", ROUTES.servers));
    assert.equal(resPut.status, 405);

    // DELETE 存在的服务器 → 200 ok:true。
    const resDel = await callHandler(find(ROUTES.servers), fakeReq("DELETE", `${ROUTES.servers}?name=dup-a`));
    assert.equal(resDel.status, 200);
    assert.equal(resDel.payload.ok, true, "delete 返回 ok:true");

    // PATCH 不存在的服务器 → 400 not found。
    const resPatchMissing = await callHandler(
      find(ROUTES.servers),
      fakeReq("PATCH", `${ROUTES.servers}?name=ghost`, { command: "x" }),
    );
    assert.equal(resPatchMissing.status, 400);
    assert.match(JSON.stringify(resPatchMissing.payload), /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- import/json：字段校验与 skip/overwrite ----

{
  const { dir, manager } = setup();
  try {
    const routes = makeRoutes(manager);
    const importRoute = routes.find((r) => r.path === ROUTES.importJson);

    // 非 POST 405。
    const guard = await callHandler(importRoute, fakeReq("GET", ROUTES.importJson));
    assert.equal(guard.status, 405);

    // body 缺 json 字符串 → 400。
    const badBody = await callHandler(importRoute, fakeReq("POST", ROUTES.importJson, { json: 42 }));
    assert.equal(badBody.status, 400);
    assert.match(JSON.stringify(badBody.payload), /must include a json string/);

    // 同名导入默认 skip；overwrite=true 更新；非法条目整体 400。
    const payload = JSON.stringify({ "dup-a": { command: "echo2" }, fresh: { url: "http://f/" } });
    const resSkip = await callHandler(importRoute, fakeReq("POST", ROUTES.importJson, { json: payload }));
    assert.equal(resSkip.status, 200);
    assert.deepEqual(resSkip.payload.skipped, ["dup-a"], "同名默认跳过");
    assert.deepEqual(resSkip.payload.imported, ["fresh"]);

    const resOverwrite = await callHandler(
      importRoute,
      fakeReq("POST", ROUTES.importJson, { json: payload, overwrite: true }),
    );
    assert.deepEqual(resOverwrite.payload.imported.sort(), ["dup-a", "fresh"], "overwrite 全部导入");
    assert.equal(manager.store.find("dup-a").command, "echo2", "overwrite 后配置更新");

    const resInvalid = await callHandler(importRoute, fakeReq("POST", ROUTES.importJson, { json: '{"bad":1}' }));
    assert.equal(resInvalid.status, 400);
    assert.match(JSON.stringify(resInvalid.payload), /entry must be an object/, "非法条目整体 400");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("  ok   unit-routes-sse: SSE 帧/健康检查/路由边界");
