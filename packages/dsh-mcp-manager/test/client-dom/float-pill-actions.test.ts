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
import { refresh, renderState } from "../../src/client/float/panel.ts";
import { bindSession } from "../../src/client/core/session.ts";
import type { McpClientContext } from "../../src/client/core/state.ts";
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
          const template =
            key === "actionFail"
              ? "操作失败：{msg}"
              : key === "loadFail"
                ? "读取失败：{msg}"
                : FAKE_ZH[key];
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
  it("启用 PATCH 捕获项目 cwd，切会话后旧响应不解除同名新请求的锁", async () => {
    const s = mountedState({
      sessionResolved: true,
      currentCwd: "/a",
      floatOpen: true,
      servers: [entry({ name: "same", scope: "project", status: "disabled" })],
    });
    const { actions, calls } = makeActions();
    let cwd = "/a";
    let notifySession!: () => void;
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => ({ byId: { active: { cwd, retainedBy: { mainView: 1 } } } }),
          subscribe: (notify: () => void) => {
            notifySession = notify;
            return () => {};
          },
        },
      },
    } as unknown as McpClientContext;
    let releaseA!: (response: Response) => void;
    let releaseB!: (response: Response) => void;
    let oldDone!: () => void;
    const oldDonePromise = new Promise<void>((resolve) => {
      oldDone = resolve;
    });
    let watchingOld = false;
    actions.render = () => {
      renderState(s, actions);
      if (watchingOld) oldDone();
    };
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET", body: init?.body });
      if (init?.method === "PATCH")
        return new Promise<Response>((resolve) => {
          if (url.endsWith("cwd=%2Fa")) releaseA = resolve;
          else releaseB = resolve;
        });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    const dispose = bindSession(ctx, s, actions);
    renderFloatPanel(s, actions);
    panelOf(s).querySelector<HTMLButtonElement>(".dm-float-actions button")!.click();
    cwd = "/b";
    notifySession();
    s.servers = [entry({ name: "same", scope: "project", status: "disabled" })];
    renderFloatPanel(s, actions);
    panelOf(s).querySelector<HTMLButtonElement>(".dm-float-actions button")!.click();
    watchingOld = true;
    releaseA(new Response("{}", { status: 202 }));
    await oldDonePromise;
    watchingOld = false;
    expect(panelOf(s).querySelector<HTMLButtonElement>(".dm-float-actions button")!.disabled).toBe(
      true,
    );
    expect(s.currentCwd).toBe("/b");
    expect(requests).toEqual([
      {
        url: "/api/dsh-mcp/servers?name=same&scope=project&cwd=%2Fa",
        method: "PATCH",
        body: '{"enabled":true}',
      },
      { url: "/api/dsh-mcp/session", method: "POST", body: '{"cwd":"/b"}' },
      {
        url: "/api/dsh-mcp/servers?name=same&scope=project&cwd=%2Fb",
        method: "PATCH",
        body: '{"enabled":true}',
      },
    ]);
    releaseB(new Response("{}", { status: 202 }));
    await settle();
    expect(calls).toEqual(["refresh", "refresh"]);
    expect(panelOf(s).querySelector<HTMLButtonElement>(".dm-float-actions button")!.disabled).toBe(
      false,
    );
    dispose();
  });
});

describe("float：行内动作按钮真的打请求", () => {
  it.each(["success", "failure"])("切换会话后旧读取迟到（%s）不覆盖新浮窗", async (outcome) => {
    const s = mountedState({ sessionResolved: true, currentCwd: "/a", floatOpen: true });
    const { actions } = makeActions();
    actions.render = () => renderState(s, actions);
    let cwd = "/a";
    let notifySession!: () => void;
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => ({ byId: { active: { cwd, retainedBy: { mainView: 1 } } } }),
          subscribe: (notify: () => void) => {
            notifySession = notify;
            return () => {};
          },
        },
      },
    } as unknown as McpClientContext;
    let releaseOld!: (response: Response) => void;
    const requests: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("?cwd=%2Fa"))
        return new Promise<Response>((resolve) => {
          releaseOld = resolve;
        });
      if (url.endsWith("?cwd=%2Fb"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              servers: [entry({ name: "new", status: "connected", scope: "project" })],
              projectRoot: "/b",
            }),
            { status: 200 },
          ),
        );
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    const dispose = bindSession(ctx, s, actions);
    const oldRead = refresh(s, actions);
    cwd = "/b";
    notifySession();
    expect(await refresh(s, actions)).toBe(true);
    expect(panelOf(s).querySelector(".dm-float-name")?.textContent).toBe("new");
    releaseOld(
      outcome === "success"
        ? new Response(
            JSON.stringify({
              servers: [entry({ name: "old", scope: "project" })],
              projectRoot: "/a",
            }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ error: "old read failed" }), { status: 503 }),
    );
    expect(await oldRead).toBe(false);
    expect(panelOf(s).querySelector(".dm-float-name")?.textContent).toBe("new");
    expect(panelOf(s).querySelector(".dm-float-head .dm-err")).toBeNull();
    expect(s.projectRoot).toBe("/b");
    expect(requests).toEqual([
      "GET /api/dsh-mcp/servers?cwd=%2Fa",
      "POST /api/dsh-mcp/session",
      "GET /api/dsh-mcp/servers?cwd=%2Fb",
    ]);
    dispose();
  });
});

describe("float：行内动作按钮真的打请求", () => {
  it("提交完成时旧读取仍在途：等待旧读取后再读取新状态，期间禁止重复连接", async () => {
    const s = mountedState({
      servers: [entry({ status: "stopped" })],
      floatOpen: true,
      sessionResolved: true,
      currentCwd: "",
    });
    const { actions } = makeActions();
    actions.refresh = (fresh) => refresh(s, actions, fresh);
    let finished!: () => void;
    const finishedPromise = new Promise<void>((resolve) => {
      finished = resolve;
    });
    actions.render = () => {
      renderState(s, actions);
      if (s.pending.size === 0 && s.servers[0]?.status === "connecting") finished();
    };
    let releaseOld!: (response: Response) => void;
    let releaseNew!: (response: Response) => void;
    let startedNew!: () => void;
    const newStarted = new Promise<void>((resolve) => {
      startedNew = resolve;
    });
    const requests: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push(`${method} ${String(input)}`);
      if (method === "POST") return Promise.resolve(new Response("{}", { status: 202 }));
      if (requests.length === 1)
        return new Promise<Response>((resolve) => {
          releaseOld = resolve;
        });
      startedNew();
      return new Promise<Response>((resolve) => {
        releaseNew = resolve;
      });
    }) as typeof fetch;
    renderFloatPanel(s, actions);
    const oldRead = refresh(s, actions);
    panelOf(s).querySelector<HTMLButtonElement>(".dm-float-actions button")!.click();
    await settle();
    expect(requests).toEqual([
      "GET /api/dsh-mcp/servers?cwd=",
      "POST /api/dsh-mcp/servers/connect?name=ctx7&scope=global&cwd=",
    ]);
    releaseOld(
      new Response(JSON.stringify({ servers: [entry({ status: "stopped" })] }), { status: 200 }),
    );
    expect(await oldRead).toBe(true);
    await newStarted;
    const pending = panelOf(s).querySelector<HTMLButtonElement>(".dm-float-actions button")!;
    expect(pending.disabled).toBe(true);
    pending.click();
    expect(requests).toEqual([
      "GET /api/dsh-mcp/servers?cwd=",
      "POST /api/dsh-mcp/servers/connect?name=ctx7&scope=global&cwd=",
      "GET /api/dsh-mcp/servers?cwd=",
    ]);
    releaseNew(
      new Response(JSON.stringify({ servers: [entry({ status: "connecting" })] }), { status: 200 }),
    );
    await finishedPromise;
    const stop = panelOf(s).querySelector<HTMLButtonElement>(".dm-float-actions button")!;
    expect(stop.textContent).toBe("断开");
    expect(stop.disabled).toBe(false);
  });
});

describe("float：行内动作按钮真的打请求", () => {
  it("浮窗显示读取失败并在成功读取后清除，服务器错误仍在对应行", async () => {
    const s = mountedState({
      servers: [entry({ status: "failed", error: "handshake failed" })],
      floatOpen: true,
      sessionResolved: true,
      currentCwd: "",
    });
    const { actions } = makeActions();
    let readCount = 0;
    globalThis.fetch = (() => {
      readCount += 1;
      return Promise.resolve(
        readCount === 1
          ? new Response(JSON.stringify({ error: "read unavailable" }), { status: 503 })
          : new Response(
              JSON.stringify({ servers: [entry({ status: "failed", error: "handshake failed" })] }),
              { status: 200 },
            ),
      );
    }) as typeof fetch;
    expect(await refresh(s, actions)).toBe(false);
    expect(panelOf(s).querySelector(".dm-float-head .dm-err")?.textContent).toBe(
      "读取失败：read unavailable",
    );
    expect(panelOf(s).querySelector(".dm-float-row .dm-err")?.textContent).toBe("handshake failed");
    expect(await refresh(s, actions)).toBe(true);
    expect(panelOf(s).querySelector(".dm-float-head .dm-err")).toBeNull();
    expect(panelOf(s).querySelector(".dm-float-row .dm-err")?.textContent).toBe("handshake failed");
    expect(readCount).toBe(2);
  });
});

describe("float：行内动作按钮真的打请求", () => {
  it.each(["connecting", "reconnecting"])("%s 行可停止连接，不发送连接请求", async (status) => {
    const s = mountedState({
      servers: [entry({ status, name: "a b" })],
      currentCwd: "/w",
      sessionResolved: true,
    });
    const { actions, calls } = makeActions();
    renderFloatPanel(s, actions);
    const buttons = Array.from(
      panelOf(s).querySelectorAll<HTMLButtonElement>(".dm-float-actions button"),
    );
    expect(buttons.map((button) => button.textContent)).toEqual(["断开", "禁用"]);
    expect(buttons[0]!.disabled).toBe(false);
    buttons[0]!.click();
    await settle();
    expect(fetchFake.calls).toEqual([
      {
        url: "/api/dsh-mcp/servers/disconnect?name=a%20b&scope=global&cwd=%2Fw",
        method: "POST",
        body: undefined,
      },
    ]);
    expect(calls).toEqual(["refresh"]);
  });
});

describe("float：行内动作按钮真的打请求", () => {
  it("连接在收到 202 前遭拒时展示错误，重试可被 202 接受", async () => {
    const s = mountedState({ servers: [entry({ status: "stopped" })] });
    const { actions, calls } = makeActions();
    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return Promise.resolve(
        requests.length === 1
          ? new Response(JSON.stringify({ error: "no active project session" }), { status: 409 })
          : new Response(JSON.stringify({ ok: true }), { status: 202 }),
      );
    }) as typeof fetch;
    renderFloatPanel(s, actions);
    panelOf(s).querySelector<HTMLButtonElement>(".dm-float-actions button")!.click();
    await settle();
    expect(alerts).toEqual(["操作失败：no active project session"]);
    renderFloatPanel(s, actions);
    const retry = panelOf(s).querySelector<HTMLButtonElement>(".dm-float-actions button")!;
    expect(retry.disabled).toBe(false);
    retry.click();
    await settle();
    expect(requests).toEqual([
      { url: "/api/dsh-mcp/servers/connect?name=ctx7&scope=global", method: "POST" },
      { url: "/api/dsh-mcp/servers/connect?name=ctx7&scope=global", method: "POST" },
    ]);
    expect(alerts).toEqual(["操作失败：no active project session"]);
    expect(calls).toEqual(["refresh", "refresh"]);
  });
});

describe("float：行内动作按钮真的打请求", () => {
  it("点主动作按钮 → POST 对应端点，成功后 refresh", async () => {
    const s = mountedState({
      servers: [entry({ name: "ctx7" })],
      currentCwd: "/w",
      sessionResolved: true,
    });
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
});

describe("float：行内动作按钮真的打请求", () => {
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
});

describe("float：行内动作按钮真的打请求", () => {
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
});

describe("float：行内动作按钮真的打请求", () => {
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
