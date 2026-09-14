/**
 * dsh-notifier — 标题闪烁对真实 document.title 的判据（#769 的 happy-dom 层）。
 *
 * 为什么另立一层：createTitleFlasher 的纯语义已由 test/client/notify-title.test.ts 用假
 * document 钉住，但那份假件把 ports.get / ports.set 换成了普通字段——模块导出的 titleFlasher
 * 单例有没有真的接上本页的 document.title，假件里断不出来。这一层在真实 happy-dom document 上
 * 走完整链路。
 *
 * 状态纪律：titleFlasher 是模块级单例（恢复缓存跨调用共享），每个用例前后都要 restore 并重置
 * document.title，否则上一个用例的「已闪烁」状态会串进下一个。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { titleFlasher } from "../../src/client/notify/title.ts";

beforeEach(() => {
  titleFlasher.restore();
  document.title = "DSH";
});

afterEach(() => {
  titleFlasher.restore();
});

describe("titleFlasher：读写真实 document.title", () => {
  it("flash 把 document.title 换成带铃铛的标题", () => {
    titleFlasher.flash("任务完成");

    expect(document.title).toBe("🔔 任务完成");
  });

  it("restore 把 document.title 还原成闪烁前的原文（get 取的是真实标题）", () => {
    document.title = "DSH — 会话 7";

    titleFlasher.flash("任务完成");
    titleFlasher.restore();

    expect(document.title).toBe("DSH — 会话 7");
  });

  it("连续闪烁后只还原到最初的标题（恢复缓存存的是第一次的原文）", () => {
    titleFlasher.flash("第一条");
    titleFlasher.flash("第二条");
    expect(document.title).toBe("🔔 第二条");

    titleFlasher.restore();

    expect(document.title).toBe("DSH");
  });

  it("超长原文完整还原：截断只作用于闪烁标题，不作用于恢复缓存", () => {
    const original = "原".repeat(60);
    document.title = original;

    titleFlasher.flash("任务完成");
    expect(document.title).toBe("🔔 任务完成");

    titleFlasher.restore();

    expect(document.title).toBe(original);
    expect(original).toHaveLength(60);
  });

  it("未闪烁时 restore 不动 document.title（幂等）", () => {
    titleFlasher.restore();
    titleFlasher.restore();

    expect(document.title).toBe("DSH");
  });

  it("还原后再闪烁会重新取当时的标题：外部改过标题也不还原成陈旧值", () => {
    titleFlasher.flash("第一次");
    titleFlasher.restore();

    document.title = "DSH 2";
    titleFlasher.flash("第二次");
    titleFlasher.restore();

    expect(document.title).toBe("DSH 2");
  });
});
