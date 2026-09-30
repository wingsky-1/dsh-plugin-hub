// @vitest-environment happy-dom
/** dsh-decision-gateway 设置独立页真机 DOM 判据（happy-dom，全离线 fetch 桩）。
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
    expect(card.getAttribute("data-plugin")).toBe("dsh-decision-gateway");
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
  it("hasPlaintextKey 即“已配置”+定长八点，ENV 名回显且无原文（D4）", async () => {
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
    const dots = card.querySelector(
      '[aria-label="已配置明文密钥掩码（定长八点，与原文长度无关）"]',
    );
    expect(dots).not.toBe(null);
    expect(dots?.textContent).toBe("••••••••");
    expect(card.textContent).not.toContain(SECRET);
    // ENV 轨激活时明文轨不挂载：切 plain 后明文框恒空。
    expect(card.querySelector('input[aria-label="明文密钥"]')).toBe(null);
    fireEvent.click(
      card.querySelector<HTMLInputElement>('input[name="dj-keymode"][value="plain"]')!,
    );
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

/**
 * R3：跨包原语层（shared/client/ui）在本包的契约判据。
 *
 * 判据按语义层（role/aria-*）+ 样式钩子层（data-dsu-*）写，**不按 className 选元素**：
 * 类名是冻结契约第 2 层的样式钩子，拿它选元素等于把钩子名焊死在测试里。
 * 本包只消费 Button（15 处），故只锁 Button；tab 族刻意未迁（语义层不许在收敛中变）。
 */
describe("R3 原语层契约：Button（本包唯一消费档）", () => {
  it("全部 dj-btn 按钮都带 dsu 钩子与恒定 type=button", async () => {
    restore = installStub(baseStub).restore;
    const card = mount();
    await pollUntil(() => (card.textContent ?? "").includes("已加载配置"), "连接已加载");
    const buttons = Array.from(card.querySelectorAll<HTMLButtonElement>("[data-dsu-btn]"));
    // connection 窗格：离线自检 + 保存两枚（重试按钮只在 failed 态出现）。
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const btn of buttons) {
      expect(btn.type).toBe("button");
      expect(btn.classList.contains("dsu-btn")).toBe(true);
      // 领域视觉仍由调用点传入的类承担（原语层不替消费包挑外观）。
      expect(btn.classList.contains("dj-btn")).toBe(true);
    }
    // 覆盖「迁移只漏了一处」：按可见按钮数对齐，裸 <button> 一枚都不许有。
    const all = card.querySelectorAll("button");
    expect(all.length).toBe(
      buttons.length + tabButtons(card).length + card.querySelectorAll(".dj-foldHead").length,
    );
  });

  it("tab 族未被迁入 SegmentedControl：aria-selected 保持页签语义", async () => {
    restore = installStub(baseStub).restore;
    const card = mount();
    const tabs = tabButtons(card);
    // 迁移前的语义层：role=group 容器 + 每项 aria-selected（不是 aria-pressed）。
    expect(card.querySelector('[role="group"]')).not.toBe(null);
    expect(tabs.map((b) => b.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(card.querySelectorAll("[aria-pressed]")).toHaveLength(0);
    // 永久禁用项：role=navigation 命中即整弹窗退回桌面 row 布局（手机内容区约 106px）。
    expect(card.querySelector("[role=navigation]")).toBe(null);
    expect(card.querySelector("[role=tablist]")).toBe(null);
  });

  it("本包未消费的 Surface/Field/Badge/Status 原语不在 DOM 上", async () => {
    restore = installStub(baseStub).restore;
    const card = mount();
    expect(card.querySelector("[data-dsu-surface]")).toBe(null);
    expect(card.querySelector("[data-dsu-field]")).toBe(null);
    expect(card.querySelector("[data-dsu-badge]")).toBe(null);
    expect(card.querySelector("[data-dsu-status]")).toBe(null);
  });
});
