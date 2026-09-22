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
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindSession } from "../../src/client/core/session.ts";
import { floatTopOffset } from "../../src/client/float/float.ts";
import { createState } from "../../src/client/core/state.ts";
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
