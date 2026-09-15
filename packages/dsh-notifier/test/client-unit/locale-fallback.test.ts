/**
 * dsh-notifier — 未装配 locale 服务时的回落（#769 阶段 3）。
 *
 * 为什么必须单独一个文件：模块级的翻译绑定一旦被 bindTranslate 改过就回不去，而 vitest 的
 * 逐文件隔离恰好给出「还没人动过它」的初始状态（根 vitest.config.ts 显式钉住 isolate: true）。
 * 写在 locale.test.ts 里做不到——那里第一个用例自己先绑了一个恒等桩，于是「回落 key 本体」
 * 只能断到那个桩：把实现里的 fallbackTranslate 换成空函数、或把绑定的初值改掉，用例照绿，
 * 而症状是宿主没有 locale 服务时界面显示空串或直接崩。
 */
import { describe, expect, it } from "vitest";

import { t } from "../../src/client/locale.ts";

describe("未装配 locale 服务", () => {
  // 这条用例的前提是**没有任何人调用过 bindTranslate**：本文件不导入 bindTranslate，也不在
  // 任何 before* 里绑。破坏这个前提，判据就退回成「断自己传进去的桩」。
  it("t 直接回落 key 本体（不依赖任何一次 bindTranslate）", () => {
    expect(t("savedOk")).toBe("savedOk");
    // 参数形态也要吃得下：回落时忽略参数，而不是插值出 undefined
    expect(t("loadFail", { msg: "boom" })).toBe("loadFail");
  });
});
