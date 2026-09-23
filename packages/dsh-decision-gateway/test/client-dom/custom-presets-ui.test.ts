// @vitest-environment happy-dom
/** 自建预设 UI：新建表单走 PUT customPresets + 两步删除（happy-dom，全离线 fetch 桩）。
 *
 * 守的是 presets.tsx 自建面：新建三字段缺一即阻断、创建 PUT 体 customPresets 全量、
 * 删除两步确认仅删本条。改坏任一分支本文件必红。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { fireEvent } from "@testing-library/react";
import { APP_ROUTES } from "../../src/client/api/routes.ts";
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

const PRESET_INFOS = [
  { id: "general", templateVersion: 1, label: "general", description: "desc-g" },
  { id: "secret-leak", templateVersion: 1, label: "secret-leak", description: "desc-s" },
  { id: "plan-review", templateVersion: 1, label: "plan-review", description: "desc-p" },
  { id: "risk-check", templateVersion: 1, label: "risk-check", description: "desc-r" },
  { id: "custom", templateVersion: 1, label: "custom", description: "desc-c" },
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
      /* ignore */
    }
  }
  document.body.innerHTML = "";
  restore?.();
  restore = null;
});

function clickText(pane: HTMLElement, text: string): void {
  const btns = Array.from(pane.querySelectorAll("button"));
  const btn = btns.find((b) => b.textContent === text) as HTMLButtonElement | undefined;
  if (!btn) throw new Error("button missing: " + text);
  fireEvent.click(btn);
}

function byAria(pane: HTMLElement, name: string): HTMLElement {
  const el = pane.querySelector('[aria-label="' + name + '"]');
  if (!el) throw new Error("aria missing: " + name);
  return el as HTMLElement;
}

describe("自建预设 UI", () => {
  it("空字段即阻断，不发 PUT", async () => {
    const handle = installStub((url, method) => {
      if (url.includes(APP_ROUTES.config) && method === "PUT") return jsonResponse(BARE_CONFIG);
      return presetsStub(url);
    });
    restore = handle.restore;
    const found = mountPane(React.createElement(PresetsPane));
    unmounts.push(found.unmount);
    const pane = found.pane;
    await pollUntil(() => pane.querySelectorAll(".dj-preset").length === 5, "five");
    clickText(pane, "新建自建预设");
    clickText(pane, "创建");
    await pollUntil(
      () => (pane.textContent ?? "").includes("id/展示名/规范均不能为空"),
      "form invalid",
    );
    expect(handle.calls.some((c) => c.method === "PUT")).toBe(false);
  });
  it("新建走 PUT customPresets 全量且默认关闭", async () => {
    const handle = installStub((url, method) => {
      if (url.includes(APP_ROUTES.config) && method === "PUT") return jsonResponse(BARE_CONFIG);
      return presetsStub(url);
    });
    restore = handle.restore;
    const found = mountPane(React.createElement(PresetsPane));
    unmounts.push(found.unmount);
    const pane = found.pane;
    await pollUntil(() => pane.querySelectorAll(".dj-preset").length === 5, "five");
    clickText(pane, "新建自建预设");
    fireEvent.change(byAria(pane, "自建 id（小写字母/数字/连字符，不可与 frozen 重名）"), {
      target: { value: "my-board" },
    });
    fireEvent.change(byAria(pane, "展示名（英文）"), { target: { value: "My board" } });
    fireEvent.change(byAria(pane, "出题规范（英文自由文本，可抄模板写法）"), {
      target: { value: "Goal: ask about boards." },
    });
    clickText(pane, "创建");
    await pollUntil(
      () => handle.calls.some((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config)),
      "PUT sent",
    );
    const put = handle.calls.find((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config));
    const body = JSON.parse(put?.body ?? "{}") as {
      customPresets?: Array<{ id: string; enabled: boolean }>;
    };
    expect(body.customPresets).toHaveLength(1);
    expect(body.customPresets?.[0]?.id).toBe("my-board");
    expect(body.customPresets?.[0]?.enabled).toBe(false);
    await pollUntil(() => (pane.textContent ?? "").includes("目录与开关位已合并"), "saved reload");
  });
  it("删除两步确认仅删本条", async () => {
    const withCustom = [
      ...PRESET_INFOS,
      { id: "my-board", templateVersion: 1, label: "My board", description: "Goal.", custom: true },
    ];
    const handle = installStub((url, method) => {
      if (url.includes(APP_ROUTES.config) && method === "PUT") return jsonResponse(BARE_CONFIG);
      if (url.includes(APP_ROUTES.presets)) return jsonResponse({ ok: true, presets: withCustom });
      return baseStub(url);
    });
    restore = handle.restore;
    const found = mountPane(React.createElement(PresetsPane));
    unmounts.push(found.unmount);
    const pane = found.pane;
    await pollUntil(() => pane.querySelectorAll(".dj-preset").length === 6, "six");
    const card = Array.from(pane.querySelectorAll(".dj-preset")).find(
      (el) => el.querySelector(".dj-presetId")?.textContent === "my-board",
    );
    if (!card) throw new Error("custom card missing");
    const detailBtn = Array.from(card.querySelectorAll("button")).find(
      (b) => b.textContent === "详情",
    );
    if (!detailBtn) throw new Error("detail button missing");
    fireEvent.click(detailBtn as HTMLButtonElement);
    await pollUntil(() => (card.textContent ?? "").includes("Goal."), "detail open");
    const delBtn = Array.from(card.querySelectorAll("button")).find(
      (b) => b.textContent === "删除",
    );
    if (!delBtn) throw new Error("delete button missing");
    fireEvent.click(delBtn as HTMLButtonElement);
    await pollUntil(
      () => (pane.textContent ?? "").includes("再次点击确认删除该自建预设"),
      "arm delete",
    );
    expect(handle.calls.some((c) => c.method === "PUT")).toBe(false);
    const confirmBtn = Array.from(card.querySelectorAll("button")).find(
      (b) => b.textContent === "确认删除？",
    );
    fireEvent.click(confirmBtn as HTMLButtonElement);
    await pollUntil(
      () => handle.calls.some((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config)),
      "PUT delete sent",
    );
    const put = handle.calls.find((c) => c.method === "PUT" && c.url.includes(APP_ROUTES.config));
    const body = JSON.parse(put?.body ?? "{}") as { customPresets?: Array<{ id: string }> };
    expect(body.customPresets).toHaveLength(0);
  });
});
