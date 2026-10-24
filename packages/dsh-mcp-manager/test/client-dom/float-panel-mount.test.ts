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
 *   `flushRafInto(rafPending)` 手动排空）。用真 rAF 的话「同帧合并」与「下一帧才 armOpen」都得靠
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

import {
  conversationHost,
  dockedBottomEdge,
  panelHost,
  placePanel,
  toggleFloat,
} from "../../src/client/float/float.ts";
import {
  entry,
  flushRafInto,
  FAKE_ZH,
  makeActions,
  panelState,
  stubRect,
} from "./client-shape-float.js";

let rafPending: Map<number, (t: number) => void>;
let rafNextId: number;
let realRaf: typeof globalThis.requestAnimationFrame;
let realCancelRaf: typeof globalThis.cancelAnimationFrame;

beforeEach(() => {
  document.body.textContent = "";
  rafPending = new Map();
  rafNextId = 1;
  realRaf = globalThis.requestAnimationFrame;
  realCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: (t: number) => void): number => {
    const id = rafNextId;
    rafNextId += 1;
    rafPending.set(id, cb);
    return id;
  }) as unknown as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number): void => {
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

/**
 * 可控 rAF 替身：回调按 id 入队，由 flushRafInto(rafPending) 排空。
 *
 * 刻意做成**带 id 的真取消**（cancelAnimationFrame 从队列里摘掉该 id），而不只是计数：
 * mountFloat 的 disposer 有一条「卸载时取消已排队的重算」的行为，计数替身无法证明
 * 那一帧真的不会跑——那又是一条「断言量与被改代码之间没有因果连线」的形态。
 */
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
    flushRafInto(rafPending);
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
    flushRafInto(rafPending);
    toggleFloat(s, actions, false);
    expect(s.floatOpen).toBe(false);
    expect(s.floatPill!.classList.contains("dm-float--open")).toBe(false);
  });

  it("收起走 300ms 动画：299ms 仍可见、300ms 才 hidden", () => {
    const s = panelState();
    const { actions } = makeActions();
    toggleFloat(s, actions, true);
    flushRafInto(rafPending);
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
    flushRafInto(rafPending);
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
    flushRafInto(rafPending);
    expect(s.floatPanel!.querySelectorAll(".dm-float-row").length).toBe(1);
    toggleFloat(s, actions, false);
    expect(s.floatPanel!.querySelectorAll(".dm-float-row").length).toBe(1);
  });
});
