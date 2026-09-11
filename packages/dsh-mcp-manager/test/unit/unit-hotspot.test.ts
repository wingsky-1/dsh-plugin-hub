// @ts-nocheck
/**
 * dsh-mcp-manager — unit：通过公共 API 覆盖剩余的未覆盖热点。
 *
 * 方法：通过 makeRoutes 调用实际 route handler 覆盖 connect/disconnect/reconnect 路由；
 * 通过 apply 完整 settings 生命周期覆盖 isUnloading。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const {
  apply,
  makeRoutes,
  ROUTES,
  McpStore,
  McpManager,
  normalizeServer,
} = await import("../../src/index.ts");

let tempDirs = [];

function makeTempDir(prefix) {
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
    const manager = new McpManager({ logger: { warn: () => {}, info: () => {}, error: () => {} } }, store);

    const routes = makeRoutes(manager);
    return { routes, find: (path) => routes.find((r) => r.path === path) };
  }

  // 伪造 req/res
  function fakeReq(method, url, body) {
    return {
      method,
      url,
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "localhost:3080", origin: "http://localhost:3080", "sec-fetch-site": "same-origin" },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body));
      },
    };
  }

  function fakeRes() {
    const state = { status: 200, body: "", headers: {} };
    return {
      state,
      writeHead: (s, h) => { state.status = s; if (h) state.headers = h; },
      write: (chunk) => { state.body += chunk.toString(); },
      end: (chunk) => { if (chunk) state.body += chunk.toString(); },
      setHeader: () => {},
      on: () => {},
      destroy: () => {},
    };
  }

  it("connect 缺 name → 400", async () => {
    const { find } = makeRoutesFixture();
    const res = fakeRes();
    await find(ROUTES.connect).handler(fakeReq("POST", ROUTES.connect), res);
    expect(res.state.status).toBe(400);
  });

  it("connect 合法 name → 200", async () => {
    const { find } = makeRoutesFixture();
    const res = fakeRes();
    await find(ROUTES.connect).handler(fakeReq("POST", `${ROUTES.connect}?name=route-test`), res);
    expect(res.state.status).toBe(200);
  });

  it("disconnect 缺 name → 400", async () => {
    const { find } = makeRoutesFixture();
    const res = fakeRes();
    await find(ROUTES.disconnect).handler(fakeReq("POST", ROUTES.disconnect), res);
    expect(res.state.status).toBe(400);
  });

  it("disconnect 合法 name → 200", async () => {
    const { find } = makeRoutesFixture();
    const res = fakeRes();
    await find(ROUTES.disconnect).handler(fakeReq("POST", `${ROUTES.disconnect}?name=route-test`), res);
    expect(res.state.status).toBe(200);
  });

  it("reconnect 缺 name → 400", async () => {
    const { find } = makeRoutesFixture();
    const res = fakeRes();
    await find(ROUTES.reconnect).handler(fakeReq("POST", ROUTES.reconnect), res);
    expect(res.state.status).toBe(400);
  });

  it("reconnect 合法 name → 200", async () => {
    const { find } = makeRoutesFixture();
    const res = fakeRes();
    await find(ROUTES.reconnect).handler(fakeReq("POST", `${ROUTES.reconnect}?name=route-test`), res);
    expect(res.state.status).toBe(200);
  });

  it("connect GET → 405", async () => {
    const { find } = makeRoutesFixture();
    const res = fakeRes();
    await find(ROUTES.connect).handler(fakeReq("GET", ROUTES.connect), res);
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
    await find(ROUTES.connect).handler(extReq, res);
    expect(res.state.status).toBe(403);
  });
});

describe("apply 完整 settings 生命周期（isUnloading 覆盖）", () => {
  async function applyWithSettingsLifecycle() {
    const dir = makeTempDir("dsh-mcp-manager-bundled-");
    const refs = { disposer: null, watchCb: null };

    const ctx = {
      fiber: { state: "active" },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      inject: (keys, cb) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              register: (ns, schema, opts) => {
                return {
                  get: () => ({ ui: { position: "top-right", offset: { x: 8, y: 8, blankY: 40 } } }),
                  watch: (cb) => { refs.watchCb = cb; },
                };
              },
            },
            effect: (fn) => {
              refs.disposer = fn();
              return () => {};
            },
          });
        }
        return () => {};
      },
      on: () => () => {},
      effect: (fn) => { const d = fn(); return () => { d(); }; },
    };

    await apply(ctx, { enabled: true, storePath: join(dir, "mcp.json") });
    return { ctx, refs };
  }

  it("effect disposer 已注册", async () => {
    const { refs } = await applyWithSettingsLifecycle();
    expect(refs.disposer).not.toBeNull();
  });

  it("scope.watch 已注册（settings 装配面）", async () => {
    const { refs } = await applyWithSettingsLifecycle();
    expect(refs.watchCb).not.toBeNull();
  });

  // 哑断言清理（#664 阶段 8）：isUnloading 短路（unloading/disposed 态
  // watch/disposer 不触发 onChange）由 shared/settings-namespace.js 自身
  // 单测覆盖——此处保留卸载路径执行冒烟（不抛）。
  it("卸载态 disposer/watch 执行不抛", async () => {
    const { ctx, refs } = await applyWithSettingsLifecycle();
    expect(() => {
      ctx.fiber.state = "unloading";
      refs.disposer();
      ctx.fiber.state = "disposed";
      refs.watchCb();
    }).not.toThrow();
  });
});

describe("apply 的 agent/pre-step 在 announceCatalog=true 时注册", () => {
  async function applyWithPreStep() {
    const dir = makeTempDir("dsh-mcp-manager-pre-");
    const refs = { preHandler: null };
    const ctx = {
      fiber: { state: "active" },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      inject: (keys, cb) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              register: () => ({ get: () => ({}), watch: () => {} }),
            },
            effect: () => () => {},
          });
        }
        return () => {};
      },
      on: (evt, handler) => {
        if (evt === "agent/pre-step") refs.preHandler = handler;
        return () => {};
      },
      effect: (fn) => { const d = fn(); return () => { d(); }; },
    };

    await apply(ctx, { enabled: true, announceCatalog: true, storePath: join(dir, "mcp.json") });
    return refs;
  }

  it("pre-step handler 通过 apply 注册", async () => {
    const refs = await applyWithPreStep();
    expect(refs.preHandler).not.toBeNull();
  });

  it("pre-step reject 透传", async () => {
    const refs = await applyWithPreStep();
    // 调用 handler: reject 透传
    const rejectResult = await refs.preHandler(
      { agent: { session: { header: { cwd: "/tmp" } } }, messages: [], signal: { aborted: false, throwIfAborted: () => {} } },
      async () => ({ kind: "reject" }),
    );
    expect(rejectResult.kind).toBe("reject");
  });
});

describe("apply 的 SSE broadcast 与 route disposer", () => {
  async function applyWithBroadcast() {
    const dir = makeTempDir("dsh-mcp-manager-broadcast-");
    const refs = { effectDisposer: null };

    const ctx = {
      fiber: { state: "active" },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: {
        register: (route) => {
          if (route.path === "/api/dsh-mcp/events") {
            // 不处理，只验证 apply 完成
          }
          return () => {};
        },
      },
      systemPrompt: { section: () => () => {} },
      inject: () => () => {},
      on: () => () => {},
      effect: (fn) => {
        const d = fn();
        refs.effectDisposer = () => { d(); };
        return () => {};
      },
    };

    await apply(ctx, { enabled: true, storePath: join(dir, "mcp.json") });
    return refs;
  }

  it("effect disposer 已注册", async () => {
    const refs = await applyWithBroadcast();
    expect(refs.effectDisposer).not.toBeNull();
  });

  it("disposer 重复触发幂等（不抛）", async () => {
    const refs = await applyWithBroadcast();
    expect(() => {
      // 触发 disposer（模拟卸载场景）
      refs.effectDisposer();
      // 再次触发（幂等，不抛）
      refs.effectDisposer();
    }).not.toThrow();
  });
});

describe("apply 的 settings 注入（uiUpdate 写入路径）", () => {
  it("settings 命名空间注册（inject settings 装配面）", async () => {
    const dir = makeTempDir("dsh-mcp-manager-ui2-");
    let registerCalled = false;
    const ctx = {
      fiber: { state: "active" },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      inject: (keys, cb) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              update: function(ns, patch) { return Promise.resolve(); },
              register: () => {
                registerCalled = true;
                return { get: () => ({}), watch: () => {} };
              },
            },
            effect: () => () => {},
          });
        }
        return () => {};
      },
      on: () => () => {},
      effect: (fn) => { const d = fn(); return () => { d(); }; },
    };

    await apply(ctx, { enabled: true, storePath: join(dir, "mcp.json") });
    // 哑断言清理（#664 阶段 8）：假 ok 输出改真实断言——settings 命名空间
    // 注册（installSettingsNamespace 经 inject(["settings"]) 调 register）。
    expect(registerCalled).toBeTruthy();
  });
});
