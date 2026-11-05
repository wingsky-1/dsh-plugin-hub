/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { describe, expect, it } from "vitest";
import {
  CHUNKS,
  GEN,
  fakeLlm,
  generateReport,
  generateReportOutcome,
  resolveGenerateRoute,
  type ReportLlmService,
} from "./report-generation-support.ts";
import { RAW_PROVIDER_FAILURE } from "./report-generation-fixtures.ts";

describe("generate：路由解析异常稳定脱敏", () => {
  it("listModels 结构化 transient 返回 unresolved outcome，保留非空 ledger marker 且不 stream", async () => {
    const f = fakeLlm(CHUNKS);
    const llm: ReportLlmService = {
      ...f.llm,
      listModels: async () => {
        throw { code: "TIMEOUT", message: RAW_PROVIDER_FAILURE };
      },
    };
    const route = await resolveGenerateRoute({ llm, provider: "", model: "" });

    expect(route).toMatchObject({
      status: "failure",
      unresolved: true,
      failure: { kind: "transient", code: "route-resolution-failed" },
    });
    expect(route.route.provider).not.toBe("");
    expect(route.route.model).not.toBe("");
    expect(JSON.stringify(route)).not.toContain(RAW_PROVIDER_FAILURE);
    expect(f.seen.calls).toHaveLength(0);
  });

  it("listModels 未知异常 fail closed，不标记为 transient", async () => {
    const f = fakeLlm(CHUNKS, { throwInListModels: RAW_PROVIDER_FAILURE });
    const route = await resolveGenerateRoute({ llm: f.llm, provider: "", model: "" });

    expect(route).toMatchObject({
      status: "failure",
      unresolved: false,
      failure: { kind: "unknown", code: "route-resolution-failed" },
    });
    expect(JSON.stringify(route)).not.toContain(RAW_PROVIDER_FAILURE);
    expect(f.seen.calls).toHaveLength(0);
  });

  it("空 route 永不 stream", async () => {
    const f = fakeLlm(CHUNKS);
    const result = await generateReportOutcome(
      GEN({
        llm: f.llm,
        route: { status: "success", route: { provider: "", model: "" } },
      }),
    );

    expect(result).toMatchObject({
      status: "failure",
      failure: { kind: "permanent", code: "route-unavailable" },
      result: {
        body: "",
        meta: { ok: false, error: "无可用的已注册 provider/model（须先在 dsh 注册适配器路由）" },
      },
    });
    expect(f.seen.calls).toHaveLength(0);
  });

  it.each([
    { name: "listProviders", options: { throwInListProviders: RAW_PROVIDER_FAILURE } },
    { name: "listModels", options: { throwInListModels: RAW_PROVIDER_FAILURE } },
  ])("$name 抛错返回固定安全错误且不启动 stream", async ({ options }) => {
    const f = fakeLlm(CHUNKS, options);

    const result = await generateReport(GEN({ llm: f.llm }));

    expect(result.meta).toMatchObject({ ok: false, error: "模型路由解析失败" });
    expect(result.body).toBe("");
    expect(result.meta.error).not.toContain("sk-test-not-a-real-key");
    expect(result.meta.error).not.toContain("/home/private/report.json");
    expect(result.meta.error).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(f.seen.calls).toHaveLength(0);
  });
});
