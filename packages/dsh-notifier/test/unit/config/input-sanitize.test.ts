/**
 * dsh-notifier config input sanitizeSettings 自然块。
 */
import { describe, expect, it } from "vitest";

import { sanitizeSettings } from "../../../src/server/config/impl/input/index.ts";
import { stored } from "./input-input-support.ts";

describe("sanitizeSettings：只留认识的键，且不归一化", () => {
  it("陌生键被剔除而不是拒绝（配置文件与别的工具共享，但它不该被带进用户层再写回去）", () => {
    const kept = sanitizeSettings({ notifyAsk: false, futureKey: { a: 1 }, another: "x" });
    expect(Object.keys(kept)).toEqual(["notifyAsk"]);
    expect(kept.notifyAsk).toBe(false);
  });

  it("值原样带出，不在这里归一化（顺手归一化会让写路径把用户的原始提交偷偷改写掉）", () => {
    const kept = sanitizeSettings({ notifyAsk: "yes", historyMaxAgeDays: -5 });
    expect(kept.notifyAsk).toBe("yes");
    expect(kept.historyMaxAgeDays).toBe(-5);
  });

  it("没有可认识的键时得到空设置：陌生键被剔除、输入根本不是对象（空值走到索引取值会直接抛），两条路对调用方是同一件事", () => {
    expect(sanitizeSettings({ a: 1, b: [2] })).toEqual({});
    for (const value of [null, undefined, [], "notifyAsk", 3, true]) {
      expect(sanitizeSettings(stored(value)), String(value)).toEqual({});
    }
  });
});

// ---------------------------------------------------------------- #1016 S2：判据对象 = 合并后的条目
//
// 写面把 channels 改成按字段合并之后，判据问的问题也换了：不再是「提交上来的这条合不合法」，
// 而是「**这次写真正要落盘的那条**合不合法」。两者在存量有非法值时给出相反的结论，而后者才是
// 用户要的——磁盘上一份越界的旧配置不该让他此后改个名字都存不下去。
//
// 判据据此多收一个面：inherited（该条目里哪些字段的值原样来自存量）。清单里的字段不重判值域，
// 但**形状**判据（必填键、内置在场）一条都不让——删掉一个必填键的后果与它是不是本次改动无关。
// 服务端那一半（端到端、含真实落盘）在 test/unit/config/service.test.ts 的「按字段合并」块。
