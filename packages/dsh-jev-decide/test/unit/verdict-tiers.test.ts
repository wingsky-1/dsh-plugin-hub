/** Noul/Score 分段与失败包络：tier 置空、confidence 派生分层、score 浮点取整、失败无概率字段（全离线 fetch 注入）。
 *
 * 守的是 service.tierOf/automationOf + client 置信派生与 score 映射：把 Noul 置空删掉、
 * 阈值改动、取整改成截断、失败包络带上 confidence，本文件必红。
 */
import { describe, expect, it } from "vitest";
import { mapFirstAnswer, toWireQuestions } from "../../src/server/tools/impl/client.ts";
import { decide } from "../../src/server/tools/impl/service.ts";
import type { DecideDeps } from "../../src/server/tools/deps.ts";
import { truncateCodePoints } from "../../src/shared/contract.ts";

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

function okFetch(body: unknown): DecideDeps["fetchImpl"] {
  return async () => ({ status: 200, text: JSON.stringify(body) });
}

/** 官方答案体（题 id 与调用一致；choice 置信直给，score 浮点）。 */
function sdkAnswer(id: string, answer: unknown): unknown {
  return {
    model: "jev-1.13.0",
    answers: { [id]: answer },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function sdkChoice(id: string, choice: string, confidence: number): unknown {
  return sdkAnswer(id, {
    type: "choice",
    choice,
    confidence,
    probabilities: { [choice]: confidence },
  });
}

function sdkScore(id: string, score: unknown, confidence = 0.5): unknown {
  return sdkAnswer(id, { type: "score", score, confidence });
}

describe("Noul 置空 tier", () => {
  it("choice Noul 即 tier none + automation manual（上游 tier 高也置空）", async () => {
    const out = await decide(
      {
        preset_id: "general",
        state: { text: "hello", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({
        fetchImpl: okFetch(sdkChoice("q1", "Noul", 0.9)),
      }),
    );
    expect(out).toMatchObject({ ok: true, tier: "none", automation: "manual" });
    if (out.ok) {
      expect(out.choice).toBe("Noul");
      expect(out.provider).toBe("official");
    }
  });
  it("非 Noul 按置信派生：0.9 high/auto、0.7 low/assisted、0.3 none/manual", async () => {
    const high = await decide(
      {
        preset_id: "general",
        state: { text: "h", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({
        fetchImpl: okFetch(sdkChoice("q1", "A", 0.9)),
      }),
    );
    expect(high).toMatchObject({ ok: true, tier: "high", automation: "auto" });
    const low = await decide(
      {
        preset_id: "general",
        state: { text: "h", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({
        fetchImpl: okFetch(sdkChoice("q1", "A", 0.7)),
      }),
    );
    expect(low).toMatchObject({ ok: true, tier: "low", automation: "assisted" });
    const none = await decide(
      {
        preset_id: "general",
        state: { text: "h", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({
        fetchImpl: okFetch(sdkChoice("q1", "A", 0.3)),
      }),
    );
    expect(none).toMatchObject({ ok: true, tier: "none", automation: "manual" });
  });
  it("automationCap 封顶：cap 0 即使上游 high 也 none/manual", async () => {
    const out = await decide(
      {
        preset_id: "general",
        state: { text: "h", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({
        capOf: () => 0,
        fetchImpl: okFetch(sdkChoice("q1", "A", 0.9)),
      }),
    );
    expect(out).toMatchObject({ ok: true, tier: "none", automation: "manual" });
  });
  it("automationCap 封顶：cap 1 时上游 high 压为 low/assisted（R6）", async () => {
    const out = await decide(
      {
        preset_id: "plan-review",
        state: { text: "h", lang: "en" },
        questions_override: [{ id: "q1", text: "Rate it.", kind: "score" }],
      },
      baseDeps({
        capOf: () => 1,
        fetchImpl: okFetch(sdkChoice("q1", "A", 0.9)),
      }),
    );
    expect(out).toMatchObject({ ok: true, tier: "low", automation: "assisted" });
  });
});

describe("Score 浮点取整映射（SDK 0-based legend，按档数重缩放到 1..5）", () => {
  it("自带两档：SDK 0.5 即旧口径 3（除数 n-1=1）", async () => {
    const out = await decide(
      {
        preset_id: "custom",
        state: { text: "hello", lang: "en" },
        questions_override: [{ id: "q1", text: "Rate it.", kind: "score", levels: ["低", "高"] }],
      },
      baseDeps({
        fetchImpl: okFetch(sdkScore("q1", 0.5, 0.6)),
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.score).toBe(3);
  });
  it("自带三档：SDK 1.5 即旧口径 4", async () => {
    const out = await decide(
      {
        preset_id: "custom",
        state: { text: "hello", lang: "en" },
        questions_override: [
          { id: "q1", text: "Rate it.", kind: "score", levels: ["差", "良", "优"] },
        ],
      },
      baseDeps({
        fetchImpl: okFetch(sdkScore("q1", 1.5, 0.6)),
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.score).toBe(4);
  });
  it.each([
    [0.2, 1],
    [1.7, 3],
    [3.8, 5],
  ])("SDK score %f 即旧口径 %i", async (raw, mapped) => {
    const out = await decide(
      {
        preset_id: "plan-review",
        state: { text: "hello", lang: "en" },
        questions_override: [{ id: "q1", text: "Rate it.", kind: "score" }],
      },
      baseDeps({
        fetchImpl: okFetch(sdkScore("q1", raw, 0.6)),
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.score).toBe(mapped);
      expect(out.resultKind).toBe("score");
    }
  });
  it("score 缺席/字符串即 UPSTREAM 失败", async () => {
    for (const bad of [sdkScore("q1", undefined), sdkScore("q1", "high")]) {
      const out = await decide(
        {
          preset_id: "plan-review",
          state: { text: "hello", lang: "en" },
          questions_override: [{ id: "q1", text: "Rate it.", kind: "score" }],
        },
        baseDeps({ fetchImpl: okFetch(bad) }),
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.errorCode).toBe("UPSTREAM");
    }
  });
  it("首题缺席即 bad-payload（多题取首题驱动）", () => {
    const body = {
      model: "jev-latest",
      state: "t",
      questions: toWireQuestions([{ id: "q1", text: "Q?", kind: "choice", options: ["A", "B"] }]),
    };
    const r = mapFirstAnswer(body, {
      model: "jev-1.13.0",
      answers: {},
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(r.ok).toBe(false);
  });
});

describe("失败包络无概率 + errorCode + category", () => {
  it("score 缺失失败：无 choice/score/confidence/tier，有 errorCode+category", async () => {
    const bad = await decide(
      {
        preset_id: "plan-review",
        state: { text: "hello", lang: "en" },
        questions_override: [{ id: "q1", text: "Rate it.", kind: "score" }],
      },
      baseDeps({ fetchImpl: okFetch(sdkScore("q1", undefined)) }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.errorCode).toBe("UPSTREAM");
      expect(typeof bad.error.category).toBe("string");
      expect(bad.error.category.length).toBeGreaterThan(0);
      expect("choice" in bad).toBe(false);
      expect("score" in bad).toBe(false);
      expect("confidence" in bad).toBe(false);
      expect("tier" in bad).toBe(false);
      expect("codepoints" in bad).toBe(false);
    }
  });
  it("上游 400 失败同样无概率字段", async () => {
    const bad = await decide(
      {
        preset_id: "general",
        state: { text: "hi", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({ fetchImpl: async () => ({ status: 400, text: "{}" }) }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.errorCode).toBe("UPSTREAM");
      expect("confidence" in bad).toBe(false);
      expect("tier" in bad).toBe(false);
    }
  });
  it("成功包络必带计费/重试/分层全字段", async () => {
    const out = await decide(
      {
        preset_id: "general",
        state: { text: "hello", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({
        fetchImpl: okFetch(sdkChoice("q1", "A", 0.9)),
      }),
    );
    expect(out).toMatchObject({
      ok: true,
      provider: "official",
      appliedSource: "override",
      truncated: false,
      originalLength: 5,
      tier: "high",
      automation: "auto",
      codepoints: 5,
      retries: 0,
    });
    if (out.ok) {
      expect(typeof out.latencyMs).toBe("number");
      expect(typeof out.confidence).toBe("number");
    }
  });
  it("codepoints 缺席回落原文长度", async () => {
    const out = await decide(
      {
        preset_id: "general",
        state: { text: "abcde", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({ fetchImpl: okFetch(sdkChoice("q1", "A", 0.6)) }),
    );
    expect(out).toMatchObject({ ok: true, codepoints: 5 });
  });
  it("CJK 截断不断字：按 codepoints 切分（R5）", async () => {
    const cut = truncateCodePoints("中文正文测试", 3);
    expect(cut).toMatchObject({ text: "中文正", truncated: true, originalLength: 6 });
    expect(Array.from(cut.text)).toHaveLength(3);
    let wired = "";
    const out = await decide(
      {
        preset_id: "general",
        state: { text: "中文ab", lang: "zh" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({
        connection: { timeoutMs: 8000, maxConcurrency: 4, truncBudget: 2, hasPlaintextKey: false },
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(init.body) as { state: string };
          wired = body.state;
          return { status: 200, text: JSON.stringify(sdkChoice("q1", "A", 0.6)) };
        },
      }),
    );
    expect(out).toMatchObject({ ok: true, truncated: true, originalLength: 4 });
    expect(wired).toBe("中文");
    expect(Array.from(wired)).toHaveLength(2);
  });
  it("截断即 automation 降 suggest-only（打红点：三元删去；tier 保持跟源）", async () => {
    const out = await decide(
      {
        preset_id: "general",
        state: { text: "abcdefghij", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({
        connection: { timeoutMs: 8000, maxConcurrency: 4, truncBudget: 4, hasPlaintextKey: false },
        fetchImpl: okFetch(sdkChoice("q1", "A", 0.85)),
      }),
    );
    expect(out).toMatchObject({
      ok: true,
      truncated: true,
      originalLength: 10,
      tier: "high",
      automation: "suggest-only",
    });
  });
});
