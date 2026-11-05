/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { describe, expect, it } from "vitest";
import { GEN, fakeLlm, generateReport } from "./report-generation-support.ts";
import {
  PRIVATE_IMAGE_NAME,
  PRIVATE_FILE_NAME,
  PRIVATE_TOOL_NAME,
  PRIVATE_REASONING,
  TOOL_ARGUMENTS,
  UNSUPPORTED_CONTENT_ERROR,
  UNSUPPORTED_CONTENT_STREAMS,
  UNSUPPORTED_TOOL_ERROR,
  UNSUPPORTED_TOOL_STREAMS,
} from "./report-generation-fixtures.ts";

describe("generate：官方完整 block 流", () => {
  it("block-start + text-delta + block-end + stop 成功且正文只拼接 delta 一次", async () => {
    const f = fakeLlm([
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "完整正文" },
      { type: "block-end", index: 0, block: { type: "text", text: "完整正文" } },
      { type: "finish", reason: { kind: "stop" } },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(true);
    expect(result.body).toBe("完整正文");
    expect(f.seen.calls).toHaveLength(1);
  });

  it("无 text-delta 时以 text block-end 作为正文 fallback", async () => {
    const f = fakeLlm([
      { type: "block-start", index: 0, blockType: "text" },
      { type: "block-end", index: 0, block: { type: "text", text: "仅块正文" } },
      { type: "finish", reason: { kind: "stop" } },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(true);
    expect(result.body).toBe("仅块正文");
  });

  it("reasoning block-end-only 精确归类为 reasoning-only 且不保存原文", async () => {
    const f = fakeLlm([
      { type: "block-start", index: 0, blockType: "reasoning" },
      { type: "block-end", index: 0, block: { type: "reasoning", text: PRIVATE_REASONING } },
      { type: "finish", reason: { kind: "stop" } },
    ]);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta).toMatchObject({
      ok: false,
      error: "模型仅返回推理过程未产出正文",
    });
    expect(result.body).toBe("");
    expect(JSON.stringify(result)).not.toContain(PRIVATE_REASONING);
  });

  it.each(UNSUPPORTED_TOOL_STREAMS)(
    "$name 以固定安全错误 fail closed 且不泄露工具原文",
    async ({ chunks }) => {
      const f = fakeLlm(chunks);

      const result = await generateReport(
        GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
      );

      expect(result.meta).toMatchObject({ ok: false, error: UNSUPPORTED_TOOL_ERROR });
      expect(result.body).toBe("");
      expect(JSON.stringify(result)).not.toContain(TOOL_ARGUMENTS);
      expect(f.seen.calls).toHaveLength(1);
    },
  );

  it.each(UNSUPPORTED_CONTENT_STREAMS)(
    "$name 拒绝官方非文本 block，text-delta 不得绕过且不泄露 block 原文",
    async ({ chunks }) => {
      const f = fakeLlm(chunks);

      const result = await generateReport(
        GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
      );

      expect(result.meta).toMatchObject({ ok: false, error: UNSUPPORTED_CONTENT_ERROR });
      expect(result.body).toBe("");
      expect(JSON.stringify(result)).not.toContain(PRIVATE_IMAGE_NAME);
      expect(JSON.stringify(result)).not.toContain(PRIVATE_FILE_NAME);
      expect(JSON.stringify(result)).not.toContain(PRIVATE_TOOL_NAME);
      expect(f.seen.calls).toHaveLength(1);
    },
  );
});
