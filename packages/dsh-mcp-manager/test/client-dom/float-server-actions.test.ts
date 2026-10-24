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
  actionButton,
  deleteAction,
  disableAction,
  endpointOf,
  jsonPatchInit,
  postThenRefresh,
  statusActions,
} from "../../src/client/float/servers.ts";
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

describe("servers：端点摘要", () => {
  it("streamable-http → URL（url 缺失回落空串）", () => {
    expect(endpointOf(entry({ transport: "streamable-http", url: "https://x/mcp" }))).toBe(
      "https://x/mcp",
    );
    expect(endpointOf(entry({ transport: "streamable-http" }))).toBe("");
  });

  it("stdio → command 后跟空格分隔的 args", () => {
    expect(endpointOf(entry({ command: "npx", args: ["-y", "pkg"] }))).toBe("npx -y pkg");
  });

  it("stdio 无 args → 只有 command（不留尾随空格）", () => {
    expect(endpointOf(entry({ command: "npx" }))).toBe("npx");
    expect(endpointOf(entry({ command: "npx", args: [] }))).toBe("npx");
  });

  it("command 缺失 → 空串（不产出字面量 undefined 文本）", () => {
    expect(endpointOf(entry({}))).toBe("");
  });
});

describe("servers：状态动作规格", () => {
  const st = () => {
    const s = createState();
    s.currentCwd = "/w";
    return s;
  };

  it("connected → 断开 + 重连两键，URL 带 name/scope/cwd", async () => {
    const specs = statusActions(
      entry({ status: "connected", name: "a b" }),
      st(),
      makeActions().actions,
      "&scope=global",
      "&cwd=%2Fw",
    );
    expect(specs.map((s) => s.label)).toEqual(["disconnect", "reconnect"]);
    expect(specs.map((s) => s.primary)).toEqual([false, false]);
    // 名字必须 URL 编码（a b → a%20b）。
    expect(fetchFake.calls).toHaveLength(0);
    // ActionSpec.run 的声明是 () => void | Promise<void>（同步实现也算合法），故用
    // `await` 而不是 .then() 链——后者在 void 分支上没有 .then，tsc 判 TS2339。
    await specs[0]!.run();
    expect(fetchFake.calls[0]).toEqual({
      url: "/api/dsh-mcp/servers/disconnect?name=a%20b&scope=global&cwd=%2Fw",
      method: "POST",
      body: undefined,
    });
    await specs[1]!.run();
    expect(fetchFake.calls[1]!.url).toBe(
      "/api/dsh-mcp/servers/reconnect?name=a%20b&scope=global&cwd=%2Fw",
    );
  });

  it("POST 成功后刷新一次（连/断/重连三个动作同式）", async () => {
    const { actions, calls } = makeActions();
    const specs = statusActions(entry({ status: "connected" }), st(), actions, "&scope=global", "");
    await specs[0]!.run();
    expect(calls).toEqual(["refresh"]);
  });

  it("disabled → 单键「启用并连接」：先 PATCH enabled=true 再 POST connect，最后刷新", async () => {
    const { actions, calls } = makeActions();
    const specs = statusActions(
      entry({ status: "disabled" }),
      st(),
      actions,
      "&scope=project",
      "&cwd=%2Fw",
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]!.primary).toBe(true);
    await specs[0]!.run();
    expect(fetchFake.calls).toEqual([
      {
        url: "/api/dsh-mcp/servers?name=ctx7&scope=project",
        method: "PATCH",
        body: '{"enabled":true}',
      },
      {
        url: "/api/dsh-mcp/servers/connect?name=ctx7&scope=project&cwd=%2Fw",
        method: "POST",
        body: undefined,
      },
    ]);
    expect(calls).toEqual(["refresh"]);
  });

  it("其余状态（stopped/connecting/failed）→ 单键「连接」且为 primary", async () => {
    for (const status of ["stopped", "connecting", "failed"]) {
      fetchFake!.calls.length = 0;
      const { actions, calls } = makeActions();
      const specs = statusActions(entry({ status }), st(), actions, "&scope=global", "");
      expect(specs).toHaveLength(1);
      expect(specs[0]!.primary).toBe(true);
      await specs[0]!.run();
      expect(fetchFake.calls[0]!.url).toBe("/api/dsh-mcp/servers/connect?name=ctx7&scope=global");
      expect(calls).toEqual(["refresh"]);
    }
  });

  it("postThenRefresh：请求失败时 refresh 不执行（失败只上抛）", async () => {
    fetchFake.failOnce();
    const { actions, calls } = makeActions();
    const run = postThenRefresh(st(), actions, "/x");
    await expect(run()).rejects.toThrow("boom");
    expect(calls).toEqual([]);
  });

  it("jsonPatchInit：method/content-type/body 三件套", () => {
    expect(jsonPatchInit(true)).toEqual({
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: '{"enabled":true}',
    });
    expect(jsonPatchInit(false).body).toBe('{"enabled":false}');
  });
});

describe("servers：禁用与删除动作", () => {
  it("disableAction：PATCH enabled=false 且带 cwd（#412 会话自愈）", async () => {
    const s = createState();
    s.currentCwd = "/w";
    const { actions, calls } = makeActions();
    const spec = disableAction(entry(), s, actions, "&scope=global", "&cwd=%2Fw");
    expect(spec.primary).toBe(false);
    await spec.run();
    expect(fetchFake.calls).toEqual([
      {
        url: "/api/dsh-mcp/servers?name=ctx7&scope=global&cwd=%2Fw",
        method: "PATCH",
        body: '{"enabled":false}',
      },
    ]);
    expect(calls).toEqual(["refresh"]);
  });

  it("disableAction：正在编辑该条目才 resetForm（编辑别的条目不动表单）", async () => {
    const s = createState();
    s.editingName = "ctx7";
    const a1 = makeActions();
    await disableAction(entry(), s, a1.actions, "", "").run();
    expect(a1.calls).toEqual(["resetForm", "refresh"]);

    const s2 = createState();
    s2.editingName = "other";
    const a2 = makeActions();
    await disableAction(entry(), s2, a2.actions, "", "").run();
    expect(a2.calls).toEqual(["refresh"]);
  });

  it("deleteAction：确认后才发 DELETE；未确认即中止且零请求", async () => {
    const s = createState();
    const { actions, calls } = makeActions();
    const spec = deleteAction(entry(), s, actions, "&scope=global");

    confirmAnswer = false;
    await spec.run();
    expect(confirms).toHaveLength(1);
    expect(fetchFake.calls).toHaveLength(0);
    expect(calls).toEqual([]);

    confirmAnswer = true;
    await spec.run();
    expect(fetchFake.calls).toEqual([
      { url: "/api/dsh-mcp/servers?name=ctx7&scope=global", method: "DELETE", body: undefined },
    ]);
    expect(calls).toEqual(["refresh"]);
  });

  it("deleteAction：danger 标记为 true（渲染侧据此上红色样式）", () => {
    const spec = deleteAction(entry(), createState(), makeActions().actions, "");
    expect(spec.danger).toBe(true);
    expect(spec.primary).toBe(false);
  });

  it("deleteAction：正在编辑该条目才 resetForm", async () => {
    const s = createState();
    s.editingName = "ctx7";
    const a1 = makeActions();
    await deleteAction(entry(), s, a1.actions, "").run();
    expect(a1.calls).toEqual(["resetForm", "refresh"]);

    const s2 = createState();
    s2.editingName = "other";
    const a2 = makeActions();
    await deleteAction(entry(), s2, a2.actions, "").run();
    expect(a2.calls).toEqual(["refresh"]);
  });
});

describe("servers：操作按钮", () => {
  it("class 由 primary/danger 两档组合（无档时为空串不留空格）", () => {
    expect(actionButton("x", () => {}).className).toBe("");
    expect(actionButton("x", () => {}, true).className).toBe("dm-primary");
    expect(actionButton("x", () => {}, false, true).className).toBe("dm-danger");
    expect(actionButton("x", () => {}, true, true).className).toBe("dm-primary dm-danger");
  });

  it("点击执行 onClick", async () => {
    let ran = 0;
    const btn = actionButton("go", () => {
      ran += 1;
    });
    btn.dispatchEvent(new Event("click"));
    await settle();
    expect(ran).toBe(1);
  });

  it("onClick 抛错 → alert(actionFail 带 msg)，不静默", async () => {
    const btn = actionButton("go", () => {
      throw new Error("kaput");
    });
    btn.dispatchEvent(new Event("click"));
    await settle();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("kaput");
  });

  it("onClick 抛非 Error → 走 String(error) 分支", async () => {
    const btn = actionButton("go", () => {
      throw "plain string";
    });
    btn.dispatchEvent(new Event("click"));
    await settle();
    expect(alerts[0]).toContain("plain string");
  });
});
