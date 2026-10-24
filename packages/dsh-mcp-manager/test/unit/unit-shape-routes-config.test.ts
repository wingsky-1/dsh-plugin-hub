/**
 * dsh-mcp-manager — unit：路由的配置/导入面（import-json、POST /config、tool-disable、resume）。
 *
 * 自然职责拆分（#1174 阶段 2 形状清债）：这些 describe 只碰「写面」路由（导入、配置落盘、
 * 工具禁用、resume），与 SSE 帧/心跳/health/围栏等读面无共享断言面。原与读面同处一个
 * 799 行文件（挂账 max-lines 一条），故整块迁到本文件；describe 标题沿用原名，fullName 不变。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { callHandler, installCompositionPorts, releaseCompositionPorts } from "../helpers.ts";
import {
  ROUTES,
  makeRoutes,
  unitShapeCleanupRoutes,
  unitShapeFakeReq as fakeReq,
  unitShapeRoutesFixture,
  unitShapeSetupRoutes,
} from "./unit-shape-routes-support.ts";

const fixture = unitShapeRoutesFixture();
const setup = () => unitShapeSetupRoutes(fixture);

beforeAll(() => {
  installCompositionPorts();
});

afterAll(() => {
  releaseCompositionPorts();
});

afterEach(() => {
  unitShapeCleanupRoutes(fixture);
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
