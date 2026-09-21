/** 工具契约硬核：双缺省/空串/空数组400 + 全员显式带题 + 互斥/255/中文结构化错误（全离线）。
 *
 * 守的是 validateDecideArgs + decide 校验面：把任一规则改松（例如免 override、
 * 255 改 256），本文件必红。模板零考题，全员 questions_override 必填。fetch 经注入计数，落盘无（纯函数面）。
 */
import { describe, expect, it } from "vitest";
import { decide } from "../../src/server/tools/impl/service.ts";
import { validateDecideArgs } from "../../src/server/tools/impl/validate.ts";
import type { DecideDeps } from "../../src/server/tools/deps.ts";

const CONNECTION = {
  timeoutMs: 8000,
  maxConcurrency: 4,
  truncBudget: 32000,
  hasPlaintextKey: false,
} as const;

function baseDeps(over: Partial<DecideDeps> = {}): DecideDeps {
  return {
    logger: { warn: () => {} },
    connection: { ...CONNECTION },
    isEnabled: () => true,
    capOf: () => 2,
    resolveKey: () => ({ key: "Abcdefgh12345678", source: "env" as const }),
    root: "/tmp/proj",
    sessionId: "sess-1",
    ...over,
  };
}

function choiceQuestion(
  id: string,
  text = "Q?",
): {
  readonly id: string;
  readonly text: string;
  readonly kind: "choice";
  readonly options: readonly string[];
} {
  return { id, text, kind: "choice" as const, options: ["A", "B"] };
}

describe("双缺省/空串/空数组 400", () => {
  it("args 非对象即 BAD_ARGS", () => {
    for (const bad of [null, 42, "x", []]) {
      const r = validateDecideArgs(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.errorCode).toBe("BAD_ARGS");
    }
  });
  it("preset 缺省/空串即 MISSING_PRESET", () => {
    const missing = validateDecideArgs({ state: { text: "x", lang: "en" } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.failure.errorCode).toBe("MISSING_PRESET");
    const empty = validateDecideArgs({ preset_id: "", state: { text: "x", lang: "en" } });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.failure.errorCode).toBe("MISSING_PRESET");
  });
  it("state 缺省/非对象/空串即 MISSING_STATE/EMPTY_TEXT", () => {
    const noState = validateDecideArgs({ preset_id: "general" });
    expect(noState.ok).toBe(false);
    if (!noState.ok) expect(noState.failure.errorCode).toBe("MISSING_STATE");
    const badState = validateDecideArgs({ preset_id: "general", state: "x" });
    expect(badState.ok).toBe(false);
    const emptyText = validateDecideArgs({ preset_id: "general", state: { text: "", lang: "en" } });
    expect(emptyText.ok).toBe(false);
    if (!emptyText.ok) expect(emptyText.failure.errorCode).toBe("EMPTY_TEXT");
    const nonString = validateDecideArgs({ preset_id: "general", state: { text: 42, lang: "en" } });
    expect(nonString.ok).toBe(false);
  });
  it("custom 缺 override 即 MISSING_OVERRIDE；空数组即 EMPTY_OVERRIDE", () => {
    const missing = validateDecideArgs({ preset_id: "custom", state: { text: "x", lang: "en" } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.failure.errorCode).toBe("MISSING_OVERRIDE");
    const empty = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [],
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.failure.errorCode).toBe("EMPTY_OVERRIDE");
    const emptyNonCustom = validateDecideArgs({
      preset_id: "general",
      state: { text: "x", lang: "en" },
      questions_override: [],
    });
    expect(emptyNonCustom.ok).toBe(false);
    if (!emptyNonCustom.ok) expect(emptyNonCustom.failure.errorCode).toBe("EMPTY_OVERRIDE");
  });
  it("未知预设即 UNKNOWN_PRESET", () => {
    const r = validateDecideArgs({ preset_id: "nope", state: { text: "x", lang: "en" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.errorCode).toBe("UNKNOWN_PRESET");
  });
});

describe("custom 单 present 合法 + appliedSource", () => {
  it("custom 单题即 custom", () => {
    const r = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [choiceQuestion("q1")],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.valid.appliedSource).toBe("custom");
      expect(r.valid.questions).toHaveLength(1);
    }
  });
  it("无 override 即 MISSING_OVERRIDE；显式带题即 override", async () => {
    const tpl = validateDecideArgs({ preset_id: "general", state: { text: "hi", lang: "en" } });
    expect(tpl.ok).toBe(false);
    if (!tpl.ok) expect(tpl.failure.errorCode).toBe("MISSING_OVERRIDE");
    const full = validateDecideArgs({
      preset_id: "general",
      state: { text: "hi", lang: "en" },
      questions_override: [{ id: "choice", text: "Pick?", kind: "choice", options: ["A", "B"] }],
    });
    expect(full.ok).toBe(true);
    if (full.ok) expect(full.valid.appliedSource).toBe("override");
    let calls = 0;
    const out = await decide(
      {
        preset_id: "general",
        state: { text: "hi", lang: "en" },
        questions_override: [{ id: "choice", text: "Pick?", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({
        fetchImpl: async () => {
          calls += 1;
          return { status: 200, text: JSON.stringify({ resultKind: "choice", choice: "A" }) };
        },
      }),
    );
    expect(calls).toBe(1);
    expect(out).toMatchObject({ ok: true, appliedSource: "override" });
  });
  it("任意调用方题目即 override（模板零考题，无等长同 id 约束）", () => {
    const otherId = validateDecideArgs({
      preset_id: "general",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "other", text: "Q?", kind: "choice", options: ["a", "b"] }],
    });
    expect(otherId.ok).toBe(true);
    if (otherId.ok) expect(otherId.valid.appliedSource).toBe("override");
    const twoQuestions = validateDecideArgs({
      preset_id: "general",
      state: { text: "x", lang: "en" },
      questions_override: [
        { id: "q1", text: "Q1", kind: "choice", options: ["A", "B"] },
        { id: "q2", text: "Q2", kind: "score" },
      ],
    });
    expect(twoQuestions.ok).toBe(true);
    if (twoQuestions.ok) expect(twoQuestions.valid.appliedSource).toBe("override");
  });
});

describe("互斥/255/长度/中文 400 结构化", () => {
  it("id 唯一：重复即 DUPLICATE_QUESTION_ID", () => {
    const r = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [
        { id: "q", text: "a", kind: "score" },
        { id: "q", text: "b", kind: "score" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.errorCode).toBe("DUPLICATE_QUESTION_ID");
  });
  it("choice 须 2..10 options；score 禁带 options", () => {
    const noOpts = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "q", text: "a", kind: "choice" }],
    });
    expect(noOpts.ok).toBe(false);
    if (!noOpts.ok) expect(noOpts.failure.errorCode).toBe("BAD_OPTIONS");
    const oneOpt = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "q", text: "a", kind: "choice", options: ["only"] }],
    });
    expect(oneOpt.ok).toBe(false);
    const withOpts = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "q", text: "a", kind: "score", options: ["x"] }],
    });
    expect(withOpts.ok).toBe(false);
    if (!withOpts.ok) expect(withOpts.failure.errorCode).toBe("BAD_OPTIONS");
    const emptyOpt = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "q", text: "a", kind: "choice", options: ["", "b"] }],
    });
    expect(emptyOpt.ok).toBe(false);
  });
  it("单题 255 通过、256 拒收；id 64 通过、65 拒收", () => {
    const ok255 = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "q", text: "y".repeat(255), kind: "score" }],
    });
    expect(ok255.ok).toBe(true);
    const bad256 = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "q", text: "y".repeat(256), kind: "score" }],
    });
    expect(bad256.ok).toBe(false);
    if (!bad256.ok) expect(bad256.failure.errorCode).toBe("BAD_QUESTION_TEXT");
    const okId = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "a".repeat(64), text: "t", kind: "score" }],
    });
    expect(okId.ok).toBe(true);
    const badId = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "a".repeat(65), text: "t", kind: "score" }],
    });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.failure.errorCode).toBe("BAD_QUESTION_ID");
  });
  it("总数 20 通过、21 拒收", () => {
    const twenty: unknown[] = [];
    for (let i = 0; i < 20; i += 1) twenty.push({ id: "q" + String(i), text: "t", kind: "score" });
    expect(
      validateDecideArgs({
        preset_id: "custom",
        state: { text: "x", lang: "en" },
        questions_override: twenty,
      }).ok,
    ).toBe(true);
    const twentyOne: unknown[] = [...twenty, { id: "qx", text: "t", kind: "score" }];
    const r = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: twentyOne,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.errorCode).toBe("TOO_MANY_QUESTIONS");
  });
  it("中文 id 400；正文中文合法；kind 非法 400", () => {
    const badPreset = validateDecideArgs({ preset_id: "通用", state: { text: "x", lang: "zh" } });
    expect(badPreset.ok).toBe(false);
    if (!badPreset.ok) expect(badPreset.failure.errorCode).toBe("BAD_PRESET_ID");
    const badQ = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "题", text: "t", kind: "score" }],
    });
    expect(badQ.ok).toBe(false);
    if (!badQ.ok) expect(badQ.failure.errorCode).toBe("BAD_QUESTION_ID");
    const zhBody = validateDecideArgs({
      preset_id: "general",
      state: { text: "中文正文", lang: "zh" },
      questions_override: [{ id: "q1", text: "选一个。", kind: "choice", options: ["甲", "乙"] }],
    });
    expect(zhBody.ok).toBe(true);
    const badKind = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "q", text: "t", kind: "rank" }],
    });
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.failure.errorCode).toBe("BAD_QUESTION_KIND");
  });
  it("lang 无缺省：缺省/fr 400；en/zh/unknown 通过", () => {
    expect(validateDecideArgs({ preset_id: "general", state: { text: "x" } }).ok).toBe(false);
    const fr = validateDecideArgs({ preset_id: "general", state: { text: "x", lang: "fr" } });
    expect(fr.ok).toBe(false);
    if (!fr.ok) expect(fr.failure.errorCode).toBe("BAD_LANG");
    for (const lang of ["en", "zh", "unknown"]) {
      expect(
        validateDecideArgs({
          preset_id: "general",
          state: { text: "x", lang },
          questions_override: [{ id: "q1", text: "Q?", kind: "score" }],
        }).ok,
      ).toBe(true);
    }
  });
  it("decide 校验失败即结构化包络（含 errorCode+category，无概率字段，不触网）", async () => {
    let calls = 0;
    const out = await decide(
      { preset_id: "general", state: { text: "", lang: "en" } },
      baseDeps({
        fetchImpl: async () => {
          calls += 1;
          return { status: 200, text: "{}" };
        },
      }),
    );
    expect(calls).toBe(0);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.errorCode).toBe("EMPTY_TEXT");
      expect(out.error.category).toBe("bad-request");
      expect(typeof out.error.message).toBe("string");
      expect("choice" in out).toBe(false);
      expect("score" in out).toBe(false);
      expect("confidence" in out).toBe(false);
      expect("tier" in out).toBe(false);
    }
  });
});
