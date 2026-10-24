// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 路由面：围栏 403 / 405 与 import。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的「路由（makeRoutes / events / health /
// tool-disable / resume）」describe 按自然族拆分，本文件只留 围栏 403 / 405 与 import 一族，fullName 与
// 断言逐字保留（套件名沿用原标题）。events / health / import/json / tool-disable 的 loopback 与方法白名单围栏，判据与原文件逐条相同。
//
// import 实例纪律（与原文件一致，不得改动）：lib/index.js 是自包含 bundle、有自己一份已装配的
// 六张静态端口单例；本文件同时从 src 域门面取符号，故按同实参、同顺序手装组合根端口
// （重复装配会抛，故 beforeAll 只装一次、afterAll 逆序释放）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installCompositionPorts, releaseCompositionPorts } from "../helpers.ts";
import { ROUTES, makeEventsRoute, makeHealthRoute } from "../../lib/index.js";
import { fakeRes, makeRoutesFixture } from "./smoke-routes-shape-support.ts";
import type { RoutesFixture } from "./smoke-routes-shape-support.ts";

beforeAll(() => {
  installCompositionPorts();
});

afterAll(() => {
  releaseCompositionPorts();
});

describe("路由（makeRoutes / events / health / tool-disable / resume）", () => {
  let store!: RoutesFixture["store"];
  let cleanup!: RoutesFixture["cleanup"];
  let manager!: RoutesFixture["manager"];
  let find!: RoutesFixture["find"];
  let fakeReq!: RoutesFixture["fakeReq"];
  let fakeFenceBroken!: RoutesFixture["fakeFenceBroken"];

  beforeAll(() => {
    ({ store, cleanup, manager, find, fakeReq, fakeFenceBroken } = makeRoutesFixture());
  });

  afterAll(async () => {
    cleanup();
  });

  it("events 非 loopback → 403 / 方法错 → 405（围栏不回归）", async () => {
    const eventsRoute = makeEventsRoute(
      manager as unknown as Parameters<typeof makeEventsRoute>[0],
    );
    const res403 = fakeRes();
    await eventsRoute.handler(fakeFenceBroken("GET", ROUTES.events), res403);
    expect(res403.state.status).toBe(403);
    const res405 = fakeRes();
    await eventsRoute.handler(fakeReq("POST", ROUTES.events), res405);
    expect(res405.state.status).toBe(405);
  });

  it("health 非 loopback → 403 / 方法错 → 405（围栏不回归）", async () => {
    const healthRoute = makeHealthRoute(
      manager as unknown as Parameters<typeof makeHealthRoute>[0],
    );
    const res403 = fakeRes();
    await healthRoute.handler(fakeFenceBroken("GET", ROUTES.health), res403);
    expect(res403.state.status).toBe(403);
    const res405 = fakeRes();
    await healthRoute.handler(fakeReq("POST", ROUTES.health), res405);
    expect(res405.state.status).toBe(405);
  });

  it("import/json 导入", async () => {
    const res = fakeRes();
    await find(ROUTES.importJson).handler(
      fakeReq("POST", ROUTES.importJson, {
        json: JSON.stringify({ alpha: { command: "npx", args: ["-y", "a"] } }),
      }),
      res,
    );
    expect(res.state.status).toBe(200);
    const body = JSON.parse(res.state.body);
    expect(body.imported).toEqual(["alpha"]);
    expect(store.find("alpha")!.command).toBe("npx");
  });

  it("import/json 非法 JSON → 400", async () => {
    const res = fakeRes();
    await find(ROUTES.importJson).handler(
      fakeReq("POST", ROUTES.importJson, { json: "[1,2]" }),
      res,
    );
    expect(res.state.status).toBe(400);
  });

  it("tool-disable 围栏：非 loopback → 403 / GET → 405", async () => {
    const res403 = fakeRes();
    await find(ROUTES.toolDisable).handler(
      fakeFenceBroken("PATCH", ROUTES.toolDisable, { server: "@x/s", tool: "t", disabled: true }),
      res403,
    );
    expect(res403.state.status).toBe(403);
    const res405 = fakeRes();
    await find(ROUTES.toolDisable).handler(fakeReq("GET", ROUTES.toolDisable), res405);
    expect(res405.state.status).toBe(405);
  });
});
