// Shape-only support module; all executable assertion bodies are moved verbatim.
import { existsSync, readFileSync } from "node:fs";
import { retryFenceFile, type RetryLedgerPort } from "../../../../src/server/schedule/interface.ts";
import { RETRY_DAY, RETRY_NOW } from "./report-executor-support.ts";

/** 报告成功 meta + 正文（commit persist 用）。 */
export function commitFixtureResult() {
  return {
    body: "报告正文",
    meta: {
      period: "daily" as const,
      key: RETRY_DAY,
      startDay: RETRY_DAY,
      endDay: RETRY_DAY,
      provider: "generic-provider",
      model: "generic-model",
      generatedAt: RETRY_NOW,
      durationMs: 1,
      ok: true as const,
    },
  };
}

/** 一次性失败的端口包装（注入真实 I/O 失败，不改生产代码）。 */
export function failingPort(
  base: RetryLedgerPort,
  overrides: Partial<RetryLedgerPort>,
): RetryLedgerPort {
  return { ...base, ...overrides };
}

/** 读围栏文件；未落盘即空围栏（无 marker 是合法状态）。 */
export function fenceEntries(root: string): {
  commits: Array<{ period: string; key: string; cycleId: string }>;
  storageTerminals: Array<{ period: string; key: string; cycleId: string }>;
} {
  const file = retryFenceFile(root);
  if (!existsSync(file)) return { commits: [], storageTerminals: [] };
  return JSON.parse(readFileSync(file, "utf8")) as {
    commits: Array<{ period: string; key: string; cycleId: string }>;
    storageTerminals: Array<{ period: string; key: string; cycleId: string }>;
  };
}
