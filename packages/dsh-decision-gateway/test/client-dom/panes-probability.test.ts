// @vitest-environment happy-dom
/** dsh-decision-gateway 窗格交互 + 概率条边界（happy-dom，全离线 fetch 桩）。
 *
 * 守的是 panes/history entryNode+paintOptions+清空两步、panes/presets 行渲染+开关+阈值、
 * panes/connection 保存守卫、components/probRow 归一分支：改宽任一分支本文件必红。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { fireEvent } from "@testing-library/react";
import { APP_ROUTES } from "../../src/client/api/routes.ts";
import type { DecisionHistoryEntry } from "../../src/client/api/interface.ts";
import { ProbBar, tierBadge } from "../../src/client/settings/prob.tsx";
import { ConnectionPane } from "../../src/client/settings/connection.tsx";
import { HistoryPane } from "../../src/client/settings/history.tsx";
import { PresetsPane } from "../../src/client/settings/presets.tsx";
import {
  BARE_CONFIG,
  baseStub,
  installStub,
  jsonResponse,
  mountPane,
  pollUntil,
} from "../client-helpers.ts";
import { setLang } from "../../src/client/locale.ts";

function entry(over: Partial<DecisionHistoryEntry> = {}): DecisionHistoryEntry {
  return {
    ts: 1700000000000,
    rootHash: "abc123",
    rootDisplay: "proj",
    sessionId: "sess-aaa",
    presetId: "general",
    templateVersion: 1,
    stateHash: "s",
    snippetRedacted: "hello",
    lang: "en",
    truncated: false,
    originalLength: 5,
    resultKind: "choice",
    choice: "A",
    confidence: 0.8,
    tier: "high",
    automation: "auto",
    provider: "official",
    latencyMs: 5,
    ...over,
  };
}

const PRESET_INFOS = [
  { id: "general", templateVersion: 1, label: "通用", description: "desc-g" },
  { id: "secret-leak", templateVersion: 1, label: "泄漏", description: "desc-s" },
  { id: "plan-review", templateVersion: 1, label: "评审", description: "desc-p" },
  { id: "risk-check", templateVersion: 1, label: "风险", description: "desc-r" },
  { id: "custom", templateVersion: 1, label: "自定", description: "desc-c" },
];

function presetsStub(url: string): Response {
  if (url.includes(APP_ROUTES.presets)) return jsonResponse({ ok: true, presets: PRESET_INFOS });
  return baseStub(url);
}

let restore: (() => void) | null = null;
const unmounts: Array<() => void> = [];
beforeEach(() => {
  document.body.innerHTML = "";
  setLang("zh");
});

afterEach(() => {
  for (const u of unmounts.splice(0)) {
    try {
      u();
    } catch {
      /* 忽略 */
    }
  }
  document.body.innerHTML = "";
  restore?.();
  restore = null;
});

describe("ProbBar 边界", () => {
  function barOf(over: Partial<DecisionHistoryEntry> = {}): HTMLElement {
    const { pane, unmount } = mountPane(React.createElement(ProbBar, { entry: entry(over) }));
    unmounts.push(unmount);
    return pane;
  }
  it("score 5 无 confidence 即 100%（score/5 归一）", () => {
    const row = barOf({ confidence: 0, score: 5, choice: undefined, resultKind: "score" });
    const fill = row.querySelector<HTMLElement>(".dj-barFill");
    expect(fill?.style.width).toBe("100%");
    const num = row.querySelector(".dj-probNum");
    expect(num?.textContent).toBe("100%");
    expect(num?.getAttribute("title")).toContain("score 5/5");
  });
  it("双无即 0% 且题“无概率”", () => {
    const row = barOf({ confidence: 0, score: undefined, choice: undefined, resultKind: "choice" });
    expect(row.querySelector<HTMLElement>(".dj-barFill")?.style.width).toBe("0%");
    const num = row.querySelector(".dj-probNum");
    expect(num?.textContent).toBe("0%");
    expect(num?.getAttribute("title")).toBe("无概率");
  });
  it("confidence 优先于 score", () => {
    const row = barOf({ confidence: 0.9, score: 3 });
    expect(row.querySelector<HTMLElement>(".dj-barFill")?.style.width).toBe("90%");
    expect(row.querySelector(".dj-probNum")?.getAttribute("title")).toContain("confidence 0.9");
  });
  it("tier 决定填充类；阈值线恒 80%", () => {
    expect(barOf({ tier: "high" }).querySelector(".dj-barFillHigh")).not.toBe(null);
    expect(barOf({ tier: "low" }).querySelector(".dj-barFillLow")).not.toBe(null);
    expect(barOf({ tier: "none" }).querySelector(".dj-barFillHigh")).toBe(null);
    expect(barOf({ tier: "none" }).querySelector(".dj-barFillLow")).toBe(null);
    expect(barOf({}).querySelector<HTMLElement>(".dj-barThreshold")?.style.left).toBe("80%");
  });
  it("tierBadge 三档文案", () => {
    const mountBadge = (tier: "high" | "low" | "none"): HTMLElement => {
      const { pane, unmount } = mountPane(tierBadge(tier));
      unmounts.push(unmount);
      return pane;
    };
    expect(mountBadge("high").querySelector(".dj-badgeOn")?.textContent).toBe("high");
    expect(mountBadge("low").querySelector(".dj-badgeWarn")?.textContent).toBe("low");
    expect(mountBadge("none").querySelector(".dj-badge")?.textContent).toBe("none");
  });
});

describe("presets 窗格交互", () => {
  it("五预设行：开关切换与阈值下拉即时刷新", async () => {
    restore = installStub(presetsStub).restore;
    const { pane, unmount } = mountPane(React.createElement(PresetsPane));
    unmounts.push(unmount);
    await pollUntil(() => pane.querySelectorAll(".dj-preset").length === 5, "五预设行");
    expect(pane.textContent).toContain("预设 5 个");
    const box = pane.querySelector<HTMLInputElement>('input[aria-label="启用预设 general"]');
    expect(box?.checked).toBe(true);
    fireEvent.click(box!);
    expect(pane.textContent).toContain("已关闭");
    const sel = pane.querySelector<HTMLSelectElement>('select[aria-label="自动化上限 general"]');
    fireEvent.change(sel!, { target: { value: "1" } });
    sel!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(sel!.closest(".dj-rangeRow")?.querySelector(".dj-rangeVal")?.textContent).toBe("low");
  });
  it("目录 500 即加载失败错态", async () => {
    const stub = (url: string): Response => {
      if (url.includes(APP_ROUTES.presets)) return jsonResponse({ ok: false }, 500);
      return baseStub(url);
    };
    restore = installStub(stub).restore;
    const { pane, unmount } = mountPane(React.createElement(PresetsPane));
    unmounts.push(unmount);
    await pollUntil(() => (pane.textContent ?? "").includes("加载失败"), "预设错态");
    expect(pane.textContent).toContain("加载失败");
  });
});

describe("history 条目渲染与清空", () => {
  const ENTRIES = [
    entry({}),
    entry({
      sessionId: "sess-aaa",
      resultKind: "score",
      choice: undefined,
      score: 4,
      confidence: 0,
      tier: "low",
      truncated: true,
      snippetRedacted: "scored",
      errorCode: "UPSTREAM",
    }),
  ];
  function entriesStub(url: string, method: string): Response {
    if (url.includes(APP_ROUTES.history) && method === "DELETE")
      return jsonResponse({ ok: true, deleted: true });
    if (url.includes(APP_ROUTES.history)) return jsonResponse({ ok: true, entries: ENTRIES });
    return baseStub(url);
  }
  it("条目：snippet/tier/截断/错误行/概率宽/计数/会话选项", async () => {
    restore = installStub(entriesStub).restore;
    const { pane, unmount } = mountPane(React.createElement(HistoryPane));
    unmounts.push(unmount);
    await pollUntil(() => pane.querySelectorAll(".dj-histItem").length === 2, "两条目");
    expect(pane.textContent).toContain("hello");
    expect(pane.textContent).toContain("截断");
    expect(pane.textContent).toContain("错误：UPSTREAM");
    expect(pane.textContent).toContain("共 2 条");
    const fills = Array.from(pane.querySelectorAll<HTMLElement>(".dj-barFill"));
    expect(fills.map((f) => f.style.width)).toEqual(["80%", "80%"]);
    const sessSel = pane.querySelector<HTMLSelectElement>('select[aria-label="会话过滤"]');
    expect(sessSel?.textContent).toContain("sess-aaa");
  });
  it("清空两步确认：DELETE 带 sessionId，成功后重载为空", async () => {
    const seen: string[] = [];
    let cleared = false;
    const stub = (url: string, method: string): Response => {
      seen.push(method + " " + url);
      if (url.includes(APP_ROUTES.history) && method === "DELETE") {
        cleared = true;
        return jsonResponse({ ok: true, deleted: true });
      }
      if (url.includes(APP_ROUTES.history))
        return jsonResponse({ ok: true, entries: cleared ? [] : ENTRIES });
      return baseStub(url);
    };
    restore = installStub(stub).restore;
    const { pane, unmount } = mountPane(React.createElement(HistoryPane));
    unmounts.push(unmount);
    await pollUntil(() => pane.querySelectorAll(".dj-histItem").length === 2, "两条目");
    const sessSel = pane.querySelector<HTMLSelectElement>('select[aria-label="会话过滤"]');
    fireEvent.change(sessSel!, { target: { value: "sess-aaa" } });
    sessSel!.dispatchEvent(new Event("change", { bubbles: true }));
    const clearBtn = Array.from(pane.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "清空本会话",
    );
    await pollUntil(() => clearBtn?.disabled === false, "清空可用");
    fireEvent.click(clearBtn!);
    expect(clearBtn?.textContent).toBe("确认清空本会话？");
    fireEvent.click(clearBtn!);
    await pollUntil(
      () => seen.some((c) => c.startsWith("DELETE ") && c.includes("sessionId=sess-aaa")),
      "DELETE 单会话",
    );
    await pollUntil(() => (pane.textContent ?? "").includes("暂无历史"), "清空后重载为空");
  });
  it("条目按 ts 倒序（打红点：排序比较）", async () => {
    const stub = (url: string): Response => {
      if (url.includes(APP_ROUTES.history))
        return jsonResponse({
          ok: true,
          entries: [
            entry({ ts: 1, snippetRedacted: "old" }),
            entry({ ts: 2, snippetRedacted: "new" }),
          ],
        });
      return baseStub(url);
    };
    restore = installStub(stub).restore;
    const { pane, unmount } = mountPane(React.createElement(HistoryPane));
    unmounts.push(unmount);
    await pollUntil(() => pane.querySelectorAll(".dj-histItem").length === 2, "两条目");
    const items = Array.from(pane.querySelectorAll(".dj-histItem"));
    expect(items[0]?.textContent).toContain("new");
    expect(items[1]?.textContent).toContain("old");
  });
  it("错误码取 errorCode 键（打红点：键回落链）", async () => {
    const stub = (url: string): Response => {
      if (url.includes(APP_ROUTES.history)) return jsonResponse({ errorCode: "E1" }, 500);
      return baseStub(url);
    };
    restore = installStub(stub).restore;
    const { pane, unmount } = mountPane(React.createElement(HistoryPane));
    unmounts.push(unmount);
    await pollUntil(() => (pane.textContent ?? "").includes("加载失败：E1"), "精确错码");
  });
  it("deleted:false 即清空失败错态", async () => {
    const stub = (url: string, method: string): Response => {
      if (url.includes(APP_ROUTES.history) && method === "DELETE")
        return jsonResponse({ ok: true, deleted: false });
      if (url.includes(APP_ROUTES.history)) return jsonResponse({ ok: true, entries: ENTRIES });
      return baseStub(url);
    };
    restore = installStub(stub).restore;
    const { pane, unmount } = mountPane(React.createElement(HistoryPane));
    unmounts.push(unmount);
    await pollUntil(() => pane.querySelectorAll(".dj-histItem").length === 2, "两条目");
    const sessSel = pane.querySelector<HTMLSelectElement>('select[aria-label="会话过滤"]');
    fireEvent.change(sessSel!, { target: { value: "sess-aaa" } });
    sessSel!.dispatchEvent(new Event("change", { bubbles: true }));
    const clearBtn = Array.from(pane.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "清空本会话",
    );
    await pollUntil(() => clearBtn?.disabled === false, "清空可用");
    fireEvent.click(clearBtn!);
    fireEvent.click(clearBtn!);
    await pollUntil(() => (pane.textContent ?? "").includes("清空失败"), "清空失败错态");
    expect(pane.textContent).toContain("delete-not-confirmed");
  });
});

describe("connection 保存守卫", () => {
  function saveButton(pane: HTMLElement): HTMLButtonElement | undefined {
    return Array.from(pane.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "保存",
    );
  }
  it("二选一：只提交选中侧（ENV 模式无明文轨）", async () => {
    const handle = installStub((url, method) => {
      if (url.includes(APP_ROUTES.config) && method === "PUT") return jsonResponse(BARE_CONFIG);
      return baseStub(url);
    });
    restore = handle.restore;
    const { pane, unmount } = mountPane(React.createElement(ConnectionPane));
    unmounts.push(unmount);
    await pollUntil(() => (pane.textContent ?? "").includes("已加载配置"), "连接已加载");
    expect(pane.querySelector('input[aria-label="明文密钥"]')).toBe(null);
    fireEvent.change(pane.querySelector<HTMLInputElement>('input[aria-label="ENV 变量名"]')!, {
      target: { value: "JEV_X" },
    });
    fireEvent.click(saveButton(pane)!);
    await pollUntil(
      () => handle.calls.some((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config)),
      "PUT 已发",
    );
    const put = handle.calls.find((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config));
    expect(put?.body).toContain("JEV_X");
    expect(put?.body).not.toContain("apiKeyPlaintext");
  });
  it("二选一单轨隐藏：未选中轨不挂载，切换即显隐", async () => {
    restore = installStub(baseStub).restore;
    const { pane, unmount } = mountPane(React.createElement(ConnectionPane));
    unmounts.push(unmount);
    await pollUntil(() => (pane.textContent ?? "").includes("已加载配置"), "连接已加载");
    expect(pane.querySelector('input[aria-label="ENV 变量名"]')).not.toBe(null);
    expect(pane.querySelector('input[aria-label="明文密钥"]')).toBe(null);
    const plainRadio = pane.querySelector<HTMLInputElement>(
      'input[name="dj-keymode"][value="plain"]',
    )!;
    fireEvent.click(plainRadio);
    expect(pane.querySelector('input[aria-label="ENV 变量名"]')).toBe(null);
    expect(pane.querySelector('input[aria-label="明文密钥"]')).not.toBe(null);
  });
  it("载入按键模式同步快照：有 ENV 名即 env，有明文即 plain", async () => {
    const refStub = (url: string): Response => {
      if (url.includes(APP_ROUTES.config))
        return jsonResponse({
          ...BARE_CONFIG,
          connection: { ...BARE_CONFIG.connection, apiKeyRef: "JEV_SYNC" },
        });
      return baseStub(url);
    };
    restore = installStub(refStub).restore;
    const mounted = mountPane(React.createElement(ConnectionPane));
    unmounts.push(mounted.unmount);
    await pollUntil(() => (mounted.pane.textContent ?? "").includes("已加载配置"), "连接已加载");
    expect(
      mounted.pane.querySelector<HTMLInputElement>('input[name="dj-keymode"][value="env"]')
        ?.checked,
    ).toBe(true);
    const plainStub = (url: string): Response => {
      if (url.includes(APP_ROUTES.config))
        return jsonResponse({
          ...BARE_CONFIG,
          connection: { ...BARE_CONFIG.connection, hasPlaintextKey: true },
        });
      return baseStub(url);
    };
    restore();
    restore = installStub(plainStub).restore;
    const mounted2 = mountPane(React.createElement(ConnectionPane));
    unmounts.push(mounted2.unmount);
    await pollUntil(() => (mounted2.pane.textContent ?? "").includes("已加载配置"), "连接已加载2");
    expect(
      mounted2.pane.querySelector<HTMLInputElement>('input[name="dj-keymode"][value="plain"]')
        ?.checked,
    ).toBe(true);
  });
  it("切轨保存明文附 apiKeyRef:null（否则服务端互斥 400）", async () => {
    const handle = installStub((url: string, method: string) => {
      if (url.includes(APP_ROUTES.config))
        return jsonResponse({
          ...BARE_CONFIG,
          connection: { ...BARE_CONFIG.connection, apiKeyRef: "JEV_OLD" },
        });
      void method;
      return baseStub(url);
    });
    restore = handle.restore;
    const { pane, unmount } = mountPane(React.createElement(ConnectionPane));
    unmounts.push(unmount);
    await pollUntil(() => (pane.textContent ?? "").includes("已加载配置"), "连接已加载");
    fireEvent.click(
      pane.querySelector<HTMLInputElement>('input[name="dj-keymode"][value="plain"]')!,
    );
    fireEvent.change(pane.querySelector<HTMLInputElement>('input[aria-label="明文密钥"]')!, {
      target: { value: "z".repeat(20) },
    });
    fireEvent.click(saveButton(pane)!);
    await pollUntil(
      () => handle.calls.some((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config)),
      "PUT 已发",
    );
    const put = handle.calls.find((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config));
    expect(put?.body).toContain("apiKeyPlaintext");
    expect(put?.body).toContain('"apiKeyRef":null');
  });
  it("明文免二次确认直接发 PUT；非法 ENV 名仍阻断", async () => {
    const handle = installStub(baseStub);
    restore = handle.restore;
    const { pane, unmount } = mountPane(React.createElement(ConnectionPane));
    unmounts.push(unmount);
    await pollUntil(() => (pane.textContent ?? "").includes("已加载配置"), "连接已加载");
    fireEvent.change(pane.querySelector<HTMLInputElement>('input[aria-label="ENV 变量名"]')!, {
      target: { value: "lower" },
    });
    fireEvent.click(saveButton(pane)!);
    await pollUntil(() => (pane.textContent ?? "").includes("ENV 名非法"), "ENV 错");
    const plainRadio = pane.querySelector<HTMLInputElement>(
      'input[name="dj-keymode"][value="plain"]',
    )!;
    fireEvent.click(plainRadio);
    fireEvent.change(pane.querySelector<HTMLInputElement>('input[aria-label="明文密钥"]')!, {
      target: { value: "y".repeat(20) },
    });
    fireEvent.click(saveButton(pane)!);
    await pollUntil(
      () => handle.calls.some((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config)),
      "PUT 已发",
    );
    const put = handle.calls.find((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config));
    expect(put?.body).toContain("apiKeyPlaintext");
    expect(put?.body).not.toContain("confirm");
    expect(pane.textContent).not.toContain("二次确认");
  });
  it("ENV 保存成功：PUT 体含引用且重载掩码", async () => {
    const handle = installStub((url, method) => {
      if (url.includes(APP_ROUTES.config) && method === "PUT") return jsonResponse(BARE_CONFIG);
      return baseStub(url);
    });
    restore = handle.restore;
    const { pane, unmount } = mountPane(React.createElement(ConnectionPane));
    unmounts.push(unmount);
    await pollUntil(() => (pane.textContent ?? "").includes("已加载配置"), "连接已加载");
    fireEvent.change(pane.querySelector<HTMLInputElement>('input[aria-label="ENV 变量名"]')!, {
      target: { value: "JEV_NEW" },
    });
    fireEvent.click(saveButton(pane)!);
    await pollUntil(
      () => handle.calls.some((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config)),
      "PUT 已发",
    );
    const put = handle.calls.find((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config));
    expect(put?.body).toContain("JEV_NEW");
    expect(put?.body).not.toContain("baseUrl");
    await pollUntil(() => (pane.textContent ?? "").includes("已加载配置"), "保存后重载");
  });
  it("离线自检：成功与失败皆有文案", async () => {
    restore = installStub(baseStub).restore;
    const { pane, unmount } = mountPane(React.createElement(ConnectionPane));
    unmounts.push(unmount);
    await pollUntil(() => (pane.textContent ?? "").includes("已加载配置"), "连接已加载");
    const testBtn = Array.from(pane.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "离线自检",
    );
    fireEvent.click(testBtn!);
    await pollUntil(() => (pane.textContent ?? "").includes("自检通过"), "自检通过");
  });
  it("离线自检 500 即失败文案", async () => {
    const stub = (url: string): Response => {
      if (url.includes(APP_ROUTES.testConnection))
        return jsonResponse({ error: { category: "upstream" } }, 500);
      return baseStub(url);
    };
    restore = installStub(stub).restore;
    const { pane, unmount } = mountPane(React.createElement(ConnectionPane));
    unmounts.push(unmount);
    await pollUntil(() => (pane.textContent ?? "").includes("已加载配置"), "连接已加载");
    const testBtn = Array.from(pane.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "离线自检",
    );
    fireEvent.click(testBtn!);
    await pollUntil(() => (pane.textContent ?? "").includes("自检失败"), "自检失败");
  });
});

describe("presets 保存与导出", () => {
  it("保存成功：PUT presets 数组并显已保存", async () => {
    const handle = installStub((url, method) => {
      if (url.includes(APP_ROUTES.config) && method === "PUT") return jsonResponse(BARE_CONFIG);
      return presetsStub(url);
    });
    restore = handle.restore;
    const { pane, unmount } = mountPane(React.createElement(PresetsPane));
    unmounts.push(unmount);
    await pollUntil(() => pane.querySelectorAll(".dj-preset").length === 5, "五预设行");
    const saveBtn = Array.from(pane.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "保存",
    );
    fireEvent.click(saveBtn!);
    await pollUntil(
      () => handle.calls.some((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config)),
      "PUT presets 已发",
    );
    const put = handle.calls.find((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config));
    expect(JSON.parse(put?.body ?? "{}")).toMatchObject({ version: 1 });
    expect(JSON.parse(put?.body ?? "{}").presets as unknown[]).toHaveLength(5);
    await pollUntil(() => (pane.textContent ?? "").includes("目录与开关位已合并"), "保存后重载");
  });
  it("导出 JSON：下载锚带文件名", async () => {
    const prevCreate = URL.createObjectURL;
    const prevRevoke = URL.revokeObjectURL;
    let href = "";
    URL.createObjectURL = (() => {
      href = "blob:mock";
      return href;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    try {
      restore = installStub(presetsStub).restore;
      const { pane, unmount } = mountPane(React.createElement(PresetsPane));
      unmounts.push(unmount);
      await pollUntil(() => pane.querySelectorAll(".dj-preset").length === 5, "五预设行");
      const exportBtn = Array.from(pane.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.textContent === "导出 JSON",
      );
      fireEvent.click(exportBtn!);
      await pollUntil(() => (pane.textContent ?? "").includes("已导出 5 个预设"), "已导出");
      expect(href).toBe("blob:mock");
    } finally {
      URL.createObjectURL = prevCreate;
      URL.revokeObjectURL = prevRevoke;
    }
  });
  it("保存 500 即失败文案带类别", async () => {
    const stub = (url: string, method: string): Response => {
      if (url.includes(APP_ROUTES.config) && method === "PUT")
        return jsonResponse({ error: { category: "shape" } }, 400);
      return presetsStub(url);
    };
    restore = installStub(stub).restore;
    const { pane, unmount } = mountPane(React.createElement(PresetsPane));
    unmounts.push(unmount);
    await pollUntil(() => pane.querySelectorAll(".dj-preset").length === 5, "五预设行");
    const saveBtn = Array.from(pane.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "保存",
    );
    fireEvent.click(saveBtn!);
    await pollUntil(() => (pane.textContent ?? "").includes("保存失败：shape"), "保存失败");
  });
  it("详情行内单开：一次只展开一行，aria-expanded 同步", async () => {
    restore = installStub(presetsStub).restore;
    const { pane, unmount } = mountPane(React.createElement(PresetsPane));
    unmounts.push(unmount);
    await pollUntil(() => pane.querySelectorAll(".dj-preset").length === 5, "五预设行");
    const detailBtns = Array.from(pane.querySelectorAll<HTMLButtonElement>("button")).filter(
      (b) => b.textContent === "详情",
    );
    expect(detailBtns).toHaveLength(5);
    detailBtns[0]!.click();
    await pollUntil(() => detailBtns[0]!.getAttribute("aria-expanded") === "true", "首行展开");
    expect(pane.textContent).toContain("desc-g");
    detailBtns[1]!.click();
    await pollUntil(() => detailBtns[1]!.getAttribute("aria-expanded") === "true", "次行展开");
    expect(detailBtns[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(pane.querySelector("#dj-detail-general")).toBe(null);
  });
});

describe("connection 保存成功路径", () => {
  function saveButton(pane: HTMLElement): HTMLButtonElement | undefined {
    return Array.from(pane.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "保存",
    );
  }
  it("明文保存成功：PUT 体含明文不明文引用，成功后明文轨卸载无残留", async () => {
    const handle = installStub((url, method) => {
      if (url.includes(APP_ROUTES.config) && method === "PUT") return jsonResponse(BARE_CONFIG);
      return baseStub(url);
    });
    restore = handle.restore;
    const { pane, unmount } = mountPane(React.createElement(ConnectionPane));
    unmounts.push(unmount);
    await pollUntil(() => (pane.textContent ?? "").includes("已加载配置"), "连接已加载");
    const plainRadio = pane.querySelector<HTMLInputElement>(
      'input[name="dj-keymode"][value="plain"]',
    )!;
    fireEvent.click(plainRadio);
    const plain = pane.querySelector<HTMLInputElement>('input[aria-label="明文密钥"]');
    fireEvent.change(plain!, { target: { value: "z".repeat(20) } });
    expect(pane.querySelector('input[type="checkbox"]')).toBe(null);
    fireEvent.click(saveButton(pane)!);
    await pollUntil(
      () => handle.calls.some((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config)),
      "PUT 已发",
    );
    const put = handle.calls.find((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config));
    expect(put?.body).toContain("apiKeyPlaintext");
    expect(put?.body).not.toContain("apiKeyRef");
    await pollUntil(
      () => pane.querySelector('input[aria-label="明文密钥"]') === null,
      "明文轨卸载",
    );
    expect(pane.textContent).not.toContain("z".repeat(20));
  });
  it("保存 400 即失败文案带类别", async () => {
    const stub = (url: string, method: string): Response => {
      if (url.includes(APP_ROUTES.config) && method === "PUT")
        return jsonResponse({ error: { category: "shape" } }, 400);
      return baseStub(url);
    };
    restore = installStub(stub).restore;
    const { pane, unmount } = mountPane(React.createElement(ConnectionPane));
    unmounts.push(unmount);
    await pollUntil(() => (pane.textContent ?? "").includes("已加载配置"), "连接已加载");
    fireEvent.change(pane.querySelector<HTMLInputElement>('input[aria-label="ENV 变量名"]')!, {
      target: { value: "JEV_SAVE" },
    });
    fireEvent.click(saveButton(pane)!);
    await pollUntil(() => (pane.textContent ?? "").includes("保存失败：shape"), "保存失败");
  });
  it("加载失败现重试，重试后重载成功", async () => {
    let n = 0;
    const stub = (url: string): Response => {
      if (url.includes(APP_ROUTES.config)) {
        n += 1;
        if (n === 1) return jsonResponse({ ok: false }, 500);
        return jsonResponse(BARE_CONFIG);
      }
      return baseStub(url);
    };
    restore = installStub(stub).restore;
    const { pane, unmount } = mountPane(React.createElement(ConnectionPane));
    unmounts.push(unmount);
    await pollUntil(() => (pane.textContent ?? "").includes("加载失败"), "加载失败");
    const retryBtn = Array.from(pane.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "重试",
    );
    expect(retryBtn).not.toBe(null);
    fireEvent.click(retryBtn!);
    await pollUntil(() => (pane.textContent ?? "").includes("已加载配置"), "重试后加载");
  });
});

describe("history 过滤与刷新", () => {
  const ENTRIES = [entry({}), entry({ sessionId: "sess-bbb", snippetRedacted: "second" })];
  it("刷新重拉；工作目录过滤进查询串", async () => {
    const handle = installStub((url) => {
      if (url.includes(APP_ROUTES.history)) return jsonResponse({ ok: true, entries: ENTRIES });
      return baseStub(url);
    });
    restore = handle.restore;
    const { pane, unmount } = mountPane(React.createElement(HistoryPane));
    unmounts.push(unmount);
    await pollUntil(() => pane.querySelectorAll(".dj-histItem").length === 2, "两条目");
    const before = handle.calls.filter((c) => c.url.includes(APP_ROUTES.history)).length;
    const refreshBtn = Array.from(pane.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "刷新",
    );
    fireEvent.click(refreshBtn!);
    await pollUntil(
      () => handle.calls.filter((c) => c.url.includes(APP_ROUTES.history)).length > before,
      "刷新重拉",
    );
    const rootSel = pane.querySelector<HTMLSelectElement>('select[aria-label="工作目录过滤"]');
    fireEvent.change(rootSel!, { target: { value: "proj" } });
    rootSel!.dispatchEvent(new Event("change", { bubbles: true }));
    await pollUntil(() => handle.calls.some((c) => c.url.includes("root=proj")), "过滤进串");
  });
});
