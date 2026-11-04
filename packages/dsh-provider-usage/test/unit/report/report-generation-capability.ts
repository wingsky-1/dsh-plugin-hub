/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHUNKS, GEN, fakeLlm, generateReport } from "./report-generation-support.ts";
import { GENERIC_CAPABILITY, GENERIC_WITHOUT_REASONING } from "./report-generation-fixtures.ts";

function registerBaseCapabilityCases(): void {
  it("未设置时不查询 capability，GenerateOptions 不创建属性且 stream=1", async () => {
    const f = fakeLlm(CHUNKS, { capability: GENERIC_CAPABILITY });

    const result = await generateReport(
      GEN({ llm: f.llm, provider: "generic-provider", model: "generic-model" }),
    );

    expect(result.meta.ok).toBe(true);
    expect(f.seen.resolveCalls).toHaveLength(0);
    expect(f.seen.calls).toHaveLength(1);
    expect(Object.hasOwn(f.seen.calls[0]!, "reasoningEffort")).toBe(false);
  });

  it("合法 opaque ID 精确命中后以 capability branded ID 传入且 stream=1", async () => {
    const f = fakeLlm(CHUNKS, { capability: GENERIC_CAPABILITY });

    const result = await generateReport(
      GEN({
        llm: f.llm,
        provider: "generic-provider",
        model: "generic-model",
        reasoningEffort: "vendor::deep",
      }),
    );

    expect(result.meta.ok).toBe(true);
    expect(f.seen.resolveCalls).toEqual([
      {
        provider: "generic-provider",
        model: "generic-model",
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(f.seen.resolveCalls[0]!.signal?.aborted).toBe(false);
    expect(f.seen.calls).toHaveLength(1);
    expect(f.seen.calls[0]!.reasoningEffort).toBe("vendor::deep");
  });

  it("stale/unknown ID 不精确命中时 fail closed 且 stream=0", async () => {
    const f = fakeLlm(CHUNKS, { capability: GENERIC_CAPABILITY });

    const result = await generateReport(
      GEN({
        llm: f.llm,
        provider: "generic-provider",
        model: "generic-model",
        reasoningEffort: "vendor::retired",
      }),
    );

    expect(result.meta.ok).toBe(false);
    expect(result.meta.error).toBe("配置指定的思考等级不受当前模型支持");
    expect(f.seen.resolveCalls).toHaveLength(1);
    expect(f.seen.calls).toHaveLength(0);
  });

  it("exact model 无 reasoning capability 时 fail closed 且 stream=0", async () => {
    const f = fakeLlm(CHUNKS, { capability: GENERIC_WITHOUT_REASONING });

    const result = await generateReport(
      GEN({
        llm: f.llm,
        provider: "generic-provider",
        model: "generic-model",
        reasoningEffort: "vendor::deep",
      }),
    );

    expect(result.meta.ok).toBe(false);
    expect(result.meta.error).toBe("配置指定的思考等级不受当前模型支持");
    expect(f.seen.resolveCalls).toHaveLength(1);
    expect(f.seen.calls).toHaveLength(0);
  });

  it("resolver 缺失时 fail closed 且 stream=0", async () => {
    const f = fakeLlm();

    const result = await generateReport(
      GEN({
        llm: f.llm,
        provider: "generic-provider",
        model: "generic-model",
        reasoningEffort: "vendor::deep",
      }),
    );

    expect(result.meta.ok).toBe(false);
    expect(result.meta.error).toBe("模型能力信息不可用");
    expect(f.seen.resolveCalls).toHaveLength(0);
    expect(f.seen.calls).toHaveLength(0);
  });

  it("resolver 抛错时 fail closed 且 stream=0", async () => {
    const f = fakeLlm(CHUNKS, { capabilityError: "capability boom" });

    const result = await generateReport(
      GEN({
        llm: f.llm,
        provider: "generic-provider",
        model: "generic-model",
        reasoningEffort: "vendor::deep",
      }),
    );

    expect(result.meta.ok).toBe(false);
    expect(result.meta.error).toBe("模型能力解析失败");
    expect(f.seen.resolveCalls).toHaveLength(1);
    expect(f.seen.calls).toHaveLength(0);
  });
}

function registerCapabilityDeadlineCases(): void {
  describe("5s deadline 与调用方取消", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("never-settling resolver 恰在 5s fail closed、取消底层 signal 且 stream=0", async () => {
      const f = fakeLlm(CHUNKS, { capabilityNever: true });
      const pending = generateReport(
        GEN({
          llm: f.llm,
          provider: "generic-provider",
          model: "generic-model",
          reasoningEffort: "vendor::deep",
        }),
      );
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(4999);
      expect(f.seen.resolveCalls).toHaveLength(1);
      expect(f.seen.resolveCalls[0]!.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(settled).toBe(true);
      const result = await pending;
      expect(result.meta).toMatchObject({ ok: false, error: "模型能力解析超时" });
      expect(result.body).toBe("");
      expect(f.seen.resolveCalls[0]!.signal?.aborted).toBe(true);
      expect(f.seen.calls).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("调用方 signal 已取消时入口直接取消且不启动 resolver/stream", async () => {
      const controller = new AbortController();
      controller.abort();
      const f = fakeLlm(CHUNKS, { capability: GENERIC_CAPABILITY });

      const result = await generateReport(
        GEN({
          llm: f.llm,
          provider: "generic-provider",
          model: "generic-model",
          reasoningEffort: "vendor::deep",
          signal: controller.signal,
        }),
      );

      expect(result.meta).toMatchObject({ ok: false, error: "模型请求已取消" });
      expect(result.body).toBe("");
      expect(f.seen.resolveCalls).toHaveLength(0);
      expect(f.seen.calls).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("resolver 忽略 signal 时调用方 abort 仍立即 fail closed 并清 timer", async () => {
      const controller = new AbortController();
      const f = fakeLlm(CHUNKS, { capabilityNever: true });
      const pending = generateReport(
        GEN({
          llm: f.llm,
          provider: "generic-provider",
          model: "generic-model",
          reasoningEffort: "vendor::deep",
          signal: controller.signal,
        }),
      );
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(f.seen.resolveCalls).toHaveLength(1);
      expect(f.seen.resolveCalls[0]!.signal?.aborted).toBe(false);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(true);
      const result = await pending;
      expect(result.meta).toMatchObject({ ok: false, error: "模型能力解析已取消" });
      expect(f.seen.resolveCalls[0]!.signal?.aborted).toBe(true);
      expect(f.seen.calls).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
}

describe("generate：reasoningEffort exact-model capability", () => {
  registerBaseCapabilityCases();
  registerCapabilityDeadlineCases();
});
