// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 路由面：resume 可用性恢复。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的「路由（makeRoutes / events / health /
// tool-disable / resume）」describe 按自然族拆分，本文件只留 resume 可用性恢复 一族，fullName 与
// 断言逐字保留（套件名沿用原标题）。resume 的 body 兼容面（无 body / cwd 透传 / 非法 body）与围栏，判据与原文件逐条相同。
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
  let fakeFenceBroken!: RoutesFixture["fakeFenceBroken"];

  beforeAll(() => {
    ({ cleanup, managerState, find, fakeReq, fakeFenceBroken } = makeRoutesFixture());
  });

  afterAll(async () => {
    cleanup();
  });

  it("resume：POST 合法 → 200 + 调用 resumeReconnect；围栏 403 / GET 405", async () => {
    const before = managerState.resumed;
    const res = fakeRes();
    await find(ROUTES.resume).handler(fakeReq("POST", ROUTES.resume), res);
    expect(res.state.status).toBe(200);
    expect(managerState.resumed, "resumeReconnect 被调用（#412 切回前台恢复入口）").toBe(
      before + 1,
    );
    // 旧无 body 请求：cwd 透传 undefined（服务端回落既有绑定）。
    expect(managerState.resumedCwds[managerState.resumedCwds.length - 1]).toBe(undefined);
    const res403 = fakeRes();
    await find(ROUTES.resume).handler(fakeFenceBroken("POST", ROUTES.resume), res403);
    expect(res403.state.status).toBe(403);
    const res405 = fakeRes();
    await find(ROUTES.resume).handler(fakeReq("GET", ROUTES.resume), res405);
    expect(res405.state.status).toBe(405);
  });

  it("resume：带 cwd body 透传本次 root；cwd 非字符串 400", async () => {
    const withCwd = fakeRes();
    await find(ROUTES.resume).handler(fakeReq("POST", ROUTES.resume, { cwd: "/proj/a" }), withCwd);
    expect(withCwd.state.status).toBe(200);
    expect(managerState.resumedCwds[managerState.resumedCwds.length - 1]).toBe("/proj/a");
    // 明确无工作区：cwd:"" 透传（服务端固定 @global，不回落他人绑定）。
    const explicitGlobal = fakeRes();
    await find(ROUTES.resume).handler(fakeReq("POST", ROUTES.resume, { cwd: "" }), explicitGlobal);
    expect(explicitGlobal.state.status).toBe(200);
    expect(managerState.resumedCwds[managerState.resumedCwds.length - 1]).toBe("");
    // 非法 body：cwd 非字符串 → 400 且不触发恢复。
    const before = managerState.resumed;
    const bad = fakeRes();
    await find(ROUTES.resume).handler(fakeReq("POST", ROUTES.resume, { cwd: 7 }), bad);
    expect(bad.state.status).toBe(400);
    expect(managerState.resumed).toBe(before);
  });

  it("resume：数组/原始值/畸形 JSON → 400 且不触发恢复；无 body 兼容不变", async () => {
    // 数组是合法 JSON 但不是请求体对象：拒绝且不触发恢复（不回落既有绑定）。
    const before = managerState.resumed;
    const arr = fakeRes();
    await find(ROUTES.resume).handler(fakeReq("POST", ROUTES.resume, [1, 2]), arr);
    expect(arr.state.status).toBe(400);
    // 原始值（JSON 字符串）不是对象：同样 400。
    const prim = fakeRes();
    await find(ROUTES.resume).handler(fakeReq("POST", ROUTES.resume, "str"), prim);
    expect(prim.state.status).toBe(400);
    // 畸形 JSON：原始字节直送（不经 JSON.stringify）。
    const malformed = fakeRes();
    await find(ROUTES.resume).handler(
      {
        method: "POST",
        url: ROUTES.resume,
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "localhost:3080",
          origin: "http://localhost:3080",
          "sec-fetch-site": "same-origin",
        },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from("{not json");
        },
      } as unknown as IncomingMessage,
      malformed,
    );
    expect(malformed.state.status).toBe(400);
    expect(managerState.resumed).toBe(before);
    // 无 body 兼容：仍 200 且 cwd 透传 undefined（回落既有绑定）。
    const compat = fakeRes();
    await find(ROUTES.resume).handler(fakeReq("POST", ROUTES.resume), compat);
    expect(compat.state.status).toBe(200);
    expect(managerState.resumedCwds[managerState.resumedCwds.length - 1]).toBe(undefined);
    expect(managerState.resumed).toBe(before + 1);
  });
});
