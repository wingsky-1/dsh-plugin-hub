/**
 * dsh-mcp-manager — unit：路由 handler 热点（connect / disconnect / reconnect）。
 *
 * 方法：通过 makeRoutes 调用实际 route handler 覆盖 connect/disconnect/reconnect 路由。
 * 驱动 apply() 的那组热点（settings 生命周期、agent/pre-step 注册、SSE broadcast、
 * settings 注入）已整段迁至 test/integration/apply-lifecycle.test.ts——apply 是组合根
 * 装配体且就地定义在 src/index.ts 内，§8 导入面矩阵把它列为集成层的许可导入面。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RoutesManager } from "../../src/server/connection/interface.ts";
import { fakeManagerCtx, installCompositionPorts, releaseCompositionPorts } from "../helpers.ts";

// I8①：单元层不得值引组合根 src/index.ts——路由工厂与管理器改经各自域门面直取，
// 组合根顶层那六张静态端口表由 helpers 以同实参、同顺序手装。
const { makeRoutes, ROUTES } = await import("../../src/server/api/interface.ts");
const { McpManager } = await import("../../src/server/connection/orchestrator/interface.ts");
const { McpStore } = await import("../../src/server/store/interface.ts");
const { normalizeServer } = await import("../../src/server/config/interface.ts");

beforeAll(() => {
  installCompositionPorts();
});

afterAll(() => {
  releaseCompositionPorts();
});

let tempDirs: string[] = [];

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("路由 handlers：connect / disconnect / reconnect", () => {
  function makeRoutesFixture() {
    const dir = makeTempDir("dsh-mcp-manager-route-");
    const store = new McpStore(join(dir, "mcp.json"));
    store.data = { version: 1, servers: [] };
    // 添加一个测试服务器（不真实连接，只验证路由 handler 可被调用）
    store.upsert(normalizeServer({ name: "route-test", transport: "stdio", command: "echo" }));
    const manager = new McpManager(fakeManagerCtx(), store);

    const routes = makeRoutes(manager);
    return { routes, manager, find: (path: string) => routes.find((r) => r.path === path) };
  }

  // 伪造 req/res：只实现 handler 实际读取的面，其余按接缝收窄（`as unknown as`）。
  function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
    return {
      method,
      url,
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        host: "localhost:3080",
        origin: "http://localhost:3080",
        "sec-fetch-site": "same-origin",
      },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body));
      },
    } as unknown as IncomingMessage;
  }

  function fakeRes(): ServerResponse & {
    state: { status: number; body: string; headers: Record<string, string> };
  } {
    const state: { status: number; body: string; headers: Record<string, string> } = {
      status: 200,
      body: "",
      headers: {},
    };
    return {
      state,
      writeHead: (s: number, h?: Record<string, string>) => {
        state.status = s;
        if (h) state.headers = h;
      },
      write: (chunk: { toString(): string }) => {
        state.body += chunk.toString();
      },
      end: (chunk?: { toString(): string }) => {
        if (chunk) state.body += chunk.toString();
      },
      setHeader: () => {},
      on: () => {},
      destroy: () => {},
    } as unknown as ServerResponse & {
      state: { status: number; body: string; headers: Record<string, string> };
    };
  }

  it("connect 缺 name → 400", async () => {
    const { find } = makeRoutesFixture();
    const res = fakeRes();
    await find(ROUTES.connect)!.handler(fakeReq("POST", ROUTES.connect), res);
    expect(res.state.status).toBe(400);
  });

  // #767 S1-5b：scope 查询参数的归一化契约。五条吃 scope 的路由共用 routes.ts 的 scopeParam
  // 一处归一化（缺省/非法值 → normalizeScope），此前零判据。这里不挂真 McpManager，改挂一个
  // 记录实参的假 manager：判据要打的是「路由下传给 manager 的那一个值」，不是 manager 内部行为。
  function scopeCaptureFixture() {
    const calls: [unknown, unknown][] = [];
    const manager = {
      async setSession() {},
      async connect(name: string, scope?: string) {
        calls.push([name, scope]);
      },
      async disconnect() {},
      async reconnect() {},
      async remove() {},
      async update() {},
      async add() {},
      async projectStoreOrThrow() {
        return { data: { version: 1, servers: [] } };
      },
      summary: () => ({ servers: [] }),
      store: { data: { version: 1, servers: [] } },
    };
    return { calls, manager };
  }

  it("connect 不带 scope 与 scope=global 下传同一个归一化值（#767 S1-5b）", async () => {
    const { calls, manager } = scopeCaptureFixture();
    // 记录实参的假 manager：只实现路由触达的面，按接缝收窄。
    const route = makeRoutes(manager as unknown as RoutesManager).find(
      (r) => r.path === ROUTES.connect,
    );
    // 1) 不带 scope：空串必须被归一化为 "global"，不得原样下传（空串会落进
    //    middlewareTakes(name, "") 的另一条引擎分支，注册名与 userDisabled 清理都与显式
    //    scope=global 分叉）。改前把 scopeParam 换回 queryParam(url, "scope") ?? "" 时这一步红。
    await route!.handler(fakeReq("POST", `${ROUTES.connect}?name=scope-test`), fakeRes());
    // 2) 显式 scope=global：两者逐字相同。
    await route!.handler(
      fakeReq("POST", `${ROUTES.connect}?name=scope-test&scope=global`),
      fakeRes(),
    );
    expect(calls[0][1], "缺 scope 归一化为 global").toBe("global");
    expect(calls[1][1], "显式 scope=global").toBe("global");
    expect(calls[0][1], "两条路径下传同一个值").toBe(calls[1][1]);
    expect(
      calls.map((c) => c[0]),
      "name 原样下传",
    ).toEqual(["scope-test", "scope-test"]);
    // 3) 对照：显式 scope=project 必须原样下传，归一化不是「一律 global」。
    await route!.handler(
      fakeReq("POST", `${ROUTES.connect}?name=scope-test&scope=project`),
      fakeRes(),
    );
    expect(calls[2][1], "显式 scope=project").toBe("project");
  });

  it("connect 合法 name → 200", async () => {
    const { find, manager } = makeRoutesFixture();
    // 单池后连接只有中间层一条路径：装配实例（未装 lifecycle 时条目落 failed，仍 200）。
    await manager.initMiddleware();
    const res = fakeRes();
    await find(ROUTES.connect)!.handler(fakeReq("POST", `${ROUTES.connect}?name=route-test`), res);
    expect(res.state.status).toBe(200);
  });

  it("disconnect 缺 name → 400", async () => {
    const { find } = makeRoutesFixture();
    const res = fakeRes();
    await find(ROUTES.disconnect)!.handler(fakeReq("POST", ROUTES.disconnect), res);
    expect(res.state.status).toBe(400);
  });

  it("disconnect 合法 name → 200", async () => {
    const { find } = makeRoutesFixture();
    const res = fakeRes();
    await find(ROUTES.disconnect)!.handler(
      fakeReq("POST", `${ROUTES.disconnect}?name=route-test`),
      res,
    );
    expect(res.state.status).toBe(200);
  });

  it("reconnect 缺 name → 400", async () => {
    const { find } = makeRoutesFixture();
    const res = fakeRes();
    await find(ROUTES.reconnect)!.handler(fakeReq("POST", ROUTES.reconnect), res);
    expect(res.state.status).toBe(400);
  });

  it("reconnect 合法 name → 200", async () => {
    const { find, manager } = makeRoutesFixture();
    await manager.initMiddleware();
    const res = fakeRes();
    await find(ROUTES.reconnect)!.handler(
      fakeReq("POST", `${ROUTES.reconnect}?name=route-test`),
      res,
    );
    expect(res.state.status).toBe(200);
  });

  it("connect GET → 405", async () => {
    const { find } = makeRoutesFixture();
    const res = fakeRes();
    await find(ROUTES.connect)!.handler(fakeReq("GET", ROUTES.connect), res);
    expect(res.state.status).toBe(405);
  });

  it("connect 非 loopback → 403", async () => {
    const { find } = makeRoutesFixture();
    const res = fakeRes();
    const extReq = {
      method: "POST",
      url: ROUTES.connect,
      socket: { remoteAddress: "192.168.1.1" },
      headers: { host: "localhost:3080", origin: "http://external" },
      async *[Symbol.asyncIterator]() {},
    };
    await find(ROUTES.connect)!.handler(extReq as unknown as IncomingMessage, res);
    expect(res.state.status).toBe(403);
  });
});
