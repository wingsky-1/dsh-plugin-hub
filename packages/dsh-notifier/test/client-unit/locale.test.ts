/**
 * dsh-notifier — 文案绑定的判据（#769 阶段 3）。
 *
 * 绑定状态必须能被 apply 期与 locale 订阅回调重绑，而调用点全文共用同一个 t。
 * 这两件事以前靠一个模块级 var 实现（无判据）；现在收进 locale.ts 的 const 容器，可直测。
 *
 * 「未装配时回落 key 本体」不在这里断：绑定一旦被重绑就回不去，本文件每条用例都要先绑一次，
 * 所以那条判据在 locale-fallback.test.ts（单独文件才拿得到未被动过的模块初值）。
 */
import { describe, expect, it } from "vitest";

import { bindTranslate, t, type Translate } from "../../src/client/locale.ts";

describe("文案绑定", () => {
  it("装配后走当前绑定，并把参数透传下去", () => {
    const calls: Array<{ key: string; params: unknown }> = [];
    const bound: Translate = (key, params) => {
      calls.push({ key, params });
      return "译:" + key;
    };
    bindTranslate(bound);
    expect(t("savedOk")).toBe("译:savedOk");
    expect(t("cleared", { n: 3 })).toBe("译:cleared");
    expect(calls[1]).toEqual({ key: "cleared", params: { n: 3 } });
  });

  it("重绑立即生效（切语言的订阅回调走的就是这条路径）", () => {
    bindTranslate((key) => "zh:" + key);
    expect(t("save")).toBe("zh:save");
    bindTranslate((key) => "en:" + key);
    expect(t("save")).toBe("en:save");
  });
});
