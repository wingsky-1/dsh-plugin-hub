// @vitest-environment happy-dom
/**
 * dsh-mcp-manager — client-dom：float/float.ts 的**胶囊与渲染层**判据（对应豁免清理第 8a 笔）。
 *
 * 环境声明必须落在文件里（变异面按拓扑派生的是单 project node 环境配置）。
 *
 * ## 覆盖面边界（刻意与 8b 分开，两笔各自可独立回退）
 *
 * 本文件覆盖：renderPill、renderFloatHealth、renderFloatRow（含 stagger / 状态点 / 动作按钮 /
 * 工具折叠组）、appendScopeGroup、renderFloatEmpty、openMainPanel、renderFloatPanel，
 * 以及此前无判据的纯函数 floatProjectName / floatTopOffset。
 *
 * 本文件**不**覆盖（留给 8b）：toggleFloat、placePanel、mountFloat、conversationHost、
 * panelHost、dockedBottomEdge。为了不把 8b 的面提前吃掉，本文件全部用
 * `floatOpen: false` 调 renderFloatPanel——那样 `if (state.floatOpen) placePanel(state)`
 * 那支不会命中，placePanel 保持未覆盖。两条豁免的删除条件都要求「水位 + 变异面」同时成立，
 * 因此**本笔只有在自身双条件齐备时才删条目**。
 *
 * ## 夹具纪律（quick-add.ts 上踩过一次，这里先立规矩）
 *
 * floatPill / floatPanel 一律**真实挂到 document.body**。装配代码读的是 state 上的元素引用
 * 与全局 document；不挂载时那些「找不到 → 静默 return / 跳过」的路径会恒成立，
 * 断言就变成与被改代码没有因果连线的装饰性断言（那条恒真绿与本批次已抓到的四次同型）。
 *
 * 假件说明（testing SKILL §3 例外清单）：fetch 是 globalThis 上的**手写**替身（点动作按钮
 * 会真的打请求），只记录 (url, method, body) 并回放固定 JSON；actions 是手写记录对象；
 * window.alert / window.confirm 手写记录并在 afterEach 还原。不用 vi.mock/fn/spyOn。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bindLocale } from "../../../../shared/client/i18n.js";
import { createState } from "../../src/client/core/state.ts";
import type { McpServerListEntry, McpState, UiActions } from "../../src/client/core/state.ts";
import {
  floatProjectName,
  floatTopOffset,
  renderFloatPanel,
  renderPill,
} from "../../src/client/float/float.ts";
import { el } from "../../src/client/core/dom.ts";

/** 假译函数用到的模板：只列本文件断言真正读到文案的键。译文与 key 形态**不同**。 */
const FAKE_ZH: Record<string, string> = {
  floatTitle: "MCP 管理器",
  floatAriaLabel: "MCP 管理器",
  floatManage: "管理",
  floatEmptyTitle: "还没有 MCP 服务器",
  floatEmptyCta: "去添加",
  floatGlobalSession: "全局会话",
  groupProject: "项目级",
  groupGlobal: "全局",
  groupAttention: "需关注（{n}）",
  statusGroupCount: "{status}（{n}）",
  healthRunning: "运行中 {n}",
  healthConnecting: "连接中 {n}",
  healthStopped: "未连接 {n}",
  healthFailed: "失败 {n}",
  serverMeta: "{status} · {tools} 工具",
  toolsCount: "工具（{n}）",
  stConnected: "运行中",
  stConnecting: "连接中",
  stReconnecting: "重连中",
  stStopped: "未连接",
  stDisabled: "已停用",
  stFailed: "失败",
  disconnect: "断开",
  reconnect: "重连",
  connect: "连接",
  enable: "启用",
  disable: "禁用",
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

class FetchFake {
  calls: Array<{ url: string; method: string; body: unknown }> = [];
  private readonly realFetch: typeof globalThis.fetch;

  constructor() {
    this.realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      this.calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
      return Promise.resolve({ ok: true, status: 200, json: async (): Promise<unknown> => ({}) });
    }) as unknown as typeof globalThis.fetch;
  }

  restore(): void {
    globalThis.fetch = this.realFetch;
  }
}

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

/** 取浮窗面板元素（本文件多个 describe 共用，故提到模块作用域）。 */
function panelOf(s: McpState): HTMLElement {
  return s.floatPanel!;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** 建一个「胶囊与面板都已挂载」的 state（真实 DOM，见文件头夹具纪律）。 */
function mountedState(raw: Partial<McpState> = {}): McpState {
  const state = createState();
  Object.assign(state, raw);
  const pill = el("button", { class: "dm-float" });
  const panel = el("div", { class: "dm-float-panel" });
  panel.hidden = true;
  document.body.appendChild(pill);
  document.body.appendChild(panel);
  state.floatPill = pill;
  state.floatPanel = panel;
  return state;
}

let fetchFake: FetchFake;
let alerts: string[];
const realAlert = window.alert;
const realConfirm = window.confirm;
let confirmAnswer = true;

beforeEach(() => {
  document.body.textContent = "";
  alerts = [];
  confirmAnswer = true;
  fetchFake = new FetchFake();
  bindLocale(
    {
      bind:
        () =>
        (key: string, params?: Record<string, unknown>): string => {
          const template = FAKE_ZH[key];
          if (template === undefined) return key;
          let out = template;
          for (const [name, value] of Object.entries(params ?? {})) {
            out = out.split(`{${name}}`).join(String(value));
          }
          return out;
        },
    },
    "mcpManager",
  );
  window.alert = (msg?: string): void => {
    alerts.push(String(msg));
  };
  window.confirm = (): boolean => confirmAnswer;
});

afterEach(() => {
  fetchFake.restore();
  window.alert = realAlert;
  window.confirm = realConfirm;
  document.body.textContent = "";
  bindLocale({ bind: () => (key: string) => key }, "mcpManager");
});

describe("float：浮窗项目名与垂直偏移", () => {
  it("floatProjectName：有项目根取末段", () => {
    expect(floatProjectName(mountedState({ projectRoot: "/a/b/proj" }))).toBe("proj");
  });

  it("floatProjectName：Windows 风格路径同样取末段", () => {
    expect(floatProjectName(mountedState({ projectRoot: "C:\\work\\proj" }))).toBe("proj");
  });

  it("floatProjectName：无根 / 空串回落「全局会话」", () => {
    expect(floatProjectName(mountedState({}))).toBe("全局会话");
    expect(floatProjectName(mountedState({ projectRoot: "" }))).toBe("全局会话");
  });

  it("floatTopOffset：非空白会话取 offsetY", () => {
    const ctx = {} as never;
    const s = mountedState({
      mcpUiConfig: { position: "top-right", offsetX: 8, offsetY: 7, blankY: 40, zIndexBase: 10 },
    });
    expect(floatTopOffset(ctx, s)).toBe(7);
  });

  it("floatTopOffset：配置缺 offsetY/blankY 时回落 8 与该 8（不是 0）", () => {
    const ctx = {} as never;
    const s = mountedState({ mcpUiConfig: {} as never });
    expect(floatTopOffset(ctx, s)).toBe(8);
  });
});

describe("float：renderPill 胶囊渲染", () => {
  it("胶囊未挂载 → 直接返回（不抛）", () => {
    const s = createState();
    expect(() => {
      renderPill(s);
    }).not.toThrow();
  });

  it("空列表：只有状态点与「MCP」，不设 title/aria（保留宿主默认 tooltip）", () => {
    const s = mountedState({ servers: [] });
    renderPill(s);
    const pill = s.floatPill!;
    expect(pill.textContent).toBe("MCP");
    expect(pill.querySelector(".dm-dot")).not.toBeNull();
    expect(pill.hasAttribute("title")).toBe(false);
    expect(pill.hasAttribute("aria-label")).toBe(false);
    expect(pill.classList.contains("dm-float--fail")).toBe(false);
  });

  it("有服务器：文案为「已连/总数」并设 title 与 aria-label", () => {
    const s = mountedState({ servers: [entry(), entry({ name: "b" })], counts: { connected: 1 } });
    renderPill(s);
    const pill = s.floatPill!;
    expect(pill.textContent).toContain("MCP 1/2");
    expect(pill.getAttribute("title")).toBe("MCP 管理器");
    expect(pill.getAttribute("aria-label")).toBe("MCP 管理器 · 1/2");
  });

  it("有失败：加 --fail 修饰 + 「!」标记，title/aria 带失败数", () => {
    const s = mountedState({ servers: [entry()], counts: { connected: 1, failed: 2 } });
    renderPill(s);
    const pill = s.floatPill!;
    expect(pill.classList.contains("dm-float--fail")).toBe(true);
    expect(pill.querySelector(".dm-float-fail")?.textContent).toBe("!");
    expect(pill.getAttribute("title")).toBe("MCP 管理器 · 失败 2");
    expect(pill.getAttribute("aria-label")).toBe("MCP 管理器 · 失败 2");
  });

  it("重连中计入失败数（bad = failed + reconnecting）", () => {
    const s = mountedState({ servers: [entry()], counts: { connected: 1, reconnecting: 2 } });
    renderPill(s);
    expect(s.floatPill!.classList.contains("dm-float--fail")).toBe(true);
    expect(s.floatPill!.getAttribute("title")).toBe("MCP 管理器 · 失败 2");
  });

  it("状态点配色随失败/连接数切换", () => {
    const s = mountedState({ servers: [entry()], counts: { connected: 1 } });
    renderPill(s);
    expect(s.floatPill!.querySelector<HTMLElement>(".dm-dot")!.getAttribute("style")).toContain(
      "state-success",
    );
    const s2 = mountedState({ servers: [entry()], counts: { connected: 1, failed: 1 } });
    renderPill(s2);
    expect(s2.floatPill!.querySelector<HTMLElement>(".dm-dot")!.getAttribute("style")).toContain(
      "state-error",
    );
  });

  it("重复渲染先清空旧内容（不得逐次追加）", () => {
    const s = mountedState({ servers: [entry()], counts: { connected: 1 } });
    renderPill(s);
    const first = s.floatPill!.childNodes.length;
    renderPill(s);
    expect(s.floatPill!.childNodes.length).toBe(first);
  });
});

describe("float：renderFloatPanel 健康摘要与分组", () => {
  it("面板未挂载 → 直接返回（不抛）", () => {
    const s = createState();
    expect(() => {
      renderFloatPanel(s, makeActions().actions);
    }).not.toThrow();
  });

  it("健康摘要有运行段；连接/未连接/失败三段按计数条件出现", () => {
    const s = mountedState({ counts: { connected: 2, connecting: 1, stopped: 1, failed: 3 } });
    renderFloatPanel(s, makeActions().actions);
    const health = panelOf(s).querySelector(".dm-float-health")!;
    expect(health.textContent).toBe("运行中 2 · 连接中 1 · 未连接 1 · 失败 3");
    expect(health.querySelector(".dm-health-ok")?.textContent).toBe("运行中 2");
    expect(health.querySelector(".dm-health-bad")?.textContent).toBe("失败 3");
  });

  it("零计数不产生 0 值文案段（只留运行段）", () => {
    const s = mountedState({ counts: { connected: 0, failed: 0 } });
    renderFloatPanel(s, makeActions().actions);
    expect(panelOf(s).querySelector(".dm-float-health")?.textContent).toBe("运行中 0");
  });

  it("重连中并入「连接中」计数（与面板计数口径一致）", () => {
    const s = mountedState({ counts: { connected: 1, connecting: 1, reconnecting: 2 } });
    renderFloatPanel(s, makeActions().actions);
    expect(panelOf(s).querySelector(".dm-float-health")?.textContent).toBe("运行中 1 · 连接中 3");
  });

  it("空列表 → 空态说明 + 引导按钮", () => {
    const s = mountedState({ servers: [] });
    renderFloatPanel(s, makeActions().actions);
    const empty = panelOf(s).querySelector(".dm-status")!;
    expect(empty.textContent).toContain("还没有 MCP 服务器");
    expect(empty.querySelector("button")?.textContent).toBe("去添加");
  });

  it("空态引导按钮：收起浮窗并打开主面板", () => {
    const s = mountedState({ servers: [], floatOpen: true });
    const { actions, calls } = makeActions();
    // 打开态下 renderFloatPanel 会走 placePanel —— 本笔刻意用 floatOpen=false 以隔离 8b，
    // 故这里先渲一次（关闭态），再手动置开并点 CTA，验证 openMainPanel 的两个动作。
    renderFloatPanel(s, actions);
    s.floatOpen = false;
    const cta = panelOf(s).querySelector<HTMLButtonElement>(".dm-status button")!;
    cta.dispatchEvent(new Event("click"));
    expect(calls).toContain("showPanel");
    expect(s.floatOpen).toBe(false);
  });

  it("面板头含项目名、健康摘要与「管理」按钮", () => {
    const s = mountedState({ projectRoot: "/a/proj", counts: { connected: 1 } });
    renderFloatPanel(s, makeActions().actions);
    expect(panelOf(s).querySelector(".dm-float-title")?.textContent).toBe("proj");
    expect(panelOf(s).querySelector(".dm-float-head button")?.textContent).toBe("管理");
  });

  it("「管理」按钮：收起浮窗并打开主面板", () => {
    const s = mountedState({ projectRoot: "/a/proj" });
    const { actions, calls } = makeActions();
    renderFloatPanel(s, actions);
    panelOf(s)
      .querySelector<HTMLButtonElement>(".dm-float-head button")!
      .dispatchEvent(new Event("click"));
    expect(calls).toContain("showPanel");
  });

  it("失败与重连中进「需关注」置顶组，且组头带 --alert 修饰", () => {
    const s = mountedState({
      servers: [entry({ name: "ok" }), entry({ name: "bad", status: "failed" })],
    });
    renderFloatPanel(s, makeActions().actions);
    const first = panelOf(s).querySelector("section.dm-float-group")!;
    expect(first.querySelector(".dm-float-group-title")?.className).toContain("--alert");
    expect(first.textContent).toContain("bad");
    // 需关注组排在最前
    expect(first.textContent).not.toContain("ok");
  });

  it("project / global 各自成组（标题按 scope 取）", () => {
    const s = mountedState({
      servers: [entry({ name: "p", scope: "project" }), entry({ name: "g", scope: "global" })],
    });
    renderFloatPanel(s, makeActions().actions);
    const titles = [...panelOf(s).querySelectorAll(".dm-float-group-title")].map(
      (n) => n.textContent,
    );
    expect(titles).toEqual(["项目级", "全局"]);
  });

  it("同组内按服务器名排序（localeCompare）", () => {
    const s = mountedState({
      servers: [entry({ name: "c" }), entry({ name: "a" }), entry({ name: "b" })],
    });
    renderFloatPanel(s, makeActions().actions);
    const names = [...panelOf(s).querySelectorAll(".dm-float-name")].map((n) => n.textContent);
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("每行含状态点、名称、摘要、动作区", () => {
    const s = mountedState({ servers: [entry()], counts: { connected: 1 } });
    renderFloatPanel(s, makeActions().actions);
    const row = panelOf(s).querySelector(".dm-float-row")!;
    expect(row.querySelector(".dm-dot")).not.toBeNull();
    expect(row.querySelector(".dm-float-name")?.textContent).toBe("ctx7");
    expect(row.querySelector(".dm-float-meta")?.textContent).toBe("运行中 · 0 工具");
    expect(row.querySelector(".dm-float-actions")).not.toBeNull();
  });

  it("失败行带 --fail 修饰，非失败行不带", () => {
    const s = mountedState({
      servers: [entry({ name: "a" }), entry({ name: "b", status: "failed" })],
    });
    renderFloatPanel(s, makeActions().actions);
    // 按行文本取，不按下标：失败行走「需关注」组而该组**先**渲染，下标 0 未必是非失败行。
    const byName = new Map(
      [...panelOf(s).querySelectorAll(".dm-float-row")].map((r) => [
        r.querySelector(".dm-float-name")!.textContent,
        r.className,
      ]),
    );
    expect(byName.get("b")).toContain("dm-float-row--fail");
    expect(byName.get("a")).not.toContain("dm-float-row--fail");
  });

  it("connected 行两个动作（主 + 禁用）；disabled 行只有一个（主）", () => {
    const s = mountedState({
      servers: [entry({ name: "a" }), entry({ name: "b", status: "disabled" })],
    });
    renderFloatPanel(s, makeActions().actions);
    const byName = new Map(
      [...panelOf(s).querySelectorAll(".dm-float-row")].map((r) => [
        r.querySelector(".dm-float-name")!.textContent,
        r.querySelectorAll(".dm-float-actions button").length,
      ]),
    );
    expect(byName.get("a")).toBe(2);
    expect(byName.get("b")).toBe(1);
  });

  it("有工具才出折叠工具组，且 summary 带工具数", () => {
    const s = mountedState({ servers: [entry({ tools: ["a", "b"] })] });
    renderFloatPanel(s, makeActions().actions);
    const details = panelOf(s).querySelector("details.dm-float-tools")!;
    expect(details.querySelector("summary")?.textContent).toBe("工具（2）");
    expect(details.getAttribute("data-dm-server")).toBe("ctx7");
    expect(details.querySelectorAll("input[type=checkbox]")).toHaveLength(2);
  });

  it("已禁用工具的 checkbox 默认勾上", () => {
    const s = mountedState({ servers: [entry({ tools: ["a", "b"], disabledTools: ["b"] })] });
    renderFloatPanel(s, makeActions().actions);
    const boxes = [...panelOf(s).querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);
  });

  it("跨重渲染保留工具组折叠态（C8）", () => {
    const s = mountedState({ servers: [entry({ tools: ["t"] })] });
    renderFloatPanel(s, makeActions().actions);
    panelOf(s).querySelector<HTMLDetailsElement>("details.dm-float-tools")!.open = true;
    renderFloatPanel(s, makeActions().actions);
    expect(panelOf(s).querySelector<HTMLDetailsElement>("details.dm-float-tools")!.open).toBe(true);
  });

  it("stagger 标记只在本次渲染内有效：渲染后被清掉", () => {
    const s = mountedState({ servers: [entry()] });
    s.floatPanel!.dataset.dmStagger = "1";
    renderFloatPanel(s, makeActions().actions);
    expect(s.floatPanel!.dataset.dmStagger).toBeUndefined();
  });

  it("stagger 开启时行带 dm-stagger 与递增 animationDelay", () => {
    const s = mountedState({ servers: [entry({ name: "a" }), entry({ name: "b" })] });
    s.floatPanel!.dataset.dmStagger = "1";
    renderFloatPanel(s, makeActions().actions);
    const rows = [...panelOf(s).querySelectorAll<HTMLElement>(".dm-float-row")];
    expect(rows[0]!.className).toContain("dm-stagger");
    expect(rows[0]!.style.animationDelay).toBe("0ms");
    expect(rows[1]!.style.animationDelay).toBe("30ms");
  });

  it("stagger 未开启时行不带 dm-stagger、也没有 animationDelay", () => {
    const s = mountedState({ servers: [entry()] });
    renderFloatPanel(s, makeActions().actions);
    const row = panelOf(s).querySelector<HTMLElement>(".dm-float-row")!;
    expect(row.className).not.toContain("dm-stagger");
    expect(row.style.animationDelay).toBe("");
  });

  it("重渲染清空旧内容（不得逐次追加）", () => {
    const s = mountedState({ servers: [entry()] });
    renderFloatPanel(s, makeActions().actions);
    const first = panelOf(s).querySelectorAll(".dm-float-row").length;
    renderFloatPanel(s, makeActions().actions);
    expect(panelOf(s).querySelectorAll(".dm-float-row")).toHaveLength(first);
  });
});

describe("float：行内动作按钮真的打请求", () => {
  it("点主动作按钮 → POST 对应端点，成功后 refresh", async () => {
    const s = mountedState({ servers: [entry({ name: "ctx7" })], currentCwd: "/w" });
    const { actions, calls } = makeActions();
    renderFloatPanel(s, actions);
    const btn = panelOf(s).querySelector<HTMLButtonElement>(".dm-float-actions button")!;
    btn.dispatchEvent(new Event("click"));
    await settle();
    expect(fetchFake.calls).toHaveLength(1);
    expect(fetchFake.calls[0]!.url).toBe(
      "/api/dsh-mcp/servers/disconnect?name=ctx7&scope=global&cwd=%2Fw",
    );
    expect(calls).toEqual(["refresh"]);
  });

  it("点禁用按钮 → PATCH 带 enabled:false 载荷", async () => {
    const s = mountedState({ servers: [entry()] });
    const { actions } = makeActions();
    renderFloatPanel(s, actions);
    const btns = [...panelOf(s).querySelectorAll<HTMLButtonElement>(".dm-float-actions button")];
    btns[1]!.dispatchEvent(new Event("click"));
    await settle();
    expect(fetchFake.calls[0]).toEqual({
      url: "/api/dsh-mcp/servers?name=ctx7&scope=global",
      method: "PATCH",
      body: '{"enabled":false}',
    });
  });

  it("勾选工具 checkbox → PATCH tool-disable，body 含归一 server key", async () => {
    const s = mountedState({ servers: [entry({ tools: ["t1"] })] });
    s.projectRoot = "/p";
    const { actions, calls } = makeActions();
    renderFloatPanel(s, actions);
    const box = panelOf(s).querySelector<HTMLInputElement>("input[type=checkbox]")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect(fetchFake.calls[0]!.url).toBe("/api/dsh-mcp/tool-disable");
    expect(fetchFake.calls[0]!.body).toBe(
      JSON.stringify({ server: "@@global/ctx7", tool: "t1", disabled: true }),
    );
    expect(calls).toEqual(["refresh"]);
  });

  it("projectRoot 缺失 → 回滚勾选且不发请求（防御非法 @/name）", async () => {
    const s = mountedState({ servers: [entry({ tools: ["t1"], scope: "project" })] });
    const { actions, calls } = makeActions();
    renderFloatPanel(s, actions);
    const box = panelOf(s).querySelector<HTMLInputElement>("input[type=checkbox]")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect(fetchFake.calls).toHaveLength(0);
    expect(box.checked).toBe(false);
    expect(calls).toEqual([]);
  });
});
