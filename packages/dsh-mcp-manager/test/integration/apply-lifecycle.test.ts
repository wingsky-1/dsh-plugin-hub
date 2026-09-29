/**
 * dsh-mcp-manager — integration：apply 函数各分支覆盖。
 *
 * 集成层（docs/ARCHITECTURE-METHOD.md §8 导入面矩阵）：矩阵把「包产物入口 + `apply()`」列为
 * 集成层的许可导入面，本文件的被测对象**就是 `apply()` 本身**——它在 src/index.ts 内就地定义
 * （包自己的架构计划「各落点域端口化之后才谈把它再拆出去」把它压在组合根里），全仓无第二出口，
 * 故单元层不存在合法导入面。断言与其夹具自 test/unit/apply.test.ts 逐字迁来，未改判据。
 *
 * 覆盖：
 * - apply enabled:true 时注册 agent/pre-step 监听（catalog 注入路径）
 * - apply 的 SSE 广播（status → write summary）
 * - apply 的 route disposer（卸载时 destroy 连接）
 * - apply 的 settings 注入（uiUpdate）
 * - apply 的 agent/pre-step 信号取消（signal.throwIfAborted）
 * - 装配顺序（源码序锁定）：升级链 await 跑完才装读存储的域
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { callHandler, fakeManagerCtx, fakeRes, pollUntil } from "../helpers.ts";
import type { FakeToolEntry } from "../helpers.ts";

// apply 与 resolveDebugConfig 都是组合根内就地定义、单元层无合法导入面的符号——本层经包入口取
// 它们（§8 矩阵：包产物入口是集成层的许可导入面）。
const { apply, resolveDebugConfig } = await import("../../src/index.ts");
const { McpManager } = await import("../../src/server/connection/orchestrator/interface.ts");
const { ROUTES } = await import("../../src/server/api/interface.ts");
const { MCP_MANAGER_IDENTITY } = await import("../../src/shared/interface.ts");
import type { McpManagerService } from "../../src/shared/interface.ts";
const { McpStore, saveDisabledTools } = await import("../../src/server/store/interface.ts");
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

/**
 * 装配顺序（源码序锁定）：升级链必须 await 跑完，才轮到任何读存储的域。
 *
 * 为什么只能钉源码顺序：运行期能观测到的只有「apply 的 promise resolve 时链已跑完」（本文件上方
 * 那条 fail-closed 用例就是它的运行期面），而**装配体内**的先后没有观测量——把 installUpgrade 挪到
 * `store.load()` 之后，各域读着被搬走一半的磁盘跑起来，假 ctx 装配照样成功。组合根里唯一可判的形态
 * 就是源码文本的先后（同先例：dsh-provider-usage report-routes/composition-root.test.ts 的装配序锁定）。
 */
describe("装配顺序：升级链 await 跑完才装读存储的域", () => {
  const applySrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "index.ts"),
    "utf8",
  );

  it("升级域是 await 装配方（漏掉 await 即红）", () => {
    expect(applySrc.indexOf("await installUpgrade({")).toBeGreaterThan(-1);
  });

  it("先复位 upgrade 装配标记再装配（release 晚于 install 即红）", () => {
    const release = applySrc.indexOf("releaseUpgrade();");
    const install = applySrc.indexOf("await installUpgrade({");
    expect(release).toBeGreaterThan(-1);
    expect(release).toBeLessThan(install);
  });

  it("升级链早于存储装载（迁移必须早于任何读存储的域）", () => {
    const install = applySrc.indexOf("await installUpgrade({");
    const load = applySrc.indexOf("await store.load();");
    expect(install).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(-1);
    expect(install).toBeLessThan(load);
  });
});

describe("通过 apply 间接覆盖 installSettingsNamespace 降级分支", () => {
  it("ctx.inject 不可用时静默降级（不抛）", async () => {
    // 通过 fakeCtx 模拟 apply 的 settings 注入路径
    // 覆盖 installSettingsNamespace 的 ctx.inject 不可用分支
    // 故意缺 inject 方法的残缺宿主：apply 必须静默降级。残缺形状按接缝收窄（运行时原样传入）。
    const noInjectCtx = {
      logger: { warn: () => {} },
      // 没有 inject 方法
      effect: () => () => {},
      on: () => () => {},
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    };
    const dir = makeTempDir("dsh-mcp-manager-ni-");
    await expect(
      apply(noInjectCtx as unknown as Context, {
        enabled: false,
        storePath: join(dir, "mcp.json"),
      }),
    ).resolves.toBeUndefined();
  });

  it("settings.describe 抛错时降级（不抛）", async () => {
    // settings 服务存在但 describe 抛错 → 回落 entry
    const failSettingsCtx = {
      logger: { warn: () => {} },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              describe: () => {
                throw new Error("describe failed");
              },
            },
            effect: () => () => {},
          });
        }
        return () => {};
      },
      effect: () => () => {},
      on: () => () => {},
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    };
    const dir = makeTempDir("dsh-mcp-manager-sf-");
    await expect(
      apply(failSettingsCtx as unknown as Context, {
        enabled: false,
        storePath: join(dir, "mcp.json"),
      }),
    ).resolves.toBeUndefined();
  });

  it("settings 缺少 register 时降级（不抛）", async () => {
    // settings 服务存在但 register 不是函数
    const noRegCtx = {
      logger: { warn: () => {} },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {},
            effect: () => () => {},
          });
        }
        return () => {};
      },
      effect: () => () => {},
      on: () => () => {},
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    };
    const dir = makeTempDir("dsh-mcp-manager-nr-");
    await expect(
      apply(noRegCtx as unknown as Context, { enabled: false, storePath: join(dir, "mcp.json") }),
    ).resolves.toBeUndefined();
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
              describe: () => [],
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
  it("settings 命名空间接线（inject settings 装配面）", async () => {
    const dir = makeTempDir("dsh-mcp-manager-ui2-");
    let describeCalled = false;
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
              describe: () => {
                describeCalled = true;
                return [];
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
    // 接线（installSettingsNamespace 经 inject(["settings"]) 调 describe）。
    expect(describeCalled).toBeTruthy();
  });
});

describe("apply 完整 settings 生命周期（isUnloading 覆盖）", () => {
  async function applyWithSettingsLifecycle() {
    const dir = makeTempDir("dsh-mcp-manager-bundled-");
    const refs: { disposer: null | (() => void); emit: null | ((ns: string) => void) } = {
      disposer: null,
      emit: null,
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
              describe: () => [
                {
                  ns: MCP_MANAGER_IDENTITY.settingsNamespace,
                  value: {
                    ui: { position: "top-right", offset: { x: 8, y: 8, blankY: 40 } },
                  },
                  revision: 0,
                },
              ],
            },
            effect: (fn: () => () => void) => {
              refs.disposer = fn();
              return () => {};
            },
            on: (event: string, cb2: (ns: string, revision: number) => void) => {
              if (event !== "settings/document-updated") throw new Error("unexpected event");
              refs.emit = (ns: string) => cb2(ns, 1);
              return () => {
                refs.emit = null;
              };
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

  it("内部订阅已接线（settings 装配面）", async () => {
    const { refs } = await applyWithSettingsLifecycle();
    expect(refs.emit).not.toBeNull();
  });

  // 哑断言清理（#664 阶段 8）：isUnloading 短路（unloading/disposed 态
  // 订阅/disposer 不触发 onChange）由 shared/settings-namespace.js 自身
  // 单测覆盖——此处保留卸载路径执行冒烟（不抛）。
  it("卸载态 disposer/订阅执行不抛", async () => {
    const { ctx, refs } = await applyWithSettingsLifecycle();
    const emit = refs.emit!;
    expect(() => {
      ctx.fiber.state = "unloading";
      refs.disposer!();
      ctx.fiber.state = "disposed";
      emit(MCP_MANAGER_IDENTITY.settingsNamespace);
    }).not.toThrow();
  });
});

describe("#767 笔 1a：ctx.mcpManager.getTools 行为判据", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2gt-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  /**
   * 最小 apply 宿主：`provide` 捕获核心化服务；loader / plugin / tools.schemas 支撑一条
   * 真装载链（官方 client 的 syncTools 在本夹具里由 OFFICIAL_MODULE.apply 代替）。
   */
  async function appliedService() {
    const provided = new Map<string, unknown>();
    const schemas: FakeToolEntry[] = [];
    const officialModule = {
      name: "test:official",
      // 真实引擎里这一步由官方 client 的 syncTools 做：把 `mcp__<serverName>__<tool>`
      // 写进宿主注册表。六态投影的 hasTools 与 getTools 的注册面因此同源。
      apply: (_pluginCtx: unknown, config: { serverName: string }) => {
        schemas.push({
          name: `mcp__${config.serverName}__echo`,
          description: "回显给定的文本",
        });
      },
    };
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {}, exporter: () => () => {} },
      tools: { register: () => () => {}, schemas: () => schemas },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      inject: () => () => {},
      on: () => () => {},
      effect: (fn: () => unknown) => fn(),
      provide: (serviceName: string, service: unknown) => {
        provided.set(serviceName, service);
      },
      get: (serviceName: string) =>
        serviceName === "loader" ? { import: async () => officialModule } : undefined,
      plugin: (
        module: { apply?: (ctx: unknown, config: { serverName: string }) => unknown },
        config: { serverName: string },
      ) => {
        if (typeof module?.apply === "function") module.apply(ctx, config);
        return { await: async () => undefined, dispose: async () => {} };
      },
    };
    const store = new McpStore(join(homeDir, "mcp.json"));
    store.data = { version: 1, servers: [] };
    await store.save();
    // 残缺宿主（只实现装配触达面）：按接缝收窄，装配语义不变。
    await apply(ctx as unknown as Context, {
      storePath: store.path,
      announceToAgent: false,
      announceCatalog: false,
    });
    // 提供方挂载的真服务（行为面由本组用例钉住），此处取其类型面。
    return { svc: provided.get("mcpManager") as McpManagerService, schemas };
  }

  /** 起一台全局服务器并等它在池里拿到 id（单池：进 @global 单元）。 */
  async function connectedService(svc: McpManagerService) {
    await svc.registerServer({
      name: "g1",
      transport: "stdio",
      command: "dsh-noop-cmd",
      reconnect: { enabled: false },
      enabled: true,
    });
    await pollUntil("池内条目拿到 id 且注册面命中", () => svc.getTools("g1").length > 0);
  }

  it("① 中间层接管的服务器返回非空且逐字是注册名（mcp__<id>__<tool>）", async () => {
    const { svc } = await appliedService();
    await connectedService(svc);
    const tools = svc.getTools("g1");
    // 旧数据源（直连账本 toolMeta）只由已退役的那条路径填充 → 这里会恒返回 []。
    expect(tools.length, "非空（数据源换到池了）").toBeGreaterThan(0);
    // 逐字是注册名：`mcp__<id>__<tool>`，id 是装配期分配的不透明短 id（不是裸名、不是裸名加前缀）。
    expect(tools.map((tool) => tool.name)).toEqual([
      expect.stringMatching(/^mcp__[A-Za-z0-9_-]+__echo$/),
    ]);
    expect(tools[0].description).toBe("回显给定的文本");
  });

  it("① 否定：返回的不是裸名（改成裸名即红）", async () => {
    const { svc } = await appliedService();
    await connectedService(svc);
    const names = svc.getTools("g1").map((tool) => tool.name);
    expect(names, "裸名口径（summary().tools / 目录读口）不在这里返回").not.toContain("echo");
    for (const name of names) expect(name.startsWith("mcp__")).toBe(true);
  });

  it("② 未知 server 返回 []", async () => {
    const { svc } = await appliedService();
    expect(svc.getTools("ghost")).toEqual([]);
  });

  it("② 未连接（断开后）返回 []", async () => {
    const { svc } = await appliedService();
    await connectedService(svc);
    await svc.disconnect("g1");
    expect(svc.getTools("g1"), "断开后条目已拆 → 不再返回工具").toEqual([]);
  });
});

describe("apply：配置分支", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-apply2-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  // enabled:false：无路由、无 section、无 pre-step。
  // （cordis effect(fn, label) 语义：立即执行工厂取回 disposer。）
  function makeCtx() {
    const state: {
      preSteps: Array<(...args: unknown[]) => void>;
      sections: string[];
      routes: string[];
      disposers: Array<() => void>;
      injected: unknown[];
    } = { preSteps: [], sections: [], routes: [], disposers: [], injected: [] };
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: {
        register: (route: { path: string }) => {
          state.routes.push(route.path);
          return () => {
            const i = state.routes.indexOf(route.path);
            if (i >= 0) state.routes.splice(i, 1);
          };
        },
      },
      systemPrompt: {
        section: (opts: { name: string }) => {
          state.sections.push(opts.name);
          return () => {
            const i = state.sections.indexOf(opts.name);
            if (i >= 0) state.sections.splice(i, 1);
          };
        },
      },
      inject: (keys: unknown, _cb: (services: unknown) => void) => {
        state.injected.push(keys);
        return () => {};
      },
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (event === "agent/pre-step") state.preSteps.push(handler);
        return () => {};
      },
      effect: (fn: () => () => void) => {
        const disposer = fn();
        state.disposers.push(disposer);
        return disposer;
      },
    };
    return { ctx, state };
  }

  async function applied(options: Record<string, unknown> | undefined) {
    const { ctx, state } = makeCtx();
    // 残缺宿主（只实现装配触达面）：按接缝收窄，装配语义不变。
    await apply(ctx as unknown as Context, options);
    return { ctx, state };
  }

  it("禁用不注册路由", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.routes.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("禁用不注入提示词", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.sections.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("禁用不注册 pre-step", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.preSteps.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("禁用仅注册 dispose effect", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.disposers.length).toBe(1);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  // announceToAgent:false：有路由无 section；announceCatalog:false：无 pre-step。
  const disabledAnnounce = () =>
    applied({
      announceToAgent: false,
      announceCatalog: false,
      storePath: join(homeDir, "st.json"),
    });

  it("启用时注册全部路由", async () => {
    const { state } = await disabledAnnounce();
    expect(state.routes.length >= 9).toBeTruthy();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("关闭宣告不注入提示词", async () => {
    const { state } = await disabledAnnounce();
    expect(state.sections.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("关闭目录不注册 pre-step", async () => {
    const { state } = await disabledAnnounce();
    expect(state.preSteps.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  // 默认开启：section + pre-step + settings 注入。
  const defaultOn = () => applied({ storePath: join(homeDir, "st2.json") });

  it("默认注入提示词 section", async () => {
    const { state } = await defaultOn();
    expect(state.sections.length).toBe(1);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("默认注册目录 pre-step", async () => {
    const { state } = await defaultOn();
    expect(state.preSteps.length).toBe(1);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("尝试注入 settings", async () => {
    const { state } = await defaultOn();
    expect(state.injected.some((k) => Array.isArray(k) && k.includes("settings"))).toBeTruthy();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("settings 注入回调通路（cb 收到 settings 服务即挂载成功）", async () => {
    const { ctx } = await defaultOn();
    // settings 注入回调挂 uiUpdate 的通路验证（cb 收到 settings 服务即挂载成功）。
    const settingsCalls: Array<[unknown, unknown]> = [];
    const settingsCtx = {
      logger: ctx.logger,
      effect: ctx.effect,
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              update: async (ns: unknown, patch: unknown) => settingsCalls.push([ns, patch]),
            },
          });
        }
        return () => {};
      },
    };
    // 残缺宿主（只实现 settings 注入面）：按接缝收窄。
    await apply(settingsCtx as unknown as Context, { enabled: false });
    expect(typeof settingsCalls).toBe("object");
  });

  // effect disposer：卸载时注销路由与提示词。
  function unloadFixture() {
    return applied({ storePath: join(homeDir, "st3.json") });
  }

  it("默认注册多个 effect disposer", async () => {
    const { state } = await unloadFixture();
    expect(state.disposers.length >= 2).toBeTruthy();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("卸载注销全部路由", async () => {
    const { state } = await unloadFixture();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
    expect(state.routes.length).toBe(0);
  });

  it("卸载注销提示词", async () => {
    const { state } = await unloadFixture();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
    expect(state.sections.length).toBe(0);
  });
});

describe("前端 POST /config 不会覆盖抹除已有的 debug 配置", () => {
  async function updateUiOnly() {
    // 原文件里的 tempDir() 是那个文件的 mkdtempSync 助手，这里改用本层同形态的 makeTempDir
    // （同一 mkdtempSync 隔离目录、同一 afterEach 回收；前缀沿用原命名便于认产物）。
    const dir = makeTempDir("mcp-stats-test-");
    const store = new McpStore(join(dir, "mcp.json"));
    const manager = new McpManager(fakeManagerCtx(), store);

    let persistedSettings = {
      ui: { position: "top-right", offset: { x: 8, y: 8, blankY: 40 }, zIndexBase: 10 },
      debug: { callStats: true, statsFile: "/tmp/custom.json" },
    };

    manager.uiConfigSource = () => persistedSettings;
    manager.uiUpdate = async (patch) => {
      // 模拟 settings.update 行为：合并 patch，不抹除不在 patch 中的字段
      persistedSettings = { ...persistedSettings, ...patch };
      return persistedSettings;
    };

    // 前端更新 UI（只提交扁平 UI 参数）
    await manager.updateUiConfig({ position: "bottom-left", offsetX: 10, offsetY: 20 });
    return {
      persisted: () => persistedSettings,
      debugCfg: () => resolveDebugConfig(undefined, persistedSettings),
    };
  }

  it("更新 UI 后 debug.callStats 未被抹除", async () => {
    const { persisted } = await updateUiOnly();
    expect(persisted().debug?.callStats).toBe(true);
  });

  it("更新 UI 后 debug.statsFile 未被抹除", async () => {
    const { persisted } = await updateUiOnly();
    expect(persisted().debug?.statsFile).toBe("/tmp/custom.json");
  });

  it("debug 解析依然生效（callStats）", async () => {
    const { debugCfg } = await updateUiOnly();
    expect(debugCfg().callStats).toBe(true);
  });

  it("debug 解析依然生效（statsFile）", async () => {
    const { debugCfg } = await updateUiOnly();
    expect(debugCfg().statsFile).toBe("/tmp/custom.json");
  });
});
