// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 路由面：tool-disable 三态。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的「路由（makeRoutes / events / health /
// tool-disable / resume）」describe 按自然族拆分，本文件只留 tool-disable 三态 一族，fullName 与
// 断言逐字保留（套件名沿用原标题）。tool-disable 的缺参 400 / 非法 root 400 / 合法写入与 mcp__ 前缀剥离，判据与原文件逐条相同。
//
// import 实例纪律（与原文件一致，不得改动）：lib/index.js 是自包含 bundle、有自己一份已装配的
// 六张静态端口单例；本文件同时从 src 域门面取符号，故按同实参、同顺序手装组合根端口
// （重复装配会抛，故 beforeAll 只装一次、afterAll 逆序释放）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installCompositionPorts, releaseCompositionPorts } from "../helpers.ts";
import { ROUTES, makeRoutes } from "../../lib/index.js";
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

  it("tool-disable：缺 server/tool → 400；root 不属于工作空间 / setToolDisabled 未挂 → 400", async () => {
    const res1 = fakeRes();
    await find(ROUTES.toolDisable).handler(
      fakeReq("PATCH", ROUTES.toolDisable, { tool: "t", disabled: true }),
      res1,
    );
    expect(res1.state.status).toBe(400);
    const res2 = fakeRes();
    await find(ROUTES.toolDisable).handler(
      fakeReq("PATCH", ROUTES.toolDisable, { server: "@x/s", tool: "t", disabled: true }),
      res2,
    );
    expect(res2.state.status, "root 不属于工作空间或不可写 → 400").toBe(400);
  });

  it("tool-disable：合法请求 → 200 且调用 setToolDisabled（scope=global → @global root）", async () => {
    const calls: { root: string; server: string; tool: string; disabled: boolean }[] = [];
    const tdManager = {
      ...manager,
      projectRoot: "/proj",
      setToolDisabled: async (root: string, server: string, tool: string, disabled: boolean) => {
        calls.push({ root, server, tool, disabled });
      },
    };
    const tdRoutes = makeRoutes(
      tdManager as unknown as Parameters<typeof makeRoutes>[0],
      process.cwd(),
    );
    const tdRoute = tdRoutes.find((route) => route.path === ROUTES.toolDisable)!;
    const res = fakeRes();
    await tdRoute.handler(
      fakeReq("PATCH", ROUTES.toolDisable, {
        server: "@/proj/ctx",
        tool: "use_ctx",
        disabled: true,
      }),
      res,
    );
    expect(res.state.status).toBe(200);
    expect(calls).toEqual([{ root: "/proj", server: "ctx", tool: "use_ctx", disabled: true }]);
    // #392 遗留④：带 mcp__ 前缀的 tool 名剥前缀后入禁用表（旧客户端/手工 API 提交
    // 带前缀名仍生效；此前原样存键 → guard 查裸名不命中，禁用静默无效）。
    const resPrefix = fakeRes();
    await tdRoute.handler(
      fakeReq("PATCH", ROUTES.toolDisable, {
        server: "@/proj/ctx",
        tool: "mcp__ctx__use_ctx",
        disabled: true,
      }),
      resPrefix,
    );
    expect(resPrefix.state.status).toBe(200);
    expect(calls[calls.length - 1], "前缀名剥前缀入禁用表").toEqual({
      root: "/proj",
      server: "ctx",
      tool: "use_ctx",
      disabled: true,
    });
    // 跨 server 前缀（剥后仍 mcp__ 开头）→ 400（防错禁他 server 工具）。
    const resCross = fakeRes();
    await tdRoute.handler(
      fakeReq("PATCH", ROUTES.toolDisable, {
        server: "@/proj/ctx",
        tool: "mcp__other__t",
        disabled: true,
      }),
      resCross,
    );
    expect(resCross.state.status, "跨 server 前缀拒绝").toBe(400);
    // 全局 root：scope=global 的服务器以 @global 为 key。
    const resG = fakeRes();
    await tdRoute.handler(
      fakeReq("PATCH", ROUTES.toolDisable, {
        server: "@/proj/gctx",
        tool: "use_g",
        disabled: true,
      }),
      resG,
    );
    expect(resG.state.status, "global 服务器（store 条目）以项目 root 为 key 可写").toBe(200);
  });
});
