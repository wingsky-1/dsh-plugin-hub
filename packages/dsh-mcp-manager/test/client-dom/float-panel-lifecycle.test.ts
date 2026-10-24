// @vitest-environment happy-dom
/**
 * dsh-mcp-manager — client-dom：float/float.ts 的**浮窗挂载与卸载**判据。
 *
 * 覆盖面：mountFloat 的挂载配置、dispose、交互监听、rAF 与容器迁移。
 * 顶层 beforeEach/afterEach 保持原 RAF/clock/DOM 生命周期。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bindLocale } from "../../../../shared/client/i18n.js";
import { createState } from "../../src/client/core/state.ts";
import { mountFloat, toggleFloat } from "../../src/client/float/float.ts";
import {
  entry,
  flushRafInto,
  FAKE_ZH,
  makeActions,
  settle,
  stubRect,
} from "./client-shape-float.js";

let rafPending: Map<number, (t: number) => void>;
let rafNextId: number;
let rafCancelled: number;
let realRaf: typeof globalThis.requestAnimationFrame;
let realCancelRaf: typeof globalThis.cancelAnimationFrame;

/** 仍在排队的帧数。 */
function rafQueueLength(): number {
  return rafPending.size;
}

beforeEach(() => {
  document.body.textContent = "";
  rafPending = new Map();
  rafNextId = 1;
  rafCancelled = 0;
  realRaf = globalThis.requestAnimationFrame;
  realCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: (t: number) => void): number => {
    const id = rafNextId;
    rafNextId += 1;
    rafPending.set(id, cb);
    return id;
  }) as unknown as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number): void => {
    rafCancelled += 1;
    rafPending.delete(id);
  }) as unknown as typeof globalThis.cancelAnimationFrame;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  bindLocale(
    {
      bind:
        () =>
        (key: string, params?: Record<string, unknown>): string => {
          const t = FAKE_ZH[key];
          if (t === undefined) return key;
          let out = t;
          for (const [n, v] of Object.entries(params ?? {})) {
            out = out.split(`{${n}}`).join(String(v));
          }
          return out;
        },
    },
    "mcpManager",
  );
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancelRaf;
  document.body.textContent = "";
  bindLocale({ bind: () => (key: string) => key }, "mcpManager");
});

function registerMountSetup(it: (name: string, fn: () => void) => void): void {
  it("挂载：胶囊与面板都进 DOM，胶囊挂会话容器、面板挂 overlay", () => {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-shell-overlay", "");
    document.body.appendChild(overlay);
    const host = document.createElement("div");
    host.setAttribute("data-conversation-scroll", "");
    document.body.appendChild(host);

    const state = createState();
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    expect(state.floatPill).toBeDefined();
    expect(state.floatPanel).toBeDefined();
    expect(state.floatPill!.parentElement).toBe(host);
    expect(state.floatPanel!.parentElement).toBe(overlay);
    expect(state.floatPill!.getAttribute("aria-label")).toBe("MCP 管理器");
    dispose();
  });

  it("挂载：胶囊渲染出摘要文案（renderPill 被调用）", () => {
    const state = createState();
    state.servers = [entry()];
    state.counts = { connected: 1 };
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    expect(state.floatPill!.textContent).toContain("MCP 1/1");
    dispose();
  });

  it("挂载：按配置写层级基准与 fixed 定位（zIndexBase 越界被 clamp）", () => {
    const state = createState();
    state.mcpUiConfig = {
      position: "top-right",
      offsetX: 8,
      offsetY: 8,
      blankY: 40,
      zIndexBase: 99999,
    };
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    expect(state.floatPill!.style.zIndex).toBe("9000");
    expect(state.floatPanel!.style.zIndex).toBe("9000");
    expect(state.floatPill!.style.position).toBe("fixed");
    dispose();
  });

  it("挂载：按容器宽度写断点档位 data 属性", () => {
    const host = document.createElement("div");
    host.setAttribute("data-conversation-scroll", "");
    document.body.appendChild(host);
    stubRect(host, { top: 0, bottom: 600, left: 0, right: 300, width: 300, height: 600 });
    const state = createState();
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    expect(state.floatPill!.dataset.dmBp).toBe("narrow");
    expect(state.floatPanel!.dataset.dmBp).toBe("narrow");
    dispose();
  });

  it("卸载：元素移除、state 引用清空、updateFloatState 置空", () => {
    const state = createState();
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    const pill = state.floatPill!;
    expect(state.updateFloatState).toBeTypeOf("function");
    dispose();
    expect(pill.isConnected).toBe(false);
    expect(state.floatPill).toBeUndefined();
    expect(state.floatPanel).toBeUndefined();
    expect(state.updateFloatState).toBeUndefined();
    expect(state.floatOpen).toBe(false);
  });
}

function registerDispose(it: (name: string, fn: () => void) => void): void {
  it("卸载后再触发 scroll：不再重算（监听器已解绑）", () => {
    const host = document.createElement("div");
    host.setAttribute("data-conversation-scroll", "");
    document.body.appendChild(host);
    const state = createState();
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    const fn = state.updateFloatState!;
    dispose();
    // 卸载后 state.updateFloatState 已被清空；直接调旧引用不应再产生排队任务
    void fn;
    host.dispatchEvent(new Event("scroll"));
    expect(rafQueueLength()).toBe(0);
  });

  it("卸载时取消已排队的重算（dispose 调 cancelAnimationFrame，不留悬挂帧）", () => {
    const host = document.createElement("div");
    host.setAttribute("data-conversation-scroll", "");
    document.body.appendChild(host);
    const state = createState();
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    // 排一帧但不排空：dispose 时 rafId !== 0，必须被取消
    rafPending.clear();
    rafCancelled = 0;
    host.dispatchEvent(new Event("scroll"));
    expect(rafQueueLength()).toBe(1);
    dispose();
    expect(rafCancelled).toBe(1);
    expect(rafQueueLength()).toBe(0);
  });

  it("胶囊点击 → 展开浮窗（点击接线）", () => {
    const state = createState();
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    state.floatPill!.dispatchEvent(new Event("click"));
    expect(state.floatOpen).toBe(true);
    dispose();
  });
}

function registerInteraction(it: (name: string, fn: () => void) => void): void {
  it("Esc 关闭浮窗（文档级 keydown）", () => {
    const state = createState();
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    state.floatPill!.dispatchEvent(new Event("click"));
    flushRafInto(rafPending);
    expect(state.floatOpen).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(state.floatOpen).toBe(false);
    dispose();
  });

  it("Esc 已被他人 preventDefault → 让位（不抢）", () => {
    const state = createState();
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    state.floatPill!.dispatchEvent(new Event("click"));
    flushRafInto(rafPending);
    const preventer = (e: Event): void => {
      e.preventDefault();
    };
    document.addEventListener("keydown", preventer, { capture: true });
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    } finally {
      document.removeEventListener("keydown", preventer, { capture: true });
    }
    expect(state.floatOpen).toBe(true);
    dispose();
  });

  it("焦点移出胶囊/面板 → 收起浮窗（focusout 自动关闭）", () => {
    const state = createState();
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    state.floatPill!.dispatchEvent(new Event("click"));
    flushRafInto(rafPending);
    expect(state.floatOpen).toBe(true);
    // relatedTarget 落在胶囊/面板之外 → 收起
    state.floatPill!.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }),
    );
    expect(state.floatOpen).toBe(false);
    dispose();
  });

  it("焦点仍在胶囊/面板内部 → 不收起（relatedTarget 命中面板即让位）", () => {
    const state = createState();
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    state.floatPill!.dispatchEvent(new Event("click"));
    flushRafInto(rafPending);
    const inner = document.createElement("span");
    state.floatPanel!.appendChild(inner);
    state.floatPill!.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: inner }),
    );
    expect(state.floatOpen).toBe(true);
    dispose();
  });

  it("工具 checkbox 请求失败 → 回滚勾选（乐观更新必须能自愈）", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<unknown> => ({
      ok: false,
      status: 500,
      json: async (): Promise<unknown> => ({ error: "boom" }),
    })) as unknown as typeof fetch;
    try {
      const state = createState();
      state.projectRoot = "/p";
      state.servers = [entry({ tools: ["t1"], scope: "project" })];
      const dispose = mountFloat(state as never, state as never, makeActions().actions);
      toggleFloat(state, makeActions().actions, true);
      const box = state.floatPanel!.querySelector<HTMLInputElement>("input[type=checkbox]")!;
      box.checked = true;
      box.dispatchEvent(new Event("change"));
      await settle();
      expect(box.checked).toBe(false);
      dispose();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("卸载后 Esc 不再关浮窗（监听器成对解绑，不泄漏到下一个挂载）", () => {
    const s1 = createState();
    const d1 = mountFloat(s1 as never, s1 as never, makeActions().actions);
    d1();
    const s2 = createState();
    const d2 = mountFloat(s2 as never, s2 as never, makeActions().actions);
    s2.floatPill!.dispatchEvent(new Event("click"));
    flushRafInto(rafPending);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(s2.floatOpen).toBe(false);
    d2();
  });
}

function registerScrollAndMove(it: (name: string, fn: () => void) => void): void {
  it("同帧多次 scroll 只排一次重算（rAF 合并）", () => {
    const host = document.createElement("div");
    host.setAttribute("data-conversation-scroll", "");
    document.body.appendChild(host);
    const state = createState();
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    rafPending.clear();
    host.dispatchEvent(new Event("scroll"));
    host.dispatchEvent(new Event("scroll"));
    host.dispatchEvent(new Event("scroll"));
    expect(rafQueueLength()).toBe(1);
    dispose();
  });

  it("DOM 变更后胶囊迁移到新出现的会话容器（place 去抖）", async () => {
    const state = createState();
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    expect(state.floatPill!.parentElement).toBe(document.body);
    const host = document.createElement("div");
    host.setAttribute("data-conversation-scroll", "");
    document.body.appendChild(host);
    await settle();
    flushRafInto(rafPending);
    await settle();
    expect(state.floatPill!.parentElement).toBe(host);
    dispose();
  });
}

describe("float：mountFloat 挂载与卸载", () => {
  registerMountSetup(it);
  registerDispose(it);
  registerInteraction(it);
  registerScrollAndMove(it);
});
