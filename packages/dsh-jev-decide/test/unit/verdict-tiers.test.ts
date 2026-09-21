/** Noul/Score 分段与失败包络：tier 置空、1-5 整形、失败无概率字段（全离线 fetch 注入）。
 *
 * 守的是 service.tierOf/automationOf + client.parseVerdict 的 score 段：把 Noul 置空删掉、
 * score 上限改成 10、失败包络带上 confidence，本文件必红。
 */
import { describe, expect, it } from "vitest";
import { parseVerdict } from "../../src/server/tools/impl/client.ts";
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

describe("Noul 置空 tier", () => {
  it("choice Noul 即 tier none + automation manual（上游 tier 高也置空）", async () => {
    const out = await decide(
      {
        preset_id: "general",
        state: { text: "hello", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({
        fetchImpl: okFetch({
          resultKind: "choice",
          choice: "Noul",
          confidence: 0.9,
          tier: 2,
          automation: 2,
        }),
      }),
    );
    expect(out).toMatchObject({ ok: true, tier: "none", automation: "manual" });
    if (out.ok) {
      expect(out.choice).toBe("Noul");
      expect(out.provider).toBe("official");
    }
  });
  it("非 Noul 按序号映射：2 high/auto、1 low/assisted、0 none/manual", async () => {
    const high = await decide(
      {
        preset_id: "general",
        state: { text: "h", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({
        fetchImpl: okFetch({
          resultKind: "choice",
          choice: "A",
          confidence: 0.7,
          tier: 2,
          automation: 2,
        }),
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
        fetchImpl: okFetch({
          resultKind: "choice",
          choice: "A",
          confidence: 0.7,
          tier: 1,
          automation: 1,
        }),
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
        fetchImpl: okFetch({
          resultKind: "choice",
          choice: "A",
          confidence: 0.7,
          tier: 0,
          automation: 0,
        }),
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
        fetchImpl: okFetch({
          resultKind: "choice",
          choice: "A",
          confidence: 0.8,
          tier: 2,
          automation: 2,
        }),
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
        fetchImpl: okFetch({
          resultKind: "choice",
          choice: "A",
          confidence: 0.8,
          tier: 2,
          automation: 2,
        }),
      }),
    );
    expect(out).toMatchObject({ ok: true, tier: "low", automation: "assisted" });
  });
});

describe("Score 1-5 分段", () => {
  it.each([1, 2, 3, 4, 5])("score %i 合法通过", async (score) => {
    const out = await decide(
      {
        preset_id: "plan-review",
        state: { text: "hello", lang: "en" },
        questions_override: [{ id: "q1", text: "Rate it.", kind: "score" }],
      },
      baseDeps({
        fetchImpl: okFetch({ resultKind: "score", score, confidence: 0.5, tier: 1, automation: 1 }),
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.score).toBe(score);
      expect(out.resultKind).toBe("score");
    }
  });
  it.each([0, 6, 9])("score %i 越界即 UPSTREAM 失败", async (score) => {
    const out = await decide(
      {
        preset_id: "plan-review",
        state: { text: "hello", lang: "en" },
        questions_override: [{ id: "q1", text: "Rate it.", kind: "score" }],
      },
      baseDeps({ fetchImpl: okFetch({ resultKind: "score", score }) }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.errorCode).toBe("UPSTREAM");
  });
  it("score 非整（2.5）即失败", () => {
    expect(parseVerdict(200, JSON.stringify({ resultKind: "score", score: 2.5 })).ok).toBe(false);
  });
  it("score 缺席/字符串即失败", () => {
    expect(parseVerdict(200, JSON.stringify({ resultKind: "score" })).ok).toBe(false);
    expect(parseVerdict(200, JSON.stringify({ resultKind: "score", score: "5" })).ok).toBe(false);
  });
});

describe("失败包络无概率 + errorCode + category", () => {
  it("score 越界失败：无 choice/score/confidence/tier，有 errorCode+category", async () => {
    const bad = await decide(
      {
        preset_id: "plan-review",
        state: { text: "hello", lang: "en" },
        questions_override: [{ id: "q1", text: "Rate it.", kind: "score" }],
      },
      baseDeps({ fetchImpl: okFetch({ resultKind: "score", score: 9 }) }),
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
        fetchImpl: okFetch({
          resultKind: "choice",
          choice: "A",
          confidence: 0.7,
          tier: 2,
          automation: 2,
          codepoints: 42,
        }),
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
      codepoints: 42,
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
      baseDeps({ fetchImpl: okFetch({ resultKind: "choice", choice: "A" }) }),
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
          const body = JSON.parse(init.body) as { state: { text: string } };
          wired = body.state.text;
          return { status: 200, text: JSON.stringify({ resultKind: "choice", choice: "A" }) };
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
        fetchImpl: okFetch({
          resultKind: "choice",
          choice: "A",
          confidence: 0.8,
          tier: 2,
          automation: 2,
        }),
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
