// @vitest-environment happy-dom
//
// 环境声明必须落在文件里，不能只靠 vitest.config.ts 的 client-dom project：变异面按拓扑派生的是
// 单 project node 环境配置，本层要进变异面就得自带环境（照 notifier client-dom 范本）。
/** dsh-jev-decide 三 tab 真实 DOM 判据（D4，happy-dom，全离线 fetch 桩）。
 *
 * 守的是 client/index.apply 的三 tab 装配 + connection 掩码态 + history 空错态：
 * 把 tab 少一个、掩码拼原文、空历史文案改掉任一改动，本文件必红。
 * fetch 经全局桩（loopback 路由取数面），落盘无。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_ROUTES } from "../../src/client/api/routes.ts";
import {
  BARE_CONFIG,
  baseStub,
  installStub,
  jsonResponse,
  mountCard,
  pollUntil,
} from "../client-helpers.ts";

function tabButtons(card: HTMLElement): HTMLButtonElement[] {
  return Array.from(card.querySelectorAll<HTMLButtonElement>(".dj-tab"));
}

function paneOf(card: HTMLElement, tab: string): HTMLElement | null {
  return card.querySelector<HTMLElement>('.dj-pane[data-tab="' + tab + '"]');
}

let restore: (() => void) | null = null;
beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  restore?.();
  restore = null;
});

describe("三 tab 切换", () => {
  it("三 tab 俱在；点击即切换显隐（D4）", async () => {
    restore = installStub(baseStub).restore;
    const { card } = mountCard();
    const buttons = tabButtons(card);
    expect(buttons.map((b) => b.textContent)).toEqual(["连接", "模板库", "历史"]);
    expect(paneOf(card, "connection")?.hidden).toBe(false);
    const presetsBtn = buttons.find((b) => b.textContent === "模板库");
    expect(presetsBtn).toBeDefined();
    presetsBtn?.click();
    expect(paneOf(card, "presets")?.hidden).toBe(false);
    expect(paneOf(card, "connection")?.hidden).toBe(true);
    expect(presetsBtn?.getAttribute("aria-selected")).toBe("true");
    const historyBtn = buttons.find((b) => b.textContent === "历史");
    historyBtn?.click();
    await pollUntil(() => paneOf(card, "history")?.hidden === false, "历史窗格显现");
    expect(paneOf(card, "presets")?.hidden).toBe(true);
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
    mountCard();
    await pollUntil(
      () => (document.body.textContent ?? "").includes("密钥：已配置"),
      "掩码已配置徽标",
    );
    expect(document.body.textContent).toContain("JEV_DOM_KEY");
    expect(document.body.textContent).not.toContain(SECRET);
    const plain = document.querySelector<HTMLInputElement>('input[aria-label="明文密钥"]');
    expect(plain).not.toBe(null);
    expect(plain?.value).toBe("");
  });
});

describe("历史空错态", () => {
  it("空历史即“暂无历史。”（D4）", async () => {
    restore = installStub(baseStub).restore;
    const { card } = mountCard();
    tabButtons(card)
      .find((b) => b.textContent === "历史")
      ?.click();
    await pollUntil(() => (card.textContent ?? "").includes("暂无历史"), "空历史文案");
    expect(card.textContent).toContain("暂无历史");
  });
  it("历史 500 即“加载失败”错态（D4）", async () => {
    const stub = (url: string): Response => {
      if (url.includes(APP_ROUTES.history)) return jsonResponse({ ok: false }, 500);
      return baseStub(url);
    };
    restore = installStub(stub).restore;
    const { card } = mountCard();
    tabButtons(card)
      .find((b) => b.textContent === "历史")
      ?.click();
    await pollUntil(() => (card.textContent ?? "").includes("加载失败"), "历史错态文案");
    expect(card.textContent).toContain("加载失败");
  });
});

describe("健康徽标三态", () => {
  it("health 200 即“服务可用”", async () => {
    restore = installStub(baseStub).restore;
    const { card } = mountCard();
    await pollUntil(() => (card.textContent ?? "").includes("服务可用"), "服务可用");
    expect(card.querySelector(".dj-statusOk")).not.toBe(null);
  });
  it("health 500 即“服务异常 状态码”", async () => {
    const stub = (url: string): Response => {
      if (url.includes(APP_ROUTES.health)) return jsonResponse({ ok: false }, 500);
      return baseStub(url);
    };
    restore = installStub(stub).restore;
    const { card } = mountCard();
    await pollUntil(() => (card.textContent ?? "").includes("服务异常 500"), "服务异常");
    expect(card.querySelector(".dj-statusErr")).not.toBe(null);
  });
  it("health 抛错即“服务不可达”", async () => {
    const stub = (url: string): Response => {
      if (url.includes(APP_ROUTES.health)) throw new Error("down");
      return baseStub(url);
    };
    restore = installStub(stub).restore;
    const { card } = mountCard();
    await pollUntil(() => (card.textContent ?? "").includes("服务不可达"), "服务不可达");
  });
});
