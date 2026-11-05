/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CHUNKS,
  GEN,
  applyPromptTemplate,
  fakeLlm,
  generateReport,
  generateReportOutcome,
} from "./report-generation-support.ts";
import {
  NORMAL_FINISH_REASONS,
  STRUCTURED_FAILURE_CASES,
  TERMINAL_FAILURES,
  TERMINAL_MERGE_CASES,
  futureContentChunk,
  futureFinishChunk,
} from "./report-generation-fixtures.ts";

describe("generate：结构化失败分类矩阵", () => {
  it.each(STRUCTURED_FAILURE_CASES)(
    "$name 保留稳定 kind/code 且不携带 raw 文本",
    async ({ expected, run }) => {
      const outcome = await run();

      expect(outcome.status).toBe("failure");
      if (outcome.status === "failure") expect(outcome.failure).toEqual(expected);
      expect(JSON.stringify(outcome)).not.toMatch(/raw|credential|secret/);
      expect(JSON.stringify(outcome.result.meta)).not.toContain(
        "raw finish secret must not escape",
      );
      expect(JSON.stringify(outcome.result.meta)).not.toContain("sk-test-not-a-real-key");
      expect(JSON.stringify(outcome.result.meta)).not.toContain("/home/private/report.json");
    },
  );

  it("capability timeout 标记 transient/capability-timeout 并清理 timer", async () => {
    vi.useFakeTimers();
    try {
      const pending = generateReportOutcome(
        GEN({
          llm: fakeLlm(CHUNKS, { capabilityNever: true }).llm,
          reasoningEffort: "vendor::deep",
        }),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const outcome = await pending;

      expect(outcome).toMatchObject({
        status: "failure",
        failure: { kind: "transient", code: "capability-timeout" },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("generate：已知正常终态分类正文与 reasoning", () => {
  it.each(NORMAL_FINISH_REASONS)(
    "$name 终态下正文成功且 reasoning 不进入正文",
    async ({ reason }) => {
      const f = fakeLlm([
        { type: "reasoning-delta", index: 0, text: "不应进入正文的推理" },
        { type: "text-delta", index: 0, text: "可见正文" },
        { type: "finish", reason },
      ]);

      const result = await generateReport(
        GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
      );

      expect(result.meta.ok).toBe(true);
      expect(result.body).toBe("可见正文");
      expect(result.meta.error).toBeUndefined();
      expect(f.seen.calls).toHaveLength(1);
    },
  );

  it("reasoning 仅含空白时返回旧空正文错误", async () => {
    const f = fakeLlm([
      { type: "reasoning-delta", index: 0, text: " \n\t " },
      { type: "finish", reason: { kind: "stop" } },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(false);
    expect(result.body).toBe("");
    expect(result.meta.error).toBe("模型未产出任何正文");
    expect(f.seen.calls).toHaveLength(1);
  });
});

describe("generate：通用 provider 仅返回推理时给出可分诊错误", () => {
  it("正常终止但只有 reasoning 时不产出正文并精确报错", async () => {
    const f = fakeLlm([
      { type: "reasoning-delta", index: 0, text: "先分析数据，再决定结论。" },
      { type: "finish", reason: { kind: "stop" } },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(false);
    expect(result.body).toBe("");
    expect(result.meta.error).toBe("模型仅返回推理过程未产出正文");
    expect(f.seen.calls).toHaveLength(1);
  });
});

describe("generate：终止失败优先于已有正文", () => {
  it.each(TERMINAL_FAILURES)(
    "$name 终态返回固定安全文案且不保留正文",
    async ({ reason, expectedError }) => {
      const f = fakeLlm([
        { type: "text-delta", index: 0, text: "不应保存的正文" },
        { type: "finish", reason },
      ]);

      const result = await generateReport(
        GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
      );

      expect(result.meta.ok).toBe(false);
      expect(result.body).toBe("");
      expect(result.meta.error).toBe(expectedError);
      expect(f.seen.calls).toHaveLength(1);
    },
  );

  it.each(TERMINAL_FAILURES)(
    "$name 终态仍优先于未知内容事件",
    async ({ reason, expectedError }) => {
      const f = fakeLlm([futureContentChunk(), { type: "finish", reason }]);

      const result = await generateReport(
        GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
      );

      expect(result.meta.ok).toBe(false);
      expect(result.body).toBe("");
      expect(result.meta.error).toBe(expectedError);
      expect(f.seen.calls).toHaveLength(1);
    },
  );
});

describe("generate：多 finish 终态合并保持 fail closed", () => {
  it.each(TERMINAL_MERGE_CASES)(
    "$name 不被后续 finish 覆盖",
    async ({ first, second, expectedError }) => {
      const f = fakeLlm([{ type: "text-delta", index: 0, text: "不应保存的正文" }, first, second]);

      const result = await generateReport(
        GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
      );

      expect(result.meta.ok).toBe(false);
      expect(result.body).toBe("");
      expect(result.meta.error).toBe(expectedError);
      expect(f.seen.calls).toHaveLength(1);
    },
  );

  it("unknown 终态伴随非空正文仍拒绝成功", async () => {
    const f = fakeLlm([
      { type: "text-delta", index: 0, text: "非空正文不能覆盖未知终态" },
      futureFinishChunk(),
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(false);
    expect(result.body).toBe("");
    expect(result.meta.error).toBe("模型流返回未知终态");
    expect(f.seen.calls).toHaveLength(1);
  });
});

describe("generate：未知流内容与终态 fail closed", () => {
  it("正文存在但流未返回终态时拒绝成功", async () => {
    const f = fakeLlm([{ type: "text-delta", index: 0, text: "未确认终态的正文" }]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(false);
    expect(result.body).toBe("");
    expect(result.meta.error).toBe("模型流未返回可识别终态");
    expect(f.seen.calls).toHaveLength(1);
  });

  it("缺失终态优先于 reasoning-only 分类", async () => {
    const f = fakeLlm([{ type: "reasoning-delta", index: 0, text: "不能暴露的推理原文" }]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(false);
    expect(result.body).toBe("");
    expect(result.meta.error).toBe("模型流未返回可识别终态");
    expect(f.seen.calls).toHaveLength(1);
  });

  it("未知 finish 优先于空输出分类并拒绝成功", async () => {
    const f = fakeLlm([
      { type: "reasoning-delta", index: 0, text: "不能暴露的推理原文" },
      futureFinishChunk(),
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(false);
    expect(result.body).toBe("");
    expect(result.meta.error).toBe("模型流返回未知终态");
    expect(f.seen.calls).toHaveLength(1);
  });

  it("未知内容块即使伴随正文与正常终态也拒绝成功", async () => {
    const f = fakeLlm([
      futureContentChunk(),
      { type: "text-delta", index: 0, text: "不应保存的正文" },
      { type: "finish", reason: { kind: "stop" } },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(false);
    expect(result.body).toBe("");
    expect(result.meta.error).toBe("模型返回了未知流事件");
    expect(f.seen.calls).toHaveLength(1);
  });

  it("未知内容块不伪装成 reasoning-only 或双空", async () => {
    const f = fakeLlm([futureContentChunk(), { type: "finish", reason: { kind: "stop" } }]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(false);
    expect(result.body).toBe("");
    expect(result.meta.error).toBe("模型返回了未知流事件");
    expect(f.seen.calls).toHaveLength(1);
  });
});

describe("generate：{stats} 模板替换", () => {
  it("{stats} 多次出现全部替换", () => {
    expect(applyPromptTemplate("A{stats}B{stats}C", "[J]")).toBe("A[J]B[J]C");
  });

  it("无占位原样返回", () => {
    expect(applyPromptTemplate("无占位", "[J]")).toBe("无占位");
  });
});
