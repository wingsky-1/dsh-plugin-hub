// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 路由面：servers CRUD。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的「路由（makeRoutes / events / health /
// tool-disable / resume）」describe 按自然族拆分，本文件只留 servers CRUD 一族，fullName 与
// 断言逐字保留（套件名沿用原标题）。被测对象是真实 makeRoutes 产物 + 假 manager，判据面（servers 增删改查、loopback 403）与原文件逐条相同。
//
// import 实例纪律（与原文件一致，不得改动）：lib/index.js 是自包含 bundle、有自己一份已装配的
// 六张静态端口单例；本文件同时从 src 域门面取符号，故按同实参、同顺序手装组合根端口
// （重复装配会抛，故 beforeAll 只装一次、afterAll 逆序释放）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installCompositionPorts, releaseCompositionPorts } from "../helpers.ts";
import { ROUTES } from "../../lib/index.js";
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
  let routes!: RoutesFixture["routes"];
  let find!: RoutesFixture["find"];
  let fakeReq!: RoutesFixture["fakeReq"];
  let fakeFenceBroken!: RoutesFixture["fakeFenceBroken"];

  beforeAll(() => {
    ({ store, cleanup, routes, find, fakeReq, fakeFenceBroken } = makeRoutesFixture());
  });

  afterAll(async () => {
    cleanup();
  });

  it("注册 9 条 exact 路由（含 tool-disable / resume）", () => {
    expect(routes.length).toBe(9);
    for (const route of routes) expect(route.kind).toBe("exact");
  });

  it("GET servers → 200 + summary", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(fakeReq("GET", ROUTES.servers), res);
    expect(res.state.status).toBe(200);
    expect(JSON.parse(res.state.body)).toEqual({ servers: [], counts: {} });
  });

  it("POST servers → 201 + 添加", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(
      fakeReq("POST", ROUTES.servers, { name: "github", transport: "stdio", command: "npx" }),
      res,
    );
    expect(res.state.status).toBe(201);
    expect(store.find("github")!.command).toBe("npx");
  });

  it("POST 重复名称 → 400", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(
      fakeReq("POST", ROUTES.servers, { name: "github", transport: "stdio", command: "npx" }),
      res,
    );
    expect(res.state.status).toBe(400);
  });

  it("PATCH 更新 → 200", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(
      fakeReq("PATCH", `${ROUTES.servers}?name=github`, { args: ["-y", "x"] }),
      res,
    );
    expect(res.state.status).toBe(200);
    expect(store.find("github")!.args).toEqual(["-y", "x"]);
  });

  it("DELETE → 200 + 移除", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(fakeReq("DELETE", `${ROUTES.servers}?name=github`), res);
    expect(res.state.status).toBe(200);
    expect(store.find("github")).toBe(undefined);
  });

  it("非 loopback → 403", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(fakeFenceBroken("GET", ROUTES.servers), res);
    expect(res.state.status).toBe(403);
  });
});
