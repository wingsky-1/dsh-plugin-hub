// Shape-only support module; all executable assertion bodies are moved verbatim.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createRetryLedger, readLastRun } from "../../../../src/server/schedule/interface.ts";
import type { LlmResolvedModelInfo, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { runDueReportOutcome } from "../../../../src/server/execute/interface.ts";
import {
  RETRY_DAY,
  RETRY_NOW,
  retryDue,
  retryConfig,
  retryTrend,
  retryContext,
  retryLedger,
  commitCurrentThenClear,
  retryExecutor,
  SUCCESS_CHUNKS,
  normalizeCfg,
} from "./report-executor-support.ts";

export function registerExecutorEntryCases(): void {
  it("runner 生成失败返回 tagged outcome，不压成普通 Error", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-runner-outcome-"));
    const { ctx, calls } = retryContext([{ type: "finish", reason: { kind: "stop" } }]);

    try {
      const outcome = await runDueReportOutcome({
        due: retryDue(),
        trend: retryTrend(1),
        ctx,
        reportCfg: retryConfig(),
        promptTemplate: "prompt",
        historyRoot: root,
        sanitizeDiagnostic: (value) => value,
      });

      expect(outcome).toMatchObject({
        status: "failure",
        failure: { kind: "empty-output", code: "empty-output" },
        result: { body: "", meta: { ok: false, error: "模型未产出任何正文" } },
      });
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("unresolved transient route 首次进入 waiting；到期重新 listModels，resolved 后才 stream", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-route-unresolved-"));
    let now = RETRY_NOW;
    let listModelsCalls = 0;
    const ledger = createRetryLedger(root, {
      now: () => now,
      createCycleId: () => "cycle-route-unresolved",
    });
    const commit = commitCurrentThenClear(root, ledger);
    const messages: string[] = [];
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS, undefined, async () => {
      listModelsCalls += 1;
      if (listModelsCalls === 1) {
        throw { code: "TIMEOUT", message: "raw listModels failure must stay hidden" };
      }
      return [{ provider: "generic-provider", id: "generic-model", name: "Generic Model" }];
    });
    const executor = retryExecutor({
      root,
      trend: retryTrend(1),
      ctx,
      ledger,
      commit,
      config: () => normalizeCfg({ provider: "", model: "", push: { enabled: false } }),
      now: () => now,
      warn: (message) => messages.push(message),
    });

    try {
      await expect(executor(retryDue())).rejects.toThrow("模型路由解析失败");
      expect(listModelsCalls).toBe(1);
      expect(calls).toHaveLength(0);
      const waiting = await ledger.get("daily", RETRY_DAY);
      expect(waiting).toMatchObject({ phase: "waiting", attempts: 1, terminal: false });
      expect(waiting?.route.provider).not.toBe("");
      expect(waiting?.route.model).not.toBe("");
      expect(JSON.parse(messages[0]!)).toMatchObject({
        event: "report_attempt",
        code: "route-resolution-failed",
        result: "failure",
      });

      now = RETRY_NOW + 60_000;
      const result = await executor(retryDue());

      expect(result.meta).toMatchObject({
        ok: true,
        provider: "generic-provider",
        model: "generic-model",
      });
      expect(listModelsCalls).toBe(2);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ provider: "generic-provider", model: "generic-model" });
      expect(await ledger.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

export function registerExecutorEffortCase(): void {
  it("unresolved cycle 固定 reasoningEffort 快照，配置变更不漂移", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-effort-snapshot-"));
    let now = RETRY_NOW;
    let configuredEffort = "vendor::A";
    let resolveCalls = 0;
    const effortCalls: Array<string | undefined> = [];
    const ledger = retryLedger(root, () => "cycle-effort-snapshot");
    const commit = commitCurrentThenClear(root, ledger);
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    Object.assign(ctx.llm, {
      resolveModelInfo: async (): Promise<LlmResolvedModelInfo> => ({
        provider: "generic-provider",
        id: "generic-model",
        name: "Generic Model",
        reasoning: {
          efforts: [
            { id: "vendor::A" as ReasoningEffortId, name: "A" },
            { id: "vendor::B" as ReasoningEffortId, name: "B" },
          ],
          defaultEffort: "vendor::A" as ReasoningEffortId,
        },
      }),
    });
    const executor = retryExecutor({
      root,
      trend: retryTrend(1),
      ctx,
      ledger,
      commit,
      config: () => normalizeCfg({ reasoningEffort: configuredEffort }),
      resolveRoute: async (input) => {
        effortCalls.push(input.reasoningEffort);
        resolveCalls += 1;
        if (resolveCalls === 1) {
          return {
            status: "failure",
            route: { provider: "", model: "" },
            failure: { kind: "transient", code: "route-resolution-failed" },
            unresolved: true,
          };
        }
        return {
          status: "success",
          route: {
            provider: "generic-provider",
            model: "generic-model",
            ...(input.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: input.reasoningEffort }),
          },
        };
      },
      now: () => now,
    });

    try {
      await expect(executor(retryDue())).rejects.toThrow("模型路由解析失败");
      expect(effortCalls).toEqual(["vendor::A"]);
      expect((await ledger.get("daily", RETRY_DAY))?.route.reasoningEffort).toBe("vendor::A");

      configuredEffort = "vendor::B";
      now = RETRY_NOW + 60_000;
      const result = await executor(retryDue());
      expect(result.meta?.provider).toBe("generic-provider");
      expect(effortCalls).toEqual(["vendor::A", "vendor::A"]);
      expect(calls[0]?.reasoningEffort).toBe("vendor::A");
      expect(await ledger.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

export function registerExecutorRouteFailureCase(): void {
  it.each([
    { name: "permanent", failure: { kind: "permanent" as const, code: "route-unavailable" } },
    { name: "unknown", failure: { kind: "unknown" as const, code: "route-unknown" } },
  ])("$name route failure 直接 terminal，stream=0", async ({ failure }) => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-route-terminal-"));
    const ledger = retryLedger(root, () => "cycle-route-terminal");
    const commit = commitCurrentThenClear(root, ledger);
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    const executor = retryExecutor({
      root,
      trend: retryTrend(1),
      ctx,
      ledger,
      commit,
      resolveRoute: async () => ({
        status: "failure",
        route: { provider: "", model: "" },
        failure,
      }),
    });

    try {
      await expect(executor(retryDue())).rejects.toThrow();
      expect(calls).toHaveLength(0);
      expect(await ledger.list()).toMatchObject([
        { terminal: true, reason: failure, phase: "terminal" },
      ]);
      expect(commit.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

export function registerExecutorNoDataCase(): void {
  it("noData 仍返回成功 ReportResult，提交 lastRun 并清 claim，模型调用为 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-nodata-"));
    const ledger = retryLedger(root, () => "cycle-nodata");
    const commit = commitCurrentThenClear(root, ledger);
    const messages: string[] = [];
    const { ctx, calls } = retryContext(SUCCESS_CHUNKS);
    const executor = retryExecutor({
      root,
      trend: retryTrend(0),
      ctx,
      ledger,
      commit,
      warn: (message) => messages.push(message),
    });

    try {
      const result = await executor(retryDue());

      expect(result.meta).toMatchObject({ ok: true, noData: true, key: RETRY_DAY, durationMs: 0 });
      expect(calls).toHaveLength(0);
      expect((await readLastRun(root)).daily).toBe(RETRY_DAY);
      expect(await ledger.list()).toEqual([]);
      expect(commit.calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
