// @vitest-environment happy-dom
/** dsh-jev-decide 设置独立页真机 DOM 判据（happy-dom，全离线 fetch 桩）。
 *
 * 守的是 settings.section 独立 tab 装配 + 三 tab 切换 + connection 掩码态 +
 * 历史空错态 + 健康徽标三态：改坏任一分支本文件必红。fetch 经全局桩，落盘无。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { APP_ROUTES } from "../../src/client/api/routes.ts";
import {
  BARE_CONFIG,
  baseStub,
  installStub,
  jsonResponse,
  mountCard,
  pollUntil,
} from "../client-helpers.ts";
import { setLang } from "../../src/client/locale.ts";

function tabButtons(card: HTMLElement): HTMLButtonElement[] {
  return Array.from(card.querySelectorAll<HTMLButtonElement>(".dj-tab"));
}

function paneOf(card: HTMLElement, tab: string): HTMLElement | null {
  return card.querySelector<HTMLElement>('.dj-pane[data-tab="' + tab + '"]');
}

let restore: (() => void) | null = null;
let unmount: (() => void) | null = null;
beforeEach(() => {
  document.body.innerHTML = "";
  setLang("zh");
});

afterEach(() => {
  try {
    unmount?.();
  } catch {
    /* 忽略 */
  }
  unmount = null;
  document.body.innerHTML = "";
  restore?.();
  restore = null;
});

function mount(): HTMLElement {
  const mounted = mountCard();
  unmount = mounted.unmount;
  return mounted.card;
}

describe("独立 tab 接线", () => {
  it("经 settings.section 注册（非 plugin.item）", async () => {
    restore = installStub(baseStub).restore;
    const card = mount();
    expect(card.getAttribute("data-plugin")).toBe("dsh-jev-decide");
    await pollUntil(() => (card.textContent ?? "").includes("已加载配置"), "连接已加载");
  });
});

describe("三 tab 切换", () => {
  it("三 tab 俱在；点击即切换挂载（D4）", async () => {
    restore = installStub(baseStub).restore;
    const card = mount();
    const buttons = tabButtons(card);
    expect(buttons.map((b) => b.textContent)).toEqual(["连接", "模板库", "历史"]);
    expect(paneOf(card, "connection")).not.toBe(null);
    const presetsBtn = buttons.find((b) => b.textContent === "模板库");
    expect(presetsBtn).toBeDefined();
    fireEvent.click(presetsBtn!);
    await pollUntil(() => paneOf(card, "presets") !== null, "模板库窗格挂载");
    expect(paneOf(card, "connection")).toBe(null);
    expect(presetsBtn?.getAttribute("aria-selected")).toBe("true");
    const historyBtn = buttons.find((b) => b.textContent === "历史");
    fireEvent.click(historyBtn!);
    await pollUntil(() => paneOf(card, "history") !== null, "历史窗格挂载");
    expect(paneOf(card, "presets")).toBe(null);
  });
});

describe("连接掩码已配置显示", () => {
  it("hasPlaintextKey 即“已配置”，ENV 名回显，明文框恒空且无原文（D4）", async () => {
    const SECRET = "DomSecretValue123456";
    const masked = {
      ...BARE_CONFIG,
      connection: { ...BARE_CONFIG.connection, hasPlaintextKey: true, apiKeyRef: "JEV_DOM_KEY" },
    };
    const stub = (url: string): Response => {
      if (url.includes(APP_ROUTES.config)) return jsonResponse(masked);
      return baseStub(url);
    };
    restore = installStub(stub).restore;
    const card = mount();
    await pollUntil(() => (card.textContent ?? "").includes("密钥：已配置"), "掩码已配置徽标");
    expect(card.textContent).toContain("JEV_DOM_KEY");
    expect(card.textContent).not.toContain(SECRET);
    const plain = card.querySelector<HTMLInputElement>('input[aria-label="明文密钥"]');
    expect(plain).not.toBe(null);
    expect(plain?.value).toBe("");
  });
});

describe("历史空错态", () => {
  it("空历史即“暂无历史。”（D4）", async () => {
    restore = installStub(baseStub).restore;
    const card = mount();
    fireEvent.click(tabButtons(card).find((b) => b.textContent === "历史")!);
    await pollUntil(() => (card.textContent ?? "").includes("暂无历史"), "空历史文案");
    expect(card.textContent).toContain("暂无历史");
  });
  it("历史 500 即“加载失败”错态（D4）", async () => {
    const stub = (url: string): Response => {
      if (url.includes(APP_ROUTES.history)) return jsonResponse({ ok: false }, 500);
      return baseStub(url);
    };
    restore = installStub(stub).restore;
    const card = mount();
    fireEvent.click(tabButtons(card).find((b) => b.textContent === "历史")!);
    await pollUntil(() => (card.textContent ?? "").includes("加载失败"), "历史错态文案");
    expect(card.textContent).toContain("加载失败");
  });
});

describe("健康徽标三态", () => {
  it("health 200 即“服务可用”", async () => {
    restore = installStub(baseStub).restore;
    const card = mount();
    await pollUntil(() => (card.textContent ?? "").includes("服务可用"), "服务可用");
    expect(card.querySelector(".dj-statusOk")).not.toBe(null);
  });
  it("health 500 即“服务异常 状态码”", async () => {
    const stub = (url: string): Response => {
      if (url.includes(APP_ROUTES.health)) return jsonResponse({ ok: false }, 500);
      return baseStub(url);
    };
    restore = installStub(stub).restore;
    const card = mount();
    await pollUntil(() => (card.textContent ?? "").includes("服务异常 500"), "服务异常");
    expect(card.querySelector(".dj-statusErr")).not.toBe(null);
  });
  it("health 抛错即“服务不可达”", async () => {
    const stub = (url: string): Response => {
      if (url.includes(APP_ROUTES.health)) throw new Error("down");
      return baseStub(url);
    };
    restore = installStub(stub).restore;
    const card = mount();
    await pollUntil(() => (card.textContent ?? "").includes("服务不可达"), "服务不可达");
  });
});
