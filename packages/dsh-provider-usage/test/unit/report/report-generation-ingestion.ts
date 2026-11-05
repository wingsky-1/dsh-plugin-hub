/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { describe, expect, it } from "vitest";
import { GEN, fakeLlm, generateReport } from "./report-generation-support.ts";

describe("生成不入统计前提（方案 §2.3）", () => {
  it("生成只经 llm.stream（无 session 事件源参与）", async () => {
    // generateReport 只消费注入的 llm 服务面，不触达 session/event 通道
    // （fake llm 无会话事件源；接线层 smoke 以 emitEvent 计数断言「生成不产生
    // session 事件→不入统计」）。
    const { llm, seen } = fakeLlm();
    await generateReport(GEN({ llm }));
    expect(seen.calls).toHaveLength(1);
  });
});
