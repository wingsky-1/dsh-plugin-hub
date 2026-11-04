/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  CHUNKS,
  GEN,
  fakeLlm,
  generateReport,
  type LlmSeen,
  type ReportResult,
} from "./report-generation-support.ts";
import { RAW_PROVIDER_FAILURE } from "./report-generation-fixtures.ts";

type FailureState = {
  r1: ReportResult;
  r2: ReportResult;
  r3: ReportResult;
  r4: ReportResult;
  r5: ReportResult;
  seen1: LlmSeen;
  seen2: LlmSeen;
  seen3: LlmSeen;
  seen4: LlmSeen;
  seen5: LlmSeen;
};

function registerFailureCases(state: FailureState): void {
  it("流异常返回固定安全文案且不泄露 key、路径或控制文本", () => {
    expect(state.seen1.calls).toHaveLength(1);
    expect(state.r1.meta.ok).toBe(false);
    expect(state.r1.body).toBe("");
    expect(state.r1.meta.error).toBe("模型请求失败");
  });

  it("已取消信号在 stream 前收口且返回固定安全文案", () => {
    expect(state.seen2.calls).toHaveLength(0);
    expect(state.r2.meta.ok).toBe(false);
    expect(state.r2.body).toBe("");
    expect(state.r2.meta.error).toBe("模型请求已取消");
  });

  it("正常终态空正文仅调用一次并返回旧错", () => {
    expect(state.seen3.calls).toHaveLength(1);
    expect(state.r3.meta.ok).toBe(false);
    expect(state.r3.body).toBe("");
    expect(state.r3.meta.error).toBe("模型未产出任何正文");
  });

  it("无注册 provider 时不调用模型流", () => {
    expect(state.seen4.calls).toHaveLength(0);
    expect(state.r4.meta).toMatchObject({
      ok: false,
      error: "无可用的已注册 provider/model（须先在 dsh 注册适配器路由）",
    });
  });

  it("provider 无可用 model 时不调用模型流", () => {
    expect(state.seen5.calls).toHaveLength(0);
    expect(state.r5.meta).toMatchObject({
      ok: false,
      error: "无可用的已注册 provider/model（须先在 dsh 注册适配器路由）",
    });
  });
}

describe("generate：失败路径（流异常 / 取消 / 空正文 / 路由不可解析）", () => {
  const state = {} as FailureState;

  beforeAll(async () => {
    // 流异常 → 失败元数据（不抛；正文空）
    const boom = fakeLlm(CHUNKS, { throwInStream: RAW_PROVIDER_FAILURE });
    state.r1 = await generateReport(GEN({ llm: boom.llm }));
    state.seen1 = boom.seen;
    // 取消 → 失败
    const controller = new AbortController();
    controller.abort();
    const canceled = fakeLlm();
    state.r2 = await generateReport(GEN({ llm: canceled.llm, signal: controller.signal }));
    state.seen2 = canceled.seen;
    // 空正文 → 失败
    const empty = fakeLlm([
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "finish", reason: { kind: "stop" } },
    ]);
    state.r3 = await generateReport(GEN({ llm: empty.llm }));
    state.seen3 = empty.seen;
    // 路由不可解析 → 失败
    const noProviders = fakeLlm(CHUNKS, { noProviders: true });
    state.r4 = await generateReport(GEN({ llm: noProviders.llm }));
    state.seen4 = noProviders.seen;
    const noModels = fakeLlm(CHUNKS, { noModels: true });
    state.r5 = await generateReport(GEN({ llm: noModels.llm }));
    state.seen5 = noModels.seen;
  });

  registerFailureCases(state);
});
