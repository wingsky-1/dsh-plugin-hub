/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  renameSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session/types";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pollUntil, callHandler } from "../../helpers.ts";
import { dayKey, sanitizeHtml } from "../../../src/shared/interface.ts";
import { TrendTracker } from "../../../src/server/aggregate/interface.ts";
import {
  TrendCollector,
  type TrendCell,
  type TrendDirRow,
  type TrendHourRow,
} from "../../../src/server/collect/interface.ts";
import {
  TREND_ROW_VERSION,
  TREND_UNIDENTIFIED,
  LAST_RUN_SCHEMA,
  deriveLastRun,
  isClosedWindowRecord,
  parseHHMM,
  DEFAULT_DAILY_PROMPT,
  DEFAULT_WEEKLY_PROMPT,
  DEFAULT_MONTHLY_PROMPT,
  DEFAULT_PROMPTS,
  LEGACY_PROMPT_TEMPLATE,
  LEGACY_DAILY_PROMPT_V1,
  LEGACY_WEEKLY_PROMPT_V1,
  LEGACY_MONTHLY_PROMPT_V1,
  LEGACY_DAILY_PROMPT_V2,
  LEGACY_WEEKLY_PROMPT_V2,
  LEGACY_MONTHLY_PROMPT_V2,
  LEGACY_DAILY_PROMPT_V3,
  LEGACY_WEEKLY_PROMPT_V3,
  LEGACY_MONTHLY_PROMPT_V3,
  LEGACY_DAILY_PROMPT_V4,
  LEGACY_WEEKLY_PROMPT_V4,
  LEGACY_MONTHLY_PROMPT_V4,
} from "../../../src/server/shared/interface.ts";
import {
  ReportScheduler,
  ReportTaskQueue,
  candidateWindow,
  ensureLastRunMigrated,
  pendingReports,
  presetLastRunForNewlyEnabled,
  previousClosedWindow,
  updateLastRun,
  writeLastRun,
  readLastRun,
  type DueReport,
  type ReportTaskInput,
} from "../../../src/server/schedule/interface.ts";
import {
  DEFAULT_REPORT_CONFIG,
  normalizeReportConfig,
  promptFor,
  writeReportConfig,
  readReportConfig,
  type ReportConfig,
  type ReportPeriod,
} from "../../../src/server/config/interface.ts";
import {
  applyPromptTemplate,
  buildStatsSnapshot,
  generateReport,
  generateReportOutcome,
  resolveGenerateRoute,
  parseReportIndexLines,
  persistReport,
  readReportIndex,
  reportBodyToHtml,
  reportHtmlFile,
  reportMetaFile,
  runDueReport,
  notifyReport,
  type ReportLlmService,
  type ReportMeta,
  type ReportResult,
} from "../../../src/server/execute/interface.ts";
import {
  handleReportStatus,
  type ReportRoutesContext,
} from "../../../src/server/report-routes/interface.ts";
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmResolvedModelInfo,
  ReasoningEffortId,
  StreamChunk,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import { __lastRunChainForTests } from "../../../src/server/schedule/store.ts";
import {
  __clearReportIndexCacheForTests,
  __reportIndexCacheStatsForTests,
} from "../../../src/server/execute/runner.ts";

const textOf = (block: unknown): string => (block as { text: string }).text;
/** fakeLlm 观测快照：逐次保存 stream 入参，并记录 exact-model capability 查询。 */
interface LlmSeen {
  listProvidersCalls: number;
  listModelsCalls: string[];
  calls: GenerateOptions[];
  resolveCalls: Array<{ provider: string; model: string; signal?: AbortSignal }>;
}

export type StatsSnapshot = ReturnType<typeof buildStatsSnapshot>;

/** 固定本地时刻：2026-09-04（周五）12:00。 */
const T0 = new Date(2026, 8, 4, 12, 0, 0).getTime();
const HOUR = 3600_000;

const CFG = (over: Record<string, unknown> = {}): ReportConfig =>
  normalizeReportConfig({
    daily: { enabled: true, time: "22:00" },
    weekly: { enabled: true, time: "09:00", weekStartsOn: 1 },
    monthly: { enabled: true, time: "09:00", dayOfMonth: 1 },
    ...over,
  });

const CHUNKS: StreamChunk[] = [
  { type: "text-delta", index: 0, text: "第一段。" },
  { type: "text-delta", index: 0, text: "第二段。" },
  { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  // finish 原因走官方对象形态；未知终态必须 fail closed。
  { type: "finish", reason: { kind: "stop" } },
];

interface FakeLlmOptions {
  throwInStream?: string;
  throwInListProviders?: string;
  throwInListModels?: string;
  noProviders?: boolean;
  noModels?: boolean;
  capability?: LlmResolvedModelInfo;
  capabilityError?: string;
  capabilityNever?: boolean;
  /** 边界测试用：明确模拟 provider 完全忽略 GenerateOptions.signal。 */
  streamSignalMode?: "ignore";
  onStreamStart?: () => void;
  streamGate?: Promise<void>;
}

/** fake llm：罐头 chunk 流；seen 记录 route、stream 与可选 exact-model capability 查询。 */
function fakeLlm(
  chunks: StreamChunk[] = CHUNKS,
  opts: FakeLlmOptions = {},
): {
  llm: ReportLlmService;
  seen: LlmSeen;
} {
  const seen: LlmSeen = {
    listProvidersCalls: 0,
    listModelsCalls: [],
    calls: [],
    resolveCalls: [],
  };
  const llm: ReportLlmService = {
    stream(o: GenerateOptions): AsyncIterable<StreamChunk> {
      seen.calls.push({ ...o, messages: [...o.messages] });
      return (async function* (): AsyncGenerator<StreamChunk> {
        if (opts.throwInStream) throw new Error(opts.throwInStream);
        if (o.signal?.aborted && opts.streamSignalMode !== "ignore") {
          throw new Error("aborted before start");
        }
        opts.onStreamStart?.();
        if (opts.streamGate !== undefined) await opts.streamGate;
        yield* chunks;
      })();
    },
    listProviders: () => {
      seen.listProvidersCalls += 1;
      if (opts.throwInListProviders !== undefined) throw new Error(opts.throwInListProviders);
      return opts.noProviders
        ? []
        : [
            { id: "prov-a", name: "A" },
            { id: "prov-b", name: "B" },
          ];
    },
    listModels: async (provider) => {
      seen.listModelsCalls.push(provider);
      if (opts.throwInListModels !== undefined) throw new Error(opts.throwInListModels);
      return opts.noModels ? [] : [{ provider: "prov-a", id: "model-a", name: "A" }];
    },
  };
  const capability = opts.capability;
  if (
    capability !== undefined ||
    opts.capabilityError !== undefined ||
    opts.capabilityNever === true
  ) {
    Object.assign(llm, {
      async resolveModelInfo(provider: string, model: string, signal?: AbortSignal) {
        seen.resolveCalls.push({ provider, model, signal });
        if (opts.capabilityNever === true) {
          return new Promise<LlmResolvedModelInfo>(() => {});
        }
        if (opts.capabilityError !== undefined) throw new Error(opts.capabilityError);
        if (capability === undefined) throw new Error("capability fixture missing");
        return capability;
      },
    });
  }
  return { llm, seen };
}

// GEN 的 llm 调用方恒覆写（全调用点均传 llm；null 默认永不被观测）：
// 以必填收敛，调用缺 llm 即红。
type GenOpts = Parameters<typeof generateReportOutcome>[0];
const GEN = (over: Partial<GenOpts> & { llm: ReportLlmService }): GenOpts => ({
  period: "daily",
  key: "2026-09-04",
  startDay: "2026-09-04",
  endDay: "2026-09-04",
  statsJson: '{"calls":1}',
  promptTemplate: "统计：{stats}",
  provider: "",
  model: "",
  ...over,
});

export {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  renameSync,
  utimesSync,
  rmSync,
  join,
  tmpdir,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  pollUntil,
  callHandler,
  dayKey,
  sanitizeHtml,
  TrendTracker,
  TrendCollector,
  TREND_ROW_VERSION,
  TREND_UNIDENTIFIED,
  ReportScheduler,
  ReportTaskQueue,
  candidateWindow,
  ensureLastRunMigrated,
  pendingReports,
  presetLastRunForNewlyEnabled,
  previousClosedWindow,
  updateLastRun,
  writeLastRun,
  readLastRun,
  textOf,
  fakeLlm,
  CFG,
  CHUNKS,
  GEN,
  T0,
  HOUR,
  LAST_RUN_SCHEMA,
  deriveLastRun,
  isClosedWindowRecord,
  DEFAULT_REPORT_CONFIG,
  normalizeReportConfig,
  promptFor,
  writeReportConfig,
  readReportConfig,
  parseHHMM,
  applyPromptTemplate,
  buildStatsSnapshot,
  generateReport,
  generateReportOutcome,
  resolveGenerateRoute,
  parseReportIndexLines,
  persistReport,
  readReportIndex,
  reportBodyToHtml,
  reportHtmlFile,
  reportMetaFile,
  runDueReport,
  notifyReport,
  handleReportStatus,
  __lastRunChainForTests,
  __clearReportIndexCacheForTests,
  __reportIndexCacheStatsForTests,
  DEFAULT_DAILY_PROMPT,
  DEFAULT_WEEKLY_PROMPT,
  DEFAULT_MONTHLY_PROMPT,
  DEFAULT_PROMPTS,
  LEGACY_PROMPT_TEMPLATE,
  LEGACY_DAILY_PROMPT_V1,
  LEGACY_WEEKLY_PROMPT_V1,
  LEGACY_MONTHLY_PROMPT_V1,
  LEGACY_DAILY_PROMPT_V2,
  LEGACY_WEEKLY_PROMPT_V2,
  LEGACY_MONTHLY_PROMPT_V2,
  LEGACY_DAILY_PROMPT_V3,
  LEGACY_WEEKLY_PROMPT_V3,
  LEGACY_MONTHLY_PROMPT_V3,
  LEGACY_DAILY_PROMPT_V4,
  LEGACY_WEEKLY_PROMPT_V4,
  LEGACY_MONTHLY_PROMPT_V4,
};

export type {
  IncomingMessage,
  ServerResponse,
  Context,
  SessionEvent,
  TrendCell,
  TrendDirRow,
  TrendHourRow,
  LlmSeen,
  DueReport,
  ReportTaskInput,
  ReportConfig,
  ReportPeriod,
  ReportLlmService,
  ReportMeta,
  ReportResult,
  ReportRoutesContext,
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmResolvedModelInfo,
  ReasoningEffortId,
  StreamChunk,
  ToolCallId,
};
