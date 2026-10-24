// @vitest-environment happy-dom
/**
 * dsh-mcp-manager — client-dom：float/float.ts 的**胶囊渲染**判据。
 *
 * 覆盖面：floatProjectName、floatTopOffset、renderPill。
 * 顶层 beforeEach/afterEach 保持原 DOM/locale 生命周期（本文件无 fetch/confirm 分支）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { floatProjectName, floatTopOffset, renderPill } from "../../src/client/float/float.ts";
import { bindLocale } from "../../../../shared/client/i18n.js";
import { createState, entry, FAKE_ZH, FetchFake, mountedState } from "./client-shape-float.js";

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
