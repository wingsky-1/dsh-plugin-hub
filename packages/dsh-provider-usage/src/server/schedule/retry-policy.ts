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

export interface RetryEntry extends RetrySeed {
  attempts: number;
  maxAttempts: typeof RETRY_MAX_ATTEMPTS;
  nextRetryAt: number | null;
  terminal: boolean;
  reason: RetryTerminalReason | null;
  cycleId: string;
  phase: RetryPhase;
}

export interface RetryClaim {
  cycleId: string;
  entry: RetryEntry;
}

export interface RetryIndexKey {
  period: ReportPeriod;
  key: string;
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
