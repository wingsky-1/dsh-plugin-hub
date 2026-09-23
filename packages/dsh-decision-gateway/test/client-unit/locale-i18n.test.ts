/** dsh-decision-gateway 中英双语锁（node 直跑，零 DOM）。
 *
 * 守的是 locales.ts 双语平衡 + locale.ts 语言判定：
 * en 缺 key（编译期 Record 已锁，运行时再锁一遍防绕行）、resolveLang 误判、
 * capLabel 的 none 档未跟语言走，任一改动本文件必红。
 * frozen 出题规范英文原文与服务端动态值不进字典（数据不翻译）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { capLabel } from "../../src/client/api/contract.ts";
import {
  bindTranslate,
  lang,
  resolveLang,
  setLang,
  t,
  unbindTranslate,
} from "../../src/client/locale.ts";
import { en, zh } from "../../src/client/locales.ts";

afterEach(() => {
  unbindTranslate();
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
  it("navigator 属性缺席即英文（真删除全局键，非空转）", () => {
    // 上一条在 Node 下空转（全局只读 navigator 恒存在）：本例真删除该键，
    // 覆盖 nav?.language 的 OptionalChaining 分支（去问号即抛错打红）。
    const prev = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
      delete (globalThis as unknown as Record<string, unknown>).navigator;
      expect("navigator" in globalThis).toBe(false);
      expect(resolveLang()).toBe("en");
    } finally {
      if (prev !== undefined) Object.defineProperty(globalThis, "navigator", prev);
    }
    expect("navigator" in globalThis).toBe(true);
  });
  it("navigator.language 逐形态判定（大小写不敏感；缺键/非串回落英文）", () => {
    // Node 24 全局自带只读 navigator（getter 无 setter）：直接赋值抛，须 defineProperty
    // 打桩并按描述符原样恢复（用完即弃，不污染其他用例）。
    const prev = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const stub = (value: unknown): void => {
      Object.defineProperty(globalThis, "navigator", {
        value,
        configurable: true,
        writable: true,
      });
    };
    try {
      stub({ language: "zh-CN" });
      expect(resolveLang()).toBe("zh");
      stub({ language: "ZH-HK" });
      expect(resolveLang()).toBe("zh");
      stub({ language: "en-US" });
      expect(resolveLang()).toBe("en");
      stub({});
      expect(resolveLang()).toBe("en");
      stub({ language: 42 });
      expect(resolveLang()).toBe("en");
    } finally {
      if (prev === undefined) delete (globalThis as unknown as Record<string, unknown>).navigator;
      else Object.defineProperty(globalThis, "navigator", prev);
    }
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

describe("宿主绑定（bindTranslate / unbindTranslate）", () => {
  it("装配后 t 走宿主实现并透传 {n}（无参传 undefined）", () => {
    const calls: Array<{ readonly key: string; readonly params?: unknown }> = [];
    bindTranslate((key, params) => {
      calls.push({ key, params });
      return `H:${key}:${JSON.stringify(params ?? null)}`;
    });
    expect(t("save")).toBe("H:save:null");
    expect(t("countEntries", { n: 3 })).toBe('H:countEntries:{"n":3}');
    expect(calls).toEqual([
      { key: "save", params: undefined },
      { key: "countEntries", params: { n: 3 } },
    ]);
  });
  it("unbind 后回落本地字典（宿主实现不再被调）", () => {
    let hostCalls = 0;
    bindTranslate(() => {
      hostCalls += 1;
      return "HOST";
    });
    expect(t("save")).toBe("HOST");
    unbindTranslate();
    setLang("zh");
    expect(t("save")).toBe("保存");
    expect(t("detail")).toBe("详情");
    expect(hostCalls).toBe(1);
  });
  it("capLabel 经宿主绑定跟语言走", () => {
    bindTranslate((key) => `HOST:${key}`);
    expect(capLabel(0)).toBe("HOST:capNone");
    expect(capLabel(2)).toBe("high");
  });
  it("装配非函数被忽略：t 回落本地字典且永不抛", () => {
    bindTranslate(undefined as never);
    setLang("zh");
    expect(t("save")).toBe("保存");
    expect(t("countEntries", { n: 2 })).toBe("共 2 条");
    bindTranslate(null as never);
    setLang("en");
    expect(t("save")).toBe("Save");
  });
});
