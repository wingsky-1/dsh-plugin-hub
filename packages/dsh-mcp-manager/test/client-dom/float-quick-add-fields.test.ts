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
import {
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
  parseKV,
  readForm,
  readHttpFormFields,
  readStdioFormFields,
  urlPlaceholderBlocks,
} from "../../src/client/float/quick-add.ts";
import { builtState, entry, FAKE_ZH, FetchFake } from "./client-shape-quick-add.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bindLocale } from "../../../../shared/client/i18n.js";
let fetchFake: FetchFake;
let alerts: string[];
const realAlert = window.alert;

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
