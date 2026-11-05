// Shape-only support module; all executable assertion bodies are moved verbatim.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { type ReportTaskInput } from "../../../../src/server/schedule/interface.ts";
import type { TrendTracker } from "../../../../src/server/aggregate/interface.ts";
import type { Context } from "@deepseek-ai/cordis";
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  ReasoningEffortId,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { runDueReport, generateReportOutcome } from "../../../../src/server/execute/interface.ts";
import { RETRY_DAY, retryContext, normalizeCfg } from "./report-executor-support.ts";

export function registerReasoningEffortSuite(): void {
  describe("runner：reportCfg.reasoningEffort 透传到生成边界", () => {
    it("先按 exact model 校验，再把 branded ID 传入唯一 stream 调用", async () => {
      const root = mkdtempSync(join(tmpdir(), "u-runner-reasoning-effort-"));
      const streamCalls: GenerateOptions[] = [];
      const resolveCalls: Array<{ provider: string; model: string }> = [];
      const effort = "vendor::deep" as ReasoningEffortId;
      const capability: LlmResolvedModelInfo = {
        provider: "generic-provider",
        id: "generic-model",
        name: "Generic Model",
        reasoning: {
          efforts: [{ id: effort, name: "Deep" }],
          defaultEffort: effort,
        },
      };
      const chunks: StreamChunk[] = [
        { type: "text-delta", index: 0, text: "runner report" },
        { type: "finish", reason: { kind: "stop" } },
      ];
      const ctx = {
        llm: {
          stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
            streamCalls.push({ ...options, messages: [...options.messages] });
            return (async function* (): AsyncGenerator<StreamChunk> {
              yield* chunks;
            })();
          },
          listProviders: () => [{ id: "generic-provider", name: "Generic" }],
          listModels: async () => [
            { provider: "generic-provider", id: "generic-model", name: "Generic Model" },
          ],
          resolveModelInfo: async (provider: string, model: string) => {
            resolveCalls.push({ provider, model });
            return capability;
          },
        },
      } as unknown as Context;
      const trend = {
        buckets: () => [
          {
            day: "2026-09-05",
            providers: [
              {
                provider: "generic-provider",
                model: "generic-model",
                cell: {
                  input: 2,
                  output: 3,
                  cacheRead: null,
                  cacheWrite: null,
                  calls: 1,
                  turns: 1,
                  toolCalls: 0,
                },
              },
            ],
          },
        ],
        dirRows: () => [],
        hourRows: () => [],
      } as unknown as TrendTracker;
      const due: ReportTaskInput = {
        period: "daily",
        key: "2026-09-05",
        startDay: "2026-09-05",
        endDay: "2026-09-05",
        force: false,
      };
      const reportCfg = normalizeCfg({
        provider: "generic-provider",
        model: "generic-model",
        reasoningEffort: "vendor::deep",
        push: { enabled: false },
      });

      try {
        const result = await runDueReport({
          due,
          trend,
          ctx,
          reportCfg,
          promptTemplate: "prompt",
          historyRoot: root,
          sanitizeDiagnostic: (value) => value,
        });

        expect(result.ok).toBe(true);
        expect(resolveCalls).toEqual([{ provider: "generic-provider", model: "generic-model" }]);
        expect(streamCalls).toHaveLength(1);
        expect(streamCalls[0]!.reasoningEffort).toBe("vendor::deep");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}

export function registerB3aSuite(): void {
  describe("B3a：报告 attempt token 观测红灯", () => {
    it("保留 reasoningTokens、缺失 token 字段为 null，并记录 fake-clock durationMs", async () => {
      const { ctx } = retryContext([
        { type: "text-delta", index: 0, text: "报告正文" },
        {
          type: "usage",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 7 },
        },
        { type: "finish", reason: { kind: "stop" } },
      ]);
      let tick = 1_000;
      const result = await generateReportOutcome({
        llm: ctx.llm,
        period: "daily",
        key: RETRY_DAY,
        startDay: RETRY_DAY,
        endDay: RETRY_DAY,
        statsJson: "{}",
        promptTemplate: "prompt",
        provider: "generic-provider",
        model: "generic-model",
        now: () => {
          const value = tick;
          tick += 125;
          return value;
        },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") throw new Error("expected successful generation");
      expect(result.result.meta.tokens).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 7,
        totalTokens: 15,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      });
      expect(result.result.meta.durationMs).toBe(125);
    });

    it("abort 记录稳定终态 code，不把取消异常原文写入观测", async () => {
      const controller = new AbortController();
      controller.abort();
      const { ctx } = retryContext([], async () => {
        throw new Error("raw abort secret must stay hidden");
      });
      const result = await generateReportOutcome({
        llm: ctx.llm,
        period: "daily",
        key: RETRY_DAY,
        startDay: RETRY_DAY,
        endDay: RETRY_DAY,
        statsJson: "{}",
        promptTemplate: "prompt",
        provider: "generic-provider",
        model: "generic-model",
        signal: controller.signal,
      });

      expect(result.status).toBe("failure");
      if (result.status !== "failure") throw new Error("expected aborted generation");
      expect(result.failure).toEqual({ kind: "aborted", code: "request-aborted" });
      expect(result.attempt).toMatchObject({ durationMs: expect.any(Number), tokens: null });
      expect(JSON.stringify(result)).not.toContain("raw");
    });
  });
}
