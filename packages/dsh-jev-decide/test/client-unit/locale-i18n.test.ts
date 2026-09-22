/** dsh-jev-decide 中英双语锁（node 直跑，零 DOM）。
 *
 * 守的是 locales.ts 双语平衡 + locale.ts 语言判定：
 * en 缺 key（编译期 Record 已锁，运行时再锁一遍防绕行）、resolveLang 误判、
 * capLabel 的 none 档未跟语言走，任一改动本文件必红。
 * frozen 出题规范英文原文与服务端动态值不进字典（数据不翻译）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { capLabel } from "../../src/client/api/contract.ts";
import { lang, resolveLang, setLang, t } from "../../src/client/locale.ts";
import { en, zh } from "../../src/client/locales.ts";

afterEach(() => {
  setLang("zh");
});

describe("双语平衡", () => {
  it("en 覆盖 zh 全部 key 且无空串", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(en[key].length).toBeGreaterThan(0);
    }
  });
  it("无 navigator 即英文（与 JEV 英文问答一致）", () => {
    expect(resolveLang()).toBe("en");
  });
});

describe("语言切换", () => {
  it("zh 下取中文；en 下取英文", () => {
    setLang("zh");
    expect(lang()).toBe("zh");
    expect(t("save")).toBe("保存");
    expect(t("detail")).toBe("详情");
    setLang("en");
    expect(t("save")).toBe("Save");
    expect(t("detail")).toBe("Details");
  });
  it("{n} 插值中英语序各自正确", () => {
    setLang("zh");
    expect(t("countEntries", { n: 3 })).toBe("共 3 条");
    expect(t("presetsCount", { n: 5 })).toBe("预设 5 个");
    setLang("en");
    expect(t("countEntries", { n: 3 })).toBe("3 entries");
    expect(t("presetsCount", { n: 5 })).toBe("5 presets");
  });
  it("capLabel 的 none 档跟语言走；high/low 双语同形", () => {
    setLang("zh");
    expect(capLabel(0)).toBe("none（仅人工）");
    setLang("en");
    expect(capLabel(0)).toBe("none (manual only)");
    expect(capLabel(1)).toBe("low");
    expect(capLabel(2)).toBe("high");
  });
});
