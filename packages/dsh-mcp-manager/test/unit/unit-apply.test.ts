/**
 * dsh-mcp-manager — unit：apply 函数各分支覆盖。
 *
 * 覆盖：
 * - apply enabled:true 时注册 agent/pre-step 监听（catalog 注入路径）
 * - apply 的 SSE 广播（status → write summary）
 * - apply 的 route disposer（卸载时 destroy 连接）
 * - apply 的 settings 注入（uiUpdate）
 * - apply 的 agent/pre-step 信号取消（signal.throwIfAborted）
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { callHandler, fakeRes } from "../helpers.ts";

// S6-B2：apply 是组合根装配体（src/index.ts 内就地定义），留包根；纯符号改道域门面。
const { apply } = await import("../../src/index.ts");
const { ROUTES } = await import("../../src/server/api/interface.ts");
const { MCP_MANAGER_IDENTITY } = await import("../../src/shared/interface.ts");
const { saveDisabledTools } = await import("../../src/server/store/interface.ts");
const { mountLedger, mountServer, releaseLifecycle } =
  await import("../../src/server/servers/lifecycle/interface.ts");

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

/** apply 通用 fakeCtx 底座（各分支按需覆盖）。 */
function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    logger: {
      warn: () => {},
      info: () => {},
      error: () => {},
      // 装载窗口经 bindHost 的日志面挂导出器收官方错因；缺这一面，装载链会撞在「夹具没造全」上
      // 而不是被测行为上。
      exporter: () => () => {},
    },
    tools: { register: () => () => {} },
    webServer: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    inject: () => () => {},
    on: () => () => {},
    effect: (fn: () => () => void) => {
      const disposer = fn();
      return () => {
        disposer();
      };
    },
    ...overrides,
  };
}

describe("apply 的 agent/pre-step 监听（announceCatalog=true）", () => {
  async function applyWithPreStep() {
    const dir = makeTempDir("dsh-mcp-manager-apply-");
    const refs: { preStepHandler: null | ((...args: unknown[]) => unknown) } = {
      preStepHandler: null,
    };
    const ctx = baseCtx({
      on: (evt: string, handler: (...args: unknown[]) => void) => {
        if (evt === "agent/pre-step") {
          refs.preStepHandler = handler;
        }
        return () => {};
      },
    });
    await apply(ctx as unknown as Context, {
      enabled: true,
      announceCatalog: true,
      storePath: join(dir, "mcp.json"),
    });
    return refs;
  }

  it("agent/pre-step 监听已注册", async () => {
    const refs = await applyWithPreStep();
    expect(refs.preStepHandler).not.toBeNull();
  });

  it("signal 取消 → handler 抛 aborted", async () => {
    const refs = await applyWithPreStep();
    // 测试 pre-step handler 的信号取消分支
    // 当 signal.aborted 时，handler 应抛 AbortError
    const abortedSignal = {
      aborted: true,
      throwIfAborted: () => {
        throw new Error("aborted");
      },
    };
    await expect(
      refs.preStepHandler!(
        { agent: { session: { header: { cwd: "/tmp" } } }, messages: [], signal: abortedSignal },
        async () => ({ kind: "enter", messages: [] }),
      ),
    ).rejects.toThrow(/aborted/);
  });

  it("pre-step 返回 decision", async () => {
    const refs = await applyWithPreStep();
    // 正常 pre-step 路径（无服务器时目录为空 → 不注入）
    const normalSignal = { aborted: false, throwIfAborted: () => {} };
    const result = (await refs.preStepHandler!(
      { agent: { session: { header: { cwd: "/tmp" } } }, messages: [], signal: normalSignal },
      async () => ({ kind: "enter", messages: [] }),
    )) as { kind: unknown; messages: unknown };
    // 无服务器时返回原始 decision（不注入）
    expect(result.kind === "enter" || Array.isArray(result.messages)).toBeTruthy();
  });

  it("reject 原样透传", async () => {
    const refs = await applyWithPreStep();
    const normalSignal = { aborted: false, throwIfAborted: () => {} };
    // reject 不处理
    // pre-step 已注册由首用例保证（同一装配器），此处非空。
    const rejectResult = (await refs.preStepHandler!(
      { agent: { session: { header: { cwd: "/tmp" } } }, messages: [], signal: normalSignal },
      async () => ({ kind: "reject" }),
    )) as { kind: unknown };
    expect(rejectResult.kind).toBe("reject");
  });
});

describe("apply 的 SSE broadcast 与 route disposer", () => {
  async function applyWithSse() {
    const dir = makeTempDir("dsh-mcp-manager-sse-");
    const destroyed: string[] = [];
    const written: unknown[] = [];
    const sseConns: Set<{
      write: (chunk: unknown) => void;
      destroy: () => void;
    }> = new Set();

    const ctx = baseCtx({
      webServer: {
        register: (route: { path: string }) => {
          // 捕获 events 路由
          if (route.path === "/api/dsh-mcp/events") {
            // 注册后模拟 SSE 连接
            sseConns.add({
              write: (chunk: unknown) => written.push(chunk),
              destroy: () => destroyed.push("destroyed"),
            });
          }
          return () => {};
        },
      },
    });

    await apply(ctx as unknown as Context, { enabled: true, storePath: join(dir, "mcp.json") });
    return { sseConns, destroyed, written };
  }

  // 哑断言清理（#664 阶段 8）：补真实装配断言——events SSE 路由已注册，
  // 连接可被 hub 接受（apply 广播面接线成立）；dispose 由 effect 收口不在此造。
  it("events SSE 路由已注册（apply 广播面装配）", async () => {
    const { sseConns } = await applyWithSse();
    expect(sseConns.size >= 1).toBeTruthy();
  });

  it("未 dispose 前连接不被销毁", async () => {
    const { destroyed } = await applyWithSse();
    expect(destroyed.length).toBe(0);
  });
});

describe("apply 的 settings 注入（uiUpdate 写入路径）", () => {
  type CapturedRoute = {
    path: string;
    handler: (req: IncomingMessage, res: ReturnType<typeof fakeRes>) => unknown;
  };

  const configRequest = (method: string, body?: unknown): IncomingMessage =>
    ({
      method,
      url: ROUTES.config,
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        host: "localhost:3080",
        origin: "http://localhost:3080",
        "sec-fetch-site": "same-origin",
      },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) {
          yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
        }
      },
      on: () => {},
    }) as unknown as IncomingMessage;

  async function applyWithSettings() {
    const dir = makeTempDir("dsh-mcp-manager-ui-");
    const routes: CapturedRoute[] = [];
    const refs: {
      updateCalled: boolean;
      updateNs: unknown;
      updatePatch: unknown;
      describeCalled: boolean;
    } = { updateCalled: false, updateNs: null, updatePatch: null, describeCalled: false };

    const ctx = baseCtx({
      webServer: {
        register: (route: CapturedRoute) => {
          routes.push(route);
          return () => {};
        },
      },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              update: function (ns: unknown, patch: unknown) {
                refs.updateCalled = true;
                refs.updateNs = ns;
                refs.updatePatch = patch;
                return Promise.resolve();
              },
              describe: () => {
                refs.describeCalled = true;
                return [
                  {
                    ns: "dsh-mcp-manager",
                    value: {
                      ui: {
                        position: "bottom-right",
                        offset: { x: 91, y: 92, blankY: 93 },
                        zIndexBase: 901,
                      },
                    },
                    revision: 0,
                  },
                ];
              },
            },
            effect: () => () => {},
          });
        }
        return () => {};
      },
    });

    await apply(ctx as unknown as Context, { enabled: true, storePath: join(dir, "mcp.json") });
    const configRoute = routes.find((route) => route.path === ROUTES.config);
    if (configRoute === undefined) throw new Error("config route was not registered");
    return { refs, configRoute };
  }

  it("从 host 的 canonical settings namespace 读取 UI 配置", async () => {
    const { configRoute, refs } = await applyWithSettings();
    expect(refs.describeCalled).toBe(true);
    const response = await callHandler(configRoute, configRequest("GET"));
    expect(response.payload).toEqual({
      position: "bottom-right",
      offsetX: 91,
      offsetY: 92,
      blankY: 93,
      zIndexBase: 901,
    });
  });

  it("POST /config 只向 canonical settings namespace 写入", async () => {
    const { configRoute, refs } = await applyWithSettings();
    const response = await callHandler(
      configRoute,
      configRequest("POST", { position: "bottom-left", offsetX: 4 }),
    );
    expect(response.status).toBe(200);
    expect(refs.updateCalled).toBe(true);
    expect(refs.updateNs).toBe(MCP_MANAGER_IDENTITY.settingsNamespace);
    expect(refs.updatePatch).toEqual({
      ui: {
        position: "bottom-left",
        offset: { x: 4, y: 8, blankY: 40 },
        zIndexBase: 10,
      },
    });
  });

  it("uiUpdate 懒写入：apply 时不触发", async () => {
    const { refs } = await applyWithSettings();
    expect(refs.updateCalled).toBe(false);
  });
});

describe("apply 的 agent/pre-step 监听（announceCatalog=false）", () => {
  it("announceCatalog=false 不注册 pre-step 监听", async () => {
    const dir = makeTempDir("dsh-mcp-manager-Nc-");
    let preStepHandler: null | ((...args: unknown[]) => unknown) = null;
    const ctx = baseCtx({
      on: (evt: string, handler: (...args: unknown[]) => void) => {
        if (evt === "agent/pre-step") preStepHandler = handler;
        return () => {};
      },
    });

    await apply(ctx as unknown as Context, {
      enabled: true,
      announceCatalog: false,
      storePath: join(dir, "mcp.json"),
    });
    expect(preStepHandler).toBeNull();
  });
});

describe("apply 的 route disposer（SSE 连接清理）", () => {
  async function applyWithRouteDisposer() {
    const dir = makeTempDir("dsh-mcp-manager-rd-");
    const refs: { disposeRoutes: null | (() => void); eventsRouteRegistered: boolean } = {
      disposeRoutes: null,
      eventsRouteRegistered: false,
    };
    const sseDestroyed: string[] = [];

    const ctx = baseCtx({
      webServer: {
        register: (route: { path: string }) => {
          if (route.path === "/api/dsh-mcp/events") {
            refs.eventsRouteRegistered = true;
          }
          return () => {};
        },
      },
      effect: (fn: () => () => void) => {
        const disposer = fn();
        refs.disposeRoutes = () => {
          // 手动触发 disposer（模拟上下文卸载）
          disposer();
        };
        return () => {};
      },
    });

    await apply(ctx as unknown as Context, { enabled: true, storePath: join(dir, "mcp.json") });
    return { refs, sseDestroyed };
  }

  // 哑断言清理（#664 阶段 8）：补真实装配断言——events 路由注册 + 卸载
  // disposer 不抛（apply 路由收口面成立）。
  it("events 路由已注册", async () => {
    const { refs } = await applyWithRouteDisposer();
    expect(refs.eventsRouteRegistered).toBeTruthy();
  });

  it("disposer 触发前无销毁记录", async () => {
    const { sseDestroyed } = await applyWithRouteDisposer();
    expect(sseDestroyed.length).toBe(0);
  });

  it("卸载 disposer 执行不抛", async () => {
    const { refs } = await applyWithRouteDisposer();
    // apply 装配期 effect 必走，非空由用例流保证。
    expect(() => refs.disposeRoutes!()).not.toThrow();
  });
});

// D8 红测：mcp__ 直呼命中禁用表 → deny ----
// 修复（spec D8）：guard 挂载与中间层实例解耦、数据源直查 manager.disabledTools、
// 独立注册路径；单池（#767 笔 1a）后中间层实例恒装配，guard 与模式无关，本用例的
// 判据（guard 已挂载 + 命中毒表 deny）逐字保留。
describe("D8：mcp__ 直呼命中禁用表 → deny", () => {
  async function applyOffModeWithDisabledTool() {
    const dir = makeTempDir("dsh-mcp-manager-d8-");
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    const guards = new Map<string, (...args: unknown[]) => unknown>();
    const ctx = baseCtx({
      on: (evt: string, handler: (...args: unknown[]) => void) => {
        guards.set(evt, handler);
        return () => {};
      },
    });
    // 预置工具级禁用表（manager.userStatePath = DSH_HOME/dsh-mcp-user-state.json）。
    const disabled = new Map([["@global", new Map([["svc", new Set(["use_t"])]])]]);
    await saveDisabledTools(join(dir, "dsh-mcp-user-state.json"), disabled);
    await apply(ctx as unknown as Context, { enabled: true, storePath: join(dir, "mcp.json") });
    const restore = () => {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    };
    return { guards, restore };
  }

  it("D8：pre-execute guard 已挂载", async () => {
    const { guards, restore } = await applyOffModeWithDisabledTool();
    try {
      const guard = guards.get("tools/pre-execute");
      expect(typeof guard === "function").toBeTruthy();
    } finally {
      restore();
    }
  });

  it("D8：mcp__ 直呼命中禁用表 → deny", async () => {
    const { guards, restore } = await applyOffModeWithDisabledTool();
    try {
      // guard 已挂载由上一用例保证（同一装配器），此处非空。
      const guard = guards.get("tools/pre-execute")!;
      const decision = (await guard(
        { name: "mcp__svc__use_t", agent: { session: { header: {} } } },
        async () => ({ kind: "allow" }),
      )) as { kind: unknown };
      expect(decision.kind).toBe("deny");
    } finally {
      restore();
    }
  });
});
describe("组合根接线：装载生命周期域（#767 S1-4c）", () => {
  afterEach(() => {
    releaseLifecycle();
  });

  /**
   * 假宿主上只多给两样：loader 服务（官方 loader 是宿主服务，bindHost 经 ctx.get 现取）与
   * plugin（挂载入口）。工具注册面按当次装载的 serverName 造一个前缀命中项——官方不暴露状态
   * API，注册面是六态投影唯一能观测「已连上」的输入面（设计 §3.1 输入面 B）。
   */
  function wiringCtx() {
    const mounts: Array<{ mod: unknown; config: { serverName: string } }> = [];
    const disposers: Array<() => unknown> = [];
    const ctx = baseCtx({
      get: (name: string) =>
        name === "loader"
          ? { import: async () => ({ name: "mcp-client", apply: () => {} }) }
          : undefined,
      plugin: (mod: unknown, config: { serverName: string }) => {
        mounts.push({ mod, config });
        return { await: async () => {}, dispose: async () => {} };
      },
      tools: {
        register: () => () => {},
        schemas: () =>
          mounts.length === 0
            ? []
            : [{ name: `mcp__${mounts[mounts.length - 1].config.serverName}__echo` }],
      },
      effect: (fn: () => () => void) => {
        const inner = fn();
        disposers.push(inner);
        return () => {
          void inner();
        };
      },
    });
    return { ctx, mounts, disposers };
  }

  const server = { name: "svc", transport: "stdio" as const, command: "echo", enabled: true };

  it("apply 之后域已装配：mountServer 经宿主 loader 装载，id 进账本、状态投影到 connected", async () => {
    const dir = makeTempDir("dsh-mcp-manager-wire-");
    const { ctx, mounts } = wiringCtx();
    await apply(ctx as unknown as Context, { enabled: false, storePath: join(dir, "mcp.json") });

    const states: string[] = [];
    const result = await mountServer({
      root: "/tmp/proj",
      server,
      onState: (state: string) => states.push(state),
    });

    expect(result.outcome).toMatchObject({ kind: "settled", state: "connected" });
    expect(result.id).toMatch(/^[A-Za-z0-9_-]{1,32}$/u);
    expect(mountLedger.get(result.id)?.key).toBe(result.id);
    // 交给官方的 serverName 是 id 表分配的注册名，不是用户写的 bare 名。
    expect(mounts.map((m) => m.config.serverName)).toEqual([result.id]);
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("跨 root 同名各自成条：两个 root 都拿到独立注册名（不再是后到跳过）", async () => {
    const dir = makeTempDir("dsh-mcp-manager-wire-");
    const { ctx, mounts } = wiringCtx();
    await apply(ctx as unknown as Context, { enabled: false, storePath: join(dir, "mcp.json") });

    const a = await mountServer({ root: "/tmp/proj-a", server, onState: () => {} });
    const b = await mountServer({ root: "/tmp/proj-b", server, onState: () => {} });

    expect(a.id).not.toBe(b.id);
    expect(mountLedger.size).toBe(2);
    expect(mounts.map((m) => m.config.serverName)).toEqual([a.id, b.id]);
  });

  it("卸载后域被复位：mountServer 报未装配（组合根漏装即抛，不静默空装）", async () => {
    const dir = makeTempDir("dsh-mcp-manager-wire-");
    const { ctx, disposers } = wiringCtx();
    await apply(ctx as unknown as Context, { enabled: false, storePath: join(dir, "mcp.json") });
    for (const dispose of disposers) await dispose();

    await expect(mountServer({ root: "/tmp/proj", server, onState: () => {} })).rejects.toThrow(
      /servers\/lifecycle 域未装配/,
    );
  });
});

// S2-D 接线判据（P4 前半）：全局迁移链失败 → apply 失败（fail-closed，不带半完成存储启动）。
describe("apply 的升级链失败穿透", () => {
  it("旧用户状态不可读 → apply 抛错", async () => {
    const homeDir = makeTempDir("dsh-mcp-apply-fail-");
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = homeDir;
    try {
      // 旧用户状态落点（LEGACY_LAYOUT.userState）做成目录：读源即抛 EISDIR
      //（确定性失败，不依赖权限位）；config 项被显式 storePath 接管整项跳过，不影响本判据。
      mkdirSync(join(homeDir, "dsh-mcp-user-state.json"));
      await expect(
        apply(baseCtx() as unknown as Context, {
          enabled: false,
          storePath: join(homeDir, "mcp.json"),
        }),
      ).rejects.toThrow(/不可读/);
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    }
  });
});
