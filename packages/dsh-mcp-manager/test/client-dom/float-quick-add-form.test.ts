// @vitest-environment happy-dom
/**
 * dsh-mcp-manager — client-dom：float/quick-add.ts 的直接判据（表单读写 + 保存三种落点 + 页面构建）。
 *
 * 环境声明必须落在文件里（变异面按拓扑派生的是单 project node 环境配置）。
 *
 * 守的事实（每条一句话，括号内是「改坏它必须红」的那句话）：
 * - parseKV：KEY=VALUE 与 KEY: VALUE 两种分隔、空行跳过、空值落空串、非法行跳过。
 * - readStdioFormFields / readHttpFormFields：command 与 url 恒写入，args/env/headers/cwd
 *   为空不落键（缺省形态与历史一致）。
 * - fillKvField / fillForm：投影省略 env/headers 时**清零**（防旧值被 readForm 原样读回落盘）。
 * - isMigratedEdit / performSaveRequest：改名或改归属才走 POST+DELETE；原条目有凭据时
 *   **无条件中止**（M7 大声失败，不得半迁移）。
 * - saveForm：投影 URL 含占位符且无既有可保时中止并提示重填；成功后 resetForm + refresh；
 *   失败一律 alert。
 * - buildQuickAdd：10 个表单控件都建出来、scope 缺省按 projectRoot、transport change 切换
 *   显隐、JSON 导入成功/跳过/失败三态各自的结果文案。
 *
 * 假件说明（testing SKILL §3 例外清单）：
 * - fetch：globalThis 上的**手写**替身，只回放脚本给的响应并记录 (url, method, body)，
 *   不实现任何服务端语义；不用 vi.mock/vi.fn/vi.spyOn。
 * - actions：手写记录对象（满足 UiActions 全部成员），只记调用名。
 * - window.alert：手写记录函数，afterEach 还原。
 * - 表单控件一律经 buildQuickAdd 真实构建（不手搓假控件）——夹具不得替被测代码做决定。
 * - 无时钟依赖、不落盘、无真实 sleep。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bindLocale } from "../../../../shared/client/i18n.js";
import { createState } from "../../src/client/core/state.ts";
import type { McpServerListEntry, McpState, UiActions } from "../../src/client/core/state.ts";
import {
  buildQuickAdd,
  beginEdit,
  controlText,
  currentCwdBody,
  fillForm,
  fillKvField,
  formScopeValue,
  formTransportValue,
  isEditing,
  isMigratedEdit,
  isPlainRecord,
  isProjectionValue,
  isServerTransport,
  jsonWriteInit,
  parseKV,
  performSaveRequest,
  readForm,
  readHttpFormFields,
  readStdioFormFields,
  resetForm,
  saveForm,
  urlPlaceholderBlocks,
} from "../../src/client/float/quick-add.ts";

/** 假译函数用到的模板：只列本文件断言真正读到文案的键。 */
const FAKE_ZH: Record<string, string> = {
  saveFail: "保存失败：{msg}",
  importFail: "导入失败：{msg}",
  importedOk: "已导入：{names}",
  importedNone: "（无）",
  importSkipped: "跳过（已存在）：{names}",
  editServer: "编辑服务器：{name}",
  addServer: "添加服务器",
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

/** 手写 fetch 假件：记录 (url, method, body)，回放固定 JSON 响应。 */
class FetchFake {
  calls: Array<{ url: string; method: string; body: unknown }> = [];
  /** 下一次响应的 body；setFail 切成非 2xx。 */
  payload: unknown = {};
  private failNext = false;
  private readonly realFetch: typeof globalThis.fetch;

  constructor() {
    this.realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      this.calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
      if (this.failNext) {
        this.failNext = false;
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async (): Promise<unknown> => ({ error: "boom" }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async (): Promise<unknown> => this.payload,
      });
    }) as unknown as typeof globalThis.fetch;
  }

  failOnce(): void {
    this.failNext = true;
  }

  restore(): void {
    globalThis.fetch = this.realFetch;
  }
}

/** 手写 actions 记录器：满足 UiActions 全部成员，只记调用名。 */
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
    switchTab: (tab: string): void => {
      calls.push("switchTab:" + tab);
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

let fetchFake: FetchFake;
let alerts: string[];
const realAlert = window.alert;

/**
 * 建一份「表单已就绪」的 state：经 buildQuickAdd 真实构建 10 个控件。
 *
 * 刻意把 page **挂到 document.body**：resetForm / beginEdit 改标题与取消按钮时走的是
 * **全局** document（getElementById("dm-form-title") / querySelector("[data-dm-cancel]")），
 * 不看 buildQuickAdd 的返回值。只拿返回值不挂载，那两条路径恒等于「找不到」而静默跳过，
 * 断言就会变成装饰性的。
 */
function builtState(raw: Partial<McpState> = {}): McpState {
  const state = createState();
  Object.assign(state, raw);
  const page = buildQuickAdd(state, makeActions().actions);
  document.body.appendChild(page);
  return state;
}

beforeEach(() => {
  document.body.textContent = "";
  alerts = [];
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
});

afterEach(() => {
  fetchFake.restore();
  window.alert = realAlert;
  document.body.textContent = "";
  bindLocale({ bind: () => (key: string) => key }, "mcpManager");
});

describe("quick-add：parseKV", () => {
  it("KEY=VALUE 与 KEY: VALUE 两种分隔都认（环境变量与请求头各用一种）", () => {
    expect(parseKV("A=1\nB: 2")).toEqual({ A: "1", B: "2" });
  });

  it("值两端的空白被裁掉（表单里常见手输空格）", () => {
    expect(parseKV("A =  1  ")).toEqual({ A: "1" });
  });

  it("空行与纯空白行跳过（多行粘贴的常态）", () => {
    expect(parseKV("A=1\n\n   \nB=2")).toEqual({ A: "1", B: "2" });
  });

  it("空值落空串而不是丢键（KEY= 是「显式置空」，与「没写」不同）", () => {
    expect(parseKV("A=")).toEqual({ A: "" });
    expect(parseKV("A:   ")).toEqual({ A: "" });
  });

  it("非法行跳过（键名不以字母/下划线开头）", () => {
    expect(parseKV("1A=1\n-A=2\nB=3")).toEqual({ B: "3" });
  });

  it("CRLF 行尾照常解析（Windows 粘贴的 JSON）", () => {
    expect(parseKV("A=1\r\nB=2")).toEqual({ A: "1", B: "2" });
  });

  it("值里含 = 或 : 不会被截断（只按首个分隔符切分）", () => {
    expect(parseKV("URL=http://x:8080/y?a=1")).toEqual({ URL: "http://x:8080/y?a=1" });
  });

  it("空串 → 空表", () => {
    expect(parseKV("")).toEqual({});
  });
});

describe("quick-add：投影值与纯对象判定", () => {
  it("isProjectionValue：认 [REDACTED] 与其 URL 序列化形态", () => {
    expect(isProjectionValue("Bearer [REDACTED]")).toBe(true);
    expect(isProjectionValue("%5BREDACTED%5D")).toBe(true);
  });

  it("isProjectionValue：普通值与非字符串判假（不得误伤）", () => {
    expect(isProjectionValue("plain")).toBe(false);
    expect(isProjectionValue("")).toBe(false);
    expect(isProjectionValue(undefined)).toBe(false);
    expect(isProjectionValue(42)).toBe(false);
  });

  it("isPlainRecord：对象真，null/数组/非对象假", () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord("x")).toBe(false);
  });
});

describe("quick-add：表单字段读取", () => {
  it("controlText：未构建控件回落空串", () => {
    expect(controlText(undefined)).toBe("");
    expect(controlText({ value: "x" })).toBe("x");
  });

  it("formScopeValue：表单显式选中 project/global 时以表单为准", () => {
    const s = builtState({ projectRoot: "/p" });
    s.formScope!.value = "global";
    expect(formScopeValue(s)).toBe("global");
    s.formScope!.value = "project";
    expect(formScopeValue(s)).toBe("project");
  });

  it("formScopeValue：表单值越界时按 projectRoot 回落（有根 project、无根 global）", () => {
    const s = builtState({ projectRoot: "/p" });
    s.formScope!.value = "bogus";
    expect(formScopeValue(s)).toBe("project");
    const s2 = builtState();
    s2.formScope!.value = "bogus";
    expect(formScopeValue(s2)).toBe("global");
  });

  it("currentCwdBody：非空 cwd 带键，空串与缺失不带键（读不到 ≠ 清空绑定）", () => {
    const s = builtState({ currentCwd: "/w" });
    expect(currentCwdBody(s)).toEqual({ cwd: "/w" });
    s.currentCwd = "";
    expect(currentCwdBody(s)).toEqual({});
    s.currentCwd = undefined;
    expect(currentCwdBody(s)).toEqual({});
  });

  it("isServerTransport / formTransportValue：越界 transport 收窄成 stdio", () => {
    expect(isServerTransport("stdio")).toBe(true);
    expect(isServerTransport("streamable-http")).toBe(true);
    expect(isServerTransport("sse")).toBe(false);
    const s = builtState();
    s.formTransport!.value = "streamable-http";
    expect(formTransportValue(s)).toBe("streamable-http");
    s.formTransport!.value = "sse";
    expect(formTransportValue(s)).toBe("stdio");
  });

  it("readStdioFormFields：command 恒写入并裁空白", () => {
    const s = builtState();
    s.formCommand!.value = "  npx  ";
    expect(readStdioFormFields(s)).toEqual({ command: "npx" });
  });

  it("readStdioFormFields：args 按逗号切分、裁空白、丢空段", () => {
    const s = builtState();
    s.formCommand!.value = "npx";
    s.formArgs!.value = " -y ,, pkg , ";
    expect(readStdioFormFields(s).args).toEqual(["-y", "pkg"]);
  });

  it("readStdioFormFields：args 空串不落键（缺省形态与历史一致）", () => {
    const s = builtState();
    s.formCommand!.value = "npx";
    s.formArgs!.value = "  ";
    expect(readStdioFormFields(s)).toEqual({ command: "npx" });
  });

  it("readStdioFormFields：env 空表不落键，非空落解析结果", () => {
    const s = builtState();
    s.formCommand!.value = "npx";
    s.formEnv!.value = "";
    expect(readStdioFormFields(s).env).toBeUndefined();
    s.formEnv!.value = "A=1\nB=2";
    expect(readStdioFormFields(s).env).toEqual({ A: "1", B: "2" });
  });

  it("readStdioFormFields：cwd 空串不落键", () => {
    const s = builtState();
    s.formCommand!.value = "npx";
    s.formCwd!.value = "  ";
    expect(readStdioFormFields(s).cwd).toBeUndefined();
    s.formCwd!.value = " /w ";
    expect(readStdioFormFields(s).cwd).toBe("/w");
  });

  it("readHttpFormFields：url 恒写入，headers 空表不落键", () => {
    const s = builtState();
    s.formUrl!.value = " https://x/mcp ";
    expect(readHttpFormFields(s)).toEqual({ url: "https://x/mcp" });
    s.formHeaders!.value = "";
    expect(readHttpFormFields(s).headers).toBeUndefined();
    s.formHeaders!.value = "Authorization: Bearer t";
    expect(readHttpFormFields(s).headers).toEqual({ Authorization: "Bearer t" });
  });

  it("readForm：按 transport 判别位分流（stdio 侧不出 url，http 侧不出 command）", () => {
    const s = builtState();
    s.formName!.value = " ctx7 ";
    s.formCommand!.value = "npx";
    s.formUrl!.value = "https://x/mcp";
    s.formEnabled!.checked = false;

    s.formTransport!.value = "stdio";
    const stdio = readForm(s);
    expect(stdio.name).toBe("ctx7");
    expect(stdio.transport).toBe("stdio");
    expect(stdio.command).toBe("npx");
    expect(stdio.enabled).toBe(false);
    expect(Object.hasOwn(stdio, "url")).toBe(false);

    s.formTransport!.value = "streamable-http";
    const http = readForm(s);
    expect(http.transport).toBe("streamable-http");
    expect(http.url).toBe("https://x/mcp");
    expect(Object.hasOwn(http, "command")).toBe(false);
  });
});

describe("quick-add：KV 回填", () => {
  it("fillKvField：表缺键（投影省略）时清零，防旧值被 readForm 原样读回落盘", () => {
    const ta = document.createElement("textarea");
    ta.value = "STALE=1";
    fillKvField(ta, undefined, "=");
    expect(ta.value).toBe("");
  });

  it("fillKvField：按给定分隔符逐行拼回（env 用等号、headers 用冒号加空格）", () => {
    const ta = document.createElement("textarea");
    fillKvField(ta, { A: "1", B: "2" }, "=");
    expect(ta.value).toBe("A=1\nB=2");
    fillKvField(ta, { Authorization: "Bearer t" }, ": ");
    expect(ta.value).toBe("Authorization: Bearer t");
  });

  it("fillKvField：控件未构建时直接返回（不抛）", () => {
    expect(() => {
      fillKvField(undefined, { A: "1" }, "=");
    }).not.toThrow();
  });
});

describe("quick-add：fillForm 回填", () => {
  it("逐字段回填：name/command/args/cwd/url/headers/env", () => {
    const s = builtState();
    fillForm(
      s,
      entry({
        name: "ctx7",
        command: "npx",
        args: ["-y", "pkg"],
        cwd: "/w",
        url: "https://x/mcp",
        headers: { Authorization: "Bearer t" },
        env: { A: "1" },
      }),
    );
    expect(s.formName!.value).toBe("ctx7");
    expect(s.formCommand!.value).toBe("npx");
    expect(s.formArgs!.value).toBe("-y, pkg");
    expect(s.formCwd!.value).toBe("/w");
    expect(s.formUrl!.value).toBe("https://x/mcp");
    expect(s.formHeaders!.value).toBe("Authorization: Bearer t");
    expect(s.formEnv!.value).toBe("A=1");
  });

  it("enabled:false 必须回填成未勾选（否则保存时被静默重新启用并自动连接）", () => {
    const s = builtState();
    s.formEnabled!.checked = true;
    fillForm(s, entry({ enabled: false }));
    expect(s.formEnabled!.checked).toBe(false);
    fillForm(s, entry({ enabled: true }));
    expect(s.formEnabled!.checked).toBe(true);
  });

  it("enabled 缺键时按 true 回填（不得默认成未勾选）", () => {
    const s = builtState();
    s.formEnabled!.checked = false;
    fillForm(s, entry({ enabled: undefined as unknown as boolean }));
    expect(s.formEnabled!.checked).toBe(true);
  });

  it("env 缺键时清零（投影省略即「沿用既有」，残留旧值会被 PATCH 落盘）", () => {
    const s = builtState();
    s.formEnv!.value = "STALE=1";
    fillForm(s, entry({ name: "x" }));
    expect(s.formEnv!.value).toBe("");
  });

  it("回填后派发 transport 的 change 事件（驱动 stdio/http 字段显隐切换）", () => {
    const s = builtState();
    let hits = 0;
    s.formTransport!.addEventListener("change", () => {
      hits += 1;
    });
    fillForm(s, entry({ transport: "streamable-http" }));
    expect(hits).toBe(1);
    expect(s.formTransport!.value).toBe("streamable-http");
  });

  it("transport 缺键回落 stdio（不写入非法值）", () => {
    const s = builtState();
    s.formTransport!.value = "streamable-http";
    fillForm(s, entry({ transport: undefined as unknown as string }));
    expect(s.formTransport!.value).toBe("stdio");
  });
});

describe("quick-add：迁移判据", () => {
  it("isEditing：editingName 已设即为编辑态", () => {
    const s = builtState();
    expect(isEditing(s)).toBe(false);
    s.editingName = "a";
    expect(isEditing(s)).toBe(true);
  });

  it("isMigratedEdit：未在编辑态判假（新建不是迁移）", () => {
    expect(
      isMigratedEdit(builtState(), { name: "a", transport: "stdio" }, { scope: "global" }),
    ).toBe(false);
  });

  it("isMigratedEdit：同名同 scope 判假（PATCH 按 (scope,name) 定位得住）", () => {
    const s = builtState({ editingName: "a", editing: entry({ name: "a", scope: "global" }) });
    expect(isMigratedEdit(s, { name: "a", transport: "stdio" }, { scope: "global" })).toBe(false);
  });

  it("isMigratedEdit：改名判真（PATCH 会 404，必须走 POST+DELETE）", () => {
    const s = builtState({ editingName: "a", editing: entry({ name: "a", scope: "global" }) });
    expect(isMigratedEdit(s, { name: "b", transport: "stdio" }, { scope: "global" })).toBe(true);
  });

  it("isMigratedEdit：改归属判真", () => {
    const s = builtState({ editingName: "a", editing: entry({ name: "a", scope: "global" }) });
    expect(isMigratedEdit(s, { name: "a", transport: "stdio" }, { scope: "project" })).toBe(true);
  });

  it("isMigratedEdit：editing 缺 scope 时同名判假（无定位信息可据）", () => {
    const s = builtState({ editingName: "a" });
    expect(isMigratedEdit(s, { name: "a", transport: "stdio" }, { scope: "project" })).toBe(false);
  });

  it("urlPlaceholderBlocks：新建与迁移一律中止，同名同 scope 的编辑才放行", () => {
    const server = { name: "a", transport: "stdio" } as const;
    expect(urlPlaceholderBlocks(builtState(), server, { scope: "global" })).toBe(true);
    const editing = builtState({
      editingName: "a",
      editing: entry({ name: "a", scope: "global" }),
    });
    expect(urlPlaceholderBlocks(editing, server, { scope: "global" })).toBe(false);
    expect(urlPlaceholderBlocks(editing, server, { scope: "project" })).toBe(true);
  });
});

describe("quick-add：保存三种落点", () => {
  it("jsonWriteInit：POST + content-type + JSON body", () => {
    expect(jsonWriteInit({ a: 1 })).toEqual({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
  });

  it("新建：单发 POST 到 servers 端点", async () => {
    const s = builtState();
    const ok = await performSaveRequest(s, { name: "a", transport: "stdio" }, { name: "a" });
    expect(ok).toBe(true);
    expect(fetchFake.calls).toEqual([
      { url: "/api/dsh-mcp/servers", method: "POST", body: '{"name":"a"}' },
    ]);
  });

  it("编辑（同名同 scope）：PATCH 按 (scope,name) 定位", async () => {
    const s = builtState({ editingName: "a", editing: entry({ name: "a", scope: "global" }) });
    s.formScope!.value = "global";
    const ok = await performSaveRequest(
      s,
      { name: "a", transport: "stdio" },
      { name: "a", scope: "global" },
    );
    expect(ok).toBe(true);
    expect(fetchFake.calls).toEqual([
      {
        url: "/api/dsh-mcp/servers?name=a&scope=global",
        method: "PATCH",
        body: '{"name":"a","scope":"global"}',
      },
    ]);
  });

  it("编辑：名称与 scope 都被 URL 编码", async () => {
    const s = builtState({ editingName: "a b", editing: entry({ name: "a b", scope: "global" }) });
    s.formScope!.value = "global";
    await performSaveRequest(
      s,
      { name: "a b", transport: "stdio" },
      { name: "a b", scope: "global" },
    );
    expect(fetchFake.calls[0]!.url).toBe("/api/dsh-mcp/servers?name=a%20b&scope=global");
  });

  it("迁移（改名）：先 POST 新条目再 DELETE 旧条目，顺序不可颠倒", async () => {
    const s = builtState({ editingName: "a", editing: entry({ name: "a", scope: "global" }) });
    const ok = await performSaveRequest(
      s,
      { name: "b", transport: "stdio" },
      { name: "b", scope: "global" },
    );
    expect(ok).toBe(true);
    expect(fetchFake.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/dsh-mcp/servers",
      "DELETE /api/dsh-mcp/servers?name=a&scope=global",
    ]);
  });

  it("迁移且原条目有凭据：**无条件中止**，零请求且大声失败（M7）", async () => {
    const s = builtState({
      editingName: "a",
      editing: entry({ name: "a", scope: "global", hasSecrets: true }),
    });
    const ok = await performSaveRequest(
      s,
      { name: "b", transport: "stdio" },
      { name: "b", scope: "global" },
    );
    expect(ok).toBe(false);
    expect(fetchFake.calls).toHaveLength(0);
    expect(alerts).toHaveLength(1);
    // 文案须指引手动路径，不得承诺「重填后保存」——该后续路径在无条件拦截下不存在。
    expect(alerts[0]).toContain("新建同名条目");
  });

  it("迁移且原条目无凭据：放行", async () => {
    const s = builtState({
      editingName: "a",
      editing: entry({ name: "a", scope: "global", hasSecrets: false }),
    });
    const ok = await performSaveRequest(
      s,
      { name: "b", transport: "stdio" },
      { name: "b", scope: "global" },
    );
    expect(ok).toBe(true);
    expect(fetchFake.calls).toHaveLength(2);
  });

  it("迁移时 DELETE 用**原归属**而非新归属（旧条目就位在原 scope 上）", async () => {
    const s = builtState({
      editingName: "a",
      editing: entry({ name: "a", scope: "project" }),
    });
    await performSaveRequest(s, { name: "a", transport: "stdio" }, { name: "a", scope: "global" });
    expect(fetchFake.calls[1]!.url).toBe("/api/dsh-mcp/servers?name=a&scope=project");
  });
});

describe("quick-add：saveForm 全链路", () => {
  it("新建成功：发请求 → resetForm → refresh", async () => {
    const s = builtState();
    s.formName!.value = "a";
    s.formCommand!.value = "npx";
    const { actions, calls } = makeActions();
    await saveForm(s, actions);
    expect(fetchFake.calls).toHaveLength(1);
    expect(calls).toEqual(["refresh"]);
    // resetForm 已把编辑态与表单清空
    expect(s.editingName).toBeUndefined();
    expect(s.formName!.value).toBe("");
    expect(s.formCommand!.value).toBe("");
  });

  it("请求失败：alert 且不 refresh（半迁移脏数据不得留在盘上）", async () => {
    fetchFake.failOnce();
    const s = builtState();
    s.formName!.value = "a";
    s.formCommand!.value = "npx";
    const { actions, calls } = makeActions();
    await saveForm(s, actions);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("boom");
    expect(calls).toEqual([]);
  });

  it("投影 URL 含占位符且无既有可保：中止、零请求、提示重填", async () => {
    const s = builtState();
    s.formName!.value = "a";
    s.formTransport!.value = "streamable-http";
    s.formUrl!.value = "https://x/[REDACTED]";
    const { actions, calls } = makeActions();
    await saveForm(s, actions);
    expect(fetchFake.calls).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("重填");
  });

  it("投影 URL 含占位符但走 PATCH（既有可沿用）：省略 url 字段后放行", async () => {
    const s = builtState({
      editingName: "a",
      editing: entry({ name: "a", scope: "global" }),
    });
    s.formScope!.value = "global";
    s.formName!.value = "a";
    s.formTransport!.value = "streamable-http";
    s.formUrl!.value = "https://x/[REDACTED]";
    const { actions } = makeActions();
    await saveForm(s, actions);
    expect(fetchFake.calls).toHaveLength(1);
    const body = JSON.parse(String(fetchFake.calls[0]!.body)) as Record<string, unknown>;
    expect(Object.hasOwn(body, "url")).toBe(false);
  });

  it("env/headers 里的占位符整表清空即删键，逐键命中即剔除该键", async () => {
    const s = builtState();
    s.formName!.value = "a";
    s.formCommand!.value = "npx";
    s.formEnv!.value = "REAL=1\nSECRET=[REDACTED]";
    const { actions } = makeActions();
    await saveForm(s, actions);
    const body = JSON.parse(String(fetchFake.calls[0]!.body)) as Record<string, unknown>;
    expect(body.env).toEqual({ REAL: "1" });
  });

  it("env 全是占位符 → 整个 env 键被删（不是留一张空表）", async () => {
    const s = builtState();
    s.formName!.value = "a";
    s.formCommand!.value = "npx";
    s.formEnv!.value = "SECRET=[REDACTED]";
    const { actions } = makeActions();
    await saveForm(s, actions);
    const body = JSON.parse(String(fetchFake.calls[0]!.body)) as Record<string, unknown>;
    expect(Object.hasOwn(body, "env")).toBe(false);
  });

  it("有 currentCwd 时 payload 带 cwd（宿主据此切换项目级 MCP）", async () => {
    const s = builtState({ currentCwd: "/w" });
    s.formName!.value = "a";
    s.formCommand!.value = "npx";
    const { actions } = makeActions();
    await saveForm(s, actions);
    const body = JSON.parse(String(fetchFake.calls[0]!.body)) as Record<string, unknown>;
    expect(body.cwd).toBe("/w");
  });

  it("scope 由表单决定并进 payload", async () => {
    const s = builtState();
    s.formName!.value = "a";
    s.formCommand!.value = "npx";
    s.formScope!.value = "project";
    const { actions } = makeActions();
    await saveForm(s, actions);
    const body = JSON.parse(String(fetchFake.calls[0]!.body)) as Record<string, unknown>;
    expect(body.scope).toBe("project");
  });
});

describe("quick-add：resetForm 与 beginEdit", () => {
  it("resetForm：清编辑态 + 清空全部字段 + transport 回落 stdio + enabled 回勾", () => {
    const s = builtState({ editingName: "a", editing: entry(), projectRoot: "/p" });
    s.formName!.value = "a";
    s.formCommand!.value = "npx";
    s.formArgs!.value = "-y";
    s.formEnv!.value = "A=1";
    s.formCwd!.value = "/w";
    s.formUrl!.value = "https://x/mcp";
    s.formHeaders!.value = "A: 1";
    s.formTransport!.value = "streamable-http";
    s.formEnabled!.checked = false;

    resetForm(s);

    expect(s.editingName).toBeUndefined();
    expect(s.editing).toBeUndefined();
    expect(s.formName!.value).toBe("");
    expect(s.formCommand!.value).toBe("");
    expect(s.formArgs!.value).toBe("");
    expect(s.formEnv!.value).toBe("");
    expect(s.formCwd!.value).toBe("");
    expect(s.formUrl!.value).toBe("");
    expect(s.formHeaders!.value).toBe("");
    expect(s.formTransport!.value).toBe("stdio");
    expect(s.formEnabled!.checked).toBe(true);
    // 有 projectRoot 时 scope 回落 project
    expect(s.formScope!.value).toBe("project");
  });

  it("resetForm：派发 transport change（驱动字段显隐回到 stdio 侧）", () => {
    const s = builtState();
    let hits = 0;
    s.formTransport!.addEventListener("change", () => {
      hits += 1;
    });
    resetForm(s);
    expect(hits).toBe(1);
  });

  it("resetForm：把标题改回「添加服务器」并禁用取消按钮", () => {
    const s = builtState();
    buildQuickAdd(s, makeActions().actions);
    const title = document.getElementById("dm-form-title");
    const cancel = document.querySelector<HTMLButtonElement>("[data-dm-cancel]");
    if (title !== null) title.textContent = "编辑服务器：x";
    if (cancel !== null) cancel.disabled = false;
    resetForm(s);
    // 断言译后文案（不是 key 形态）：顺带钉住 {name} 之外的重置文案不带插值残留。
    expect(title?.textContent).toBe("添加服务器");
    expect(cancel?.disabled).toBe(true);
  });

  it("resetForm：表单未构建时只清编辑态，不抛", () => {
    const s = createState();
    s.editingName = "a";
    expect(() => {
      resetForm(s);
    }).not.toThrow();
    expect(s.editingName).toBeUndefined();
  });

  it("beginEdit：设编辑态、切 quick tab、回填字段、改 scope、启用取消按钮", () => {
    const s = builtState();
    const { actions, calls } = makeActions();
    beginEdit(s, actions, entry({ name: "ctx7", scope: "project", command: "npx" }));
    expect(s.editingName).toBe("ctx7");
    expect(s.editing?.name).toBe("ctx7");
    expect(calls).toContain("switchTab:quick");
    expect(s.formName!.value).toBe("ctx7");
    expect(s.formCommand!.value).toBe("npx");
    expect(s.formScope!.value).toBe("project");
    expect(document.querySelector<HTMLButtonElement>("[data-dm-cancel]")?.disabled).toBe(false);
  });

  it("beginEdit：标题改成「编辑服务器：<name>」", () => {
    const s = builtState();
    buildQuickAdd(s, makeActions().actions);
    beginEdit(s, makeActions().actions, entry({ name: "ctx7" }));
    // 译后文案且 {name} 已插值——只断 key 形态的话，插值写错也看不出来。
    expect(document.getElementById("dm-form-title")?.textContent).toBe("编辑服务器：ctx7");
  });

  it("beginEdit：scope 非 project/global 时不动表单 scope（不写入非法值）", () => {
    const s = builtState({ projectRoot: "/p" });
    s.formScope!.value = "project";
    beginEdit(s, makeActions().actions, entry({ name: "a", scope: "weird" }));
    expect(s.formScope!.value).toBe("project");
  });

  it("beginEdit 之后 saveForm 走 PATCH 而非 POST（编辑态没被 resetForm 冲掉）", async () => {
    const s = builtState();
    const { actions, calls } = makeActions();
    beginEdit(s, actions, entry({ name: "ctx7", scope: "global" }));
    await saveForm(s, actions);
    expect(fetchFake.calls[0]!.method).toBe("PATCH");
    // 同一个 actions 记录器：beginEdit 的 switchTab 也在里面
    expect(calls).toEqual(["switchTab:quick", "refresh"]);
  });
});

describe("quick-add：buildQuickAdd 页面构建", () => {
  it("10 个表单控件全部建出来（少一个就会静默读到 undefined）", () => {
    const s = builtState();
    for (const key of [
      "formName",
      "formScope",
      "formTransport",
      "formCommand",
      "formArgs",
      "formEnv",
      "formCwd",
      "formUrl",
      "formHeaders",
      "formEnabled",
    ] as const) {
      expect(s[key], key + " 未构建").toBeDefined();
    }
  });

  it("scope 缺省：有 projectRoot 取 project、无根取 global", () => {
    expect(builtState({ projectRoot: "/p" }).formScope!.value).toBe("project");
    expect(builtState().formScope!.value).toBe("global");
  });

  it("编辑态下构建：name 与 scope 预填（buildQuickAdd 按 state.editing 预填）", () => {
    const s = builtState({ editing: entry({ name: "ctx7", scope: "project" }) });
    expect(s.formName!.value).toBe("ctx7");
    expect(s.formScope!.value).toBe("project");
  });

  it("enabled 默认勾上（新建即启用）", () => {
    expect(builtState().formEnabled!.checked).toBe(true);
  });

  it("transport 切到 http：stdio 侧字段隐藏、http 侧显示", () => {
    const s = builtState();
    s.formTransport!.value = "streamable-http";
    s.formTransport!.dispatchEvent(new Event("change"));
    const stdioField = s.formCommand!.closest(".dm-field") as HTMLElement;
    const httpField = s.formUrl!.closest(".dm-field") as HTMLElement;
    expect(stdioField.style.display).toBe("none");
    expect(httpField.style.display).toBe("flex");
  });

  it("transport 切回 stdio：显隐反向", () => {
    const s = builtState();
    s.formTransport!.value = "stdio";
    s.formTransport!.dispatchEvent(new Event("change"));
    expect((s.formCommand!.closest(".dm-field") as HTMLElement).style.display).toBe("flex");
    expect((s.formUrl!.closest(".dm-field") as HTMLElement).style.display).toBe("none");
  });

  it("点「保存」按钮真的走 saveForm（按钮 onclick 接线不是装饰）", async () => {
    // 钉的是**按钮接线**本身：此前只直接调 saveForm，页面里 save 按钮的 onclick 箭头函数
    // 从未被执行，pnpm cov 里那两条未覆盖语句就是它俩。改接线（onclick 指错函数 / 摘掉
    // onclick）本条必须红。
    const state = builtState();
    state.formName!.value = "a";
    state.formCommand!.value = "npx";
    const saveBtn = [
      ...document.querySelectorAll<HTMLButtonElement>(".dm-form-actions button"),
    ].find((b) => !b.hasAttribute("data-dm-cancel"))!;
    saveBtn.dispatchEvent(new Event("click"));
    await settle();
    expect(fetchFake.calls).toHaveLength(1);
    expect(fetchFake.calls[0]!.url).toBe("/api/dsh-mcp/servers");
  });

  it("点「取消编辑」按钮真的走 resetForm（表单被清空）", () => {
    const state = builtState();
    state.formName!.value = "a";
    state.formCommand!.value = "npx";
    const cancelBtn = document.querySelector<HTMLButtonElement>("[data-dm-cancel]")!;
    expect(cancelBtn.disabled).toBe(true);
    // 取消按钮初始 disabled=true（不在编辑态不提供退出），但它的 onclick 仍须是 resetForm。
    cancelBtn.dispatchEvent(new Event("click"));
    expect(state.formName!.value).toBe("");
    expect(state.formCommand!.value).toBe("");
  });

  it("页面含粘贴导入区与结果容器", () => {
    const s = builtState();
    const page = buildQuickAdd(s, makeActions().actions);
    expect(page.querySelector(".dm-result")).not.toBeNull();
    expect(page.querySelector(".dm-paste-box textarea")).not.toBeNull();
  });
});

describe("quick-add：粘贴 JSON 导入", () => {
  /** 建页面并返回结果节点与导入按钮。 */
  function importSetup(
    payload: unknown,
    raw: Partial<McpState> = {},
  ): {
    state: McpState;
    result: HTMLElement;
    button: HTMLButtonElement;
    textarea: HTMLTextAreaElement;
    calls: string[];
    actions: UiActions;
  } {
    const { actions, calls } = makeActions();
    const state = createState();
    Object.assign(state, raw);
    const page = buildQuickAdd(state, actions);
    document.body.appendChild(page);
    const result = page.querySelector<HTMLElement>(".dm-result")!;
    const button = page.querySelector<HTMLButtonElement>(".dm-actions button")!;
    const textarea = page.querySelector<HTMLTextAreaElement>(".dm-paste-box textarea")!;
    textarea.value = '{"a":{"command":"npx"}}';
    fetchFake.payload = payload;
    return { state, result, button, textarea, calls, actions };
  }

  it("导入成功：写「已导入」文案，带 scope 与 cwd 进请求体", async () => {
    const { result, button, state } = importSetup(
      { imported: ["a", "b"], skipped: [] },
      { currentCwd: "/w" },
    );
    state.formScope!.value = "project";
    button.dispatchEvent(new Event("click"));
    await settle();
    const body = JSON.parse(String(fetchFake.calls[0]!.body)) as Record<string, unknown>;
    expect(body.scope).toBe("project");
    expect(body.cwd).toBe("/w");
    // 原始 JSON 文本**原样**透传给宿主（客户端不解析、不改写它）
    expect(String(body.json)).toBe('{"a":{"command":"npx"}}');
    expect(result.textContent).toBe("已导入：a, b");
  });

  it("导入成功但列表为空：落「（无）」而不是空文案", async () => {
    const { result, button } = importSetup({ imported: [], skipped: [] });
    button.dispatchEvent(new Event("click"));
    await settle();
    expect(result.textContent).toBe("已导入：（无）");
  });

  it("有跳过项：额外挂一段跳过清单（不与已导入文案混成一段）", async () => {
    const { result, button } = importSetup({ imported: ["a"], skipped: ["b"] });
    button.dispatchEvent(new Event("click"));
    await settle();
    expect(result.querySelector(".dm-skip")?.textContent).toBe("跳过（已存在）：b");
  });

  it("无跳过项：不产生 .dm-skip 节点", async () => {
    const { result, button } = importSetup({ imported: ["a"], skipped: [] });
    button.dispatchEvent(new Event("click"));
    await settle();
    expect(result.querySelectorAll(".dm-skip")).toHaveLength(0);
  });

  it("导入失败：写「导入失败」文案（带 msg），不抛", async () => {
    fetchFake.failOnce();
    const { actions, calls } = makeActions();
    const state = createState();
    const page = buildQuickAdd(state, actions);
    document.body.appendChild(page);
    const result = page.querySelector(".dm-result")!;
    const button = page.querySelector<HTMLButtonElement>(".dm-actions button")!;
    button.dispatchEvent(new Event("click"));
    await settle();
    expect(result.textContent).toContain("boom");
    expect(calls).toEqual([]);
  });

  it("导入成功后 refresh（列表需重取）", async () => {
    const { button, calls } = importSetup({ imported: ["a"], skipped: [] });
    button.dispatchEvent(new Event("click"));
    await settle();
    expect(calls).toEqual(["refresh"]);
  });
});
