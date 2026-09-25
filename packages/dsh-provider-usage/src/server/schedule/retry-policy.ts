/**
 * dsh-provider-usage — 报告重试纯状态机（#1010 B1）。
 *
 * 本文件只回答 cycle 内状态如何转移，不读取配置、不分配 cycleId、不做 I/O。
 * route 是 initial/force 时刻的不可变快照；调用方须用 cycleId 做 CAS，
 * 防止旧 cycle 的完成回调覆盖 force 创建的新 cycle。
 */

import type { ReportPeriod } from "../config/interface.ts";

export const RETRY_MAX_ATTEMPTS = 5 as const;
export const RETRY_BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 960_000] as const;

export type RetryFailureKind =
  "transient" | "empty-output" | "permanent" | "aborted" | "unknown" | "storage";

export type RetryPhase = "initial" | "waiting" | "in-flight" | "terminal";

export interface RetryRouteSnapshot {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface RetrySeed {
  period: ReportPeriod;
  key: string;
  startDay: string;
  endDay: string;
  route: RetryRouteSnapshot;
}

export interface RetryFailure {
  code: string;
  kind: RetryFailureKind;
}

export interface RetryTerminalReason {
  code: string;
  kind: RetryFailureKind;
}

/** 报告级 attempt 的安全 token 形状；不携带 provider 原文或推理文本。 */
export interface RetryAttemptTokens {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/** 单次报告 outer attempt 的安全观测；attempt 从 1 开始。 */
export interface RetryAttemptObservation {
  attempt: number;
  result: "success" | "failure";
  code: string | null;
  status: "success" | "retry" | "terminal" | "aborted";
  durationMs: number | null;
  tokens: RetryAttemptTokens;
}

/** 周期累计事实；任一 attempt 缺失某字段时，该字段保持 null。 */
export interface RetryUsageTotals extends RetryAttemptTokens {
  durationMs: number | null;
}

export interface RetryEntry extends RetrySeed {
  attempts: number;
  maxAttempts: typeof RETRY_MAX_ATTEMPTS;
  nextRetryAt: number | null;
  terminal: boolean;
  reason: RetryTerminalReason | null;
  cycleId: string;
  phase: RetryPhase;
  attemptObservations: RetryAttemptObservation[];
  usage: RetryUsageTotals;
}

export interface RetryClaim {
  cycleId: string;
  entry: RetryEntry;
}

export interface RetryIndexKey {
  period: ReportPeriod;
  key: string;
  /** 成功 index 的事务 cycle；legacy/异 cycle 记录不能证明当前 claim。 */
  cycleId?: string;
}

function routeSnapshot(route: RetryRouteSnapshot): RetryRouteSnapshot {
  if (route.reasoningEffort === undefined) {
    return { provider: route.provider, model: route.model };
  }
  return { ...route };
}

function requireCycleId(cycleId: string): void {
  if (cycleId.length === 0) throw new Error("retry cycleId must not be empty");
}

const FAILURE_KINDS = new Set<RetryFailureKind>([
  "transient",
  "empty-output",
  "permanent",
  "aborted",
  "unknown",
  "storage",
]);

function requireFailure(failure: RetryFailure): void {
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(failure.code)) {
    throw new Error("retry failure code must be a stable identifier");
  }
  if (!FAILURE_KINDS.has(failure.kind)) {
    throw new Error("retry failure kind is invalid");
  }
}

function isRetryable(kind: RetryFailureKind): boolean {
  return kind === "transient" || kind === "empty-output";
}

const ATTEMPT_RESULTS = new Set<RetryAttemptObservation["result"]>(["success", "failure"]);
const ATTEMPT_STATUSES = new Set<RetryAttemptObservation["status"]>([
  "success",
  "retry",
  "terminal",
  "aborted",
]);

export function emptyRetryAttemptTokens(): RetryAttemptTokens {
  return {
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  };
}

export function emptyRetryUsage(): RetryUsageTotals {
  return { ...emptyRetryAttemptTokens(), durationMs: null };
}

function safeMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function validAttemptTokens(value: unknown): value is RetryAttemptTokens {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ];
  if (Object.keys(record).length !== keys.length) return false;
  return keys.every((key) => record[key] === null || safeMetric(record[key]) !== null);
}

function requireObservation(observation: RetryAttemptObservation): void {
  if (!Number.isInteger(observation.attempt) || observation.attempt < 1) {
    throw new Error("retry observation attempt must be a positive integer");
  }
  if (!ATTEMPT_RESULTS.has(observation.result)) {
    throw new Error("retry observation result is invalid");
  }
  if (!ATTEMPT_STATUSES.has(observation.status)) {
    throw new Error("retry observation status is invalid");
  }
  if (observation.code !== null && !/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(observation.code)) {
    throw new Error("retry observation code must be stable");
  }
  if (observation.result === "success" && observation.code !== null) {
    throw new Error("successful retry observation must not have a failure code");
  }
  if (observation.result === "failure" && observation.code === null) {
    throw new Error("failed retry observation must have a failure code");
  }
  if (
    (observation.result === "success" && observation.status !== "success") ||
    (observation.result === "failure" && observation.status === "success")
  ) {
    throw new Error("retry observation result and status are inconsistent");
  }
  if (observation.status === "retry" && observation.attempt > RETRY_MAX_ATTEMPTS) {
    throw new Error("retry observation status and attempt are inconsistent");
  }
  if (!validAttemptTokens(observation.tokens)) {
    throw new Error("retry observation tokens are invalid");
  }
  if (
    observation.durationMs !== null &&
    (typeof observation.durationMs !== "number" ||
      !Number.isFinite(observation.durationMs) ||
      observation.durationMs < 0)
  ) {
    throw new Error("retry observation duration is invalid");
  }
}

function addNullable(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}

export function mergeRetryUsage(
  previous: RetryUsageTotals | null,
  tokens: RetryAttemptTokens,
  durationMs: number | null,
): RetryUsageTotals {
  if (previous === null) {
    return { ...tokens, durationMs };
  }
  return {
    inputTokens: addNullable(previous.inputTokens, tokens.inputTokens),
    outputTokens: addNullable(previous.outputTokens, tokens.outputTokens),
    reasoningTokens: addNullable(previous.reasoningTokens, tokens.reasoningTokens),
    totalTokens: addNullable(previous.totalTokens, tokens.totalTokens),
    cacheReadTokens: addNullable(previous.cacheReadTokens, tokens.cacheReadTokens),
    cacheWriteTokens: addNullable(previous.cacheWriteTokens, tokens.cacheWriteTokens),
    durationMs: addNullable(previous.durationMs, durationMs),
  };
}

export function usageFromRetryObservations(
  observations: readonly RetryAttemptObservation[],
): RetryUsageTotals {
  return (
    observations.reduce<RetryUsageTotals | null>(
      (total, current) => mergeRetryUsage(total, current.tokens, current.durationMs),
      null,
    ) ?? emptyRetryUsage()
  );
}

export function usageAfterRetryObservation(
  entry: RetryEntry,
  observation: RetryAttemptObservation,
): RetryUsageTotals {
  requireObservation(observation);
  const index = entry.attemptObservations.findIndex(
    (current) => current.attempt === observation.attempt,
  );
  const observations = [...entry.attemptObservations];
  if (index >= 0) observations[index] = observation;
  else observations.push(observation);
  return usageFromRetryObservations(observations);
}

export function addRetryObservation(
  claim: RetryClaim,
  observation: RetryAttemptObservation,
): RetryClaim {
  requireObservation(observation);
  if (claim.cycleId !== claim.entry.cycleId || claim.entry.phase !== "in-flight") {
    throw new Error("retry observation claim is not in-flight");
  }
  const existingIndex = claim.entry.attemptObservations.findIndex(
    (current) => current.attempt === observation.attempt,
  );
  if (existingIndex < 0 && observation.attempt !== claim.entry.attempts + 1) {
    throw new Error("retry observation attempt does not match claim");
  }
  if (existingIndex >= 0 && existingIndex !== claim.entry.attemptObservations.length - 1) {
    throw new Error("retry observation replacement is not the latest attempt");
  }
  if (
    existingIndex >= 0 &&
    (claim.entry.attemptObservations[existingIndex]?.result !== "success" ||
      observation.result !== "failure")
  ) {
    throw new Error("retry observation replacement must change a success attempt to failure");
  }
  const attemptObservations = [...claim.entry.attemptObservations];
  if (existingIndex >= 0) attemptObservations[existingIndex] = observation;
  else attemptObservations.push(observation);
  return {
    cycleId: claim.cycleId,
    entry: {
      ...claim.entry,
      route: routeSnapshot(claim.entry.route),
      attemptObservations,
      usage: usageFromRetryObservations(attemptObservations),
    },
  };
}

export function createInitialEntry(seed: RetrySeed, now: number, cycleId: string): RetryEntry {
  requireCycleId(cycleId);
  return {
    period: seed.period,
    key: seed.key,
    startDay: seed.startDay,
    endDay: seed.endDay,
    route: routeSnapshot(seed.route),
    attempts: 0,
    maxAttempts: RETRY_MAX_ATTEMPTS,
    nextRetryAt: now,
    terminal: false,
    reason: null,
    cycleId,
    phase: "initial",
    attemptObservations: [],
    usage: emptyRetryUsage(),
  };
}

export function beginAttempt(
  entry: RetryEntry,
  now: number,
  expectedCycleId: string = entry.cycleId,
): RetryClaim | null {
  if (entry.cycleId !== expectedCycleId || entry.terminal || entry.phase === "in-flight") {
    return null;
  }
  if (entry.phase === "waiting" && entry.nextRetryAt !== null && now < entry.nextRetryAt) {
    return null;
  }
  const next: RetryEntry = {
    ...entry,
    route: routeSnapshot(entry.route),
    nextRetryAt: null,
    phase: "in-flight",
  };
  return { cycleId: entry.cycleId, entry: next };
}

export function recordFailure(
  claim: RetryClaim,
  failure: RetryFailure,
  now: number,
): RetryEntry | null {
  requireFailure(failure);
  if (claim.cycleId !== claim.entry.cycleId || claim.entry.phase !== "in-flight") return null;

  if (!isRetryable(failure.kind) || claim.entry.attempts >= RETRY_MAX_ATTEMPTS) {
    return {
      ...claim.entry,
      route: routeSnapshot(claim.entry.route),
      nextRetryAt: null,
      terminal: true,
      reason: { code: failure.code, kind: failure.kind },
      phase: "terminal",
    };
  }

  const attempts = claim.entry.attempts + 1;
  return {
    ...claim.entry,
    route: routeSnapshot(claim.entry.route),
    attempts,
    nextRetryAt: now + RETRY_BACKOFF_MS[attempts - 1]!,
    terminal: false,
    reason: null,
    phase: "waiting",
  };
}

export function beginForce(seed: RetrySeed, now: number, cycleId: string): RetryEntry {
  requireCycleId(cycleId);
  return {
    period: seed.period,
    key: seed.key,
    startDay: seed.startDay,
    endDay: seed.endDay,
    route: routeSnapshot(seed.route),
    attempts: 0,
    maxAttempts: RETRY_MAX_ATTEMPTS,
    nextRetryAt: now,
    terminal: false,
    reason: null,
    cycleId,
    phase: "waiting",
    attemptObservations: [],
    usage: emptyRetryUsage(),
  };
}

export function recover(entry: RetryEntry, now: number): RetryEntry {
  if (entry.phase !== "initial" && entry.phase !== "in-flight") return entry;
  return {
    ...entry,
    route: routeSnapshot(entry.route),
    nextRetryAt: now,
    terminal: false,
    reason: null,
    phase: "waiting",
  };
}

export function shouldReconcileRetry(
  entry: RetryEntry,
  lastRun: Partial<Record<ReportPeriod, string>>,
  indexed: readonly RetryIndexKey[],
): boolean {
  const completed = lastRun[entry.period];
  if (completed !== undefined && entry.key <= completed) return true;
  return indexed.some((item) => item.period === entry.period && item.key === entry.key);
}
