// @vitest-environment happy-dom
/**
 * dsh-mcp-manager — client-dom：float/float.ts 的**浮窗面板与挂载层**判据（对应豁免清理第 8b 笔）。
 *
 * 环境声明必须落在文件里（变异面按拓扑派生的是单 project node 环境配置）。
 *
 * 覆盖面：placePanel、toggleFloat、mountFloat、conversationHost、panelHost、dockedBottomEdge。
 * 与 8a（test/client-dom/float-pill-render.test.ts，胶囊与渲染层）互补，两笔各自可独立回退。
 *
 * ## 假件与替身说明（testing SKILL §3）
 *
 * - **requestAnimationFrame / cancelAnimationFrame**：手写可控替身（回调入队、由
 *   `flushRaf()` 手动排空）。用真 rAF 的话「同帧合并」与「下一帧才 armOpen」都得靠
 *   真实时间推进，判据会退化成对时序的祈祷；可控队列让「第 1 次调用排入、第 2 次被
 *   合并掉」这类**次数**判据成为确定量。
 * - **getBoundingClientRect / offsetWidth / offsetHeight**：happy-dom 全部返回 0，
 *   而 placePanel 的首行守卫正是「宽高皆 0 就返回」。不覆写它，整条定位算式恒不执行。
 *   这里按元素**逐个**覆写（defineProperty），只在被测元素上打桩，不改原型。
 * - **window.innerWidth / innerHeight**：happy-dom 默认 1024×768，按用例需要覆写。
 * - **fetch / actions / alert / confirm**：手写记录对象，afterEach 还原。
 * - 不用 vi.mock / vi.fn / vi.spyOn。唯一 vi 用法是假时钟，且 toFake 面显式声明
 *   （只钉 setTimeout/clearTimeout，**不钉 rAF**——rAF 已由上面的手写替身接管）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bindLocale } from "../../../../shared/client/i18n.js";
import { createState } from "../../src/client/core/state.ts";
import type { McpServerListEntry, McpState, UiActions } from "../../src/client/core/state.ts";
import { el } from "../../src/client/core/dom.ts";
import {
  conversationHost,
  dockedBottomEdge,
  mountFloat,
  panelHost,
  placePanel,
  toggleFloat,
} from "../../src/client/float/float.ts";

const FAKE_ZH: Record<string, string> = {
  floatTitle: "MCP 管理器",
  floatAriaLabel: "MCP 管理器",
  floatEmptyTitle: "还没有 MCP 服务器",
  floatEmptyCta: "去添加",
  floatGlobalSession: "全局会话",
  healthRunning: "运行中 {n}",
};

const entry = (raw: Partial<McpServerListEntry> = {}): McpServerListEntry =>
  ({
    name: "ctx7",
    transport: "stdio",
    status: "connected",
    scope: "global",
    enabled: true,
    ...raw,
  }) as McpServerListEntry;

function makeActions(): { actions: UiActions; calls: string[] } {
  const calls: string[] = [];
  const actions: UiActions = {
    refresh: async (): Promise<boolean> => {
      calls.push("refresh");
      return true;
    },
    resetForm: (): void => {
      calls.push("resetForm");
    },
    beginEdit: (): void => {
      calls.push("beginEdit");
    },
    switchTab: (): void => {
      calls.push("switchTab");
    },
    close: (): void => {
      calls.push("close");
    },
    showPanel: (): void => {
      calls.push("showPanel");
    },
    toggleFloat: (): void => {
      calls.push("toggleFloat");
    },
  };
  return { actions, calls };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/**
 * 可控 rAF 替身：回调按 id 入队，由 flushRaf() 排空。
 *
 * 刻意做成**带 id 的真取消**（cancelAnimationFrame 从队列里摘掉该 id），而不只是计数：
 * mountFloat 的 disposer 有一条「卸载时取消已排队的重算」的行为，计数替身无法证明
 * 那一帧真的不会跑——那又是一条「断言量与被改代码之间没有因果连线」的形态。
 */
let rafPending: Map<number, (t: number) => void>;
let rafNextId: number;
let rafCancelled: number;
let realRaf: typeof globalThis.requestAnimationFrame;
let realCancelRaf: typeof globalThis.cancelAnimationFrame;

/** 仍在排队的帧数。 */
function rafQueueLength(): number {
  return rafPending.size;
}

function flushRaf(): void {
  const q = [...rafPending.values()];
  rafPending.clear();
  for (const cb of q) cb(0);
}

/** 给元素打上确定尺寸与位置（happy-dom 默认全 0，会让定位算式整条不执行）。 */
function stubRect(
  node: HTMLElement,
  rect: { top: number; bottom: number; left: number; right: number; width: number; height: number },
): void {
  node.getBoundingClientRect = (): DOMRect =>
    ({
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: (): Record<string, number> => ({}),
    }) as DOMRect;
  Object.defineProperty(node, "offsetWidth", { value: rect.width, configurable: true });
  Object.defineProperty(node, "offsetHeight", { value: rect.height, configurable: true });
}

/** 装一对已挂载的胶囊 + 面板，带确定尺寸。 */
function panelState(
  raw: Partial<McpState> = {},
  rect = { top: 100, bottom: 140, left: 900, right: 940, width: 40, height: 40 },
): McpState {
  const state = createState();
  Object.assign(state, raw);
  const pill = el("button", { class: "dm-float" });
  const panel = el("div", { class: "dm-float-panel" });
  panel.hidden = true;
  stubRect(pill, rect);
  stubRect(panel, { top: 0, bottom: 200, left: 0, right: 200, width: 200, height: 200 });
  document.body.appendChild(pill);
  document.body.appendChild(panel);
  state.floatPill = pill;
  state.floatPanel = panel;
  return state;
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

describe("float：conversationHost / panelHost 宿主解析", () => {
  it("conversationHost：优先 [data-conversation-scroll]", () => {
    const host = document.createElement("div");
    host.setAttribute("data-conversation-scroll", "");
    document.body.appendChild(host);
    expect(conversationHost()).toBe(host);
  });

  it("conversationHost：无首选时回退 [data-pane=conversation]", () => {
    const host = document.createElement("div");
    host.setAttribute("data-pane", "conversation");
    document.body.appendChild(host);
    expect(conversationHost()).toBe(host);
  });

  it("conversationHost：再回退 .pI_x6G_centerCol", () => {
    const host = document.createElement("div");
    host.className = "pI_x6G_centerCol";
    document.body.appendChild(host);
    expect(conversationHost()).toBe(host);
  });

  it("conversationHost：三者皆无时回退 document.body（不返回 null）", () => {
    expect(conversationHost()).toBe(document.body);
  });

  it("panelHost：优先 [data-shell-overlay]，否则 document.body", () => {
    expect(panelHost()).toBe(document.body);
    const overlay = document.createElement("div");
    overlay.setAttribute("data-shell-overlay", "");
    document.body.appendChild(overlay);
    expect(panelHost()).toBe(overlay);
  });
});

describe("float：dockedBottomEdge 底部锚点下边界", () => {
  it("composer seat 贴底 → 取 seat 上缘（胶囊上移到输入区上方）", () => {
    const seat = document.createElement("div");
    seat.setAttribute("data-composer-seat", "");
    document.body.appendChild(seat);
    stubRect(seat, { top: 700, bottom: 800, left: 0, right: 100, width: 100, height: 100 });
    // 容器 bottom = 800，与 seat.bottom 相同 → 贴底（容差 0.5）
    expect(dockedBottomEdge({ top: 0, bottom: 800 })).toBe(700);
  });

  it("seat 存在但未贴底（距底缘 1px）→ 用容器底（桌面零回归）", () => {
    const seat = document.createElement("div");
    seat.setAttribute("data-composer-seat", "");
    document.body.appendChild(seat);
    stubRect(seat, { top: 700, bottom: 799, left: 0, right: 100, width: 100, height: 100 });
    expect(dockedBottomEdge({ top: 0, bottom: 800 })).toBe(800);
  });

  it("无 seat 节点 → 用容器底", () => {
    expect(dockedBottomEdge({ top: 0, bottom: 640 })).toBe(640);
  });
});

describe("float：placePanel 下拉面板定位", () => {
  it("胶囊/面板未挂载 → 直接返回（不抛）", () => {
    expect(() => {
      placePanel(createState());
    }).not.toThrow();
  });

  it("胶囊零尺寸（未渲染）→ 直接返回，坐标不动", () => {
    const s = panelState();
    stubRect(s.floatPill!, { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
    placePanel(s);
    expect(s.floatPanel!.style.left).toBe("");
    expect(s.floatPanel!.style.top).toBe("");
  });

  it("top-right：面板顶贴在胶囊下缘 + 6px，right 锚点使左缘贴胶囊右缘", () => {
    const s = panelState();
    s.mcpUiConfig = { position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 };
    placePanel(s);
    const panel = s.floatPanel!;
    // 顶锚点：pill.bottom(140) + gap(6) = 146
    expect(panel.style.top).toBe("146px");
    // 右锚点：pill.right(940) - panel.width(200) = 740
    expect(panel.style.left).toBe("740px");
    expect(panel.style.right).toBe("auto");
    expect(panel.style.transformOrigin).toBe("top right");
  });

  it("top-left：左缘贴胶囊左缘，展开原点取左上；越出视口时被 clamp", () => {
    const s = panelState();
    s.mcpUiConfig = { position: "top-left", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 };
    placePanel(s);
    // 原始值 = pill.left(900)；happy-dom 视口 1024 宽、面板 200 宽 → hiX = 824，
    // 故落点是 clamp 后的 824 而非 900。这条同时钉住「左锚点用 left」与「终坐标走视口 clamp」
    // 两件事——把 clamp 拆掉（直接写 rawLeft）本条会红在 900 !== 824 上。
    expect(s.floatPanel!.style.left).toBe("824px");
    expect(s.floatPanel!.style.transformOrigin).toBe("top left");
  });

  it("bottom-right：面板从胶囊上缘向上弹出，原点取右下", () => {
    const s = panelState();
    s.mcpUiConfig = {
      position: "bottom-right",
      offsetX: 8,
      offsetY: 8,
      blankY: 40,
      zIndexBase: 10,
    };
    placePanel(s);
    // 底锚点：pill.top(100) - panel.height(200) - gap(6) = -106 → clamp 到最小 6
    expect(s.floatPanel!.style.top).toBe("6px");
    expect(s.floatPanel!.style.transformOrigin).toBe("bottom right");
  });

  it("坐标经视口 clamp：顶锚点下移越过视口下缘时收在视口内", () => {
    const s = panelState(
      {},
      { top: 700, bottom: 740, left: 900, right: 940, width: 40, height: 40 },
    );
    s.mcpUiConfig = { position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 };
    // happy-dom 默认视口 1024×768；panel 200 高，pill.bottom(740)+6=746 会被 clamp 到 768-200=568
    placePanel(s);
    expect(s.floatPanel!.style.top).toBe("568px");
  });

  it("面板已定位过：重复调用不累积偏移（绝对坐标覆写）", () => {
    const s = panelState();
    s.mcpUiConfig = { position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 };
    placePanel(s);
    const first = s.floatPanel!.style.left;
    placePanel(s);
    expect(s.floatPanel!.style.left).toBe(first);
  });
});

describe("float：toggleFloat 展开与收起", () => {
  it("面板未挂载 → 直接返回（不抛）", () => {
    expect(() => {
      toggleFloat(createState(), makeActions().actions, true);
    }).not.toThrow();
  });

  it("展开：先渲染后定位，面板可见并拿到 open 类", () => {
    const s = panelState();
    const { actions } = makeActions();
    toggleFloat(s, actions, true);
    expect(s.floatOpen).toBe(true);
    expect(s.floatPanel!.hidden).toBe(false);
    // armOpen 走 rAF：未排空前不得有 open 类
    expect(s.floatPanel!.classList.contains("dm-float-panel--open")).toBe(false);
    flushRaf();
    expect(s.floatPanel!.classList.contains("dm-float-panel--open")).toBe(true);
    expect(s.floatPill!.classList.contains("dm-float--open")).toBe(true);
  });

  it("展开后面板内已渲染出内容（健康摘要 + 头部）", () => {
    const s = panelState();
    toggleFloat(s, makeActions().actions, true);
    expect(s.floatPanel!.querySelector(".dm-float-health")).not.toBeNull();
    expect(s.floatPanel!.querySelector(".dm-float-head")).not.toBeNull();
  });

  it("force=false 显式收起（不因当前已关而短路）", () => {
    const s = panelState();
    const { actions } = makeActions();
    toggleFloat(s, actions, true);
    flushRaf();
    toggleFloat(s, actions, false);
    expect(s.floatOpen).toBe(false);
    expect(s.floatPill!.classList.contains("dm-float--open")).toBe(false);
  });

  it("收起走 300ms 动画：299ms 仍可见、300ms 才 hidden", () => {
    const s = panelState();
    const { actions } = makeActions();
    toggleFloat(s, actions, true);
    flushRaf();
    toggleFloat(s, actions, false);
    expect(s.floatPanel!.hidden).toBe(false);
    expect(s.floatPanel!.classList.contains("dm-float-panel--closing")).toBe(true);
    // 边界卡在 299/300：**只断「推 300ms 后 hidden」区分不出 300 与 0**——推 300ms 两者都会
    // 触发。必须断「299ms 仍未隐藏」，那才是动画时长的判据。
    vi.advanceTimersByTime(299);
    expect(s.floatPanel!.hidden).toBe(false);
    expect(s.floatPanel!.classList.contains("dm-float-panel--closing")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(s.floatPanel!.hidden).toBe(true);
    expect(s.floatPanel!.classList.contains("dm-float-panel--closing")).toBe(false);
  });

  it("300ms 内重开：旧 close 的回调让位，不得把新展开的面板又藏起来", () => {
    const s = panelState();
    const { actions } = makeActions();
    toggleFloat(s, actions, true);
    flushRaf();
    toggleFloat(s, actions, false);
    toggleFloat(s, actions, true);
    vi.advanceTimersByTime(400);
    expect(s.floatOpen).toBe(true);
    expect(s.floatPanel!.hidden).toBe(false);
  });

  it("不传 force 时按当前状态取反", () => {
    const s = panelState();
    const { actions } = makeActions();
    expect(s.floatOpen).toBe(false);
    toggleFloat(s, actions);
    expect(s.floatOpen).toBe(true);
    toggleFloat(s, actions);
    expect(s.floatOpen).toBe(false);
  });

  it("展开时面板内服务器行被渲染（收起不清空内容）", () => {
    const s = panelState({ servers: [entry()], counts: { connected: 1 } });
    const { actions } = makeActions();
    toggleFloat(s, actions, true);
    flushRaf();
    expect(s.floatPanel!.querySelectorAll(".dm-float-row").length).toBe(1);
    toggleFloat(s, actions, false);
    expect(s.floatPanel!.querySelectorAll(".dm-float-row").length).toBe(1);
  });
});

describe("float：mountFloat 挂载与卸载", () => {
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

  it("Esc 关闭浮窗（文档级 keydown）", () => {
    const state = createState();
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    state.floatPill!.dispatchEvent(new Event("click"));
    flushRaf();
    expect(state.floatOpen).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(state.floatOpen).toBe(false);
    dispose();
  });

  it("Esc 已被他人 preventDefault → 让位（不抢）", () => {
    const state = createState();
    const dispose = mountFloat(state as never, state as never, makeActions().actions);
    state.floatPill!.dispatchEvent(new Event("click"));
    flushRaf();
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
    flushRaf();
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
    flushRaf();
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
    flushRaf();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(s2.floatOpen).toBe(false);
    d2();
  });

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
    flushRaf();
    await settle();
    expect(state.floatPill!.parentElement).toBe(host);
    dispose();
  });
});
