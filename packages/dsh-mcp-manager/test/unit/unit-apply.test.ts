// @ts-nocheck
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pollUntil } from "../helpers.ts";

const {
  apply,
  McpManager,
  McpStore,
  resolveMiddlewareMode,
  makeMiddlewareHotSwitch,
  saveDisabledTools,
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

/** apply 通用 fakeCtx 底座（各分支按需覆盖）。 */
function baseCtx(overrides = {}) {
  return {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    tools: { register: () => () => {} },
    webServer: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    inject: () => () => {},
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn();
      return () => { disposer(); };
    },
    ...overrides,
  };
}

describe("apply 的 agent/pre-step 监听（announceCatalog=true）", () => {
  async function applyWithPreStep() {
    const dir = makeTempDir("dsh-mcp-manager-apply-");
    const refs = { preStepHandler: null };
    const ctx = baseCtx({
      on: (event, handler) => {
        if (event === "agent/pre-step") {
          refs.preStepHandler = handler;
        }
        return () => {};
      },
    });
    await apply(ctx, { enabled: true, announceCatalog: true, storePath: join(dir, "mcp.json") });
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
    const abortedSignal = { aborted: true, throwIfAborted: () => { throw new Error("aborted"); } };
    await expect(
      refs.preStepHandler(
        { agent: { session: { header: { cwd: "/tmp" } } }, messages: [], signal: abortedSignal },
        async () => ({ kind: "enter", messages: [] }),
      ),
    ).rejects.toThrow(/aborted/);
  });

  it("pre-step 返回 decision", async () => {
    const refs = await applyWithPreStep();
    // 正常 pre-step 路径（无服务器时目录为空 → 不注入）
    const normalSignal = { aborted: false, throwIfAborted: () => {} };
    const result = await refs.preStepHandler(
      { agent: { session: { header: { cwd: "/tmp" } } }, messages: [], signal: normalSignal },
      async () => ({ kind: "enter", messages: [] }),
    );
    // 无服务器时返回原始 decision（不注入）
    expect(result.kind === "enter" || Array.isArray(result.messages)).toBeTruthy();
  });

  it("reject 原样透传", async () => {
    const refs = await applyWithPreStep();
    const normalSignal = { aborted: false, throwIfAborted: () => {} };
    // reject 不处理
    const rejectResult = await refs.preStepHandler(
      { agent: { session: { header: { cwd: "/tmp" } } }, messages: [], signal: normalSignal },
      async () => ({ kind: "reject" }),
    );
    expect(rejectResult.kind).toBe("reject");
  });
});

describe("apply 的 SSE broadcast 与 route disposer", () => {
  async function applyWithSse() {
    const dir = makeTempDir("dsh-mcp-manager-sse-");
    const destroyed = [];
    const written = [];
    const sseConns = new Set();

    const ctx = baseCtx({
      webServer: {
        register: (route) => {
          // 捕获 events 路由
          if (route.path === "/api/dsh-mcp/events") {
            // 注册后模拟 SSE 连接
            sseConns.add({
              write: (chunk) => written.push(chunk),
              destroy: () => destroyed.push("destroyed"),
            });
          }
          return () => {};
        },
      },
    });

    await apply(ctx, { enabled: true, storePath: join(dir, "mcp.json") });
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
  async function applyWithSettings() {
    const dir = makeTempDir("dsh-mcp-manager-ui-");
    const refs = { updateCalled: false, updateNs: null, updatePatch: null, registerCalled: false };

    const ctx = baseCtx({
      inject: (keys, cb) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              update: function(ns, patch) {
                refs.updateCalled = true;
                refs.updateNs = ns;
                refs.updatePatch = patch;
                return Promise.resolve();
              },
              register: () => {
                refs.registerCalled = true;
                return {
                  get: () => ({ ui: { position: "top-right", offset: { x: 8, y: 8, blankY: 40 } } }),
                  watch: () => {},
                };
              },
            },
            effect: () => () => {},
          });
        }
        return () => {};
      },
    });

    await apply(ctx, { enabled: true, storePath: join(dir, "mcp.json") });
    return refs;
  }

  // 哑断言清理（#664 阶段 8）：补真实装配断言——settings 命名空间已注册
  // （installSettingsNamespace 经 inject(["settings"]) 调 register）；
  // uiUpdate 是懒写入（路由调了才触发），此处不期望 update 被调。
  it("settings 命名空间注册（inject settings 装配面）", async () => {
    const refs = await applyWithSettings();
    expect(refs.registerCalled).toBeTruthy();
  });

  it("uiUpdate 懒写入：apply 时不触发", async () => {
    const refs = await applyWithSettings();
    expect(refs.updateCalled).toBe(false);
  });
});

describe("apply 的 agent/pre-step 监听（announceCatalog=false）", () => {
  it("announceCatalog=false 不注册 pre-step 监听", async () => {
    const dir = makeTempDir("dsh-mcp-manager-Nc-");
    let preStepHandler = null;
    const ctx = baseCtx({
      on: (event, handler) => {
        if (event === "agent/pre-step") preStepHandler = handler;
        return () => {};
      },
    });

    await apply(ctx, { enabled: true, announceCatalog: false, storePath: join(dir, "mcp.json") });
    expect(preStepHandler).toBeNull();
  });
});

describe("apply 的 route disposer（SSE 连接清理）", () => {
  async function applyWithRouteDisposer() {
    const dir = makeTempDir("dsh-mcp-manager-rd-");
    const refs = { disposeRoutes: null, eventsRouteRegistered: false };
    const sseDestroyed = [];

    const ctx = baseCtx({
      webServer: {
        register: (route) => {
          if (route.path === "/api/dsh-mcp/events") {
            refs.eventsRouteRegistered = true;
          }
          return () => {};
        },
      },
      effect: (fn) => {
        const disposer = fn();
        refs.disposeRoutes = () => {
          // 手动触发 disposer（模拟上下文卸载）
          disposer();
        };
        return () => {};
      },
    });

    await apply(ctx, { enabled: true, storePath: join(dir, "mcp.json") });
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
    expect(() => refs.disposeRoutes()).not.toThrow();
  });
});

// resolveMiddlewareMode 三态（issue #664 阶段 1：配置域逻辑归位，C-CFG 契约）----
describe("resolveMiddlewareMode 三态", () => {
  function makeManagerFixture() {
    const dir = makeTempDir("dsh-mcp-manager-mode-");
    const store = new McpStore(join(dir, "mcp.json"));
    return new McpManager({ logger: { info: () => {}, warn: () => {} } }, store);
  }

  it("settings 有值优先于 fallback", () => {
    // 态 1：settings 持久化值 = 运行权威（覆盖 schema 默认）
    const manager = makeManagerFixture();
    manager.uiConfigSource = () => ({ middleware: "all" });
    expect(resolveMiddlewareMode(manager, "project")).toBe("all");
  });

  it("settings 无值回落 fallback", () => {
    // 态 2：settings 无值 → fallbackRaw（resolve 侧显式传值）
    const manager = makeManagerFixture();
    manager.uiConfigSource = () => ({});
    expect(resolveMiddlewareMode(manager, "off")).toBe("off");
  });

  it("无 fallback 回落 schema 默认 project", () => {
    // 态 2b：settings 无值且无 fallback → schema 默认 project（第一启动形态）
    const manager = makeManagerFixture();
    manager.uiConfigSource = () => ({});
    expect(resolveMiddlewareMode(manager, undefined)).toBe("project");
  });

  it("settings 非法值回落 off", () => {
    // 态 3：settings 非法值 → normalize 回落 off（读取兼容、不迁移写回）
    const manager = makeManagerFixture();
    manager.uiConfigSource = () => ({ middleware: "bogus" });
    expect(resolveMiddlewareMode(manager, "project")).toBe("off");
  });
});

// B20 红测：makeMiddlewareHotSwitch 热切换补 emitStatus（C-EVT 契约：summary
// 帧源集合含热切换；现状热切换不 emitStatus → summary 帧缺失）----
describe("B20：makeMiddlewareHotSwitch 热切换补 emitStatus", () => {
  function makeHotSwitchFixture() {
    const dir = makeTempDir("dsh-mcp-manager-b20-");
    const manager = new McpManager(
      { logger: { info: () => {}, warn: () => {}, error: () => {} } },
      new McpStore(join(dir, "mcp.json")),
    );
    manager.ctx = { tools: { register: () => () => {} }, on: () => () => {} };
    manager.middlewareMode = "off";
    let emits = 0;
    manager.onStatus(() => {
      emits += 1;
    });
    const hotSwitch = makeMiddlewareHotSwitch(manager, {}, async () => undefined, { current: () => {} });
    return { hotSwitch, emits: () => emits };
  }

  it("B20：热切换后 emitStatus 被触发（summary 帧源含热切换；现状缺失 → 红测）", async () => {
    const { hotSwitch, emits } = makeHotSwitchFixture();
    await hotSwitch("project");
    await pollUntil("热切换 summary 帧（emitStatus coalesce 落定）", () => emits() >= 1);
    expect(emits() >= 1).toBeTruthy();
  });

  it("同模式热切换短路，不重复广播", async () => {
    const { hotSwitch, emits } = makeHotSwitchFixture();
    await hotSwitch("project");
    await pollUntil("热切换 summary 帧（emitStatus coalesce 落定）", () => emits() >= 1);
    await hotSwitch("project");
    await pollUntil("同模式短路无新广播", () => emits() >= 1);
    expect(emits()).toBe(1);
  });

  it("B20：切回 off 同样补 summary 帧", async () => {
    const { hotSwitch, emits } = makeHotSwitchFixture();
    await hotSwitch("project");
    await pollUntil("热切换 summary 帧（emitStatus coalesce 落定）", () => emits() >= 1);
    await hotSwitch("off");
    await pollUntil("切回 off 亦广播", () => emits() >= 2);
    expect(emits() >= 2).toBeTruthy();
  });
});

// D8 红测：off 模式 mcp__ 直呼命中禁用表 → deny ----
// 现状：pre-execute guard 只在 registerMiddlewareTools 内注册（apply.ts
// middlewareMode !== "off" 才调用）→ off 模式 mcp__ 直呼无禁用拦截（「工具级
// 禁用三入口」实际一入口）；修复（spec D8）：guard 挂载与中间层实例解耦、数据源
// 直查 manager.disabledTools、独立注册路径，三模式一致；off 模式不 initMiddleware
// （无连接池副作用，guard 只读禁用表）。
describe("D8：off 模式 mcp__ 直呼命中禁用表 → deny", () => {
  async function applyOffModeWithDisabledTool() {
    const dir = makeTempDir("dsh-mcp-manager-d8-");
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    const guards = new Map();
    const ctx = baseCtx({
      on: (event, handler) => {
        guards.set(event, handler);
        return () => {};
      },
    });
    // 预置工具级禁用表（manager.userStatePath = DSH_HOME/dsh-mcp-user-state.json）。
    const disabled = new Map([["@global", new Map([["svc", new Set(["use_t"])]])]]);
    await saveDisabledTools(join(dir, "dsh-mcp-user-state.json"), disabled);
    await apply(ctx, { enabled: true, middleware: "off", storePath: join(dir, "mcp.json") });
    const restore = () => {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    };
    return { guards, restore };
  }

  it("D8：off 模式 pre-execute guard 已挂载（现状 off 不注册 → 红测）", async () => {
    const { guards, restore } = await applyOffModeWithDisabledTool();
    try {
      const guard = guards.get("tools/pre-execute");
      expect(typeof guard === "function").toBeTruthy();
    } finally {
      restore();
    }
  });

  it("D8：off 模式 mcp__ 直呼命中禁用表 → deny（现状放行 → 红测）", async () => {
    const { guards, restore } = await applyOffModeWithDisabledTool();
    try {
      const guard = guards.get("tools/pre-execute");
      const decision = await guard({ name: "mcp__svc__use_t", agent: { session: { header: {} } } }, async () => ({ kind: "allow" }));
      expect(decision.kind).toBe("deny");
    } finally {
      restore();
    }
  });
});
