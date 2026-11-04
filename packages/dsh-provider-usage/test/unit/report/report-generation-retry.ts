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
  generateReportOutcome,
  type ReportLlmService,
  type StreamChunk,
} from "./report-generation-support.ts";
import { GENERIC_CAPABILITY, RAW_PROVIDER_FAILURE } from "./report-generation-fixtures.ts";

function registerRetryAbortCases(): void {
  it("无 reasoningEffort 的 pre-abort 在 route/capability/stream 前稳定失败", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fakeLlm(CHUNKS, {
      capability: GENERIC_CAPABILITY,
      streamSignalMode: "ignore",
      throwInListProviders: RAW_PROVIDER_FAILURE,
    });

    const outcome = await generateReportOutcome(GEN({ llm: f.llm, signal: controller.signal }));

    expect(outcome).toMatchObject({
      status: "failure",
      failure: { kind: "aborted", code: "request-aborted" },
      result: {
        body: "",
        meta: { ok: false, error: "模型请求已取消", provider: "", model: "" },
      },
    });
    expect(f.seen.listProvidersCalls).toBe(0);
    expect(f.seen.listModelsCalls).toEqual([]);
    expect(f.seen.resolveCalls).toHaveLength(0);
    expect(f.seen.calls).toHaveLength(0);
  });

  it("流中 abort 不等待忽略 signal 的 provider 并稳定收口", async () => {
    let releaseStream = (): void => {};
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let notifyStreamStarted = (): void => {};
    const streamStarted = new Promise<void>((resolve) => {
      notifyStreamStarted = resolve;
    });
    const f = fakeLlm(CHUNKS, {
      streamSignalMode: "ignore",
      onStreamStart: notifyStreamStarted,
      streamGate,
    });
    const controller = new AbortController();

    const pending = generateReportOutcome(
      GEN({
        llm: f.llm,
        provider: "generic-provider",
        model: "generic-model",
        signal: controller.signal,
      }),
    );
    await streamStarted;
    controller.abort();

    const unsettled = Symbol("unsettled");
    const observed = await Promise.race([
      pending,
      (async () => {
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
        return unsettled;
      })(),
    ]);
    releaseStream();
    const outcome = await pending;

    expect(observed).not.toBe(unsettled);
    expect(outcome).toMatchObject({
      status: "failure",
      failure: { kind: "aborted", code: "request-aborted" },
      result: { body: "", meta: { ok: false, error: "模型请求已取消" } },
    });
    expect(f.seen.calls).toHaveLength(1);
    expect(f.seen.calls[0]!.signal).toBe(controller.signal);
  });

  it("caller abort 后的 stream throw 仍归 aborted 且不泄漏 provider 原文", async () => {
    const controller = new AbortController();
    const f = fakeLlm();
    let streamCalls = 0;
    const llm: ReportLlmService = {
      ...f.llm,
      stream: () => {
        streamCalls += 1;
        controller.abort();
        throw new Error(RAW_PROVIDER_FAILURE);
      },
    };

    const outcome = await generateReportOutcome(
      GEN({
        llm,
        provider: "generic-provider",
        model: "generic-model",
        signal: controller.signal,
      }),
    );

    expect(outcome).toMatchObject({
      status: "failure",
      failure: { kind: "aborted", code: "request-aborted" },
      result: { body: "", meta: { ok: false, error: "模型请求已取消" } },
    });
    expect(streamCalls).toBe(1);
    expect(JSON.stringify(outcome)).not.toContain(RAW_PROVIDER_FAILURE);
  });
}

function registerRetryTerminalCases(): void {
  it("reasoning-only 标记 empty-output/reasoning-only 且不保留推理原文", async () => {
    const privateReasoning = "provider reasoning secret must not escape";
    const f = fakeLlm([
      { type: "reasoning-delta", index: 0, text: privateReasoning },
      { type: "finish", reason: { kind: "stop" } },
    ]);

    const outcome = await generateReportOutcome(GEN({ llm: f.llm }));

    expect(outcome).toMatchObject({
      status: "failure",
      failure: { kind: "empty-output", code: "reasoning-only" },
      result: { body: "", meta: { ok: false, error: "模型仅返回推理过程未产出正文" } },
    });
    expect(JSON.stringify(outcome)).not.toContain(privateReasoning);
  });

  it("finish 后 provider 再抛错按 protocol-after-terminal 收口", async () => {
    const f = fakeLlm();
    const llm: ReportLlmService = {
      ...f.llm,
      stream: () =>
        (async function* (): AsyncGenerator<StreamChunk> {
          yield { type: "finish", reason: { kind: "stop" } };
          throw { code: "SERVER", message: RAW_PROVIDER_FAILURE };
        })(),
    };
    const outcome = await generateReportOutcome(GEN({ llm }));

    expect(outcome).toMatchObject({
      status: "failure",
      failure: { kind: "unknown", code: "protocol-after-terminal" },
      result: { body: "", meta: { ok: false, error: "模型在结束后仍返回内容" } },
    });
    expect(JSON.stringify(outcome)).not.toContain(RAW_PROVIDER_FAILURE);
  });

  it("流异常前已收到的 usage 仍进入失败 attempt 观测", async () => {
    const f = fakeLlm();
    const llm: ReportLlmService = {
      ...f.llm,
      stream: () =>
        (async function* (): AsyncGenerator<StreamChunk> {
          yield {
            type: "usage",
            usage: {
              inputTokens: 7,
              outputTokens: 3,
              reasoningTokens: 1,
              totalTokens: 10,
              cacheReadTokens: 2,
              cacheWriteTokens: 1,
            },
          };
          throw { code: "SERVER", message: RAW_PROVIDER_FAILURE };
        })(),
    };
    const outcome = await generateReportOutcome(GEN({ llm }));

    expect(outcome).toMatchObject({
      status: "failure",
      failure: { kind: "transient", code: "provider-stream-failed" },
      attempt: {
        tokens: {
          inputTokens: 7,
          outputTokens: 3,
          reasoningTokens: 1,
          totalTokens: 10,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
        },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain(RAW_PROVIDER_FAILURE);
  });

  it("普通流异常只暴露 unknown/provider-stream-failed，不携带 provider 原文", async () => {
    const rawProviderError = "key=private path=/private/report response=private";
    const f = fakeLlm(CHUNKS, { throwInStream: rawProviderError });

    const outcome = await generateReportOutcome(GEN({ llm: f.llm }));

    expect(outcome).toMatchObject({
      status: "failure",
      failure: { kind: "unknown", code: "provider-stream-failed" },
      result: { body: "", meta: { ok: false, error: "模型请求失败" } },
    });
    expect(JSON.stringify(outcome)).not.toContain(rawProviderError);
  });
}

describe("generate：结构化 retry outcome", () => {
  registerRetryAbortCases();
  registerRetryTerminalCases();
});
