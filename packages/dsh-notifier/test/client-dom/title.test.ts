// @vitest-environment happy-dom
//
// 环境声明必须落在文件里，不能只靠 vitest.config.ts 的 client-dom project：变异面按拓扑派生的是
// 单 project node 环境配置（vitest.stryker.d/*.config.ts），本层要进变异面就得自带环境。
/**
 * dsh-notifier — 标题闪烁对真实 document.title 的判据（#769 的 happy-dom 层）。
 *
 * 为什么另立一层：createTitleFlasher 的纯语义已由 test/client-unit/notify-title.test.ts 用假
 * document 钉住，但那份假件把 ports.get / ports.set 换成了普通字段——模块导出的 titleFlasher
 * 单例有没有真的接上本页的 document.title，假件里断不出来。这一层在真实 happy-dom document 上
 * 走完整链路，故只留「接线」相关的判据：逻辑判据两层重复只会让同一次语义改动要改两处，
 * 而两层都进变异面、杀的是同一批变异体，重复的那部分不增加任何杀灭贡献。
 *
 * 状态纪律：titleFlasher 是模块级单例（恢复缓存跨调用共享），每个用例前后都要 restore 并重置
 * document.title，否则上一个用例的「已闪烁」状态会串进下一个。归属判定已由 client-unit 层
 * 覆盖，这里全部用同一枚归属令牌模拟「同一个实例」。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { titleFlasher } from "../../src/client/notify/title.ts";

/** 本层只跑单实例链路，归属令牌固定一枚。 */
const owner: object = {};

beforeEach(() => {
  titleFlasher.restore(owner);
  document.title = "DSH";
});

afterEach(() => {
  titleFlasher.restore(owner);
});

describe("titleFlasher：读写真实 document.title", () => {
  it("flash 把 document.title 换成带铃铛的标题", () => {
    titleFlasher.flash("任务完成", owner);

    expect(document.title).toBe("🔔 任务完成");
  });

  it("restore 把 document.title 还原成闪烁前的原文（get 取的是真实标题）", () => {
    document.title = "DSH — 会话 7";

    titleFlasher.flash("任务完成", owner);
    titleFlasher.restore(owner);

    expect(document.title).toBe("DSH — 会话 7");
  });

  // 「连续闪烁只记第一次的原文」「未闪烁时 restore 幂等」不在这里重复：它们断的是
  // createTitleFlasher 的逻辑，假件同样断得出来，已由 test/client-unit/notify-title.test.ts
  // 逐条覆盖。本层留下的是假件做不到的那部分——单例接线与真实 document 上的取值时机。
  it("还原后再闪烁会重新取当时的标题：外部改过标题也不还原成陈旧值", () => {
    titleFlasher.flash("第一次", owner);
    titleFlasher.restore(owner);

    document.title = "DSH 2";
    titleFlasher.flash("第二次", owner);
    titleFlasher.restore(owner);

    expect(document.title).toBe("DSH 2");
  });
});
