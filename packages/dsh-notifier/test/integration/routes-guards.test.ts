// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — e2e（HTTP 路由围栏域）：五/七条路由注册面、403 loopback 围栏、
 * 405 方法白名单（含 body 文案）、/health 配置摘要与 SSE 连接数。
 *
 * 拆法：原 routes.test.ts（1465 行 / 259 断言单链）按功能域拆为五个文件——
 * 本文件承载「围栏与只读探测」域（路由注册面 + sseData 导出面 + 403 + 405 +
 * health）。边界依据：这些块只读同一 apply 实例的路由表、不写 settings user 层、
 * 不依赖任何跨块累计状态，因此可独立前缀重放且互不干扰。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier, fakeReq, makeRes } from "../helpers.ts";
import { ROUTES } from "../../src/index.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-routes-guards-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** 单次路由调用（回收 rec）。 */
async function call(route, req) {
  const { rec, res } = makeRes();
  await route.handler(req, res);
  return rec;
}

/** 主实例（路由表 + 独立 history 文件）。 */
function mainRoutes() {
  const mainNotifier = makeNotifier(work, { historyFile: join(work, "history-route.jsonl") });
  const near = (p) => mainNotifier.routes.find((r) => r.path === p);
  return {
    mainNotifier,
    configRoute: near(ROUTES.config),
    eventsRoute: near(ROUTES.events),
    healthRoute: near(ROUTES.health),
    testRoute: near(ROUTES.test),
    historyRoute: near(ROUTES.history),
    statusRoute: near(ROUTES.status),
    kindsRoute: near(ROUTES.kinds),
  };
}

describe("路由注册面与导出面收敛锚定", () => {
  it("七条路由已注册（M2 增 status/kinds）", async () => {
    const f = mainRoutes();
    try {
      expect(f.configRoute && f.eventsRoute && f.healthRoute && f.testRoute && f.historyRoute && f.statusRoute && f.kindsRoute).toBeTruthy();
    } finally {
      f.mainNotifier.dispose();
    }
  });

  it("lib/index.js 不得可见 sseData（notifier 从不导出该符号）", async () => {
    // 收敛锚定：sseData 收敛 shared/host-utils.js 后 notifier 导出面不变——
    // 不得新增 sseData 导出（现状从不导出，防未来误加导出面漂移）。
    const lib = await import("../../src/index.ts");
    expect(!("sseData" in lib)).toBeTruthy();
  });
});

// 403——含新路由（围栏必项，评审缺口项）；403 body 文案断言（守卫收敛后逐字节锁定）
describe("403 loopback 围栏：全部路由拒绝非回环来源", () => {
  let f: ReturnType<typeof mainRoutes>;
  const routesOf = () => [f.configRoute, f.eventsRoute, f.healthRoute, f.testRoute, f.historyRoute, f.statusRoute, f.kindsRoute];
  const names = ["config", "events", "health", "test", "history", "status", "kinds"];

  beforeAll(() => {
    f = mainRoutes();
  });
  afterAll(() => {
    f.mainNotifier.dispose();
  });

  for (let i = 0; i < names.length; i += 1) {
    it(`/${names[i]}：非回环来源 → 403`, async () => {
      const rec = await call(routesOf()[i], fakeReq({ socket: { remoteAddress: "10.0.0.2" } }));
      expect(rec.status).toBe(403);
    });
  }

  for (let i = 0; i < names.length; i += 1) {
    it(`/${names[i]}：403 body 围栏文案`, async () => {
      const rec = await call(routesOf()[i], fakeReq({ socket: { remoteAddress: "10.0.0.2" } }));
      expect(JSON.parse(rec.text).error).toBe("forbidden: loopback-only");
    });
  }
});

// 405：test 路由仅 POST；history 路由 GET/DELETE；health 仅 GET；status 仅 GET；kinds 仅 GET/POST
describe("405 方法白名单", () => {
  let f: ReturnType<typeof mainRoutes>;

  beforeAll(() => {
    f = mainRoutes();
  });
  afterAll(() => {
    f.mainNotifier.dispose();
  });

  it("test 路由 GET → 405", async () => {
    expect((await call(f.testRoute, fakeReq({}))).status).toBe(405);
  });

  it("history 路由 POST → 405", async () => {
    expect((await call(f.historyRoute, fakeReq({ method: "POST" }))).status).toBe(405);
  });

  it("history POST 405 body 文案", async () => {
    // history（GET/DELETE 白名单）POST → 405 + error 文案
    const rec = await call(f.historyRoute, fakeReq({ method: "POST" }));
    expect(JSON.parse(rec.text).error).toBe("method not allowed: POST");
  });

  it("health 路由 DELETE → 405", async () => {
    expect((await call(f.healthRoute, fakeReq({ method: "DELETE" }))).status).toBe(405);
  });

  it("health DELETE 405 body 文案", async () => {
    // 单方法端点 405 body 文案断言
    const rec = await call(f.healthRoute, fakeReq({ method: "DELETE" }));
    expect(JSON.parse(rec.text).error).toBe("method not allowed: DELETE");
  });

  it("status 路由 POST → 405", async () => {
    expect((await call(f.statusRoute, fakeReq({ method: "POST" }))).status).toBe(405);
  });

  it("kinds 路由 DELETE → 405", async () => {
    expect((await call(f.kindsRoute, fakeReq({ method: "DELETE" }))).status).toBe(405);
  });

  it("kinds DELETE 405 body 文案", async () => {
    // kinds（GET/POST 白名单）DELETE → 405 + error 文案
    const rec = await call(f.kindsRoute, fakeReq({ method: "DELETE" }));
    expect(JSON.parse(rec.text).error).toBe("method not allowed: DELETE");
  });

  it("config 路由 DELETE → 405", async () => {
    // config（GET/PUT 白名单）补非法方法锚 DELETE → 405 + error 文案
    expect((await call(f.configRoute, fakeReq({ method: "DELETE" }))).status).toBe(405);
  });

  it("config DELETE 405 body 文案", async () => {
    const rec = await call(f.configRoute, fakeReq({ method: "DELETE" }));
    expect(JSON.parse(rec.text).error).toBe("method not allowed: DELETE");
  });
});

// health：配置摘要与 sseConnections（platform + browserSound/systemSound）
describe("/health 配置摘要与 SSE 连接数", () => {
  let rec: any;
  let body: any;

  beforeAll(async () => {
    const f = mainRoutes();
    try {
      rec = await call(f.healthRoute, fakeReq({}));
      body = JSON.parse(rec.text);
    } finally {
      f.mainNotifier.dispose();
    }
  });

  it("/health 返回 200", () => {
    expect(rec.status).toBe(200);
  });

  it("/health ok=true", () => {
    expect(body.ok).toBe(true);
  });

  it("/health plugin 名", () => {
    expect(body.plugin).toBe("dsh-notifier");
  });

  it("D1：/health 返回宿主平台（process.platform）", () => {
    expect(typeof body.platform).toBe("string");
  });

  it("D1：platform 为合法三平台值", () => {
    expect(["linux", "darwin", "win32"].includes(body.platform)).toBeTruthy();
  });

  it("health 返回配置摘要", () => {
    expect(typeof body.config.notifyAsk).toBe("boolean");
  });

  it("health 摘要含 maxConnections（与默认配置一致）", () => {
    expect(body.config.maxConnections).toBe(16);
  });

  it("D1：health 摘要含 browserSound", () => {
    expect(body.config.browserSound).toBe(true);
  });

  it("D1：health 摘要含 systemSound", () => {
    expect(body.config.systemSound).toBe(true);
  });

  it("health 含 sseConnections 计数", () => {
    expect(typeof body.sseConnections).toBe("number");
  });
});
