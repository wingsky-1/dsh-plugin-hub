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
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RoutesManager } from "../../src/server/connection/interface.ts";
import { fakeManagerCtx } from "../helpers.ts";

// S6-B2：apply/路由装配/管理器构造是装配依赖，留包根；纯符号改道域门面。
const { apply, makeRoutes, McpManager } = await import("../../src/index.ts");
const { ROUTES } = await import("../../src/server/api/interface.ts");
const { McpStore } = await import("../../src/server/store/interface.ts");
const { normalizeServer } = await import("../../src/server/config/interface.ts");

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

describe("apply 完整 settings 生命周期（isUnloading 覆盖）", () => {
  async function applyWithSettingsLifecycle() {
    const dir = makeTempDir("dsh-mcp-manager-bundled-");
    const refs: { disposer: null | (() => void); watchCb: null | (() => void) } = {
      disposer: null,
      watchCb: null,
    };

    const ctx = {
      fiber: { state: "active" },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              register: (_ns: unknown, _schema: unknown, _opts: unknown) => {
                return {
                  get: () => ({
                    ui: { position: "top-right", offset: { x: 8, y: 8, blankY: 40 } },
                  }),
                  watch: (cb: () => void) => {
                    refs.watchCb = cb;
                  },
                };
              },
            },
            effect: (fn: () => () => void) => {
              refs.disposer = fn();
              return () => {};
            },
          });
        }
        return () => {};
      },
      on: () => () => {},
      effect: (fn: () => () => void) => {
        const d = fn();
        return () => {
          d();
        };
      },
    };

    await apply(ctx as unknown as Context, { enabled: true, storePath: join(dir, "mcp.json") });
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
      refs.disposer!();
      ctx.fiber.state = "disposed";
      refs.watchCb!();
    }).not.toThrow();
  });
});

describe("apply 的 agent/pre-step 在 announceCatalog=true 时注册", () => {
  async function applyWithPreStep() {
    const dir = makeTempDir("dsh-mcp-manager-pre-");
    const refs: { preHandler: null | ((...args: unknown[]) => unknown) } = { preHandler: null };
    const ctx = {
      fiber: { state: "active" },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
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
      on: (evt: string, handler: (...args: unknown[]) => void) => {
        if (evt === "agent/pre-step") refs.preHandler = handler;
        return () => {};
      },
      effect: (fn: () => () => void) => {
        const d = fn();
        return () => {
          d();
        };
      },
    };

    await apply(ctx as unknown as Context, {
      enabled: true,
      announceCatalog: true,
      storePath: join(dir, "mcp.json"),
    });
    return refs;
  }

  it("pre-step handler 通过 apply 注册", async () => {
    const refs = await applyWithPreStep();
    expect(refs.preHandler).not.toBeNull();
  });

  it("pre-step reject 透传", async () => {
    const refs = await applyWithPreStep();
    // 调用 handler: reject 透传
    // pre-step 已注册由上一用例保证（同一装配器），此处非空。
    const rejectResult = (await refs.preHandler!(
      {
        agent: { session: { header: { cwd: "/tmp" } } },
        messages: [],
        signal: { aborted: false, throwIfAborted: () => {} },
      },
      async () => ({ kind: "reject" }),
    )) as { kind: unknown };
    expect(rejectResult.kind).toBe("reject");
  });
});

describe("apply 的 SSE broadcast 与 route disposer", () => {
  async function applyWithBroadcast() {
    const dir = makeTempDir("dsh-mcp-manager-broadcast-");
    const refs: { effectDisposer: null | (() => void) } = { effectDisposer: null };

    const ctx = {
      fiber: { state: "active" },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: {
        register: (route: { path: string }) => {
          if (route.path === "/api/dsh-mcp/events") {
            // 不处理，只验证 apply 完成
          }
          return () => {};
        },
      },
      systemPrompt: { section: () => () => {} },
      inject: () => () => {},
      on: () => () => {},
      effect: (fn: () => () => void) => {
        const d = fn();
        refs.effectDisposer = () => {
          d();
        };
        return () => {};
      },
    };

    await apply(ctx as unknown as Context, { enabled: true, storePath: join(dir, "mcp.json") });
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
      refs.effectDisposer!();
      // 再次触发（幂等，不抛）
      refs.effectDisposer!();
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
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              update: function (_ns: unknown, _patch: unknown) {
                return Promise.resolve();
              },
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
      effect: (fn: () => () => void) => {
        const d = fn();
        return () => {
          d();
        };
      },
    };

    await apply(ctx as unknown as Context, { enabled: true, storePath: join(dir, "mcp.json") });
    // 哑断言清理（#664 阶段 8）：假 ok 输出改真实断言——settings 命名空间
    // 注册（installSettingsNamespace 经 inject(["settings"]) 调 register）。
    expect(registerCalled).toBeTruthy();
  });
});
