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
  type LlmSeen,
  type ReportResult,
} from "./report-generation-support.ts";

describe("generate：显式路由透传", () => {
  let r: ReportResult;
  let seen: LlmSeen;
  beforeAll(async () => {
    const f = fakeLlm();
    r = await generateReport(GEN({ llm: f.llm, provider: "prov-b", model: "model-b" }));
    seen = f.seen;
  });

  it("显式 provider 直接透传", () => {
    expect(r.meta.provider).toBe("prov-b");
  });

  it("显式路由仅调用一次且完整透传", () => {
    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0]!.provider).toBe("prov-b");
    expect(seen.calls[0]!.model).toBe("model-b");
  });
});
