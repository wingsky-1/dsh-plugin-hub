/**
 * dsh-notifier — 弹出通知登记的判据（#769 阶段 3）。
 *
 * 「最多 5 条、超出关最旧、卸载全关」这三条原先散在 showNotification 与 disposer 里且无判据。
 */
import { describe, expect, it } from "vitest";

import {
  closeAllNotifications,
  NOTIFICATION_KEEP,
  trackNotification,
} from "../../src/client/notify/registry.ts";

function fake() {
  const closed: number[] = [];
  let index = 0;
  return {
    closed,
    make() {
      const id = index++;
      return {
        id,
        close(): void {
          closed.push(id);
        },
      };
    },
  };
}

describe("弹出通知登记", () => {
  it("未超上限时不动任何一条", () => {
    const f = fake();
    for (let i = 0; i < NOTIFICATION_KEEP; i += 1) trackNotification(f.make());
    expect(f.closed).toEqual([]);
  });

  it("超出上限即关最旧的那一条", () => {
    const f = fake();
    for (let i = 0; i < NOTIFICATION_KEEP; i += 1) trackNotification(f.make());
    trackNotification(f.make());
    expect(f.closed).toEqual([0]);
    trackNotification(f.make());
    expect(f.closed).toEqual([0, 1]);
  });

  it("卸载全关，且清空登记（再调一次不会重复关）", () => {
    const f = fake();
    trackNotification(f.make());
    trackNotification(f.make());
    closeAllNotifications();
    expect(f.closed).toEqual([0, 1]);
    closeAllNotifications();
    expect(f.closed).toEqual([0, 1]);
  });

  it("单条关闭抛错不阻塞其余关闭", () => {
    const f = fake();
    trackNotification(f.make());
    trackNotification({
      close(): void {
        throw new Error("already gone");
      },
    });
    trackNotification(f.make());
    expect(() => closeAllNotifications()).not.toThrow();
    // 假通知的 id 由 make() 调用次数决定：两条成功的分别是 0 与 1，中间那条是抛错的内联对象
    expect(f.closed).toEqual([0, 1]);
  });
});
