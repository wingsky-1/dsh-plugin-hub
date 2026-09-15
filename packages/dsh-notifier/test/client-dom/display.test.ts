// @vitest-environment happy-dom
//
// 环境声明必须落在文件里，不能只靠 vitest.config.ts 的 client-dom project：变异面按拓扑派生的是
// 单 project node 环境配置（vitest.stryker.d/*.config.ts），本层要进变异面就得自带环境。
/**
 * dsh-notifier — 横幅 / 短提示的真实 DOM 判据（#769 的 happy-dom 层）。
 *
 * 为什么另立一层：display.ts 此前只有纯裁剪函数（bannerTrimCount / trimBanners）的判据，
 * 「挂到 body、同 kind 替换、超上限淘汰最旧、到点自消失」这些真正决定页面里能看到几条的
 * 行为没有判据。假 document 能断言的只是「它调用了 remove」；这一层在真实 happy-dom
 * document 上断言节点在不在 DOM 里，故「超上限时只剩 N 条」是被真数出来的。
 *
 * 时间纪律：自消失用例用假钟，并显式声明 toFake 面（display.ts 只用 setTimeout /
 * clearTimeout），不用真实等待做否定判据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BANNER_CAP, showBanner, toast } from "../../src/client/notify/display.ts";

/** 当前挂在文档里的横幅，DOM 顺序 = 最旧在前。 */
function banners(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".dn-banner"));
}

/** 当前挂在文档里的短提示。 */
function toasts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".dn-toast"));
}

/** 当前横幅的 kind 序列。 */
function kinds(): string[] {
  return banners().map((node) => node.dataset.kind ?? "");
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("showBanner：挂载与内容", () => {
  it("横幅挂到 document.body 上，kind 进 dataset、标题与正文进文本", () => {
    showBanner("done", "任务完成", "用时 3 秒");

    const [banner] = banners();
    expect(banners()).toHaveLength(1);
    expect(banner.parentElement).toBe(document.body);
    expect(banner.className).toBe("dn-banner");
    expect(banner.dataset.kind).toBe("done");
    expect(banner.textContent).toContain("任务完成");
    expect(banner.textContent).toContain("用时 3 秒");
  });

  it("kind 含引号与反斜杠时按 dataset 比对：第二次同 kind 仍只留一条且不抛错", () => {
    const kind = 'a"b\\c';

    showBanner(kind, "旧标题", "m");
    showBanner(kind, "新标题", "m");

    expect(banners()).toHaveLength(1);
    expect(kinds()).toEqual([kind]);
    expect(banners()[0].textContent).toContain("新标题");
  });
});

describe("showBanner：同 kind 替换而不是叠加", () => {
  it("第二次同 kind 时旧节点从 DOM 摘除，只剩新节点", () => {
    showBanner("done", "旧", "m");
    const [old] = banners();

    showBanner("done", "新", "m");

    expect(banners()).toHaveLength(1);
    expect(old.isConnected).toBe(false);
    expect(banners()[0].textContent).toContain("新");
  });

  it("替换同 kind 不顺带淘汰其它 kind：三条满仓时替换后仍是三条，被换的那条排到最新", () => {
    showBanner("k1", "一", "m");
    showBanner("k2", "二", "m");
    showBanner("k3", "三", "m");

    showBanner("k1", "一改", "m");

    expect(banners()).toHaveLength(BANNER_CAP);
    expect(kinds()).toEqual(["k2", "k3", "k1"]);
  });
});

describe("showBanner：超过上限淘汰最旧的一条", () => {
  it("第 4 条进来后 DOM 里只剩 3 条，离场的是第 1 条", () => {
    showBanner("k1", "一", "m");
    const [oldest] = banners();
    showBanner("k2", "二", "m");
    showBanner("k3", "三", "m");

    showBanner("k4", "四", "m");

    expect(banners()).toHaveLength(BANNER_CAP);
    expect(kinds()).toEqual(["k2", "k3", "k4"]);
    expect(oldest.isConnected).toBe(false);
  });

  it("连续灌入 10 条后，DOM 里只在位最后 3 条（前 7 条全部离场）", () => {
    const created: HTMLElement[] = [];
    for (let i = 1; i <= 10; i += 1) {
      showBanner(`k${i}`, `第 ${i} 条`, "m");
      created.push(banners()[banners().length - 1]);
    }

    expect(kinds()).toEqual(["k8", "k9", "k10"]);
    expect(created.map((node) => node.isConnected)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });
});

describe("showBanner：点击即关", () => {
  it("点击横幅把它从 DOM 摘除", () => {
    showBanner("done", "任务完成", "m");
    const [banner] = banners();

    banner.click();

    expect(banner.isConnected).toBe(false);
    expect(banners()).toHaveLength(0);
  });
});

describe("toast：短提示", () => {
  it("短提示挂到 document.body 上，文本就是消息本身", () => {
    toast("已保存");

    const [node] = toasts();
    expect(toasts()).toHaveLength(1);
    expect(node.parentElement).toBe(document.body);
    expect(node.className).toBe("dn-toast");
    expect(node.textContent).toBe("已保存");
  });
});

describe("自动消失（假钟）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("横幅恰好在 8 秒到点时从 DOM 消失（早 1 毫秒还在）", () => {
    showBanner("done", "任务完成", "m");

    vi.advanceTimersByTime(7_999);
    expect(banners()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(banners()).toHaveLength(0);
  });

  it("短提示恰好在 3 秒到点时从 DOM 消失（早 1 毫秒还在）", () => {
    toast("已保存");

    vi.advanceTimersByTime(2_999);
    expect(toasts()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(toasts()).toHaveLength(0);
  });
});
