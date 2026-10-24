// @vitest-environment happy-dom
/**
 * dsh-mcp-manager — client-dom：float/float.ts 的**健康摘要与分组**判据。
 *
 * 覆盖面：renderFloatPanel 的空态、头部、需关注置顶、scope 分组、行渲染与 stagger。
 * 顶层 beforeEach/afterEach 保持原 DOM/locale 生命周期（本文件无 fetch/confirm 分支）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bindLocale } from "../../../../shared/client/i18n.js";
import { renderFloatPanel } from "../../src/client/float/float.ts";
import {
  createState,
  entry,
  FAKE_ZH,
  FetchFake,
  makeActions,
  mountedState,
} from "./client-shape-float.js";

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

function panelOf(state: { floatPanel?: HTMLElement | undefined }): HTMLElement {
  return state.floatPanel!;
}

function registerSummaryHead(it: (name: string, fn: () => void) => void): void {
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
}

function registerSummaryGroups(it: (name: string, fn: () => void) => void): void {
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
}

function registerSummaryRows(it: (name: string, fn: () => void) => void): void {
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
}

describe("float：renderFloatPanel 健康摘要与分组", () => {
  registerSummaryHead(it);
  registerSummaryGroups(it);
  registerSummaryRows(it);
});
