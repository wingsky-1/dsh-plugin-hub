/**
 * dsh-notifier — 横幅裁剪的有界性判据（#769 阶段 0）。
 *
 * 为什么值这些判据：真正的缺陷不是算错了条数，而是**无限循环**。旧实现在 querySelectorAll 的
 * 静态快照上写 `while (banners.length >= 3) banners[0].remove()`，而 Element.remove() 不改变
 * 那个数组的长度 → 条件恒真。所以这里除了断言条数契约，还刻意为"实现退回长度不变的自循环"
 * 留了一条会**超时判红**的用例——只断言算术正确是拦不住它的。
 */
import { describe, expect, it } from "vitest";

import { BANNER_CAP, bannerTrimCount, trimBanners } from "../../src/client/notify/display.ts";

/** 一批假横幅：remove 记录自己的下标，下标序即"最旧在前"。 */
function fakeBanners(count: number): { nodes: { remove(): void }[]; removed: number[] } {
  const removed: number[] = [];
  const nodes = Array.from({ length: count }, (_unused, index) => ({
    remove: (): void => {
      removed.push(index);
    },
  }));
  return { nodes, removed };
}

describe("横幅裁剪：追加一条后总数不超过上限", () => {
  it("bannerTrimCount 在 0..12 条存量上恒满足非负、不超存量、留位后未超上限", () => {
    for (let existing = 0; existing <= 12; existing += 1) {
      const over = bannerTrimCount(existing, BANNER_CAP);
      expect(over, `existing=${existing}`).toBeGreaterThanOrEqual(0);
      expect(over, `existing=${existing}`).toBeLessThanOrEqual(existing);
      expect(existing - over, `existing=${existing}`).toBeLessThan(BANNER_CAP);
    }
  });

  it("存量未达上限时不淘汰任何一条", () => {
    expect(bannerTrimCount(0, BANNER_CAP)).toBe(0);
    expect(bannerTrimCount(BANNER_CAP - 1, BANNER_CAP)).toBe(0);
  });

  it("trimBanners 从最旧端恰好淘汰应淘汰的条数", () => {
    for (let existing = 0; existing <= 8; existing += 1) {
      const { nodes, removed } = fakeBanners(existing);
      trimBanners(nodes, BANNER_CAP);
      const expected = Math.max(0, existing - BANNER_CAP + 1);
      expect(removed, `existing=${existing}`).toEqual(
        Array.from({ length: expected }, (_unused, index) => index),
      );
    }
  });

  it("大批量存量同步有界完成（实现退回长度不变的自循环则本条超时判红）", () => {
    const { nodes, removed } = fakeBanners(500);
    trimBanners(nodes, BANNER_CAP);
    expect(removed).toHaveLength(500 - BANNER_CAP + 1);
  });
});
