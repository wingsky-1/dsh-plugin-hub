// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 路由面：白名单外方法 405 文案。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的「路由（makeRoutes / events / health /
// tool-disable / resume）」describe 按自然族拆分，本文件只留 白名单外方法 405 文案 一族，fullName 与
// 断言逐字保留（套件名沿用原标题）。servers / config 与各单方法端点的白名单外方法 405 + error 文案逐字，判据与原文件逐条相同。
//
// import 实例纪律（与原文件一致，不得改动）：lib/index.js 是自包含 bundle、有自己一份已装配的
// 六张静态端口单例；本文件同时从 src 域门面取符号，故按同实参、同顺序手装组合根端口
// （重复装配会抛，故 beforeAll 只装一次、afterAll 逆序释放）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installCompositionPorts, releaseCompositionPorts } from "../helpers.ts";
import { makeEventsRoute, makeHealthRoute, ROUTES } from "../../lib/index.js";
import { fakeRes, makeRoutesFixture } from "./smoke-routes-shape-support.ts";
import type { RoutesFixture } from "./smoke-routes-shape-support.ts";

beforeAll(() => {
  installCompositionPorts();
});

afterAll(() => {
  releaseCompositionPorts();
});

describe("路由（makeRoutes / events / health / tool-disable / resume）", () => {
  let cleanup!: RoutesFixture["cleanup"];
  let manager!: RoutesFixture["manager"];
  let find!: RoutesFixture["find"];
  let fakeReq!: RoutesFixture["fakeReq"];

  beforeAll(() => {
    ({ cleanup, manager, find, fakeReq } = makeRoutesFixture());
  });

  afterAll(async () => {
    cleanup();
  });

  it("白名单外方法 → 405 + error 文案逐字（每端点 ≥1 锚；servers 为最大写面补缺）", async () => {
    // servers（R3 最大写面端点）：白名单 GET/POST/PATCH/DELETE 之外的方法 → 405+文案
    // 逐字——防守卫白名单误多列方法（围栏实质放宽而 403 用例仍绿）。
    for (const method of ["OPTIONS", "PUT"] as const) {
      const res = fakeRes();
      await find(ROUTES.servers).handler(fakeReq(method, ROUTES.servers), res);
      expect(res.state.status, `servers ${method} → 405`).toBe(405);
      expect(JSON.parse(res.state.body).error, `servers ${method} 405 文案逐字`).toBe(
        `method not allowed: ${method}`,
      );
    }
    // config（结构 β）：PUT 405 由 else 分支直出（不查 loopback），文案同源逐字。
    const cfgPut = fakeRes();
    await find(ROUTES.config).handler(
      fakeReq("PUT", ROUTES.config, { position: "bottom-right" }),
      cfgPut,
    );
    expect(cfgPut.state.status).toBe(405);
    expect(JSON.parse(cfgPut.state.body).error, "config PUT 405 文案逐字").toBe(
      "method not allowed: PUT",
    );
    const cfgOptions = fakeRes();
    await find(ROUTES.config).handler(fakeReq("OPTIONS", ROUTES.config), cfgOptions);
    expect(cfgOptions.state.status).toBe(405);
    expect(JSON.parse(cfgOptions.state.body).error, "config OPTIONS 405 文案逐字").toBe(
      "method not allowed: OPTIONS",
    );
    // 单方法端点：每端点 ≥1 非法方法 405+文案（守卫收口后错误文案统一出自 shared）。
    // events/health 不在 makeRoutes 返回列表（独立工厂路由），单独取 handler。
    const wrong: Array<[string, string, string]> = [
      ["session", ROUTES.session, "GET"],
      ["resume", ROUTES.resume, "GET"],
      ["connect", ROUTES.connect, "GET"],
      ["disconnect", ROUTES.disconnect, "GET"],
      ["reconnect", ROUTES.reconnect, "GET"],
      ["importJson", ROUTES.importJson, "GET"],
      ["toolDisable", ROUTES.toolDisable, "GET"],
    ];
    for (const [label, path, method] of wrong) {
      const res = fakeRes();
      await find(path).handler(fakeReq(method, path), res);
      expect(res.state.status, `${label} ${method} → 405`).toBe(405);
      expect(JSON.parse(res.state.body).error, `${label} 405 文案逐字`).toBe(
        `method not allowed: ${method}`,
      );
    }
    const eventsWrong = fakeRes();
    await makeEventsRoute(manager as unknown as Parameters<typeof makeEventsRoute>[0]).handler(
      fakeReq("POST", ROUTES.events),
      eventsWrong,
    );
    expect(eventsWrong.state.status).toBe(405);
    expect(JSON.parse(eventsWrong.state.body).error, "events 405 文案逐字").toBe(
      "method not allowed: POST",
    );
    const healthWrong = fakeRes();
    await makeHealthRoute(manager as unknown as Parameters<typeof makeHealthRoute>[0]).handler(
      fakeReq("POST", ROUTES.health),
      healthWrong,
    );
    expect(healthWrong.state.status).toBe(405);
    expect(JSON.parse(healthWrong.state.body).error, "health 405 文案逐字").toBe(
      "method not allowed: POST",
    );
  });
});
