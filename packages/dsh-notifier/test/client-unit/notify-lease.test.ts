/**
 * dsh-notifier — 多标签租约的判据（#769 阶段 2）。
 *
 * 租约原先直接读写 localStorage 与 Date.now，判定因此测不到。端口化后三分支与三条异常路径
 * 都能穷举——其中「raw 为空串时仍要写入租约」是一条容易在重写时丢掉的语义：不写租约的话，
 * 每个标签都会各自抢占成功，多标签重复提醒。
 */
import { describe, expect, it } from "vitest";

import { claimMaster, MASTER_KEY, MASTER_LEASE_MS } from "../../src/client/notify/lease.ts";

/** 一份可断言的假 storage + 可控时钟。 */
function harness(initial: string | null, now = 1000) {
  const writes: string[] = [];
  let stored = initial;
  let clock = now;
  const ports = {
    now: () => clock,
    read: () => stored,
    write: (value: string) => {
      writes.push(value);
      stored = value;
    },
  };
  return {
    ports,
    writes,
    get stored() {
      return stored;
    },
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("claimMaster：谁弹、谁静默", () => {
  it("无租约时抢占成功并写入自己的租约", () => {
    const h = harness(null);
    expect(claimMaster("tab-a", h.ports)).toBe(true);
    expect(h.writes).toEqual([JSON.stringify({ id: "tab-a", ts: 1000 })]);
  });

  it("storage 里是空串时同样抢占并写入（旧实现把假值当「没有租约」）", () => {
    // 若改成 JSON.parse("")，会走异常分支返回 true 却不写租约 → 每个标签都各自放行
    const h = harness("");
    expect(claimMaster("tab-a", h.ports)).toBe(true);
    expect(h.writes).toHaveLength(1);
    expect(JSON.parse(h.stored as string).id).toBe("tab-a");
  });

  it("租约属于自己且在窗口内 → 续租并保留其它键", () => {
    const h = harness(JSON.stringify({ id: "tab-a", ts: 1000, extra: "keep" }));
    h.advance(500);
    expect(claimMaster("tab-a", h.ports)).toBe(true);
    expect(JSON.parse(h.writes[0] as string)).toEqual({ id: "tab-a", ts: 1500, extra: "keep" });
  });

  it("租约属于别的标签且未过期 → 静默，且不写任何东西", () => {
    const h = harness(JSON.stringify({ id: "tab-b", ts: 1000 }));
    h.advance(500);
    expect(claimMaster("tab-a", h.ports)).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it("距租约写入 14999ms（窗口内 1ms，判定是严格小于）→ 仍归别的标签，静默且不写", () => {
    const h = harness(JSON.stringify({ id: "tab-b", ts: 1000 }));
    h.advance(14999);
    expect(claimMaster("tab-a", h.ports)).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it("距租约写入 15000ms（恰好到期）→ 被抢占（与租约时长比较，不是「有租约就静默」）", () => {
    const h = harness(JSON.stringify({ id: "tab-b", ts: 1000 }));
    h.advance(15000);
    expect(claimMaster("tab-a", h.ports)).toBe(true);
    expect(JSON.parse(h.stored as string).id).toBe("tab-a");
  });

  it("可解析但形状非法（缺 id / ts 非数字 / 数组 / 标量）一律当无租约，抢占并写入", () => {
    for (const raw of [
      JSON.stringify({ ts: 1000 }),
      JSON.stringify({ id: "x", ts: "1" }),
      "[]",
      '"s"',
      JSON.stringify(null),
    ]) {
      const h = harness(raw);
      expect(claimMaster("tab-a", h.ports), raw).toBe(true);
      expect(h.writes, raw).toHaveLength(1);
    }
  });

  it("不可解析的 JSON 走异常路径放行，且不写租约（既有语义：宁重复提醒也不写坏存储）", () => {
    const h = harness("{oops");
    expect(claimMaster("tab-a", h.ports)).toBe(true);
    expect(h.writes).toEqual([]);
  });

  it("storage 读写抛错时放行（宁可在多标签下重复提醒，也不要彻底不提醒）", () => {
    const thrower = {
      now: () => 1,
      read: () => {
        throw new Error("denied");
      },
      write: () => {
        throw new Error("denied");
      },
    };
    expect(claimMaster("tab-a", thrower)).toBe(true);
  });

  it("storage 键是跨标签共享的那一个", () => {
    expect(MASTER_KEY).toBe("dsh-notifier:master");
  });

  it("MASTER_LEASE_MS 是字面量锚（防静默漂移，不是行为判据）", () => {
    // 行为用例都把常量当输入喂进去，改这个数字不会红；这条锚让「改数字」必须在测试里显式改一次。
    expect(MASTER_LEASE_MS).toBe(15000);
  });
});
