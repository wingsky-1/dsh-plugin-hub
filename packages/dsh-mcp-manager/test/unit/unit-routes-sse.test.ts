/**
 * dsh-mcp-manager — unit：SSE 推送帧 / 健康检查 / 路由边界补齐。
 *
 * 覆盖：
 * - sseData / uiConfigChangedFrame 帧格式
 * - broadcastFrame：空集合、正常写、单连接抛错吞掉继续广播其余
 * - events 路由：403 围栏 / 405 / writeHead 头 / 连接登记与 close 清理
 * - health 路由：403 / 405 / 计数聚合
 * - servers PATCH|DELETE 缺 name 400、未知 method 405
 * - connect/disconnect/reconnect：405 + 403 围栏（#903 M-B5）
 * - session 路由：body 校验 400、cwd 切换 200
 * - import/json：缺 json 字段 400、同名 skip 与 overwrite 更新
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpManager as McpManagerType } from "../../src/server/connection/orchestrator/interface.ts";
import type { McpMiddleware as McpMiddlewareType } from "../../src/server/connection/runtime/interface.ts";
import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";
import type { ProjectUnit } from "../../src/server/connection/runtime/interface.ts";
import type { ServerConfig } from "../../src/server/config/interface.ts";
import {
  assertNoGrowth,
  callHandler,
  fakeManagerCtx,
  fakeToolsService,
  pollUntil,
} from "../helpers.ts";
import type { FakeResponseState } from "../helpers.ts";

// S6-B2：路由装配/管理器构造/中间层是装配依赖 + sseData 无域门面，留包根；其余纯符号改道域门面。
const { makeRoutes, makeEventsRoute, makeHealthRoute, sseData, McpManager, McpMiddleware } =
  await import("../../src/index.ts");
const { uiConfigChangedFrame, broadcastFrame, ROUTES, SSE_HEARTBEAT_MS, SSE_PING_FRAME } =
  await import("../../src/server/api/interface.ts");
const { McpStore } = await import("../../src/server/store/interface.ts");
const { normalizeServer } = await import("../../src/server/config/interface.ts");

// 伪造 req/res：只实现 handler 实际读取的面，其余按接缝收窄（`as unknown as`）。
const fakeReq = (
  method: string,
  url: string,
  body?: unknown,
  opts: { remote?: string } = {},
): IncomingMessage =>
  ({
    method,
    url,
    socket: { remoteAddress: opts.remote ?? "127.0.0.1" },
    headers: {
      host: "localhost:3080",
      origin: "http://localhost:3080",
      "sec-fetch-site": "same-origin",
    },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined)
        yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    },
    on: () => {},
  }) as unknown as IncomingMessage;

const fakeRes = (): ServerResponse & { state: FakeResponseState } => {
  const state: FakeResponseState = {
    status: 200,
    body: "",
    headers: {},
    destroyed: false,
    writableEnded: false,
  };
  return {
    state,
    // routes.ts 心跳回调读 res.destroyed / res.writableEnded 判定自愈清理。
    get destroyed() {
      return state.destroyed;
    },
    get writableEnded() {
      return state.writableEnded;
    },
    writeHead: (s: number, h?: Record<string, string>) => {
      state.status = s;
      state.headers = h ?? {};
    },
    write: (chunk: { toString(): string }) => {
      state.body += chunk.toString();
    },
    end: (chunk?: { toString(): string }) => {
      if (chunk) state.body += chunk.toString();
      state.writableEnded = true;
    },
    setHeader: () => {},
    on: (event: string, cb: () => void) => {
      if (event === "close") state.onClose = cb;
    },
    destroy: () => {
      state.destroyed = true;
    },
  } as unknown as ServerResponse & { state: FakeResponseState };
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-sse-"));
  tempDirs.push(dir);
  const store = new McpStore(join(dir, "mcp.json"));
  store.data = { version: 1, servers: [] };
  store.upsert(normalizeServer({ name: "dup-a", transport: "stdio", command: "echo" }));
  const manager = new McpManager(fakeManagerCtx(), store);
  manager.catalogCache.set("cached", { summary: "s" });
  managers.push(manager);
  return { dir, store, manager };
}

let tempDirs: string[] = [];
let managers: McpManagerType[] = [];

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

const countPing = (res: { state: { body: string } }) =>
  (res.state.body.match(/data: \{"type":"ping"\}/g) ?? []).length;

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
    const written: [string, unknown][] = [];
    const boom = {
      write: () => {
        throw new Error("EPIPE");
      },
    };
    const good1 = { write: (f: unknown) => written.push(["g1", f]) };
    const good2 = { write: (f: unknown) => written.push(["g2", f]) };
    // 部分连接桩（只有 write 面）：broadcastFrame 只调 write，按接缝收窄。
    return { written, conns: new Set([boom, good1, good2]) as unknown as Set<ServerResponse> };
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
    // 帧计数覆盖 write：签名按 node 面收窄（只用零参调用形态）。
    res.write = (() => {
      frames += 1;
    }) as unknown as typeof res.write;
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
    res.state.onClose!();
    expect(manager.sseHub?.size()).toBe(0);
  });

  it("close 注销后广播不再写帧", async () => {
    const { manager, res, frames, unsubscribe } = await broadcastFlow();
    res.state.onClose!();
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
    res.state.onClose!();
    expect(manager.sseHub?.size()).toBe(0);
  });

  it("close 后心跳停止", async () => {
    const { res } = heartbeatFixture();
    // 等心跳帧到达阈值（事件驱动轮询替代固定 sleep 等后台数据）。
    await pollUntil("心跳 data ping 帧到达", () => countPing(res) >= 1);
    const pingsAtClose = countPing(res);
    // close：hub 内部 evict（出表 + 停对该连接写心跳），此后不再有新帧。
    res.state.onClose!();
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
    // 单池（#767 笔 1a）：/health 的顶层三计数与 middleware 子对象都按**连接池单元表**
    // 聚合——旧直连账本（manager.supervisors）已整体退役。假池只回答「routes 是否经
    // statusOf / toolCountOf 取数」这一条；读时刷新的真实语义由下面两条真 McpMiddleware
    // 用例钉住。
    const units = new Map([
      [
        "/root-a",
        {
          root: "/root-a",
          connections: new Map([
            ["x", { status: "connected" }],
            ["y", { status: "failed" }],
          ]),
        },
      ],
      ["/root-b", { root: "/root-b", connections: new Map() }],
    ]);
    const toolCounts = new Map([["/root-a\u0000x", 2]]);
    // 假池只回答「routes 是否经 statusOf / toolCountOf 取数」：按既有注释的意图收窄为端口面。
    manager.middleware = {
      units: units as unknown as Map<string, ProjectUnit>,
      statusOf: (root: string, serverName: string) =>
        units.get(root)?.connections.get(serverName)?.status,
      toolCountOf: (root: string, serverName: string) =>
        toolCounts.get(root + "\u0000" + serverName) ?? 0,
    } as unknown as McpMiddlewareType;
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
    // #767 笔 2：middleware 子对象只剩三个计数键——模式键已随 `middleware` 配置键删除。
    expect(payload.middleware).toEqual({ units: 2, connections: 2, connected: 1 });
    expect("mode" in payload.middleware).toBe(false);
    expect(payload.middleware.units).toBe(2);
  });

  /** health 的计数判据必须打在真 statusOf 上：假池只能验「接线到没到」，验不了读时刷新。 */
  function realPoolHost(tools: unknown, servers: ServerConfig[]) {
    return {
      ctx: { tools },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      projectServersFor: async () => servers,
      globalServers: () => [],
      normalizedProjectRoot: async (cwd: string | undefined) => cwd,
      saveUserState: async () => {},
      emitStatus: () => {},
      catalogCachePath: () => "/tmp/cache.json",
      isGlobalServer: () => false,
      isRuntimeServer: () => false,
    };
  }

  it("#767 S1-4d：计数随注册面变化（前缀工具消失 → middleware.connected 下降）", () => {
    // 真池（真 McpMiddleware + 真 projectServerState）：官方不暴露状态 API，六态只能读注册面，
    // 而 entry.status 只在装载窗口结算时写入——routes 若直读它会永远停在陈旧的 connected。
    const { manager, route } = healthFixture();
    const servers: ServerConfig[] = [
      { name: "x", transport: "stdio", command: "echo", enabled: true },
    ];
    const tools = fakeToolsService({ schemas: [{ name: "mcp__id-x__t" }] });
    // 真池 + 部分宿主：ctx/tools 等面只给池实际触达的形状，按接缝收窄。
    const mw = new McpMiddleware(realPoolHost(tools, servers) as unknown as MiddlewareHost);
    mw.units.set("/root-a", {
      root: "/root-a",
      connections: new Map([
        [
          "x",
          {
            server: servers[0],
            id: "id-x",
            handle: { disposed: false },
            status: "connected",
            error: undefined,
            connectedAt: Date.now(),
            readySettled: true,
            everConnected: true,
            disposed: false,
          },
        ],
      ]),
      catalog: new Map(),
      userDisabled: new Set(),
      lastTouchedAt: Date.now(),
      inFlight: new Map(),
      // 单元桩带域外探测字段（catalog/everConnected/disposed）：只供本文件判据，按接缝收窄。
    } as unknown as ProjectUnit);
    manager.middleware = mw;
    const middlewarePayload = () => {
      const res = fakeRes();
      route.handler(fakeReq("GET", ROUTES.health), res);
      return JSON.parse(res.state.body).middleware;
    };
    expect(middlewarePayload()).toEqual({
      units: 1,
      connections: 1,
      connected: 1,
    });
    // 注册面里该 id 前缀的工具消失（官方退避/预算耗尽时注销工具）→ 下一读计为未连接。
    tools.entries = [{ name: "mcp__other-id__t" }];
    expect(middlewarePayload().connected).toBe(0);
    expect(middlewarePayload().connections).toBe(1);
  });

  it("#767 S1-4d：虚拟单元（toolDefinitions）在 /health 恒计为 connected", () => {
    // 虚拟连接从不挂官方实例、注册面永远没有它的前缀——若 /health 也按注册面判，它会恒计为
    // 未连接（同一份 statusOf 的第三处读点；另两处见 unit-middleware 与 unit-manager2）。
    const { manager, route } = healthFixture();
    const virtual: ServerConfig = {
      name: "cg",
      transport: "stdio",
      command: "codegraph",
      enabled: true,
      toolDefinitions: [],
    };
    const tools = fakeToolsService();
    const mw = new McpMiddleware(realPoolHost(tools, [virtual]) as unknown as MiddlewareHost);
    mw.units.set("/root-a", {
      root: "/root-a",
      connections: new Map([
        [
          "cg",
          {
            server: virtual,
            id: undefined,
            handle: undefined,
            status: "connected",
            error: undefined,
            connectedAt: Date.now(),
            readySettled: true,
            everConnected: true,
            disposed: false,
          },
        ],
      ]),
      catalog: new Map(),
      userDisabled: new Set(),
      lastTouchedAt: Date.now(),
      inFlight: new Map(),
      // 单元桩带域外探测字段（catalog/everConnected/disposed）：只供本文件判据，按接缝收窄。
    } as unknown as ProjectUnit);
    manager.middleware = mw;
    const middlewarePayload = () => {
      const res = fakeRes();
      route.handler(fakeReq("GET", ROUTES.health), res);
      return JSON.parse(res.state.body).middleware;
    };
    expect(tools.entries).toEqual([]);
    expect(middlewarePayload().connected).toBe(1);
    // 用户禁用（浮窗断开）是把它投影成 disabled 的输入面之一。
    mw.units.get("/root-a")!.userDisabled.add("cg");
    expect(middlewarePayload().connected).toBe(0);
    expect(middlewarePayload().connections).toBe(1);
  });
});

describe("session / servers 边界", () => {
  function routesFixture() {
    const { manager } = setup();
    const routes = makeRoutes(manager);
    // 路由表静态装配：缺路由即装配损坏，此处断言存在（缺失时抛 TypeError 判红）。
    return { manager, routes, find: (path: string) => routes.find((r) => r.path === path)! };
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

  it.each(["PATCH", "DELETE"])(
    "servers %s 缺 name 文案含 name query parameter is required",
    async (method) => {
      const { find } = routesFixture();
      const res = await callHandler(find(ROUTES.servers), fakeReq(method, ROUTES.servers));
      expect(JSON.stringify(res.payload)).toMatch(/name query parameter is required/);
    },
  );

  it("servers PUT → 405", async () => {
    const { find } = routesFixture();
    const resPut = await callHandler(find(ROUTES.servers), fakeReq("PUT", ROUTES.servers));
    expect(resPut.status).toBe(405);
  });

  it("DELETE 存在的服务器 → 200", async () => {
    const { find } = routesFixture();
    const resDel = await callHandler(
      find(ROUTES.servers),
      fakeReq("DELETE", `${ROUTES.servers}?name=dup-a`),
    );
    expect(resDel.status).toBe(200);
  });

  it("delete 返回 ok:true", async () => {
    const { find } = routesFixture();
    const resDel = await callHandler(
      find(ROUTES.servers),
      fakeReq("DELETE", `${ROUTES.servers}?name=dup-a`),
    );
    expect((resDel.payload as { ok: unknown }).ok).toBe(true);
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

describe("connect/disconnect/reconnect 围栏（#903 M-B5）", () => {
  function routesFixture() {
    const { manager } = setup();
    const routes = makeRoutes(manager);
    return { manager, routes, find: (path: string) => routes.find((r) => r.path === path)! };
  }

  // 三路由 guarded 均为 POST（shared/routes.ts ROUTE_FENCE）：非 POST 一律 405。
  it.each([[ROUTES.connect], [ROUTES.disconnect], [ROUTES.reconnect]])(
    "%s 非 POST → 405",
    async (path) => {
      const { find } = routesFixture();
      const res = await callHandler(find(path), fakeReq("GET", path));
      expect(res.status).toBe(405);
    },
  );

  // loopback 围栏先于方法分流之外的动作：三路由非回环一律 403。
  it.each([[ROUTES.connect], [ROUTES.disconnect], [ROUTES.reconnect]])(
    "%s 非 loopback → 403",
    async (path) => {
      const { find } = routesFixture();
      const res = await callHandler(
        find(path),
        fakeReq("POST", path, undefined, { remote: "8.8.8.8" }),
      );
      expect(res.status).toBe(403);
    },
  );
});

describe("import/json：字段校验与 skip/overwrite", () => {
  function importFixture() {
    const { manager } = setup();
    const routes = makeRoutes(manager);
    // 路由表静态装配：缺路由即装配损坏，此处断言存在。
    const importRoute = routes.find((r) => r.path === ROUTES.importJson)!;
    return { manager, importRoute };
  }

  it("非 POST 405", async () => {
    const { importRoute } = importFixture();
    const guard = await callHandler(importRoute, fakeReq("GET", ROUTES.importJson));
    expect(guard.status).toBe(405);
  });

  it("body 缺 json 字符串 → 400", async () => {
    const { importRoute } = importFixture();
    const badBody = await callHandler(
      importRoute,
      fakeReq("POST", ROUTES.importJson, { json: 42 }),
    );
    expect(badBody.status).toBe(400);
  });

  it("缺 json 字符串文案含 must include a json string", async () => {
    const { importRoute } = importFixture();
    const badBody = await callHandler(
      importRoute,
      fakeReq("POST", ROUTES.importJson, { json: 42 }),
    );
    expect(JSON.stringify(badBody.payload)).toMatch(/must include a json string/);
  });

  it("同名默认跳过", async () => {
    const { importRoute } = importFixture();
    const payload = JSON.stringify({ "dup-a": { command: "echo2" }, fresh: { url: "http://f/" } });
    const resSkip = await callHandler(
      importRoute,
      fakeReq("POST", ROUTES.importJson, { json: payload }),
    );
    expect((resSkip.payload as { skipped: unknown }).skipped).toEqual(["dup-a"]);
  });

  it("新名导入", async () => {
    const { importRoute } = importFixture();
    const payload = JSON.stringify({ "dup-a": { command: "echo2" }, fresh: { url: "http://f/" } });
    const resSkip = await callHandler(
      importRoute,
      fakeReq("POST", ROUTES.importJson, { json: payload }),
    );
    expect((resSkip.payload as { imported: unknown }).imported).toEqual(["fresh"]);
  });

  it("overwrite 全部导入", async () => {
    const { importRoute } = importFixture();
    const payload = JSON.stringify({ "dup-a": { command: "echo2" }, fresh: { url: "http://f/" } });
    const resOverwrite = await callHandler(
      importRoute,
      fakeReq("POST", ROUTES.importJson, { json: payload, overwrite: true }),
    );
    expect((resOverwrite.payload as { imported: string[] }).imported.sort()).toEqual([
      "dup-a",
      "fresh",
    ]);
  });

  it("overwrite 后配置更新", async () => {
    const { importRoute, manager } = importFixture();
    const payload = JSON.stringify({ "dup-a": { command: "echo2" }, fresh: { url: "http://f/" } });
    await callHandler(
      importRoute,
      fakeReq("POST", ROUTES.importJson, { json: payload, overwrite: true }),
    );
    expect(manager.store.find("dup-a")!.command).toBe("echo2");
  });

  it("非法条目整体 400", async () => {
    const { importRoute } = importFixture();
    const resInvalid = await callHandler(
      importRoute,
      fakeReq("POST", ROUTES.importJson, { json: '{"bad":1}' }),
    );
    expect(resInvalid.status).toBe(400);
  });

  it("非法条目文案含 entry must be an object", async () => {
    const { importRoute } = importFixture();
    const resInvalid = await callHandler(
      importRoute,
      fakeReq("POST", ROUTES.importJson, { json: '{"bad":1}' }),
    );
    expect(JSON.stringify(resInvalid.payload)).toMatch(/entry must be an object/);
  });
});

// M7：POST /config 未知顶层键 → 400 拒绝（且不落盘） ----
describe("M7：POST /config 未知顶层键 → 400 拒绝", () => {
  function configFixture() {
    const { manager } = setup();
    const uiUpdates: unknown[] = [];
    manager.uiUpdate = async (patch) => {
      // 记录落盘意图：未知键不得触达 uiUpdate（知道错了就不许写）。
      uiUpdates.push(patch);
    };
    const routes = makeRoutes(manager);
    // 路由表静态装配：缺路由即装配损坏，此处断言存在。
    const configRoute = routes.find((r) => r.path === ROUTES.config)!;
    return { manager, configRoute, uiUpdates };
  }

  async function postBody(body: unknown) {
    const fixture = configFixture();
    const res = await callHandler(fixture.configRoute, fakeReq("POST", ROUTES.config, body));
    return { ...fixture, res };
  }

  it("config 路由存在", () => {
    const { configRoute } = configFixture();
    expect(configRoute).toBeTruthy();
  });

  it("M7：未知顶层键应 400 拒绝", async () => {
    const { res } = await postBody({ middleware: "all" });
    expect(res.status).toBe(400);
  });

  it("M7：已删配置键 middleware / middlewarePolicy 一律按未知键拒绝", async () => {
    const mw = await postBody({ middleware: "project" });
    expect(mw.res.status).toBe(400);
    const policy = await postBody({ middlewarePolicy: { denyTools: {} } });
    expect(policy.res.status).toBe(400);
  });

  it("错误文案列出全部未知键", async () => {
    const { res } = await postBody({ foo: 1, middleware: "all" });
    expect((res.payload as { error: unknown }).error).toBe(
      "unknown config key(s): foo, middleware",
    );
  });

  it("未知键不触达 uiUpdate（不落盘）", async () => {
    const { uiUpdates } = await postBody({ middleware: "all" });
    expect(uiUpdates.length).toBe(0);
  });

  it("manager 上没有模式镜像字段（无第二事实源可写）", () => {
    const { manager } = configFixture();
    expect("middlewareMode" in manager).toBe(false);
    expect("setMiddlewareMode" in manager).toBe(false);
  });

  it("合法扁平 UI 键 → 200 并落盘", async () => {
    const { res, uiUpdates } = await postBody({ position: "top-left", offsetX: 12 });
    expect(res.status).toBe(200);
    expect(uiUpdates.length).toBe(1);
  });
});
// CRAP-ZERO tool-disable 路由：分支覆盖（与 routes-controllers 解析拆分同批）
describe("CRAP-ZERO tool-disable 路由", () => {
  function toolFixture() {
    const { manager } = setup();
    const routes = makeRoutes(manager);
    const route = routes.find((r) => r.path === ROUTES.toolDisable)!;
    return { manager, route };
  }

  it("非 PATCH → 405", async () => {
    const { route } = toolFixture();
    const res = await callHandler(route, fakeReq("GET", ROUTES.toolDisable));
    expect(res.status).toBe(405);
  });

  it("无 body → 400", async () => {
    const { route } = toolFixture();
    const res = await callHandler(route, fakeReq("PATCH", ROUTES.toolDisable));
    expect(res.status).toBe(400);
  });

  it("body 缺字段 → 400 且文案含均为必填", async () => {
    const { route } = toolFixture();
    const res = await callHandler(route, fakeReq("PATCH", ROUTES.toolDisable, {}));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.payload)).toMatch(/均为必填/);
  });

  it("server 格式非法 → 400", async () => {
    const { route } = toolFixture();
    const res = await callHandler(
      route,
      fakeReq("PATCH", ROUTES.toolDisable, { server: "nope", tool: "t" }),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.payload)).toMatch(/格式非法/);
  });

  it("跨空间 root → 400 且文案含不属于当前工作空间", async () => {
    const { route } = toolFixture();
    const res = await callHandler(
      route,
      fakeReq("PATCH", ROUTES.toolDisable, { server: "@/tmp/proj/x", tool: "t" }),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.payload)).toMatch(/不属于当前工作空间/);
  });

  it("合法禁用 → 200 且透传 root/裸名/开关", async () => {
    const { manager, route } = toolFixture();
    const calls: Array<[string, string, string, boolean]> = [];
    manager.setToolDisabled = (async (
      root: string,
      server: string,
      tool: string,
      disabled: boolean,
    ) => {
      calls.push([root, server, tool, disabled]);
    }) as typeof manager.setToolDisabled;
    const res = await callHandler(
      route,
      fakeReq("PATCH", ROUTES.toolDisable, { server: "@global/dup-a", tool: "t", disabled: true }),
    );
    expect(res.status).toBe(200);
    expect((res.payload as { ok: unknown }).ok).toBe(true);
    expect(calls).toEqual([["@global", "dup-a", "t", true]]);
  });
});
// CRAP-ZERO resume route hit
describe("CRAP-ZERO resume route", () => {
  it("POST resume returns 200 ok", async () => {
    const { manager } = setup();
    const routes = makeRoutes(manager);
    const route = routes.find((r) => r.path === ROUTES.resume)!;
    const res = await callHandler(route, fakeReq("POST", ROUTES.resume));
    expect(res.status).toBe(200);
    expect((res.payload as { ok: unknown }).ok).toBe(true);
  });
});
