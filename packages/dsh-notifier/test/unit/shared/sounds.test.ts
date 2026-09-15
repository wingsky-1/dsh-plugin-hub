/**
 * dsh-notifier src/shared —— 内置音色白名单（两端共享面）的直连判据。
 *
 * 这一层是跨端契约的定义处：宿主端写入口径与客户端设置页的选项读同一份白名单，
 * 断言因此盯住「值 + 顺序 + 与音色表的关系」，而不只是「有个数组」。
 */
import { describe, expect, it } from "vitest";

import { FOLLOW_SYSTEM_TONE, SOUND_IDS, TONES, isSoundId } from "../../../src/shared/interface.ts";
import type { SoundId } from "../../../src/shared/interface.ts";

describe("SOUND_IDS：内置音色白名单", () => {
  it("取值与顺序逐项钉住（顺序即设置页展示顺序）", () => {
    expect([...SOUND_IDS]).toEqual(["ding", "bell", "chime", "pop"]);
  });

  // G2：白名单 ⊆ 音色表，且每个白名单音色都有音符。缺口是「新增配置音色而漏 TONES」：
  // 只看 TONES 的旧断言在那种改法下是绿的，而用户会选到一个没有音符、放不出声的音色。
  it("SOUND_IDS ⊆ Object.keys(TONES)，且每个音色的 notes 非空", () => {
    for (const id of SOUND_IDS) {
      expect(Object.hasOwn(TONES, id), "TONES 缺 " + id).toBe(true);
      expect(TONES[id]?.notes.length, id + " 没有音符").toBeGreaterThan(0);
    }
    // 反向不要求相等：TONES 还含「跟随系统默认音」这类不在设置白名单里的键。
    // 条数是锚：白名单为空时上面的 for 会空转成假绿，故这里钉死真实条数（取值与顺序另由
    // 上一用例的 toEqual 钉住），新增或删除音色必须显式改这个数字。
    expect(SOUND_IDS.length).toBe(4);
  });

  it("「跟随系统默认」不占白名单位：它只在音色表里", () => {
    expect(SOUND_IDS).not.toContain(FOLLOW_SYSTEM_TONE);
    expect(Object.hasOwn(TONES, FOLLOW_SYSTEM_TONE)).toBe(true);
  });

  it("isSoundId 只认白名单里的字面量（大小写、空白、未知音色、非字符串一律判否）", () => {
    for (const id of SOUND_IDS) expect(isSoundId(id), id).toBe(true);
    const rejected = [
      "Ding",
      "ding ",
      " chime",
      "chime2",
      FOLLOW_SYSTEM_TONE,
      "",
      "toString",
      42,
      true,
      null,
      {},
      [],
    ];
    for (const value of rejected) {
      expect(isSoundId(value), String(value)).toBe(false);
    }
  });

  it("类型面与值面同源：SoundId 的成员都在白名单里", () => {
    const typed: SoundId = "bell";
    expect(SOUND_IDS).toContain(typed);
  });
});
