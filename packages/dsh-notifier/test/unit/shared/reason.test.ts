/**
 * dsh-notifier shared 域 —— 投递理由的结构化形态（#782 批 1）。
 *
 * 判据面：这一层是**跨端线格式**的定义处，服务端写盘、客户端渲染、升级链割接都读同一份口径。
 * 规范化的容错边界错一格，症状是历史页显示 `undefined`（读太严）或把半截值透传到界面（读太松）。
 */
import { describe, expect, it } from "vitest";

import {
  REASON_LEGACY,
  clampReasonDetail,
  normalizeReason,
  reason,
  reasonFromCause,
  sameReasonShape,
} from "../../../src/server/shared/interface.ts";

describe("reason：生产侧构造", () => {
  it("只写取到的键（缺 params / detail 时不留空壳）", () => {
    expect(reason("reasonSkipConfig")).toEqual({ code: "reasonSkipConfig" });
    expect(reason("reasonBarkHttp", { params: { status: 503 } })).toEqual({
      code: "reasonBarkHttp",
      params: { status: 503 },
    });
    // 空 detail 与没有 detail 是同一件事：界面上都是「没有原文可展开」
    expect(reason("reasonChannelThrew", { detail: "" })).toEqual({ code: "reasonChannelThrew" });
  });

  it("参数只收标量：嵌套值留不下来（文案层不必再判嵌套）", () => {
    // 跨边界值不受编译期约束：用读侧入口喂一个带嵌套参数的对象，验证过滤发生在共享层。
    expect(
      normalizeReason({ code: "reasonBarkHttp", params: { status: 500, nested: { a: 1 } } }),
    ).toEqual({ code: "reasonBarkHttp", params: { status: 500 } });
  });
});

describe("normalizeReason：读侧归一化", () => {
  // 升级前的行、手改的文件都会走到这里：字符串按整句原文收编，不猜它的 code。
  it("散文（字符串）收编成 reasonLegacy + detail", () => {
    expect(normalizeReason("连接超时")).toEqual({ code: REASON_LEGACY, detail: "连接超时" });
    expect(normalizeReason("")).toBeUndefined();
  });

  it("结构化对象只取认识的三个字段（陌生键与非法参数类型都丢掉）", () => {
    expect(
      normalizeReason({
        code: "reasonBarkHttp",
        params: { status: 400, bad: { x: 1 } },
        detail: "boom",
        extra: "不该留下",
      }),
    ).toEqual({ code: "reasonBarkHttp", params: { status: 400 }, detail: "boom" });
  });

  it("读不出的形态一律 undefined：null / 数组 / 没有 code / 空 code", () => {
    expect(normalizeReason(null)).toBeUndefined();
    expect(normalizeReason([])).toBeUndefined();
    expect(normalizeReason(42)).toBeUndefined();
    expect(normalizeReason({})).toBeUndefined();
    expect(normalizeReason({ code: "" })).toBeUndefined();
    expect(normalizeReason({ code: 7 })).toBeUndefined();
  });

  // 认不出的 code 仍然保留：跨版本的数据不该被本版的闭集裁掉，渲染侧对它做中性回退。
  it("不认识的 code 原样保留（读侧开放，闭集只管生产侧）", () => {
    expect(normalizeReason({ code: "reasonFromTheFuture" })).toEqual({
      code: "reasonFromTheFuture",
    });
  });

  it("幂等：归一化过的值再归一化一次逐字不变", () => {
    const once = normalizeReason({ code: "reasonBarkHttp", params: { status: 401 }, detail: "x" });
    expect(normalizeReason(once)).toEqual(once);
  });
});

describe("reasonFromCause / reasonEquals / clampReasonDetail", () => {
  // 抛出物不一定是 Error（跨边界值）：原因若印成 undefined，日志里就只剩「失败」两个字。
  it("reasonFromCause：Error 取 message，非 Error 取 String，都进 detail 且不做主文案", () => {
    expect(reasonFromCause("reasonChannelThrew", new Error("出口实现违约"))).toEqual({
      code: "reasonChannelThrew",
      detail: "出口实现违约",
    });
    expect(reasonFromCause("reasonChannelThrew", "裸抛出物")).toEqual({
      code: "reasonChannelThrew",
      detail: "裸抛出物",
    });
  });

  // 割接用它判「这条已经改过形了」：判松了会反复改写同一行，判成语义等价则割接变空操作。
  it("sameReasonShape：判的是形态不是语义——旧散文与它的收编形态**判不等**（否则割接不生效）", () => {
    const produced = reason("reasonBarkHttp", { params: { status: 401 }, detail: "nope" });
    expect(sameReasonShape(produced, produced)).toBe(true);
    // 同一形态的另一份对象也算（割接重跑不该因为对象身份不同就再写一次盘）
    expect(sameReasonShape({ ...produced }, produced)).toBe(true);
    // params 进判据：只看 code+detail 的旧写法会把「带参数但已割接」的条目再写一次盘
    expect(sameReasonShape({ ...produced, params: { status: 402 } }, produced)).toBe(false);
    expect(sameReasonShape({ code: "reasonBarkHttp", detail: "nope" }, produced)).toBe(false);
    // 关键一格：语义等价但不是同一个形态 —— 必须判不等，否则旧数据永远不会被割接
    expect(sameReasonShape("旧散文", { code: REASON_LEGACY, detail: "旧散文" })).toBe(false);
    expect(
      sameReasonShape(
        { code: REASON_LEGACY, detail: "旧散文" },
        { code: REASON_LEGACY, detail: "旧散文" },
      ),
    ).toBe(true);
    // 字符串、null、数组都不算结构化形态
    expect(sameReasonShape(null, produced)).toBe(false);
    expect(sameReasonShape([], produced)).toBe(false);
  });

  // 截断是展示语义：超长原文不砍会把设置页撑坏，砍错档位会丢掉定位用的尾部。
  it("clampReasonDetail 按码点截断 detail，无 detail 时原样返回同一个对象", () => {
    expect(
      clampReasonDetail({ code: "reasonChannelThrew", detail: "长".repeat(400) }, 300),
    ).toEqual({
      code: "reasonChannelThrew",
      detail: "长".repeat(300),
    });
    const untouched = { code: "reasonSkipConfig" } as const;
    expect(clampReasonDetail(untouched, 300)).toBe(untouched);
    const short = { code: "reasonChannelThrew", detail: "短" } as const;
    expect(clampReasonDetail(short, 300)).toBe(short);
  });
});
