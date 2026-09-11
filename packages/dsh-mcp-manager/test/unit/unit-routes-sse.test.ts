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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoGrowth, callHandler, pollUntil } from "../helpers.ts";

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
} = await import("../../src/index.ts");

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
  tempDirs.push(dir);
  const store = new McpStore(join(dir, "mcp.json"));
  store.data = { version: 1, servers: [] };
  store.upsert(normalizeServer({ name: "dup-a", transport: "stdio", command: "echo" }));
  const manager = new McpManager({ logger: { warn: () => {}, info: () => {}, error: () => {} } }, store);
  manager.catalogCache.set("cached", { summary: "s" });
  managers.push(manager);
  return { dir, store, manager };
}

let tempDirs = [];
let managers = [];

afterEach(() => {
  for (const manager of managers) {
    try {
      manager.sseHub?.dispose();
    } catch {
      // 心跳清理失败不掩盖用例结论
    }
  }
  managers = [];
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

const countPing = (res) => (res.state.body.match(/data: \{"type":"ping"\}/g) ?? []).length;

describe("帧格式", () => {
  it("sseData 产出 data 帧", () => {
    expect(sseData({ a: 1 })).toBe('data: {"a":1}\n\n');
  });

  it("uiConfigChangedFrame 产出 ui-config-changed 帧", () => {
    expect(uiConfigChangedFrame()).toBe('data: {"type":"ui-config-changed"}\n\n');
  });
});

describe("broadcastFrame", () => {
  function broadcastFixture() {
    const written = [];
    const boom = { write: () => { throw new Error("EPIPE"); } };
    const good1 = { write: (f) => written.push(["g1", f]) };
    const good2 = { write: (f) => written.push(["g2", f]) };
    return { written, conns: new Set([boom, good1, good2]) };
  }

  it("空集合广播不抛", () => {
    expect(() => broadcastFrame(undefined, "data: x\n\n")).not.toThrow();
  });

  it("单连接断开不影响其余", () => {
    const { conns } = broadcastFixture();
    expect(() => broadcastFrame(conns, "f1")).not.toThrow();
  });

  it("其余连接按登记顺序收到帧", () => {
    const { conns, written } = broadcastFixture();
    broadcastFrame(conns, "f1");
    expect(written.map((x) => x[0])).toEqual(["g1", "g2"]);
  });
});

describe("events 路由", () => {
  function subscribe() {
    const { manager } = setup();
    const route = makeEventsRoute(manager);
    const res = fakeRes();
    route.handler(fakeReq("GET", ROUTES.events), res);
    return { manager, route, res };
  }

  /** 订阅 + 广播接线：帧计数经 res.write 覆盖捕获。 */
  async function broadcastFlow() {
    const { manager } = setup();
    const route = makeEventsRoute(manager);
    const res = fakeRes();
    route.handler(fakeReq("GET", ROUTES.events), res);
    let frames = 0;
    res.write = () => {
      frames += 1;
    };
    const unsubscribe = manager.onStatus(() => {
      manager.sseHub?.broadcast(sseData({ type: "summary" }));
    });
    manager.emitStatus();
    // emitStatus 是 coalesce 异步（setTimeout 0）：轮询等广播落定（事件驱动替代固定 sleep）。
    await pollUntil("广播落定 frames===1", () => frames === 1);
    return { manager, res, frames: () => frames, unsubscribe };
  }

  it("非 loopback → 403", () => {
    const { route } = subscribe();
    const resForeign = fakeRes();
    route.handler(fakeReq("GET", ROUTES.events, undefined, { remote: "8.8.8.8" }), resForeign);
    expect(resForeign.state.status).toBe(403);
  });

  it("403 文案含 loopback-only", () => {
    const { route } = subscribe();
    const resForeign = fakeRes();
    route.handler(fakeReq("GET", ROUTES.events, undefined, { remote: "8.8.8.8" }), resForeign);
    expect(resForeign.state.body).toMatch(/loopback-only/);
  });

  it("非 GET → 405", () => {
    const { route } = subscribe();
    const resWrongMethod = fakeRes();
    route.handler(fakeReq("POST", ROUTES.events), resWrongMethod);
    expect(resWrongMethod.state.status).toBe(405);
  });

  it("成功订阅 status 200", () => {
    const { res } = subscribe();
    expect(res.state.status).toBe(200);
  });

  it("订阅响应头 content-type 为 text/event-stream", () => {
    const { res } = subscribe();
    expect(res.state.headers["content-type"]).toBe("text/event-stream");
  });

  it("订阅初始帧以 : connected 开头", () => {
    const { res } = subscribe();
    expect(res.state.body.startsWith(": connected")).toBeTruthy();
  });

  it("连接已登记（hub 惰性创建）", () => {
    const { manager } = subscribe();
    expect(manager.sseHub?.size()).toBe(1);
  });

  it("close 后注销", async () => {
    const { manager, res } = await broadcastFlow();
    // close 注销。
    res.state.onClose();
    expect(manager.sseHub?.size()).toBe(0);
  });

  it("close 注销后广播不再写帧", async () => {
    const { manager, res, frames, unsubscribe } = await broadcastFlow();
    res.state.onClose();
    // 二次广播应执行但不再写帧（连接已注销）——哨兵确认广播落定后断言帧数不变。
    let landed = 0;
    const offSentinel = manager.onStatus(() => {
      landed += 1;
    });
    manager.emitStatus();
    await pollUntil("二次广播落定", () => landed >= 1);
    offSentinel();
    expect(frames()).toBe(1);
    unsubscribe();
  });
});

// #515：mcp 补齐连接上限 + 淘汰（对齐 notifier；取代旧裸 Set 无上限） ----
describe("#515：连接上限 + 淘汰", () => {
  function limitFixture() {
    const { manager } = setup();
    // 上限 2：注册 3 条 → 最老被淘汰，表收敛 2。
    const route = makeEventsRoute(manager, { heartbeatMs: 60_000, maxConnections: 2 });
    const r1 = fakeRes();
    const r2 = fakeRes();
    const r3 = fakeRes();
    route.handler(fakeReq("GET", ROUTES.events), r1);
    route.handler(fakeReq("GET", ROUTES.events), r2);
    route.handler(fakeReq("GET", ROUTES.events), r3);
    return { manager, r1, r2, r3 };
  }

  it("上限 2，注册 3 收敛到 2", () => {
    const { manager } = limitFixture();
    expect(manager.sseHub?.size()).toBe(2);
  });

  it("最老 r1 被淘汰 destroy", () => {
    const { r1 } = limitFixture();
    expect(r1.state.destroyed).toBe(true);
  });

  it("r2 保留", () => {
    const { r2 } = limitFixture();
    expect(r2.state.destroyed).toBe(false);
  });

  it("r3 保留", () => {
    const { r3 } = limitFixture();
    expect(r3.state.destroyed).toBe(false);
  });

  it("evict 原因计数 limit=1", () => {
    const { manager } = limitFixture();
    const stats = manager.sseHub?.evictStats();
    expect(stats?.limit).toBe(1);
  });
});

// SSE 心跳（#268）：data ping 帧 / 间隔常量 / close 与卸载 disposer 清理 ----
describe("SSE 心跳常量契约", () => {
  // 常量契约：间隔对齐 dsh-notifier HEARTBEAT_MS（30s）；心跳必须是 data 帧而非
  // 注释帧——注释帧不触发客户端 onmessage，watchdog 无失活信号可依。
  it("心跳间隔 30s（对齐 notifier）", () => {
    expect(SSE_HEARTBEAT_MS).toBe(30_000);
  });

  it("心跳为 data ping 帧", () => {
    expect(SSE_PING_FRAME).toBe('data: {"type":"ping"}\n\n');
  });
});

describe("SSE 心跳：登记 / close 清理", () => {
  function heartbeatFixture() {
    const { manager } = setup();
    const route = makeEventsRoute(manager, { heartbeatMs: 10 });
    const res = fakeRes();
    route.handler(fakeReq("GET", ROUTES.events), res);
    return { manager, res };
  }

  it("连接已登记（hub）", () => {
    const { manager } = heartbeatFixture();
    expect(manager.sseHub?.size()).toBe(1);
  });

  it("close 后注销", () => {
    const { manager, res } = heartbeatFixture();
    res.state.onClose();
    expect(manager.sseHub?.size()).toBe(0);
  });

  it("close 后心跳停止", async () => {
    const { res } = heartbeatFixture();
    // 等心跳帧到达阈值（事件驱动轮询替代固定 sleep 等后台数据）。
    await pollUntil("心跳 data ping 帧到达", () => countPing(res) >= 1);
    const pingsAtClose = countPing(res);
    // close：hub 内部 evict（出表 + 停对该连接写心跳），此后不再有新帧。
    res.state.onClose();
    await assertNoGrowth("close 后心跳停止", () => countPing(res), pingsAtClose);
    expect(countPing(res)).toBe(pingsAtClose);
  });
});

describe("SSE 心跳：卸载 disposer 清理", () => {
  // 卸载路径：插件 disposer 显式执行全部 cleanups（index.ts apply 清理同款），
  // 不依赖 res.destroy() 触发 close 的异步时序。
  function unloadFixture() {
    const { manager } = setup();
    const route = makeEventsRoute(manager, { heartbeatMs: 10 });
    const resA = fakeRes();
    const resB = fakeRes();
    route.handler(fakeReq("GET", ROUTES.events), resA);
    route.handler(fakeReq("GET", ROUTES.events), resB);
    return { manager, resA, resB };
  }

  it("两条连接已登记", () => {
    const { manager } = unloadFixture();
    expect(manager.sseHub?.size()).toBe(2);
  });

  it("dispose 后连接 A 心跳停止", async () => {
    const { manager, resA } = unloadFixture();
    // 卸载路径：hub.dispose() 统一停心跳 + destroy 全部连接（apply disposer 同款），
    // 不依赖 res.destroy() 触发 close 的异步时序。
    manager.sseHub?.dispose();
    await assertNoGrowth("dispose 后连接 A 心跳停止", () => countPing(resA), 0);
    expect(countPing(resA)).toBe(0);
  });

  it("dispose 后连接 B 心跳停止", async () => {
    const { manager, resB } = unloadFixture();
    manager.sseHub?.dispose();
    await assertNoGrowth("dispose 后连接 B 心跳停止", () => countPing(resB), 0);
    expect(countPing(resB)).toBe(0);
  });
});

describe("SSE 心跳：destroy 自愈路径", () => {
  // 自愈路径：destroy() 后（模拟 close 事件丢失的极端场景）下一跳心跳看到
  // destroyed 即自杀清理——不再写帧，且从 disposer 注册表自删。
  async function healFixture() {
    const { manager } = setup();
    const route = makeEventsRoute(manager, { heartbeatMs: 10 });
    const res = fakeRes();
    route.handler(fakeReq("GET", ROUTES.events), res);
    await pollUntil("destroy 前心跳在写帧", () => countPing(res) >= 1);
    const pingsAtDestroy = countPing(res);
    res.destroy(); // 不触发 onClose：hub 心跳 tick 看到 destroyed 即 evict（自愈）
    return { manager, res, pingsAtDestroy };
  }

  it("destroy 后心跳停止写帧", async () => {
    const { res, pingsAtDestroy } = await healFixture();
    await assertNoGrowth("destroy 后心跳停止写帧", () => countPing(res), pingsAtDestroy);
    expect(countPing(res)).toBe(pingsAtDestroy);
  });

  it("hub 自愈 evict destroyed 连接", async () => {
    const { manager } = await healFixture();
    // 心跳 tick 是异步的：轮询等 hub 自愈出表（事件驱动替代固定 sleep）。
    await pollUntil("hub 自愈 evict destroyed 连接", () => (manager.sseHub?.size() ?? 0) === 0);
    expect(manager.sseHub?.size() ?? 0).toBe(0);
  });
});

describe("health 路由", () => {
  function healthFixture() {
    const { manager } = setup();
    const route = makeHealthRoute(manager);
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
    return { manager, route };
  }

  function healthPayload() {
    const { manager, route } = healthFixture();
    const resOk = fakeRes();
    route.handler(fakeReq("GET", ROUTES.health), resOk);
    return { manager, status: resOk.state.status, payload: JSON.parse(resOk.state.body) };
  }

  it("非 loopback → 403", () => {
    const { route } = healthFixture();
    const resForeign = fakeRes();
    route.handler(fakeReq("GET", ROUTES.health, undefined, { remote: "10.0.0.1" }), resForeign);
    expect(resForeign.state.status).toBe(403);
  });

  it("非 GET → 405", () => {
    const { route } = healthFixture();
    const resWrong = fakeRes();
    route.handler(fakeReq("POST", ROUTES.health), resWrong);
    expect(resWrong.state.status).toBe(405);
  });

  it("health 200", () => {
    const { status } = healthPayload();
    expect(status).toBe(200);
  });

  it("health ok 标志为 true", () => {
    const { payload } = healthPayload();
    expect(payload.ok).toBe(true);
  });

  it("health plugin 名", () => {
    const { payload } = healthPayload();
    expect(payload.plugin).toBe("dsh-mcp-manager");
  });

  it("health 服务器计数为 2", () => {
    const { payload } = healthPayload();
    expect(payload.servers).toBe(2);
  });

  it("health 已连接计数为 1", () => {
    const { payload } = healthPayload();
    expect(payload.connected).toBe(1);
  });

  it("health 工具计数为 2", () => {
    const { payload } = healthPayload();
    expect(payload.tools).toBe(2);
  });

  it("health 目录缓存计数为 1", () => {
    const { payload } = healthPayload();
    expect(payload.catalogCacheEntries).toBe(1);
  });

  it("health 补中间层连接计数", () => {
    const { payload } = healthPayload();
    expect(payload.middleware).toEqual({ mode: "project", units: 2, connections: 2, connected: 1 });
  });
});

describe("session / servers 边界", () => {
  function routesFixture() {
    const { manager } = setup();
    const routes = makeRoutes(manager);
    return { manager, routes, find: (path) => routes.find((r) => r.path === path) };
  }

  it("session 非 POST 405", async () => {
    const { find } = routesFixture();
    const sesGuard = await callHandler(find(ROUTES.session), fakeReq("GET", ROUTES.session));
    expect(sesGuard.status).toBe(405);
  });

  it("session body 无 cwd 字符串 → 400", async () => {
    const { find } = routesFixture();
    const sesBad = await callHandler(find(ROUTES.session), fakeReq("POST", ROUTES.session, {}));
    expect(sesBad.status).toBe(400);
  });

  it("session 无 body → 400", async () => {
    const { find } = routesFixture();
    const sesNoBody = await callHandler(find(ROUTES.session), fakeReq("POST", ROUTES.session));
    expect(sesNoBody.status).toBe(400);
  });

  it.each(["PATCH", "DELETE"])("servers %s 缺 name → 400", async (method) => {
    const { find } = routesFixture();
    const res = await callHandler(find(ROUTES.servers), fakeReq(method, ROUTES.servers));
    expect(res.status).toBe(400);
  });

  it.each(["PATCH", "DELETE"])("servers %s 缺 name 文案含 name query parameter is required", async (method) => {
    const { find } = routesFixture();
    const res = await callHandler(find(ROUTES.servers), fakeReq(method, ROUTES.servers));
    expect(JSON.stringify(res.payload)).toMatch(/name query parameter is required/);
  });

  it("servers PUT → 405", async () => {
    const { find } = routesFixture();
    const resPut = await callHandler(find(ROUTES.servers), fakeReq("PUT", ROUTES.servers));
    expect(resPut.status).toBe(405);
  });

  it("DELETE 存在的服务器 → 200", async () => {
    const { find } = routesFixture();
    const resDel = await callHandler(find(ROUTES.servers), fakeReq("DELETE", `${ROUTES.servers}?name=dup-a`));
    expect(resDel.status).toBe(200);
  });

  it("delete 返回 ok:true", async () => {
    const { find } = routesFixture();
    const resDel = await callHandler(find(ROUTES.servers), fakeReq("DELETE", `${ROUTES.servers}?name=dup-a`));
    expect(resDel.payload.ok).toBe(true);
  });

  it("PATCH 不存在的服务器 → 400", async () => {
    const { find } = routesFixture();
    const resPatchMissing = await callHandler(
      find(ROUTES.servers),
      fakeReq("PATCH", `${ROUTES.servers}?name=ghost`, { command: "x" }),
    );
    expect(resPatchMissing.status).toBe(400);
  });

  it("PATCH 不存在的服务器文案含 not found", async () => {
    const { find } = routesFixture();
    const resPatchMissing = await callHandler(
      find(ROUTES.servers),
      fakeReq("PATCH", `${ROUTES.servers}?name=ghost`, { command: "x" }),
    );
    expect(JSON.stringify(resPatchMissing.payload)).toMatch(/not found/);
  });
});

describe("import/json：字段校验与 skip/overwrite", () => {
  function importFixture() {
    const { manager } = setup();
    const routes = makeRoutes(manager);
    const importRoute = routes.find((r) => r.path === ROUTES.importJson);
    return { manager, importRoute };
  }

  it("非 POST 405", async () => {
    const { importRoute } = importFixture();
    const guard = await callHandler(importRoute, fakeReq("GET", ROUTES.importJson));
    expect(guard.status).toBe(405);
  });

  it("body 缺 json 字符串 → 400", async () => {
    const { importRoute } = importFixture();
    const badBody = await callHandler(importRoute, fakeReq("POST", ROUTES.importJson, { json: 42 }));
    expect(badBody.status).toBe(400);
  });

  it("缺 json 字符串文案含 must include a json string", async () => {
    const { importRoute } = importFixture();
    const badBody = await callHandler(importRoute, fakeReq("POST", ROUTES.importJson, { json: 42 }));
    expect(JSON.stringify(badBody.payload)).toMatch(/must include a json string/);
  });

  it("同名默认跳过", async () => {
    const { importRoute } = importFixture();
    const payload = JSON.stringify({ "dup-a": { command: "echo2" }, fresh: { url: "http://f/" } });
    const resSkip = await callHandler(importRoute, fakeReq("POST", ROUTES.importJson, { json: payload }));
    expect(resSkip.payload.skipped).toEqual(["dup-a"]);
  });

  it("新名导入", async () => {
    const { importRoute } = importFixture();
    const payload = JSON.stringify({ "dup-a": { command: "echo2" }, fresh: { url: "http://f/" } });
    const resSkip = await callHandler(importRoute, fakeReq("POST", ROUTES.importJson, { json: payload }));
    expect(resSkip.payload.imported).toEqual(["fresh"]);
  });

  it("overwrite 全部导入", async () => {
    const { importRoute } = importFixture();
    const payload = JSON.stringify({ "dup-a": { command: "echo2" }, fresh: { url: "http://f/" } });
    const resOverwrite = await callHandler(
      importRoute,
      fakeReq("POST", ROUTES.importJson, { json: payload, overwrite: true }),
    );
    expect(resOverwrite.payload.imported.sort()).toEqual(["dup-a", "fresh"]);
  });

  it("overwrite 后配置更新", async () => {
    const { importRoute, manager } = importFixture();
    const payload = JSON.stringify({ "dup-a": { command: "echo2" }, fresh: { url: "http://f/" } });
    await callHandler(importRoute, fakeReq("POST", ROUTES.importJson, { json: payload, overwrite: true }));
    expect(manager.store.find("dup-a").command).toBe("echo2");
  });

  it("非法条目整体 400", async () => {
    const { importRoute } = importFixture();
    const resInvalid = await callHandler(importRoute, fakeReq("POST", ROUTES.importJson, { json: '{"bad":1}' }));
    expect(resInvalid.status).toBe(400);
  });

  it("非法条目文案含 entry must be an object", async () => {
    const { importRoute } = importFixture();
    const resInvalid = await callHandler(importRoute, fakeReq("POST", ROUTES.importJson, { json: '{"bad":1}' }));
    expect(JSON.stringify(resInvalid.payload)).toMatch(/entry must be an object/);
  });
});

// B7：POST /config 非法 middleware → 400 拒绝（不热切换、不落盘） ----
describe("B7：POST /config 非法 middleware → 400 拒绝", () => {
  function configFixture() {
    const { manager } = setup();
    const uiUpdates = [];
    manager.uiUpdate = async (patch) => {
      // 记录落盘意图：非法值不得触达（现状会落盘 {middleware:"off"}）
      uiUpdates.push(String(patch.middleware));
    };
    const routes = makeRoutes(manager);
    const configRoute = routes.find((r) => r.path === ROUTES.config);
    return { manager, configRoute, uiUpdates };
  }

  async function postBogus() {
    const fixture = configFixture();
    const res = await callHandler(fixture.configRoute, fakeReq("POST", ROUTES.config, { middleware: "bogus" }));
    return { ...fixture, res };
  }

  it("config 路由存在", () => {
    const { configRoute } = configFixture();
    expect(configRoute).toBeTruthy();
  });

  it("B7：非法 middleware 应 400 拒绝（现状静默回落 off 并落盘）", async () => {
    const { res } = await postBogus();
    expect(res.status).toBe(400);
  });

  it("错误文案指明 middleware 非法", async () => {
    const { res } = await postBogus();
    expect(res.payload.error).toMatch(/middleware/);
  });

  it("非法值不改写运行模式", async () => {
    const { manager } = await postBogus();
    expect(manager.middlewareMode).toBe("off");
  });

  it("非法值不触达 uiUpdate（不落盘）", async () => {
    const { uiUpdates } = await postBogus();
    expect(uiUpdates.length).toBe(0);
  });
});
