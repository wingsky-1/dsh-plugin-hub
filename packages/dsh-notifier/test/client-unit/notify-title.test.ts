/**
 * dsh-notifier — 标题闪烁的判据（#769 阶段 3）。
 *
 * 「隐藏时收到通知 → 标题变 🔔 → 卸载」是本包唯一会让标题永久卡死的路径（恢复只发生在回前台
 * 与卸载两处）。这里用假 document 把恢复语义钉住：只记第一次的原始标题、restore 幂等，以及
 * 归属判定——热更时旧实例的 disposer 不许摘掉新实例点亮的闪烁（那是通知被静音/无权限时唯一
 * 的可见提醒）。
 */
import { describe, expect, it } from "vitest";

import { createTitleFlasher } from "../../src/client/notify/title.ts";

function harness(initial = "DSH") {
  const doc = { title: initial };
  const flasher = createTitleFlasher({
    get: () => doc.title,
    set: (value: string) => {
      doc.title = value;
    },
  });
  // 归属令牌：一枚令牌 = 一次 apply 建立的实例；跨实例场景由用例另取
  const owner: object = {};
  return { doc, flasher, owner };
}

describe("标题闪烁", () => {
  it("闪烁时把标题换成带铃铛的短标题", () => {
    const h = harness();
    h.flasher.flash("任务完成", h.owner);
    expect(h.doc.title).toBe("🔔 任务完成");
  });

  it("连续闪烁只记第一次的原始标题（否则恢复出来的是上一个 🔔 标题）", () => {
    const h = harness("原名");
    h.flasher.flash("第一条", h.owner);
    h.flasher.flash("第二条", h.owner);
    expect(h.doc.title).toBe("🔔 第二条");
    h.flasher.restore(h.owner);
    expect(h.doc.title).toBe("原名");
  });

  it("超长标题截到 40 字符（标题栏放不下，也不该被长文本挤爆）", () => {
    const h = harness();
    h.flasher.flash("x".repeat(100), h.owner);
    expect(h.doc.title).toBe("🔔 " + "x".repeat(40));
  });

  it("restore 幂等：没闪过或闪完再调都不改变标题", () => {
    const h = harness("原名");
    h.flasher.restore(h.owner);
    expect(h.doc.title).toBe("原名");
    h.flasher.flash("一次", h.owner);
    h.flasher.restore(h.owner);
    h.flasher.restore(h.owner);
    expect(h.doc.title).toBe("原名");
  });

  it("恢复后可再次闪烁（卸载后重新挂载的路径）", () => {
    const h = harness("原名");
    h.flasher.flash("第一次", h.owner);
    h.flasher.restore(h.owner);
    h.flasher.flash("第二次", h.owner);
    expect(h.doc.title).toBe("🔔 第二次");
    h.flasher.restore(h.owner);
    expect(h.doc.title).toBe("原名");
  });

  it("旧实例的 restore 摘不掉新实例的闪烁（归属判定）", () => {
    const h = harness("原名");
    const first: object = {};
    const second: object = {};
    h.flasher.flash("甲通知", first);
    h.flasher.flash("乙通知", second);
    expect(h.doc.title).toBe("🔔 乙通知");

    // 热更时旧实例的 disposer 仍会执行：它一 restore，用户就看不到隐藏页收到的通知了
    h.flasher.restore(first);
    expect(h.doc.title).toBe("🔔 乙通知");

    h.flasher.restore(second);
    expect(h.doc.title).toBe("原名");
  });

  it("归属者自己恢复之后，旧实例再 restore 仍是 no-op", () => {
    const h = harness("原名");
    const first: object = {};
    const second: object = {};
    h.flasher.flash("甲通知", first);
    h.flasher.flash("乙通知", second);
    h.flasher.restore(second);
    expect(h.doc.title).toBe("原名");
    h.flasher.restore(first);
    expect(h.doc.title).toBe("原名");
  });
});
