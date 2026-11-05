/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { describe, expect, it } from "vitest";
import {
  GEN,
  fakeLlm,
  generateReport,
  generateReportOutcome,
  type StreamChunk,
} from "./report-generation-support.ts";
import {
  RAW_PROVIDER_FAILURE,
  REPORT_TOOL_CALL_ID,
  TOOL_ARGUMENTS,
  UNSUPPORTED_CONTENT_ERROR,
  futureContentChunk,
  futureFinishChunk,
} from "./report-generation-fixtures.ts";

const AFTER_TERMINAL_ERROR = "模型在结束后仍返回内容";

function registerAfterTerminalCases(): void {
  const AFTER_FINISH_CASES: Array<{ name: string; tail: StreamChunk[] }> = [
    { name: "text-delta", tail: [{ type: "text-delta", index: 0, text: "结束后追加的正文" }] },
    {
      name: "reasoning-delta",
      tail: [{ type: "reasoning-delta", index: 0, text: "结束后追加的推理" }],
    },
    {
      name: "usage",
      tail: [{ type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }],
    },
    {
      name: "tool-call-delta",
      tail: [
        {
          type: "tool-call-delta",
          index: 0,
          id: REPORT_TOOL_CALL_ID,
          name: "read_private_file",
          argumentsDelta: TOOL_ARGUMENTS,
        },
      ],
    },
    { name: "unknown chunk", tail: [futureContentChunk()] },
    { name: "第二个 finish", tail: [{ type: "finish", reason: { kind: "stop" } }] },
  ];

  it.each(AFTER_FINISH_CASES)(
    "stop 之后的 $name 进入 protocol-after-terminal 且正文不落盘",
    async ({ tail }) => {
      const f = fakeLlm([
        { type: "text-delta", index: 0, text: "结束前正文" },
        { type: "finish", reason: { kind: "stop" } },
        ...tail,
      ]);

      const result = await generateReport(
        GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
      );

      expect(result.meta.ok).toBe(false);
      expect(result.body).toBe("");
      expect(result.meta.error).toBe(AFTER_TERMINAL_ERROR);
      expect(f.seen.calls).toHaveLength(1);
    },
  );
}

function registerAfterTerminalAssertions(): void {
  it("after-terminal 走 unknown kind（不进入自动重试）", async () => {
    const f = fakeLlm([
      { type: "text-delta", index: 0, text: "结束前正文" },
      { type: "finish", reason: { kind: "stop" } },
      { type: "text-delta", index: 0, text: "结束后追加的正文" },
    ]);

    const outcome = await generateReportOutcome(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(outcome).toMatchObject({
      status: "failure",
      failure: { kind: "unknown", code: "protocol-after-terminal" },
    });
  });

  it("error 终态优先于 after-terminal（错误分类不回归）", async () => {
    const f = fakeLlm([
      { type: "text-delta", index: 0, text: "不应保存的正文" },
      {
        type: "finish",
        reason: { kind: "error", failure: { message: RAW_PROVIDER_FAILURE, code: "raw" } },
      },
      { type: "text-delta", index: 0, text: "结束后追加的正文" },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta).toMatchObject({ ok: false, error: "模型请求失败" });
    expect(result.body).toBe("");
    expect(JSON.stringify(result)).not.toContain(RAW_PROVIDER_FAILURE);
  });

  it("unknown finish 终态优先于 after-terminal（终态合并不回归）", async () => {
    const f = fakeLlm([
      { type: "text-delta", index: 0, text: "不应保存的正文" },
      futureFinishChunk(),
      { type: "text-delta", index: 0, text: "结束后追加的正文" },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta).toMatchObject({ ok: false, error: "模型流返回未知终态" });
    expect(result.body).toBe("");
  });

  it("after-terminal 之前的 usage 仍为首个 usage 事实（first usage 不回归）", async () => {
    const f = fakeLlm([
      { type: "text-delta", index: 0, text: "结束前正文" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      { type: "finish", reason: { kind: "stop" } },
      { type: "usage", usage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998 } },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta).toMatchObject({ ok: false, error: AFTER_TERMINAL_ERROR });
    expect(result.meta.tokens).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("after-terminal 之前的不支持内容块仍按 unsupported-content 归类（block policy 不回归）", async () => {
    const f = fakeLlm([
      { type: "block-start", index: 0, blockType: "image" },
      { type: "finish", reason: { kind: "stop" } },
      { type: "text-delta", index: 0, text: "结束后追加的正文" },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta).toMatchObject({ ok: false, error: UNSUPPORTED_CONTENT_ERROR });
    expect(result.body).toBe("");
  });
}

describe("generate：#1010 残余 A finish 之后任何 chunk 一律 fail closed", () => {
  registerAfterTerminalCases();
  registerAfterTerminalAssertions();
});

describe("generate：#1010 残余 B 空白 text-delta 不屏蔽 block-end 正文", () => {
  it.each([
    { name: "空串", text: "" },
    { name: "半角空格", text: " " },
    { name: "全角空白", text: "\u3000" },
    { name: "换行缩进", text: "\n   " },
  ])("$name delta + 非空 block-end.text 成功且正文取自块", async ({ text }) => {
    const f = fakeLlm([
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text },
      { type: "block-end", index: 0, block: { type: "text", text: "完整块正文" } },
      { type: "finish", reason: { kind: "stop" } },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(true);
    expect(result.body).toBe(text + "完整块正文");
    expect(f.seen.calls).toHaveLength(1);
  });

  it("空白 delta + 非空 block-end 不再误报空输出（不进入重试）", async () => {
    const f = fakeLlm([
      { type: "text-delta", index: 0, text: "   " },
      { type: "block-end", index: 0, block: { type: "text", text: "块正文" } },
      { type: "finish", reason: { kind: "stop" } },
    ]);

    const outcome = await generateReportOutcome(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(outcome.status).toBe("success");
    expect(outcome.result.body).toContain("块正文");
  });

  it("非空 delta + 同块 block-end 仍去重（正文只拼接一次）", async () => {
    const f = fakeLlm([
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "第一段" },
      { type: "text-delta", index: 0, text: "空白" },
      { type: "block-end", index: 0, block: { type: "text", text: "第一段空白" } },
      { type: "finish", reason: { kind: "stop" } },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(true);
    expect(result.body).toBe("第一段空白");
  });

  it("空白 delta 后的同 index 非空 delta 仍抑制 block-end 重复", async () => {
    const f = fakeLlm([
      { type: "text-delta", index: 0, text: "  " },
      { type: "text-delta", index: 0, text: "真实正文" },
      { type: "block-end", index: 0, block: { type: "text", text: "  真实正文" } },
      { type: "finish", reason: { kind: "stop" } },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.body).toBe("  真实正文");
  });

  it("纯空白 delta + 纯空白 block-end 仍归空正文错误（不误判成功）", async () => {
    const f = fakeLlm([
      { type: "text-delta", index: 0, text: "  " },
      { type: "block-end", index: 0, block: { type: "text", text: "   " } },
      { type: "finish", reason: { kind: "stop" } },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta).toMatchObject({ ok: false, error: "模型未产出任何正文" });
  });
});
