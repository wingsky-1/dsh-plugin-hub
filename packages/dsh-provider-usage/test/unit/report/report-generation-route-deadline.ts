/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHUNKS,
  GEN,
  fakeLlm,
  generateReport,
  generateReportOutcome,
  resolveGenerateRoute,
} from "./report-generation-support.ts";
import { RAW_PROVIDER_FAILURE } from "./report-generation-fixtures.ts";

/**
 * 只排空微任务、不引入真实等待的收敛探针：用于在 fake clock 下判定 promise 是否已
 * settle（未 settle 的无界 await 会挂死测试进程，故不直接 await）。
 */
async function settleProbe<T>(
  pending: Promise<T>,
  turns = 50,
): Promise<{ status: "settled"; value: T } | { status: "pending" }> {
  let outcome: { status: "settled"; value: T } | { status: "pending" } = { status: "pending" };
  void pending.then(
    (value) => {
      outcome = { status: "settled", value };
    },
    () => {
      outcome = { status: "pending" };
    },
  );
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
  return outcome;
}

function registerRouteDeadlineAssertions(): void {
  it("never-settling listModels 恰在 5s 收敛为 route-resolution-failed 且 stream=0", async () => {
    let listModelsCalls = 0;
    const f = fakeLlm(CHUNKS);
    Object.assign(f.llm, {
      listModels: async (provider: string) => {
        f.seen.listModelsCalls.push(provider);
        listModelsCalls += 1;
        return new Promise<Array<{ provider: string; id: string; name: string }>>(() => {});
      },
    });

    const pending = resolveGenerateRoute({ llm: f.llm, provider: "", model: "" });

    await vi.advanceTimersByTimeAsync(4999);
    expect(await settleProbe(pending)).toEqual({ status: "pending" });
    expect(listModelsCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    const settled = await settleProbe(pending);

    expect(settled).toMatchObject({
      status: "settled",
      value: {
        status: "failure",
        unresolved: true,
        failure: { kind: "transient", code: "route-resolution-failed" },
      },
    });
    expect(f.seen.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never-settling listModels 时 generateReport 同样收敛且不发起 stream", async () => {
    const f = fakeLlm(CHUNKS);
    Object.assign(f.llm, {
      listModels: () =>
        new Promise<Array<{ provider: string; id: string; name: string }>>(() => {}),
    });

    const pending = generateReport(GEN({ llm: f.llm }));

    await vi.advanceTimersByTimeAsync(4999);
    expect(await settleProbe(pending)).toEqual({ status: "pending" });

    await vi.advanceTimersByTimeAsync(1);
    const settled = await settleProbe(pending);

    expect(settled).toMatchObject({
      status: "settled",
      value: { meta: { ok: false, error: "模型路由解析失败" } },
    });
    expect(f.seen.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("底层晚到 rejection 被吸收（不产生未处理拒绝、不二次失败）", async () => {
    const f = fakeLlm(CHUNKS);
    let rejectLate: (error: Error) => void = () => {};
    Object.assign(f.llm, {
      listModels: () =>
        new Promise<Array<{ provider: string; id: string; name: string }>>((_resolve, reject) => {
          rejectLate = reject;
        }),
    });

    const pending = resolveGenerateRoute({ llm: f.llm, provider: "", model: "" });
    await vi.advanceTimersByTimeAsync(5000);
    const settled = await settleProbe(pending);
    expect(settled).toMatchObject({ status: "settled", value: { status: "failure" } });

    rejectLate(new Error(RAW_PROVIDER_FAILURE));
    await vi.advanceTimersByTimeAsync(0);
    await settleProbe(Promise.resolve());

    if (settled.status !== "settled") throw new Error("expected settled route outcome");
    expect(settled.value).toMatchObject({
      status: "failure",
      failure: { kind: "transient", code: "route-resolution-failed" },
    });
    expect(JSON.stringify(settled.value)).not.toContain(RAW_PROVIDER_FAILURE);
    expect(f.seen.calls).toHaveLength(0);
  });

  it("显式 provider+model 时不发 listModels（有界化不新增调用）", async () => {
    const f = fakeLlm(CHUNKS);

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(true);
    expect(f.seen.listModelsCalls).toEqual([]);
    expect(f.seen.calls).toHaveLength(1);
  });

  it("超时后不遗留 timer（进程可自然退出）", async () => {
    const f = fakeLlm(CHUNKS);
    Object.assign(f.llm, {
      listModels: () =>
        new Promise<Array<{ provider: string; id: string; name: string }>>(() => {}),
    });

    const pending = generateReportOutcome(GEN({ llm: f.llm }));
    await vi.advanceTimersByTimeAsync(5000);
    const settled = await settleProbe(pending);
    expect(settled).toMatchObject({
      status: "settled",
      value: {
        status: "failure",
        failure: { kind: "transient", code: "route-resolution-failed" },
        result: { meta: { ok: false, error: "模型路由解析失败" } },
      },
    });
    expect(JSON.stringify(settled)).not.toContain(RAW_PROVIDER_FAILURE);
    expect(vi.getTimerCount()).toBe(0);
  });
}

describe("generate：#1010 残余 C 默认路由发现 5s 有界收敛", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  registerRouteDeadlineAssertions();
});
