/**
 * dsh-notifier — 弹出通知登记的判据（#769 阶段 3）。
 *
 * 「最多 5 条、超出关最旧、卸载只关自己登记的」原先散在 showNotification 与 disposer 里且无判据。
 * 上限是页面级语义（整个页面同时留几条弹窗），归属只决定「谁的清理关谁的弹窗」。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  closeNotificationsOf,
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

/**
 * 注册表是模块级单例，逐用例隔离只能靠「谁登记谁清理」：用例结束时关掉本用例用过的全部令牌，
 * 免得上一条用例的残留被后面用例的上限淘汰踩到（那会让「超出上限」的判据看着红得莫名其妙）。
 */
const owners: object[] = [];
function owner(): object {
  const token: object = {};
  owners.push(token);
  return token;
}
afterEach(() => {
  for (const token of owners.splice(0)) closeNotificationsOf(token);
});

describe("弹出通知登记", () => {
  // 值锚：其余用例都以 NOTIFICATION_KEEP 为输入，常量改坏了它们照样绿，故显式钉住字面量。
  it("上限字面量是 5 条（值锚）", () => {
    expect(NOTIFICATION_KEEP).toBe(5);
  });

  it("未超上限时不动任何一条", () => {
    const f = fake();
    const token = owner();
    for (let i = 0; i < NOTIFICATION_KEEP; i += 1) trackNotification(f.make(), token);
    expect(f.closed).toEqual([]);
  });

  it("超出上限即关最旧的那一条", () => {
    const f = fake();
    const token = owner();
    for (let i = 0; i < NOTIFICATION_KEEP; i += 1) trackNotification(f.make(), token);
    trackNotification(f.make(), token);
    expect(f.closed).toEqual([0]);
    trackNotification(f.make(), token);
    expect(f.closed).toEqual([0, 1]);
  });

  // 硬编码档位：以常量驱动时把 NOTIFICATION_KEEP 改成 1 或 100 都不会红。这条把「6 条进、第 1 条
  // 被挤掉、页面剩 5 条」写成字面量，改常量必然打红。
  it("硬编码档位：连登 6 条即挤掉第 1 条、页面只剩 5 条", () => {
    const f = fake();
    const token = owner();
    for (let i = 0; i < 6; i += 1) trackNotification(f.make(), token);
    expect(f.closed).toEqual([0]);
    // 关掉本实例的登记就能数出「此刻页面上还剩几条」：只剩 1..5，共 5 条
    closeNotificationsOf(token);
    expect(f.closed).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("关掉本实例登记的通知并清空，再调一次不会重复关", () => {
    const f = fake();
    const token = owner();
    trackNotification(f.make(), token);
    trackNotification(f.make(), token);
    closeNotificationsOf(token);
    expect(f.closed).toEqual([0, 1]);
    closeNotificationsOf(token);
    expect(f.closed).toEqual([0, 1]);
  });

  it("closeNotificationsOf 只关自己登记的弹窗（别的实例不动）", () => {
    const a = fake();
    const b = fake();
    const tokenA = owner();
    const tokenB = owner();
    trackNotification(a.make(), tokenA);
    trackNotification(b.make(), tokenB);

    closeNotificationsOf(tokenA);

    expect(a.closed).toEqual([0]);
    expect(b.closed).toEqual([]);
    closeNotificationsOf(tokenB);
    expect(b.closed).toEqual([0]);
  });

  it("页面上限不分归属：甲乙交替登记超限时，挤掉的是页面上最旧的那条", () => {
    const a = fake();
    const b = fake();
    const tokenA = owner();
    const tokenB = owner();
    // 交替登记，第 6 条由乙登记：页面上最旧的是甲的第 1 条，超限淘汰不看归属
    trackNotification(a.make(), tokenA);
    trackNotification(b.make(), tokenB);
    trackNotification(a.make(), tokenA);
    trackNotification(b.make(), tokenB);
    trackNotification(a.make(), tokenA);
    trackNotification(b.make(), tokenB);

    expect(a.closed).toEqual([0]);
    expect(b.closed).toEqual([]);
    // 再关甲的登记：甲只剩 1、2 两条（第 0 条已被淘汰）
    closeNotificationsOf(tokenA);
    expect(a.closed).toEqual([0, 1, 2]);
    expect(b.closed).toEqual([]);
  });

  it("单条关闭抛错不阻塞其余关闭", () => {
    const f = fake();
    const token = owner();
    trackNotification(f.make(), token);
    trackNotification(
      {
        close(): void {
          throw new Error("already gone");
        },
      },
      token,
    );
    trackNotification(f.make(), token);
    expect(() => closeNotificationsOf(token)).not.toThrow();
    // 假通知的 id 由 make() 调用次数决定：两条成功的分别是 0 与 1，中间那条是抛错的内联对象
    expect(f.closed).toEqual([0, 1]);
  });
});
