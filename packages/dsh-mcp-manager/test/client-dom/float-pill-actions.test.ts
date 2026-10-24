// @vitest-environment happy-dom
/**
 * dsh-mcp-manager — client-dom：float/float.ts 的**行内动作请求**判据。
 *
 * 覆盖面：主动作、禁用 PATCH、工具勾选与 projectRoot 防御。
 * 顶层 beforeEach/afterEach 保持原 fetch/alert/confirm/locale 生命周期。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bindLocale } from "../../../../shared/client/i18n.js";
import { renderFloatPanel } from "../../src/client/float/float.ts";
import {
  entry,
  FAKE_ZH,
  FetchFake,
  makeActions,
  mountedState,
  settle,
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
