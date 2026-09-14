/**
 * dsh-notifier — 标题闪烁的判据（#769 阶段 3）。
 *
 * 「隐藏时收到通知 → 标题变 🔔 → 卸载」是本包唯一会让标题永久卡死的路径（恢复只发生在回前台
 * 与卸载两处）。这里用假 document 把恢复语义钉住：只记第一次的原始标题、restore 幂等。
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
  return { doc, flasher };
}

describe("标题闪烁", () => {
  it("闪烁时把标题换成带铃铛的短标题", () => {
    const h = harness();
    h.flasher.flash("任务完成");
    expect(h.doc.title).toBe("🔔 任务完成");
  });

  it("连续闪烁只记第一次的原始标题（否则恢复出来的是上一个 🔔 标题）", () => {
    const h = harness("原名");
    h.flasher.flash("第一条");
    h.flasher.flash("第二条");
    expect(h.doc.title).toBe("🔔 第二条");
    h.flasher.restore();
    expect(h.doc.title).toBe("原名");
  });

  it("超长标题截到 40 字符（标题栏放不下，也不该被长文本挤爆）", () => {
    const h = harness();
    h.flasher.flash("x".repeat(100));
    expect(h.doc.title).toBe("🔔 " + "x".repeat(40));
  });

  it("restore 幂等：没闪过或闪完再调都不改变标题", () => {
    const h = harness("原名");
    h.flasher.restore();
    expect(h.doc.title).toBe("原名");
    h.flasher.flash("一次");
    h.flasher.restore();
    h.flasher.restore();
    expect(h.doc.title).toBe("原名");
  });

  it("恢复后可再次闪烁（卸载后重新挂载的路径）", () => {
    const h = harness("原名");
    h.flasher.flash("第一次");
    h.flasher.restore();
    h.flasher.flash("第二次");
    expect(h.doc.title).toBe("🔔 第二次");
    h.flasher.restore();
    expect(h.doc.title).toBe("原名");
  });
});
