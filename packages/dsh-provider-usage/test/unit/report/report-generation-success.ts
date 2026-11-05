/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  GEN,
  fakeLlm,
  generateReport,
  textOf,
  type LlmSeen,
  type ReportResult,
} from "./report-generation-support.ts";

describe("generate：成功路径（正文拼接 / token 元数据 / 空串跟随默认路由）", () => {
  let r: ReportResult;
  let seen: LlmSeen;
  beforeAll(async () => {
    const f = fakeLlm();
    r = await generateReport(GEN({ llm: f.llm }));
    seen = f.seen;
  });

  it("生成成功", () => {
    expect(r.meta.ok).toBe(true);
  });

  it("text-delta 顺序拼接", () => {
    expect(r.body).toBe("第一段。第二段。");
  });

  it("usage chunk 记元数据", () => {
    expect(r.meta.tokens).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: null,
      totalTokens: 15,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });

  it("空 provider → 注册序首个", () => {
    expect(r.meta.provider).toBe("prov-a");
  });

  it("空 model → 该 provider 首个", () => {
    expect(r.meta.model).toBe("model-a");
  });

  it("模型流仅调用一次并透传解析后路由", () => {
    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0]!.provider).toBe("prov-a");
  });

  it("单条 user 消息", () => {
    expect(seen.calls[0]!.messages.length).toBe(1);
  });

  it("user source", () => {
    // 0.1.7 起 messages 元素为 RequestMessage（source 可选，hand-built one-shot
    // 允许无 source）；?. 收窄后断言强度不变（缺 source 即 undefined ≠ "user" 照红）。
    expect(seen.calls[0]!.messages[0]?.source?.kind).toBe("user");
  });

  it("role=user（UserMessage 字面量，类型层同步钉死）", () => {
    expect(seen.calls[0]!.messages[0].role).toBe("user");
  });

  it("{stats} 注入统计 JSON", () => {
    expect(textOf(seen.calls[0]!.messages[0].content[0]).includes('{"calls":1}')).toBeTruthy();
  });

  it("tools 不传 = 无工具面", () => {
    expect(seen.calls[0]!.tools === undefined).toBeTruthy();
  });

  it("时长记录", () => {
    expect(typeof r.meta.durationMs).toBe("number");
    expect(r.meta.durationMs).toBeGreaterThanOrEqual(0);
  });
});
