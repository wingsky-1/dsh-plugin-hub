// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 路由面：session 会话切换。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的「路由（makeRoutes / events / health /
// tool-disable / resume）」describe 按自然族拆分，本文件只留 session 会话切换 一族，fullName 与
// 断言逐字保留（套件名沿用原标题）。POST/GET session 与 scope 透传，判据与原文件逐条相同。
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
  let cleanup!: RoutesFixture["cleanup"];
  let managerState!: RoutesFixture["managerState"];
  let find!: RoutesFixture["find"];
  let fakeReq!: RoutesFixture["fakeReq"];

  beforeAll(() => {
    ({ cleanup, managerState, find, fakeReq } = makeRoutesFixture());
  });

  afterAll(async () => {
    cleanup();
  });

  it("POST session {cwd} → 200 并记录会话", async () => {
    const res = fakeRes();
    await find(ROUTES.session).handler(fakeReq("POST", ROUTES.session, { cwd: "C:/proj" }), res);
    expect(res.state.status).toBe(200);
    expect(managerState.sessionCwd).toBe("C:/proj");
  });

  it("GET servers?cwd= 不触发会话切换（#324 纯读）", async () => {
    // #324：GET /servers 是纯读快照，cwd 参数被忽略（不再触发 setSession）。
    // 会话切换只走 POST /api/dsh-mcp/session。
    await find(ROUTES.session).handler(
      fakeReq("POST", ROUTES.session, { cwd: "C:/proj" }),
      fakeRes(),
    );
    const res = fakeRes();
    await find(ROUTES.servers).handler(fakeReq("GET", `${ROUTES.servers}?cwd=C:/other`), res);
    expect(res.state.status).toBe(200);
    expect(managerState.sessionCwd, "GET 不应改变会话 cwd").toBe("C:/proj");
  });

  it("POST servers scope=project 透传 scope", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(
      fakeReq("POST", ROUTES.servers, {
        name: "proj-mcp",
        transport: "stdio",
        command: "x",
        scope: "project",
      }),
      res,
    );
    expect(res.state.status).toBe(201);
    expect(managerState.lastScope).toBe("project");
  });

  it("DELETE ?scope=project 透传 scope", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(
      fakeReq("DELETE", `${ROUTES.servers}?name=proj-mcp&scope=project`),
      res,
    );
    expect(res.state.status).toBe(200);
    expect(managerState.lastScope).toBe("project");
  });

  it("session 缺 cwd → 400", async () => {
    const res = fakeRes();
    await find(ROUTES.session).handler(fakeReq("POST", ROUTES.session, {}), res);
    expect(res.state.status).toBe(400);
  });
});
