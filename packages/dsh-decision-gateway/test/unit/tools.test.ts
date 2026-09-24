/** tools 域单测（fetch 全注入 mock，全程离线；落盘仅内存记录器）。 */
import { describe, expect, it } from "vitest";
import type { DecideDeps, FetchImpl } from "../../src/server/tools/deps.ts";
import {
  callWithRetry,
  confidenceTier,
  mapFirstAnswer,
  sdkErrorToFailure,
  toWireQuestions,
} from "../../src/server/tools/impl/client.ts";
import type { DecisionRequestBody } from "../../src/server/tools/impl/client.ts";
import { createSemaphore } from "../../src/server/tools/impl/semaphore.ts";
import { localPrecheckHit } from "../../src/server/tools/impl/precheck.ts";
import { decide } from "../../src/server/tools/impl/service.ts";
import { validateDecideArgs } from "../../src/server/tools/impl/validate.ts";

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
    signal: new AbortController().signal,
    ...over,
  };
}

function jsonFetch(status: number, body: unknown, seen?: { count: number }): FetchImpl {
  return async () => {
    if (seen !== undefined) seen.count += 1;
    return { status, text: JSON.stringify(body) };
  };
}

/** 官方答案体：单题 choice（题 id 须与调用一致）。 */
function sdkChoice(id: string, choice: string, confidence: number): unknown {
  return {
    model: "jev-1.13.0",
    answers: {
      [id]: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } },
    },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/** 官方答案体：单题 score（SDK 浮点，legend 0-based）。 */
function sdkScore(id: string, score: unknown, confidence = 0.5): unknown {
  return {
    model: "jev-1.13.0",
    answers: { [id]: { type: "score", score, confidence } },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

describe("参数校验 400", () => {
  it("双缺省/空串/空数组", () => {
    expect(validateDecideArgs({}).ok).toBe(false);
    expect(validateDecideArgs({ preset_id: "", state: { text: "x", lang: "en" } }).ok).toBe(false);
    expect(validateDecideArgs({ preset_id: "general", state: { text: "", lang: "en" } }).ok).toBe(
      false,
    );
    expect(validateDecideArgs({ preset_id: "custom", state: { text: "x", lang: "en" } }).ok).toBe(
      false,
    );
    expect(
      validateDecideArgs({
        preset_id: "custom",
        state: { text: "x", lang: "en" },
        questions_override: [],
      }).ok,
    ).toBe(false);
  });
  it("lang 无缺省", () => {
    expect(validateDecideArgs({ preset_id: "general", state: { text: "x" } }).ok).toBe(false);
    expect(validateDecideArgs({ preset_id: "general", state: { text: "x", lang: "fr" } }).ok).toBe(
      false,
    );
  });
  it("中文 id 400（正文中文合法）", () => {
    expect(validateDecideArgs({ preset_id: "通用", state: { text: "x", lang: "zh" } }).ok).toBe(
      false,
    );
    const ok = validateDecideArgs({
      preset_id: "general",
      state: { text: "中文正文", lang: "zh" },
      questions_override: [{ id: "q1", text: "选一个。", kind: "choice", options: ["甲", "乙"] }],
    });
    expect(ok.ok).toBe(true);
  });
  it("全员显式带题；任意调用方题目即 override", () => {
    const custom = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "q1", text: "Q?", kind: "choice", options: ["a", "b"] }],
    });
    expect(custom.ok).toBe(true);
    const missing = validateDecideArgs({ preset_id: "general", state: { text: "x", lang: "en" } });
    expect(missing.ok).toBe(false);
    const full = validateDecideArgs({
      preset_id: "general",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "other", text: "Q?", kind: "choice", options: ["a", "b"] }],
    });
    expect(full.ok).toBe(true);
    if (full.ok) expect(full.valid.appliedSource).toBe("override");
  });
  it("互斥与 255：id 唯一、choice 必带 options、score 禁带、单题超长", () => {
    const dup = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [
        { id: "q", text: "a", kind: "score" },
        { id: "q", text: "b", kind: "score" },
      ],
    });
    expect(dup.ok).toBe(false);
    const noOpts = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "q", text: "a", kind: "choice" }],
    });
    expect(noOpts.ok).toBe(false);
    const withOpts = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "q", text: "a", kind: "score", options: ["x"] }],
    });
    expect(withOpts.ok).toBe(false);
    const long = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "q", text: "y".repeat(256), kind: "score" }],
    });
    expect(long.ok).toBe(false);
  });
  it("levels：score 可带 2-10 分档，choice 带即拒收", () => {
    const okLevels = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [{ id: "q", text: "a", kind: "score", levels: ["差", "良", "优"] }],
    });
    expect(okLevels.ok).toBe(true);
    if (okLevels.ok) expect(okLevels.valid.questions[0]?.levels).toEqual(["差", "良", "优"]);
    for (const bad of [
      { id: "q", text: "a", kind: "score", levels: ["单档"] },
      { id: "q", text: "a", kind: "score", levels: ["", "良"] },
      {
        id: "q",
        text: "a",
        kind: "score",
        levels: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"],
      },
      { id: "q", text: "a", kind: "choice", options: ["A", "B"], levels: ["x", "y"] },
    ]) {
      const r = validateDecideArgs({
        preset_id: "custom",
        state: { text: "x", lang: "en" },
        questions_override: [bad],
      });
      expect(r.ok).toBe(false);
    }
    const choiceLevels = validateDecideArgs({
      preset_id: "custom",
      state: { text: "x", lang: "en" },
      questions_override: [
        { id: "q", text: "a", kind: "choice", options: ["A", "B"], levels: ["x", "y"] },
      ],
    });
    expect(choiceLevels.ok).toBe(false);
    if (!choiceLevels.ok) expect(choiceLevels.failure.errorCode).toBe("BAD_LEVELS");
  });
});

describe("本地预检不离境", () => {
  it("命中密形即 local-precheck 且 fetch 零调用", async () => {
    expect(localPrecheckHit("key sk-Abcdef12345678 here")).toBe(true);
    expect(localPrecheckHit("today is sunny")).toBe(false);
    let calls = 0;
    const out = await decide(
      {
        preset_id: "general",
        state: { text: "my sk-Abcdef12345678 leak", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({
        fetchImpl: async () => {
          calls += 1;
          return { status: 200, text: "{}" };
        },
      }),
    );
    expect(calls).toBe(0);
    expect(out).toMatchObject({
      ok: true,
      provider: "official",
      appliedSource: "local-precheck",
      tier: "none",
      automation: "manual",
    });
  });
});

describe("远端编排", () => {
  it("成功输出必带字段", async () => {
    const events: unknown[] = [];
    const out = await decide(
      {
        preset_id: "general",
        state: { text: "hello", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({
        fetchImpl: jsonFetch(200, sdkChoice("q1", "A", 0.9)),
        recordEvent: (e) => {
          events.push(e);
        },
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
    expect(events).toHaveLength(1);
  });
  it("Noul 置空 tier；score 非数失败无概率字段", async () => {
    const noul = await decide(
      {
        preset_id: "general",
        state: { text: "hello", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({
        fetchImpl: jsonFetch(200, sdkChoice("q1", "Noul", 0.9)),
      }),
    );
    expect(noul).toMatchObject({ ok: true, tier: "none" });
    const bad = await decide(
      {
        preset_id: "plan-review",
        state: { text: "hello", lang: "en" },
        questions_override: [{ id: "q1", text: "Rate it.", kind: "score" }],
      },
      baseDeps({ fetchImpl: jsonFetch(200, sdkScore("q1", "high")) }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.errorCode).toBe("UPSTREAM");
      expect("confidence" in bad).toBe(false);
      expect("tier" in bad).toBe(false);
    }
  });
  it("无 key 与禁用预设", async () => {
    const noKey = await decide(
      {
        preset_id: "general",
        state: { text: "hi", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({ resolveKey: () => ({ key: undefined, source: "none" as const }) }),
    );
    expect(noKey).toMatchObject({ ok: false });
    const disabled = await decide(
      {
        preset_id: "general",
        state: { text: "hi", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({ isEnabled: () => false }),
    );
    expect(disabled).toMatchObject({ ok: false });
    if (!disabled.ok) expect(disabled.error.errorCode).toBe("PRESET_DISABLED");
  });
  it("截断标记与原始长度", async () => {
    const out = await decide(
      {
        preset_id: "general",
        state: { text: "abcdefghij", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({
        connection: { ...CONNECTION, truncBudget: 4 },
        fetchImpl: jsonFetch(200, sdkChoice("q1", "A", 0.6)),
      }),
    );
    expect(out).toMatchObject({ ok: true, truncated: true, originalLength: 10 });
  });
  it("重试计数：500 后成功记 1；4xx 不重试", async () => {
    let n = 0;
    const flaky: FetchImpl = async () => {
      n += 1;
      if (n === 1) return { status: 500, text: "err" };
      return { status: 200, text: JSON.stringify(sdkChoice("q1", "A", 0.9)) };
    };
    const out = await decide(
      {
        preset_id: "general",
        state: { text: "hi", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({ fetchImpl: flaky }),
    );
    expect(out).toMatchObject({ ok: true, retries: 1 });
    expect(n).toBe(2);
    const seen = { count: 0 };
    const bad = await decide(
      {
        preset_id: "general",
        state: { text: "hi", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({ fetchImpl: jsonFetch(400, {}, seen) }),
    );
    expect(bad.ok).toBe(false);
    expect(seen.count).toBe(1);
  });
});

describe("客户端件", () => {
  it("错误映射：401 不可重试；score 浮点合法取整", async () => {
    const unauth = await decide(
      {
        preset_id: "general",
        state: { text: "hi", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      baseDeps({ fetchImpl: jsonFetch(401, {}) }),
    );
    expect(unauth.ok).toBe(false);
    if (!unauth.ok) {
      expect(unauth.error.errorCode).toBe("UNAUTHORIZED");
      expect(unauth.error.category).toBe("unauthorized");
    }
    const scored = await decide(
      {
        preset_id: "plan-review",
        state: { text: "hi", lang: "en" },
        questions_override: [{ id: "q1", text: "Rate it.", kind: "score" }],
      },
      baseDeps({ fetchImpl: jsonFetch(200, sdkScore("q1", 2.3, 0.6)) }),
    );
    expect(scored.ok).toBe(true);
    if (scored.ok) expect(scored.score).toBe(3);
  });
  it("映射纯函数：confidence 分层 + 首题驱动 + 错误分类", () => {
    expect(confidenceTier(0.9)).toBe(2);
    expect(confidenceTier(0.7)).toBe(1);
    expect(confidenceTier(0.2)).toBe(0);
    const body = {
      model: "jev-latest",
      state: "t",
      questions: toWireQuestions([{ id: "q1", text: "Q?", kind: "choice", options: ["A", "B"] }]),
    } satisfies DecisionRequestBody;
    const mapped = mapFirstAnswer(body, {
      model: "jev-1.13.0",
      answers: {
        q1: { type: "choice", choice: "B", confidence: 0.6, probabilities: { A: 0.4, B: 0.6 } },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.verdict.choice).toBe("B");
      expect(mapped.verdict.tier).toBe(1);
    }
    const missing = mapFirstAnswer(body, {
      model: "jev-1.13.0",
      answers: {},
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(missing.ok).toBe(false);
    const noAnswers = mapFirstAnswer(body, {
      model: "jev-1.13.0",
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Parameters<typeof mapFirstAnswer>[1]);
    expect(noAnswers.ok).toBe(false);
    if (!noAnswers.ok) {
      expect(noAnswers.failure.category).toBe("bad-payload");
      expect(noAnswers.failure.retryable).toBe(false);
    }
    const down = sdkErrorToFailure(new Error("down"));
    expect(down).toMatchObject({ code: "NETWORK", retryable: true });
  });
  it("信号量串行（max=1 时并发不超 1）", async () => {
    const gate = createSemaphore(1);
    let live = 0;
    let peak = 0;
    const task = () =>
      gate.run(async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live -= 1;
      });
    await Promise.all([task(), task(), task()]);
    expect(peak).toBe(1);
  });
  it("callWithRetry 网络抛错可重试并计数", async () => {
    let n = 0;
    const r = await callWithRetry(
      {
        model: "jev-latest",
        state: "t",
        questions: toWireQuestions([{ id: "q", text: "Q?", kind: "choice", options: ["A", "B"] }]),
      },
      "k",
      1000,
      async () => {
        n += 1;
        throw new Error("down");
      },
    );
    expect(r.retries).toBe(2);
    expect(n).toBe(3);
    expect(r.failure?.retryable).toBe(true);
  });
});
