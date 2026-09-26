/**
 * dsh-mcp-manager — client-unit：S2 ctx 形状最小面直测（P3-b/B5）。
 *
 * 覆盖 bindSession 分支（list 缺失/getSnapshot 缺失/cwd 变化与未变/空 cwd 仍通知/
 * 快照抛错回落/subscribe 配对）与 floatTopOffset blank 链（blank 真假与缺省、
 * blankY/offsetY 回落链、快照缺失）及 McpClientContext.effect 配对（label 透传 +
 * disposer 执行，对齐 apply ctx.effect 语义）。
 *
 * 离线，无落盘。直连 src/client（client-unit 层，自动落 testLayers；已认领进 client-panel 段——所测 state.ts 归属该段，session/float 暂无归属段故同落，k 约 0；变异无信号声明见 PR 正文）。
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply, inject as clientInject } from "../../src/client/index.ts";
import { bindSession } from "../../src/client/core/session.ts";
import { floatTopOffset } from "../../src/client/float/float.ts";
import { createState } from "../../src/client/core/state.ts";
import { MCP_MANAGER_IDENTITY } from "../../src/shared/interface.ts";
import type { McpClientContext } from "../../src/client/core/state.ts";

const SESSION_PATH = "/api/dsh-mcp/session";

function okFetch(): void {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({}),
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

function fetchCalls(): string[] {
  const f = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return f.mock.calls.map((c) => String(c[0] ?? ""));
}

function fetchBodies(): string[] {
  const f = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return f.mock.calls.map((c) => String((c[1] as { body?: unknown } | undefined)?.body ?? ""));
}

function makeState(cwd: string | undefined): {
  currentCwd: string | undefined;
  updateFloatState: (() => void) | undefined;
  API: { session: string };
  updateCalls: number;
} {
  const st = {
    currentCwd: cwd,
    updateFloatState: undefined as (() => void) | undefined,
    API: { session: SESSION_PATH },
    updateCalls: 0,
  };
  st.updateFloatState = () => {
    st.updateCalls += 1;
  };
  return st;
}

function makeActions(): { refresh: ReturnType<typeof vi.fn> } {
  return { refresh: vi.fn(async () => true) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bindSession 分支", () => {
  it("list 缺失时返回 noop，不发请求不抛错", async () => {
    okFetch();
    const ctx = {} as McpClientContext;
    const state = makeState(undefined);
    const actions = makeActions();
    const dispose = bindSession(ctx, state as never, actions as never);
    expect(typeof dispose).toBe("function");
    dispose();
    expect(fetchCalls()).toEqual([]);
    expect(actions.refresh).not.toHaveBeenCalled();
  });

  it("getSnapshot 缺失时返回 noop", async () => {
    okFetch();
    const ctx = { sessions: { list: {} } } as unknown as McpClientContext;
    const state = makeState(undefined);
    const actions = makeActions();
    const dispose = bindSession(ctx, state as never, actions as never);
    dispose();
    expect(fetchCalls()).toEqual([]);
  });

  it("cwd 变化时 POST 会话并 refresh", async () => {
    okFetch();
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => ({ current: "s1", byId: { s1: { cwd: "/a" } } }),
        },
      },
    } as unknown as McpClientContext;
    const state = makeState(undefined);
    const actions = makeActions();
    bindSession(ctx, state as never, actions as never);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(state.currentCwd).toBe("/a");
    expect(state.updateCalls).toBe(1);
    expect(fetchCalls()).toEqual([SESSION_PATH]);
    expect(fetchBodies()[0]).toContain("/a");
    expect(actions.refresh).toHaveBeenCalledTimes(1);
  });

  it("cwd 未变时不 POST（短路）", async () => {
    okFetch();
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => ({ current: "s1", byId: { s1: { cwd: "/a" } } }),
        },
      },
    } as unknown as McpClientContext;
    const state = makeState("/a");
    const actions = makeActions();
    bindSession(ctx, state as never, actions as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.currentCwd).toBe("/a");
    expect(fetchCalls()).toEqual([]);
    expect(actions.refresh).not.toHaveBeenCalled();
  });

  it("空 cwd 也显式通知宿主（body 为空串，防串台）", async () => {
    okFetch();
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => ({ current: "s1", byId: { s1: {} } }),
        },
      },
    } as unknown as McpClientContext;
    const state = makeState("/a");
    const actions = makeActions();
    bindSession(ctx, state as never, actions as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.currentCwd).toBeUndefined();
    expect(fetchCalls()).toEqual([SESSION_PATH]);
    expect(fetchBodies()[0]).toContain('\"cwd\":\"\"');
  });

  it("快照抛错时回落 cwd=undefined 并继续走变更通知", async () => {
    okFetch();
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => {
            throw new Error("snapshot boom");
          },
        },
      },
    } as unknown as McpClientContext;
    const state = makeState("/a");
    const actions = makeActions();
    bindSession(ctx, state as never, actions as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.currentCwd).toBeUndefined();
    expect(fetchCalls()).toEqual([SESSION_PATH]);
  });

  it("subscribe 存在时返回其 disposer（配对），缺失时返回 noop", () => {
    okFetch();
    const disposer = vi.fn();
    const subscribe = vi.fn(() => disposer);
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => ({ current: "s1", byId: { s1: { cwd: "/a" } } }),
          subscribe,
        },
      },
    } as unknown as McpClientContext;
    const state = makeState(undefined);
    const actions = makeActions();
    const ret = bindSession(ctx, state as never, actions as never);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(ret).toBe(disposer);

    const ctx2 = {
      sessions: {
        list: {
          getSnapshot: () => ({ current: "s1", byId: { s1: { cwd: "/a" } } }),
        },
      },
    } as unknown as McpClientContext;
    const ret2 = bindSession(ctx2, makeState(undefined) as never, makeActions() as never);
    expect(typeof ret2).toBe("function");
    ret2();
  });
});

describe("floatTopOffset blank 链", () => {
  function ctxWith(session: Record<string, unknown> | undefined): McpClientContext {
    if (session === undefined) return {} as McpClientContext;
    return {
      sessions: {
        list: {
          getSnapshot: () => ({ current: "s1", byId: { s1: session } }),
        },
      },
    } as unknown as McpClientContext;
  }

  it("blank 会话取 blankY，非 blank 取 offsetY", () => {
    const state = createState();
    state.mcpUiConfig = { ...state.mcpUiConfig, offsetY: 8, blankY: 40 };
    expect(floatTopOffset(ctxWith({ blank: true }), state)).toBe(40);
    expect(floatTopOffset(ctxWith({ blank: false }), state)).toBe(8);
    expect(floatTopOffset(ctxWith({}), state)).toBe(8);
  });

  it("blankY 缺失时回落 offsetY，offsetY 缺失时回落 8", () => {
    const state = createState();
    state.mcpUiConfig = { ...state.mcpUiConfig, offsetY: 12, blankY: 12 };
    (state.mcpUiConfig as { blankY?: unknown }).blankY = undefined as unknown as number;
    expect(floatTopOffset(ctxWith({ blank: true }), state)).toBe(12);
    (state.mcpUiConfig as { offsetY?: unknown }).offsetY = undefined as unknown as number;
    expect(floatTopOffset(ctxWith({ blank: false }), state)).toBe(8);
  });

  it("快照缺失时按非 blank 取 offsetY", () => {
    const state = createState();
    state.mcpUiConfig = { ...state.mcpUiConfig, offsetY: 9, blankY: 40 };
    expect(floatTopOffset(ctxWith(undefined), state)).toBe(9);
    expect(floatTopOffset({ sessions: { list: {} } } as unknown as McpClientContext, state)).toBe(
      9,
    );
  });
});

describe("McpClientContext.effect 配对（对齐 apply 语义）", () => {
  it("label 透传且返回的 disposer 可执行清理", () => {
    let cleaned = false;
    let seenLabel: string | undefined;
    let captured: (() => () => void) | undefined;
    const ctx = {
      get: () => undefined,
      effect: (fn: () => () => void, label?: string) => {
        seenLabel = label;
        captured = fn;
      },
      sessions: {},
    } as unknown as McpClientContext;
    ctx.effect(
      () => () => {
        cleaned = true;
      },
      "dsh-mcp-manager: ui",
    );
    expect(seenLabel).toBe("dsh-mcp-manager: ui");
    expect(typeof captured).toBe("function");
    const dispose = captured!();
    expect(typeof dispose).toBe("function");
    dispose();
    expect(cleaned).toBe(true);
  });
});

type RowView = "summary" | "page";

type RowRegister = (served: ReadonlySet<string>) => () => void;

interface RowRegistration {
  item: Record<string, unknown>;
  render: (props: { view: RowView; form: unknown }) => unknown;
}

interface RowLifecycleHarness {
  watchedNamespaces: readonly string[];
  injectedSlots: readonly string[];
  ledger: readonly RowRegistration[];
  offCalls: () => number;
  watchStops: () => number;
  serve: (servedNamespaces: ReadonlySet<string>) => void;
  unserved: () => void;
  teardown: () => void;
}

/**
 * 用真实 apply 建立 row 生命周期；空 head 让样式 no-op，随后浮窗挂载在 DOM 面停止。
 * row effect 已在这两步之间建立，故夹具只观察装配与清理契约。
 */
function bootRowLifecycle(): RowLifecycleHarness {
  const watchedNamespaces: string[] = [];
  const injectedSlots: string[] = [];
  const ledger: RowRegistration[] = [];
  const effectDisposers: (() => void)[] = [];
  let registerRow: RowRegister | undefined;
  let activeOff: (() => void) | undefined;
  let offCalls = 0;
  let watchStops = 0;

  const slots = {
    inject(name: string, setup: () => unknown): () => void {
      injectedSlots.push(name);
      const registered = setup();
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        offCalls += 1;
        if (typeof registered === "function") registered();
      };
    },
    register(item: Record<string, unknown>, render: RowRegistration["render"]): () => void {
      const registration: RowRegistration = { item: { ...item }, render };
      ledger.push(registration);
      return () => {
        const index = ledger.indexOf(registration);
        if (index !== -1) ledger.splice(index, 1);
      };
    },
  };
  const unserved = (): void => {
    const off = activeOff;
    activeOff = undefined;
    off?.();
  };
  const configForms = {
    whileServed(namespaces: readonly string[], register: RowRegister): () => void {
      watchedNamespaces.push(...namespaces);
      registerRow = register;
      return () => {
        watchStops += 1;
        unserved();
      };
    },
  };
  const ctx = {
    get(name: string): unknown {
      if (name === "slots") return slots;
      if (name === "configForms") return configForms;
      return undefined;
    },
    effect(fn: () => () => void): () => void {
      const dispose = fn();
      effectDisposers.push(dispose);
      return dispose;
    },
    sessions: {},
  } as unknown as McpClientContext;

  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWarn = console.warn;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { head: null },
  });
  console.warn = () => {};
  try {
    apply(ctx);
  } finally {
    console.warn = previousWarn;
    if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, "document", previousDocument);
  }

  return {
    watchedNamespaces,
    injectedSlots,
    ledger,
    offCalls: () => offCalls,
    watchStops: () => watchStops,
    serve: (servedNamespaces) => {
      if (registerRow === undefined) throw new Error("configForms did not capture row register");
      unserved();
      const intersects = [...servedNamespaces].some((namespace) =>
        watchedNamespaces.includes(namespace),
      );
      if (intersects) activeOff = registerRow(new Set(servedNamespaces));
    },
    unserved,
    teardown: () => {
      const dispose = effectDisposers[0];
      if (dispose === undefined) throw new Error("row registration was not held by ctx.effect");
      dispose();
    },
  };
}

describe("0.1.7-rc.2 plugins.row.config 装配", () => {
  it("apply 只监听 canonical settings namespace，服务前 slot ledger 为空", () => {
    const harness = bootRowLifecycle();
    expect(harness.watchedNamespaces).toEqual([MCP_MANAGER_IDENTITY.settingsNamespace]);
    expect(harness.injectedSlots).toEqual([]);
    expect(harness.ledger).toEqual([]);
  });

  it("服务后注册精确 keyed row，并把 summary/page view 与 form 交给组件", () => {
    const harness = bootRowLifecycle();
    harness.serve(new Set(["dsh-mcp-manager"]));
    expect(harness.injectedSlots).toEqual(["plugins.row.config"]);
    expect(harness.ledger).toHaveLength(1);
    expect(harness.ledger[0]?.item).toEqual({
      name: "plugins.row.config",
      key: MCP_MANAGER_IDENTITY.rowConfigKey,
      locale: "mcpManager",
    });
    const form = { id: "config-form" };
    const summary = harness.ledger[0]?.render({ view: "summary", form }) as {
      props?: { view?: string; form?: unknown };
    } | null;
    const page = harness.ledger[0]?.render({ view: "page", form }) as {
      props?: { view?: string; form?: unknown };
    } | null;
    expect(summary?.props).toEqual({ view: "summary", form });
    expect(page?.props).toEqual({ view: "page", form });
  });

  it.each([
    ["legacy host namespace", ["ui-dsh-mcp-manager"]],
    ["empty host facts", []],
  ] as const)("%s 不注册 row", (_label, servedNamespaces) => {
    const harness = bootRowLifecycle();
    harness.serve(new Set(servedNamespaces));
    expect(harness.injectedSlots).toEqual([]);
    expect(harness.ledger).toEqual([]);
  });

  it("namespace 撤下调用 register 返回的 off 并清空 slot ledger", () => {
    const harness = bootRowLifecycle();
    harness.serve(new Set(["dsh-mcp-manager"]));
    harness.unserved();
    expect(harness.ledger).toEqual([]);
    expect(harness.offCalls()).toBe(1);
  });

  it("外层 effect teardown 停止 watch、调用当前 off 并清空 slot ledger", () => {
    const harness = bootRowLifecycle();
    harness.serve(new Set(["dsh-mcp-manager"]));
    harness.teardown();
    expect(harness.ledger).toEqual([]);
    expect(harness.offCalls()).toBe(1);
    expect(harness.watchStops()).toBe(1);
  });

  it("canonical identity 的 package/row/settings/key 关系可追溯", () => {
    const metadata = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { name: string };
    expect(metadata.name).toBe(MCP_MANAGER_IDENTITY.bundlePackage);
    const hostSource = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    const clientSource = readFileSync(
      new URL("../../src/client/index.ts", import.meta.url),
      "utf8",
    );
    expect(hostSource).toContain("MCP_MANAGER_IDENTITY.settingsNamespace");
    expect(hostSource).toContain("shared/interface.ts");
    expect(clientSource).toContain("MCP_MANAGER_IDENTITY.settingsNamespace");
    expect(clientSource).toContain("MCP_MANAGER_IDENTITY.rowConfigKey");
    expect(clientSource).toContain("shared/interface.ts");
    expect(MCP_MANAGER_IDENTITY).toEqual({
      bundlePackage: "@wingsky-1/dsh-mcp-manager",
      rowId: "dsh-mcp-manager",
      settingsNamespace: "dsh-mcp-manager",
      rowConfigKey: "@wingsky-1/dsh-mcp-manager#dsh-mcp-manager",
    });
  });

  it("source inject 精确声明 configForms", () => {
    expect(clientInject).toEqual(["sessions", "slots", "configForms", "locale"]);
  });

  it("package client metadata 注入官方 settings provider", () => {
    const metadata = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { dsh: { client: { inject: string[] } } };
    expect(metadata.dsh.client.inject).toContain("@deepseek-ai/dsh-client-ui-settings");
  });

  it("client 装配源码拒绝两个 legacy settings slot", () => {
    const source = ["index.ts", "settings/settings-card.tsx"]
      .map((path) => readFileSync(new URL("../../src/client/" + path, import.meta.url), "utf8"))
      .join("\n");
    const legacySlots = [
      ["settings", "plugin", "item"].join("."),
      ["settings", "plugins", "tab"].join("."),
    ];
    expect(legacySlots.filter((slot) => source.includes(slot))).toEqual([]);
  });
});
