/**
 * dsh-notifier —— 一次失败请求的可操作结论（#769）。
 *
 * 为什么这些判据只能在这里守：判定要同时伺候新旧两种宿主——新宿主的围栏拒答体带 `code`/`status`，
 * 旧宿主只有 `HTTP 403` 这种 message。判定顺序一旦写反（比如先看文案、或把结构化字段当唯一来源），
 * 症状是「局域网直连的引导没了」而不是任何一处报错：服务端的用例看不见客户端，客户端的产物契约
 * 也看不见它。故这里把顺序逐条钉住，并覆盖畸形输入（null / 缺字段 / 类型不对）不抛。
 */
import { describe, expect, it } from "vitest";

import { REFUSAL_CODES } from "../../src/shared/interface.ts";
import { apiFailureOf, markHttpFailure } from "../../src/client/api-error.ts";
import type { NotifierLocaleKey } from "../../src/client/locales.ts";
import { en, zh } from "../../src/client/locales.ts";

/** 翻译函数桩：断言取的是哪个 key，而不是去对一句会变的文案。 */
const t = (key: string): string => "T:" + key;

describe("apiFailureOf：结构化优先、状态码与文案兜底", () => {
  it("线上取值与宿主端逐字一致（改名即断掉两端共享的那份闭集）", () => {
    expect(REFUSAL_CODES.FORBIDDEN_LOOPBACK).toBe("FORBIDDEN_LOOPBACK");
    expect(REFUSAL_CODES.METHOD_NOT_ALLOWED).toBe("METHOD_NOT_ALLOWED");
  });

  it("结构化 code 命中：只给 code、没有 status、文案里也没有 403，仍判出回环围栏并给引导", () => {
    const failure = apiFailureOf(
      { code: REFUSAL_CODES.FORBIDDEN_LOOPBACK, message: "forbidden: loopback-only" },
      t,
    );
    expect(failure).toEqual({
      refused: true,
      hint: "T:lanAccessHint",
      message: "forbidden: loopback-only",
    });
  });

  it("结构化 status 命中：只挂 status=403（未带 code）也认回环围栏", () => {
    const failure = apiFailureOf({ status: 403, message: "boom" }, t);
    expect(failure).toEqual({ refused: true, hint: "T:lanAccessHint", message: "boom" });
  });

  it("旧宿主兜底：只有 message 里的 HTTP 403（Error 与裸字符串两种形态）", () => {
    expect(apiFailureOf(new Error("HTTP 403"), t)).toEqual({
      refused: true,
      hint: "T:lanAccessHint",
      message: "HTTP 403",
    });
    expect(apiFailureOf("HTTP 403", t)).toEqual({
      refused: true,
      hint: "T:lanAccessHint",
      message: "HTTP 403",
    });
  });

  it("结构化字段优先于文案：METHOD_NOT_ALLOWED 即使 status/文案是 403 也不给局域网引导", () => {
    const failure = apiFailureOf(
      { code: REFUSAL_CODES.METHOD_NOT_ALLOWED, status: 403, message: "HTTP 403" },
      t,
    );
    expect(failure).toEqual({ refused: true, hint: "", message: "HTTP 403" });
  });

  it("非围栏失败：空引导，message 原样交出", () => {
    expect(apiFailureOf(new Error("HTTP 500"), t)).toEqual({
      refused: false,
      hint: "",
      message: "HTTP 500",
    });
    expect(apiFailureOf(new Error("boom"), t)).toEqual({
      refused: false,
      hint: "",
      message: "boom",
    });
  });

  it("畸形输入不抛：null / 缺字段 / 类型不对一律判成「不是围栏拒答」", () => {
    expect(apiFailureOf(null, t)).toEqual({ refused: false, hint: "", message: "" });
    expect(apiFailureOf(undefined, t)).toEqual({ refused: false, hint: "", message: "" });
    expect(apiFailureOf({}, t)).toEqual({ refused: false, hint: "", message: "[object Object]" });
    // 类型不对的字段不参与判定：数字形态的 403 不是契约里那条结构化事实
    expect(apiFailureOf({ code: 403, status: "403", message: 42 }, t)).toEqual({
      refused: false,
      hint: "",
      message: "[object Object]",
    });
  });

  it("响应体形态的输入：围栏体的裸字符串 error 与端点失败体的嵌套 error 都能取出展示正文", () => {
    expect(
      apiFailureOf(
        { error: "forbidden: loopback-only", code: REFUSAL_CODES.FORBIDDEN_LOOPBACK, status: 403 },
        t,
      ),
    ).toEqual({ refused: true, hint: "T:lanAccessHint", message: "forbidden: loopback-only" });
    expect(
      apiFailureOf({ ok: false, error: { code: "not-found", details: "未注册的动态种类" } }, t),
    ).toEqual({ refused: false, hint: "", message: "未注册的动态种类" });
  });

  it("引导文案的 key 在 zh/en 字典里都在，且判定给出的就是这条文案", () => {
    expect(zh.lanAccessHint).toBeTypeOf("string");
    expect(zh.lanAccessHint).not.toBe("");
    expect(en.lanAccessHint).toBeTypeOf("string");
    expect(en.lanAccessHint).not.toBe("");
    // 把 key 与判定连起来：用字典本身当翻译函数，判定给出的引导必须**等于字典里那一条**。
    // 判定侧换成别的 key、或退化成恒等实现，这里都红——而原来那条断的是本文件 :16 的
    // T: 前缀桩，等于断自己传进去的东西，写成什么都绿。
    const zhT = (key: NotifierLocaleKey): string => zh[key];
    expect(apiFailureOf({ code: REFUSAL_CODES.FORBIDDEN_LOOPBACK }, zhT).hint).toBe(
      zh.lanAccessHint,
    );
    expect(apiFailureOf({ status: 403, message: "boom" }, zhT).hint).toBe(zh.lanAccessHint);
  });
});

describe("markHttpFailure：结构化字段必须真的挂到 Error 上", () => {
  it("围栏拒答体是平铺的 {error, code, status}：code 与 status 都挂上，断言能走通到判定", () => {
    const error = markHttpFailure(new Error("HTTP 403"), 403, {
      error: "forbidden: loopback-only",
      code: REFUSAL_CODES.FORBIDDEN_LOOPBACK,
      status: 403,
    });
    expect(error.code).toBe(REFUSAL_CODES.FORBIDDEN_LOOPBACK);
    expect(error.status).toBe(403);
    // 文案不因新增字段而变：旧宿主的状态码兜底仍读得到
    expect(error.message).toBe("HTTP 403");
    // 端到端：挂载后的错误必须真的判出回环围栏（漏挂字段时这条会红）
    expect(apiFailureOf(error, t)).toEqual({
      refused: true,
      hint: "T:lanAccessHint",
      message: "HTTP 403",
    });
  });

  it("端点失败体把 code 嵌在 error 里，status 取响应码（409 冲突不是围栏拒答）", () => {
    const error = markHttpFailure(new Error("版本冲突"), 409, {
      ok: false,
      error: { error: "版本冲突", code: "SETTINGS_CONFLICT" },
    });
    expect(error.code).toBe("SETTINGS_CONFLICT");
    expect(error.status).toBe(409);
    expect(apiFailureOf(error, t)).toEqual({
      refused: false,
      hint: "",
      message: "版本冲突",
    });
  });

  it("body 形状认不出（裸字符串 / null）不抛：只挂得到响应码，兜底路径照旧成立", () => {
    const bare = markHttpFailure(new Error("HTTP 403"), 403, "forbidden: loopback-only");
    expect(bare.code).toBeUndefined();
    expect(bare.status).toBe(403);
    expect(apiFailureOf(bare, t).hint).toBe("T:lanAccessHint");

    const nothing = markHttpFailure(new Error("HTTP 500"), 500, null);
    expect(nothing.code).toBeUndefined();
    expect(nothing.status).toBe(500);
    expect(apiFailureOf(nothing, t)).toEqual({ refused: false, hint: "", message: "HTTP 500" });
  });

  it("非字符串 code 不当契约读（畸形响应体不污染判定）", () => {
    const error = markHttpFailure(new Error("HTTP 403"), 403, { code: 403, status: "403" });
    expect(error.code).toBeUndefined();
    expect(error.status).toBe(403);
  });

  it("只挂 status、不读响应体：与裸 throw 的判定结论逐字相同（clearHistory 的调用点形态）", () => {
    // DELETE /history 的失败体未必是 JSON，解析它会把一条失败请求变成两条，故那里只挂
    // 状态码。这条判据钉住「挂状态码不改变任何结论」：既证明那处改动行为中性，也拦住
    // 判定侧退化回「只认文案里的 403」——退化了这条会红。
    for (const status of [403, 500]) {
      const bare = new Error("HTTP " + status);
      const marked = markHttpFailure(new Error("HTTP " + status), status);
      expect(marked.code).toBeUndefined();
      expect(marked.status).toBe(status);
      expect(apiFailureOf(marked, t)).toEqual(apiFailureOf(bare, t));
    }
  });
});
