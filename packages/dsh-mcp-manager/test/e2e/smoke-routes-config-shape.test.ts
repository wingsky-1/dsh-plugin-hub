// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 路由面：config 读写。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的「路由（makeRoutes / events / health /
// tool-disable / resume）」describe 按自然族拆分，本文件只留 config 读写 一族，fullName 与
// 断言逐字保留（套件名沿用原标题）。config 端点的读回 / 写回 / 未知键 400 / 方法 405 围栏，判据与原文件逐条相同。
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
  let find!: RoutesFixture["find"];
  let fakeReq!: RoutesFixture["fakeReq"];
  let fakeFenceBroken!: RoutesFixture["fakeFenceBroken"];

  beforeAll(() => {
    ({ cleanup, find, fakeReq, fakeFenceBroken } = makeRoutesFixture());
  });

  afterAll(async () => {
    cleanup();
  });

  it("config GET → 200 读回（默认 top-right/8/8/40）", async () => {
    const res = fakeRes();
    await find(ROUTES.config).handler(fakeReq("GET", ROUTES.config), res);
    expect(res.state.status).toBe(200);
    const body = JSON.parse(res.state.body);
    expect(body.position).toBe("top-right");
    expect(body.offsetX).toBe(8);
    expect(body.offsetY).toBe(8);
    expect(body.blankY).toBe(40);
    // #767 笔 2：`middleware` 键已删，GET 只回 UI 配置（键集逐字相等防残留）。
    expect(Object.keys(body).sort(), "键集 = UI 配置 5 键的子集且无模式键").toEqual([
      "blankY",
      "offsetX",
      "offsetY",
      "position",
    ]);
  });

  it("config 非 loopback GET → 200（只读 UI 配置放开）", async () => {
    const res = fakeRes();
    await find(ROUTES.config).handler(fakeFenceBroken("GET", ROUTES.config), res);
    expect(res.state.status).toBe(200);
    const body = JSON.parse(res.state.body);
    expect(body.position).toBe("top-right");
    expect(body.offsetX).toBe(8);
  });

  it("config POST 写 → 200 且读回更新（配置读写）", async () => {
    const write = fakeRes();
    await find(ROUTES.config).handler(
      fakeReq("POST", ROUTES.config, {
        position: "bottom-right",
        offsetX: 12,
        offsetY: 20,
        blankY: 60,
      }),
      write,
    );
    expect(write.state.status).toBe(200);
    const written = JSON.parse(write.state.body);
    expect(written.position).toBe("bottom-right");
    expect(written.offsetX).toBe(12);
    // 读回：POST 后 GET /config 应反映新值（宿主经设置命名空间持久化后的归一化结果）。
    const read = fakeRes();
    await find(ROUTES.config).handler(fakeReq("GET", ROUTES.config), read);
    const readBack = JSON.parse(read.state.body);
    expect(readBack).toEqual({
      position: "bottom-right",
      offsetX: 12,
      offsetY: 20,
      blankY: 60,
      zIndexBase: 10,
    });
  });

  it("config POST 未知顶层键 → 400 且不落盘（M7）", async () => {
    const readNow = async () => {
      const read = fakeRes();
      await find(ROUTES.config).handler(fakeReq("GET", ROUTES.config), read);
      return JSON.parse(read.state.body);
    };
    const before = await readNow();
    // `middleware` / `middlewarePolicy` 已删（笔 2）：它们与任意陌生键同走 400 路径。
    for (const body of [{ middleware: "off" }, { middlewarePolicy: {} }, { foo: 1 }]) {
      const write = fakeRes();
      await find(ROUTES.config).handler(fakeReq("POST", ROUTES.config, body), write);
      expect(write.state.status, `未知键 ${JSON.stringify(body)} 应 400`).toBe(400);
      expect(JSON.parse(write.state.body).error).toMatch(/unknown config key\(s\)/);
    }
    expect(await readNow(), "未知键不落盘：读回与写前逐字相等").toEqual(before);
  });

  it("config POST 非 loopback → 403（写操作不开放远程页面）", async () => {
    const res = fakeRes();
    await find(ROUTES.config).handler(
      fakeFenceBroken("POST", ROUTES.config, { position: "bottom-right" }),
      res,
    );
    expect(res.state.status).toBe(403);
  });

  it("config PUT → 405（仅 GET/POST 合法；方法错围栏）", async () => {
    const res = fakeRes();
    await find(ROUTES.config).handler(
      fakeReq("PUT", ROUTES.config, { position: "bottom-right" }),
      res,
    );
    expect(res.state.status).toBe(405);
  });
});
