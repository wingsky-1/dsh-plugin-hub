/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { describe, expect, it } from "vitest";
import { GEN, fakeLlm, generateReport } from "./report-generation-support.ts";

describe("generate：冲突 usage 采用首个 chunk", () => {
  it("完整首 usage 的所有 token 字段均优先于冲突后块", async () => {
    const f = fakeLlm([
      { type: "text-delta", index: 0, text: "可见正文" },
      {
        type: "usage",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
        },
      },
      {
        type: "usage",
        usage: {
          inputTokens: 999,
          outputTokens: 888,
          totalTokens: 1887,
          cacheReadTokens: 777,
          cacheWriteTokens: 666,
        },
      },
      { type: "finish", reason: { kind: "stop" } },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(true);
    expect(result.body).toBe("可见正文");
    expect(result.meta.tokens).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: null,
      totalTokens: 15,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });
    expect(f.seen.calls).toHaveLength(1);
  });

  it("首 usage 缺失可选字段形成的 null 不会被冲突后块补写", async () => {
    const f = fakeLlm([
      { type: "text-delta", index: 0, text: "可见正文" },
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } },
      {
        type: "usage",
        usage: {
          inputTokens: 999,
          outputTokens: 888,
          totalTokens: 1887,
          cacheReadTokens: 777,
          cacheWriteTokens: 666,
        },
      },
      { type: "finish", reason: { kind: "stop" } },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(true);
    expect(result.body).toBe("可见正文");
    expect(result.meta.tokens).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
    expect(f.seen.calls).toHaveLength(1);
  });
});
