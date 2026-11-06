/**
 * dsh-mcp-manager — unit：路由的配置/导入面（import-json、POST /config、tool-disable、resume）。
 *
 * 自然职责拆分（#1174 阶段 2 形状清债）：这些 describe 只碰「写面」路由（导入、配置落盘、
 * 工具禁用、resume），与 SSE 帧/心跳/health/围栏等读面无共享断言面。原与读面同处一个
 * 799 行文件（挂账 max-lines 一条），故整块迁到本文件；describe 标题沿用原名，fullName 不变。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { callHandler, installCompositionPorts, releaseCompositionPorts } from "../helpers.ts";
import {
  ROUTES,
  makeEventsRouteWithAccess,
  makeHealthRouteWithAccess,
  makeRoutes,
  makeRoutesWithAccess,
  unitShapeCleanupRoutes,
  unitShapeFakeReq as fakeReq,
  unitShapeFakeRes,
  unitShapeRoutesFixture,
  unitShapeSetupRoutes,
} from "./unit-shape-routes-support.ts";

const fixture = unitShapeRoutesFixture();
const setup = () => unitShapeSetupRoutes(fixture);

function remoteAdmission(rejection: 401 | 403 | undefined = undefined) {
  return vi.fn(() => rejection);
}

function admittedPeer() {
  let releaseEffect: (() => void) | undefined;
  const dispose = vi.fn();
  const effect = vi.fn((execute: () => () => void, _label?: string) => {
    releaseEffect = execute();
    return dispose;
  });
  return {
    peer: { ctx: { effect } },
    effect,
    dispose,
    release: () => releaseEffect?.(),
  };
}

type MethodOrderCase = [
  path: string,
  method: string,
  run: (req: ReturnType<typeof fakeReq>, res: unknown) => unknown,
];

function routeMethodOrderCases(
  routes: ReturnType<typeof makeRoutesWithAccess>,
  events: ReturnType<typeof makeEventsRouteWithAccess>,
  health: ReturnType<typeof makeHealthRouteWithAccess>,
): MethodOrderCase[] {
  const routeRun = (path: string) => (req: ReturnType<typeof fakeReq>, res: unknown) =>
    routes.find((route) => route.path === path)!.handler(req, res as never);
  return [
    [ROUTES.servers, "OPTIONS", routeRun(ROUTES.servers)],
    [ROUTES.config, "OPTIONS", routeRun(ROUTES.config)],
    [ROUTES.session, "GET", routeRun(ROUTES.session)],
    [ROUTES.resume, "GET", routeRun(ROUTES.resume)],
    [ROUTES.connect, "GET", routeRun(ROUTES.connect)],
    [ROUTES.disconnect, "GET", routeRun(ROUTES.disconnect)],
    [ROUTES.reconnect, "GET", routeRun(ROUTES.reconnect)],
    [ROUTES.importJson, "GET", routeRun(ROUTES.importJson)],
    [ROUTES.toolDisable, "GET", routeRun(ROUTES.toolDisable)],
    [ROUTES.events, "POST", (req, res) => events.handler(req, res as never)],
    [ROUTES.health, "POST", (req, res) => health.handler(req, res as never)],
  ];
}

beforeAll(() => {
  installCompositionPorts();
});

afterAll(() => {
  releaseCompositionPorts();
});

afterEach(() => {
  unitShapeCleanupRoutes(fixture);
});

describe("官方 raw route 短请求 admission", () => {
  it("非回环 GET /config 经 admission 放行，loopback 快路径不调用 source", async () => {
    const { manager } = setup();
    const admission = remoteAdmission();
    const source = vi.fn(() => admission);
    const route = makeRoutesWithAccess(manager, process.cwd(), { remoteAdmission: source }).find(
      (item) => item.path === ROUTES.config,
    )!;
    const req = fakeReq("GET", ROUTES.config, undefined, { remote: "8.8.8.8" });
    const remote = await callHandler(route, req);
    expect(remote.status).toBe(200);
    expect(source).toHaveBeenCalledTimes(1);
    expect(admission).toHaveBeenCalledWith(req);

    const loopback = await callHandler(route, fakeReq("GET", ROUTES.config));
    expect(loopback.status).toBe(200);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403] as const)("/config 拒绝 %i 原样返回且先于未知方法 405", async (rejection) => {
    const { manager } = setup();
    const source = vi.fn(() => remoteAdmission(rejection));
    const route = makeRoutesWithAccess(manager, process.cwd(), { remoteAdmission: source }).find(
      (item) => item.path === ROUTES.config,
    )!;
    const res = await callHandler(
      route,
      fakeReq("PUT", ROUTES.config, undefined, { remote: "8.8.8.8" }),
    );
    expect(source).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(rejection);
  });

  it("认证通过后才判 405；缺 source 或 source 抛错时 fail-closed 403", async () => {
    const { manager } = setup();
    const source = vi.fn(() => remoteAdmission());
    const route = makeRoutesWithAccess(manager, process.cwd(), { remoteAdmission: source }).find(
      (item) => item.path === ROUTES.config,
    )!;
    const admitted = await callHandler(
      route,
      fakeReq("OPTIONS", ROUTES.config, undefined, { remote: "8.8.8.8" }),
    );
    expect(admitted.status).toBe(405);
    expect(source).toHaveBeenCalledTimes(1);

    const missing = await callHandler(
      makeRoutesWithAccess(manager).find((item) => item.path === ROUTES.config)!,
      fakeReq("GET", ROUTES.config, undefined, { remote: "8.8.8.8" }),
    );
    expect(missing.status).toBe(403);
    const throwing = await callHandler(
      makeRoutesWithAccess(manager, process.cwd(), {
        remoteAdmission: () => () => {
          throw new Error("connection unloaded");
        },
      }).find((item) => item.path === ROUTES.config)!,
      fakeReq("GET", ROUTES.config, undefined, { remote: "8.8.8.8" }),
    );
    expect(throwing.status).toBe(403);
  });
});

describe("11 条 raw route 的认证与方法顺序", () => {
  it("全部先认证，通过后才返回 405", async () => {
    const { manager } = setup();
    const short = remoteAdmission();
    const shortSource = vi.fn(() => short);
    const peerSource = vi.fn(() => () => ({ peer: admittedPeer().peer }));
    const routes = makeRoutesWithAccess(manager, process.cwd(), { remoteAdmission: shortSource });
    const events = makeEventsRouteWithAccess(manager, { remotePeerAdmission: peerSource });
    const health = makeHealthRouteWithAccess(manager, { remoteAdmission: shortSource });
    const cases = routeMethodOrderCases(routes, events, health);
    for (const [path, method, run] of cases) {
      const res = unitShapeFakeRes();
      await run(fakeReq(method, path, undefined, { remote: "8.8.8.8" }), res);
      expect(res.state.status, `${path} ${method}`).toBe(405);
    }
    expect(shortSource).toHaveBeenCalledTimes(10);
    expect(peerSource).toHaveBeenCalledTimes(1);
  });

  it("全部认证拒绝时先返回 401，不泄漏方法是否被支持", async () => {
    const { manager } = setup();
    const short = remoteAdmission(401);
    const shortSource = vi.fn(() => short);
    const peerSource = vi.fn(() => () => ({ rejection: 401 }) as const);
    const routes = makeRoutesWithAccess(manager, process.cwd(), { remoteAdmission: shortSource });
    const events = makeEventsRouteWithAccess(manager, { remotePeerAdmission: peerSource });
    const health = makeHealthRouteWithAccess(manager, { remoteAdmission: shortSource });
    const cases = routeMethodOrderCases(routes, events, health);
    for (const [path, method, run] of cases) {
      const res = unitShapeFakeRes();
      await run(fakeReq(method, path, undefined, { remote: "8.8.8.8" }), res);
      expect(res.state.status, `${path} ${method}`).toBe(401);
    }
    expect(shortSource).toHaveBeenCalledTimes(10);
    expect(peerSource).toHaveBeenCalledTimes(1);
  });
});

describe("官方 SSE admission 与 Peer 生命周期", () => {
  it("admitted Peer release 即时出表并 destroy", () => {
    const { manager } = setup();
    const admitted = admittedPeer();
    const source = vi.fn(() => () => ({ peer: admitted.peer }));
    const route = makeEventsRouteWithAccess(manager, { remotePeerAdmission: source });
    const res = unitShapeFakeRes();
    route.handler(fakeReq("GET", ROUTES.events, undefined, { remote: "8.8.8.8" }), res);
    expect(source).toHaveBeenCalledTimes(1);
    expect(admitted.effect).toHaveBeenCalledTimes(1);
    expect(manager.sseHub?.size()).toBe(1);

    admitted.release();
    expect(manager.sseHub?.size()).toBe(0);
    expect(res.state.destroyed).toBe(true);
  });

  it("客户端 close 幂等释放 Peer effect", () => {
    const { manager } = setup();
    const admitted = admittedPeer();
    const route = makeEventsRouteWithAccess(manager, {
      remotePeerAdmission: () => () => ({ peer: admitted.peer }),
    });
    const res = unitShapeFakeRes();
    route.handler(fakeReq("GET", ROUTES.events, undefined, { remote: "8.8.8.8" }), res);
    res.state.onClose!();
    res.state.onClose!();
    expect(manager.sseHub?.size()).toBe(0);
    expect(admitted.dispose).toHaveBeenCalledTimes(1);
  });

  it("拒绝先于 405；effect 注册失败不写 200 也不登记", () => {
    const { manager } = setup();
    const rejected = unitShapeFakeRes();
    makeEventsRouteWithAccess(manager, {
      remotePeerAdmission: () => () => ({ rejection: 401 }) as const,
    }).handler(fakeReq("POST", ROUTES.events, undefined, { remote: "8.8.8.8" }), rejected);
    expect(rejected.state.status).toBe(401);
    expect(manager.sseHub).toBeUndefined();

    const admitted = admittedPeer();
    admitted.peer.ctx.effect.mockImplementation(() => {
      throw new Error("peer disposed");
    });
    const unavailable = unitShapeFakeRes();
    makeEventsRouteWithAccess(manager, {
      remotePeerAdmission: () => () => ({ peer: admitted.peer }),
    }).handler(fakeReq("GET", ROUTES.events, undefined, { remote: "8.8.8.8" }), unavailable);
    expect(unavailable.state.status).toBe(403);
    expect(manager.sseHub).toBeUndefined();
  });

  it("loopback SSE 不调用官方 Peer admission", () => {
    const { manager } = setup();
    const source = vi.fn(() => () => ({ peer: admittedPeer().peer }));
    const res = unitShapeFakeRes();
    makeEventsRouteWithAccess(manager, { remotePeerAdmission: source }).handler(
      fakeReq("GET", ROUTES.events),
      res,
    );
    expect(source).not.toHaveBeenCalled();
    expect(res.state.status).toBe(200);
    expect(manager.sseHub?.size()).toBe(1);
  });
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
