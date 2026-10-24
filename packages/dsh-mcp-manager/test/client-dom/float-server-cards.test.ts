// @vitest-environment happy-dom
/**
 * dsh-mcp-manager — client-dom：float/servers.ts 渲染与动作面的直接判据。
 *
 * 环境声明必须落在文件里（变异面按拓扑派生的是单 project node 环境配置）。
 *
 * 守的事实（每条一句话）：
 * - endpointOf：streamable-http 出 URL、stdio 出 command+args、无 command 出空串。
 * - statusActions：connected 两键、disabled 走 PATCH 启用**再** POST 连接、其余一键；
 *   三条 URL 的 query 拼装（name 编码、scope、cwd）逐条钉。
 * - disableAction / deleteAction：PATCH/DELETE 的 method 与 body；delete 的 confirm 闸
 *   （未确认即中止，不得发请求）；正在编辑该条目才 resetForm。
 * - actionButton：失败时 alert(actionFail) 而非静默；class 组合。
 * - serverToolsDetails：interactive 出 checkbox 且 disabled 状态回填、非 interactive 出纯文本；
 *   openTools 命中才 open；tools 非数组时出空列表。
 * - renderServer / renderServers：卡片结构、busy 态禁用删除按钮、空态文案、失败组置顶、
 *   project/global 两分组、组内按名字排序、details 折叠态跨重渲染恢复。
 *
 * 假件说明（testing SKILL §3 例外清单）：
 * - fetch：globalThis 上的**手写**假函数，只回放脚本给的响应并记录 (url, method, body)，
 *   不实现任何服务端语义；不用 vi.mock/vi.fn/vi.spyOn。
 * - actions：手写记录对象（满足 UiActions 全部成员），只记调用序。
 * - window.alert / window.confirm：手写记录函数，afterEach 还原。
 * - 无时钟依赖（不钉假钟）、无落盘、无真实 sleep。
 */
import {
  bucketByStatus,
  renderServer,
  renderServers,
  serverCardClass,
  serverCardHeader,
  serverToolsDetails,
} from "../../src/client/float/servers.ts";
import type { McpServerListEntry, McpState } from "../../src/client/core/state.ts";
import {
  createState,
  entry,
  FAKE_ZH,
  FetchFake,
  makeActions,
  settle,
} from "./client-shape-servers.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bindLocale } from "../../../../shared/client/i18n.js";
let fetchFake: FetchFake;
let alerts: string[];
let confirms: boolean[];
let confirmAnswer: boolean;
const realAlert = window.alert;
const realConfirm = window.confirm;

beforeEach(() => {
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
  document.body.textContent = "";
  alerts = [];
  confirms = [];
  confirmAnswer = true;
  fetchFake = new FetchFake();
  window.alert = (msg?: string): void => {
    alerts.push(String(msg));
  };
  window.confirm = (): boolean => {
    confirms.push(true);
    return confirmAnswer;
  };
});

afterEach(() => {
  bindLocale({ bind: () => (key: string) => key }, "mcpManager");
  fetchFake.restore();
  window.alert = realAlert;
  window.confirm = realConfirm;
  document.body.textContent = "";
});

describe("servers：工具折叠组", () => {
  const st = () => createState();

  it("interactive：出 checkbox，已在 disabledTools 里的默认勾上", () => {
    const s = st();
    s.projectRoot = "/p";
    const details = serverToolsDetails(
      entry({ tools: ["a", "b"], disabledTools: ["b"] }),
      2,
      { tools: true },
      s,
      makeActions().actions,
      true,
    );
    const boxes = details.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect(boxes).toHaveLength(2);
    expect([...boxes].map((b) => b.checked)).toEqual([false, true]);
    expect(details.querySelector("summary")?.textContent).toBe("toolsCount");
    expect(details.dataset.dmServer).toBe("ctx7");
  });

  it("非 interactive：出纯文本 li，无 checkbox", () => {
    const details = serverToolsDetails(
      entry({ tools: ["a"] }),
      1,
      { tools: true },
      st(),
      makeActions().actions,
      false,
    );
    expect(details.querySelectorAll("input")).toHaveLength(0);
    expect(details.querySelectorAll("li")).toHaveLength(1);
    expect(details.querySelector("li")?.textContent).toBe("a");
  });
});

describe("servers：工具折叠组", () => {
  const st = () => createState();

  it("openTools 命中该服务器才展开（未命中保持收起）", () => {
    const opened = serverToolsDetails(
      entry({ tools: ["a"] }),
      1,
      { tools: true, openTools: new Set(["ctx7"]) },
      st(),
      makeActions().actions,
      false,
    );
    expect((opened as HTMLDetailsElement).open).toBe(true);
    const closed = serverToolsDetails(
      entry({ tools: ["a"] }),
      1,
      { tools: true, openTools: new Set(["other"]) },
      st(),
      makeActions().actions,
      false,
    );
    expect((closed as HTMLDetailsElement).open).toBe(false);
    const none = serverToolsDetails(
      entry({ tools: ["a"] }),
      1,
      { tools: true },
      st(),
      makeActions().actions,
      false,
    );
    expect((none as HTMLDetailsElement).open).toBe(false);
  });

  it("tools 非数组 → 空列表（不抛）", () => {
    const details = serverToolsDetails(
      entry({}),
      0,
      { tools: true },
      st(),
      makeActions().actions,
      true,
    );
    expect(details.querySelectorAll("li")).toHaveLength(0);
  });

  it("勾选工具 → PATCH tool-disable，body 含归一后的 server key / tool / disabled", async () => {
    const s = st();
    s.projectRoot = "/p";
    const { actions, calls } = makeActions();
    const details = serverToolsDetails(
      entry({ scope: "project", tools: ["a"] }),
      1,
      { tools: true },
      s,
      actions,
      true,
    );
    const box = details.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect(fetchFake.calls).toEqual([
      {
        url: "/api/dsh-mcp/tool-disable",
        method: "PATCH",
        body: JSON.stringify({ server: "@/p/ctx7", tool: "a", disabled: true }),
      },
    ]);
    expect(calls).toEqual(["refresh"]);
  });
});

describe("servers：工具折叠组", () => {
  const st = () => createState();

  it("projectRoot 缺失 → 回滚勾选且不发请求（防御非法 @/name）", async () => {
    const s = st();
    const { actions, calls } = makeActions();
    const details = serverToolsDetails(
      entry({ scope: "project", tools: ["a"] }),
      1,
      { tools: true },
      s,
      actions,
      true,
    );
    const box = details.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect(fetchFake.calls).toHaveLength(0);
    expect(box.checked).toBe(false);
    expect(calls).toEqual([]);
  });

  it("请求失败 → 回滚勾选（乐观更新必须能自愈）", async () => {
    const s = st();
    s.projectRoot = "/p";
    fetchFake.failOnce();
    const { actions, calls } = makeActions();
    const details = serverToolsDetails(
      entry({ scope: "project", tools: ["a"] }),
      1,
      { tools: true },
      s,
      actions,
      true,
    );
    const box = details.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect(box.checked).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("servers：卡片头与分桶", () => {
  it("卡片类名：失败/重连中带 --fail 修饰", () => {
    expect(serverCardClass(entry({ status: "failed" }))).toBe("dm-server dm-server--fail");
    expect(serverCardClass(entry({ status: "reconnecting" }))).toBe("dm-server dm-server--fail");
    expect(serverCardClass(entry({ status: "connected" }))).toBe("dm-server");
  });

  it("分桶：未知状态归 stopped 桶而不丢行", () => {
    const byStatus = bucketByStatus([entry({ name: "a" }), entry({ name: "b", status: "weird" })]);
    expect(byStatus.get("connected")).toHaveLength(1);
    expect(byStatus.get("stopped")).toHaveLength(1);
  });

  it("分桶：六态键全部预建空桶（渲染按桶序遍历，缺键会漏分组）", () => {
    const byStatus = bucketByStatus([]);
    expect([...byStatus.keys()]).toEqual([
      "connected",
      "connecting",
      "reconnecting",
      "stopped",
      "disabled",
      "failed",
    ]);
  });

  it("卡片头：名称 / transport 徽标 / scope 徽标 / 状态徽标 / 工具计数五段", () => {
    const header = serverCardHeader(entry({ tools: ["a", "b"] }), 2);
    expect(header.querySelector(".dm-name")?.textContent).toBe("ctx7");
    expect(header.querySelector(".dm-badge")?.className).toContain("dm-stdio");
    expect(header.textContent).toContain("stdio");
    expect(header.querySelector(".dm-st-connected")).not.toBeNull();
    expect(header.querySelector(".dm-count")?.textContent).toBe("toolsCountPlain");
  });

  it("卡片头：streamable-http 出 dm-http 徽标与 HTTP 文案", () => {
    const header = serverCardHeader(entry({ transport: "streamable-http" }), 0);
    expect(header.querySelector(".dm-badge")?.className).toContain("dm-http");
    expect(header.textContent).toContain("HTTP");
  });

  it("卡片头：project scope 出项目徽标，global 出全局徽标", () => {
    expect(serverCardHeader(entry({ scope: "project" }), 0).textContent).toContain(
      "badgeScopeProject",
    );
    expect(serverCardHeader(entry({ scope: "global" }), 0).textContent).toContain(
      "badgeScopeGlobal",
    );
  });
});

describe("servers：单卡渲染", () => {
  it("结构：article.dm-server 含头 / 端点 / 动作区", () => {
    const card = renderServer(entry(), createState(), makeActions().actions);
    expect(card.tagName).toBe("ARTICLE");
    expect(card.className).toBe("dm-server");
    expect(card.querySelector("header")).not.toBeNull();
    expect(card.querySelector(".dm-endpoint")?.textContent).toBe("");
    expect(card.querySelector(".dm-actions")).not.toBeNull();
  });

  it("有 error 才渲染 .dm-err（空串不算错误）", () => {
    expect(
      renderServer(entry({ error: "boom" }), createState(), makeActions().actions).querySelector(
        ".dm-err",
      )?.textContent,
    ).toBe("boom");
    expect(
      renderServer(entry({ error: "" }), createState(), makeActions().actions).querySelector(
        ".dm-err",
      ),
    ).toBeNull();
    expect(
      renderServer(entry(), createState(), makeActions().actions).querySelector(".dm-err"),
    ).toBeNull();
  });

  it("有工具才渲染工具折叠组", () => {
    expect(
      renderServer(entry({ tools: ["a"] }), createState(), makeActions().actions).querySelector(
        "details.dm-tools",
      ),
    ).not.toBeNull();
    expect(
      renderServer(entry(), createState(), makeActions().actions).querySelector("details.dm-tools"),
    ).toBeNull();
  });

  it("disabled 行不出禁用按钮（已禁用不必再禁）", () => {
    const card = renderServer(entry({ status: "disabled" }), createState(), makeActions().actions);
    const labels = [...card.querySelectorAll(".dm-actions button")].map((b) => b.textContent);
    expect(labels).toEqual(["enableAndConnect", "edit", "delete"]);
  });

  it("非 disabled 行的按钮序列：状态动作 + 禁用 + 编辑 + 删除", () => {
    const card = renderServer(entry({ status: "connected" }), createState(), makeActions().actions);
    const labels = [...card.querySelectorAll(".dm-actions button")].map((b) => b.textContent);
    expect(labels).toEqual(["disconnect", "reconnect", "disable", "edit", "delete"]);
  });

  it("connecting/reconnecting 是 busy 态：删除按钮被 disabled（防并发操作）", () => {
    for (const status of ["connecting", "reconnecting"]) {
      const card = renderServer(entry({ status }), createState(), makeActions().actions);
      const buttons = [...card.querySelectorAll<HTMLButtonElement>(".dm-actions button")];
      expect(buttons[buttons.length - 1]!.disabled).toBe(true);
    }
  });

  it("非 busy 态：删除按钮可点", () => {
    const card = renderServer(entry({ status: "connected" }), createState(), makeActions().actions);
    const buttons = [...card.querySelectorAll<HTMLButtonElement>(".dm-actions button")];
    expect(buttons[buttons.length - 1]!.disabled).toBe(false);
  });

  it("编辑按钮 → actions.beginEdit(server)", () => {
    const { actions, calls } = makeActions();
    const card = renderServer(entry(), createState(), actions);
    const edit = [...card.querySelectorAll("button")].find((b) => b.textContent === "edit")!;
    edit.dispatchEvent(new Event("click"));
    expect(calls).toEqual(["beginEdit"]);
  });
});

describe("servers：列表页渲染", () => {
  function mountWith(servers: McpServerListEntry[]): McpState {
    const s = createState();
    s.bodyEl = document.createElement("div");
    document.body.appendChild(s.bodyEl);
    s.servers = servers;
    return s;
  }

  it("bodyEl 未建 → 直接返回（不抛）", () => {
    const s = createState();
    s.servers = [entry()];
    renderServers(s, makeActions().actions);
    expect(document.body.textContent).toBe("");
  });

  it("空列表 → 出空态说明，不出分组", () => {
    const s = mountWith([]);
    renderServers(s, makeActions().actions);
    expect(s.bodyEl!.querySelector(".dm-status")?.textContent).toBe("serversEmpty");
    expect(s.bodyEl!.querySelectorAll("section.dm-group")).toHaveLength(0);
  });

  it("失败与重连中进「需关注」置顶组，组头带 --alert 修饰", () => {
    const s = mountWith([
      entry({ name: "ok", status: "connected" }),
      entry({ name: "bad", status: "failed" }),
    ]);
    renderServers(s, makeActions().actions);
    const first = s.bodyEl!.querySelector("section.dm-group")!;
    expect(first.querySelector(".dm-group-alert")).not.toBeNull();
    expect(first.textContent).toContain("bad");
  });

  it("project / global 各自成组，标题带数量", () => {
    const s = mountWith([
      entry({ name: "p1", scope: "project" }),
      entry({ name: "g1", scope: "global" }),
    ]);
    renderServers(s, makeActions().actions);
    const titles = [...s.bodyEl!.querySelectorAll("section.dm-group > h3")].map(
      (h) => h.textContent,
    );
    expect(titles).toEqual(["groupProject (1)", "groupGlobal (1)"]);
  });

  it("同组内按服务器名排序（localeCompare）", () => {
    const s = mountWith([entry({ name: "c" }), entry({ name: "a" }), entry({ name: "b" })]);
    renderServers(s, makeActions().actions);
    const names = [...s.bodyEl!.querySelectorAll(".dm-name")].map((n) => n.textContent);
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("每个非空状态档出一个子分组，标题经 pangu 处理", () => {
    const s = mountWith([entry({ name: "a" }), entry({ name: "b", status: "failed" })]);
    renderServers(s, makeActions().actions);
    const subs = [...s.bodyEl!.querySelectorAll(".dm-subgroup-title")].map((n) => n.textContent);
    expect(subs).toHaveLength(2);
    expect(subs.every((t) => t.includes("statusGroupCount"))).toBe(true);
  });

  it("重渲染保留 details 折叠态（C8：连续禁用 N 个工具免反复展开）", () => {
    const s = mountWith([entry({ name: "a", tools: ["t1", "t2"] })]);
    renderServers(s, makeActions().actions);
    const details = s.bodyEl!.querySelector<HTMLDetailsElement>("details.dm-tools")!;
    details.open = true;
    // 折叠态集合按 dataset.dmServer 收集，重渲染后恢复。
    renderServers(s, makeActions().actions);
    expect(s.bodyEl!.querySelector<HTMLDetailsElement>("details.dm-tools")!.open).toBe(true);
  });

  it("重渲染前是收起的 → 重渲染后仍收起", () => {
    const s = mountWith([entry({ name: "a", tools: ["t1"] })]);
    renderServers(s, makeActions().actions);
    s.bodyEl!.querySelector<HTMLDetailsElement>("details.dm-tools")!.open = false;
    renderServers(s, makeActions().actions);
    expect(s.bodyEl!.querySelector<HTMLDetailsElement>("details.dm-tools")!.open).toBe(false);
  });

  it("重渲染清空旧内容（不得逐次追加）", () => {
    const s = mountWith([entry({ name: "a" })]);
    renderServers(s, makeActions().actions);
    const first = s.bodyEl!.querySelectorAll("article").length;
    renderServers(s, makeActions().actions);
    expect(s.bodyEl!.querySelectorAll("article")).toHaveLength(first);
  });
});
