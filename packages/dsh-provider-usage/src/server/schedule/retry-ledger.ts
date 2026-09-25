/**
 * dsh-provider-usage — 报告重试状态账本（#1010 B1）。
 *
 * retry-ledger.json 是自动重试成本与预算的事实源：每次状态变化都在 per-root
 * Promise 临界区内读-改-写，并以 0600 临时文件 → fsync → atomic rename →
 * 目录 fsync 提交。损坏文件先 no-clobber 取证隔离并留下 fail-closed 标记；
 * 任何后续调用都不会把已被隔离的缺失文件误判成空账本。
 */

import { constants, existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { ReportPeriod } from "../config/interface.ts";
import {
  beginAttempt as policyBeginAttempt,
  beginForce as policyBeginForce,
  createInitialEntry,
  recordFailure as policyRecordFailure,
  recover as policyRecover,
  shouldReconcileRetry,
  addRetryObservation,
  usageFromRetryObservations,
  RETRY_MAX_ATTEMPTS,
  type RetryAttemptObservation,
  type RetryAttemptTokens,
  type RetryClaim,
  type RetryEntry,
  type RetryFailure,
  type RetryFailureKind,
  type RetryIndexKey,
  type RetryPhase,
  type RetryRouteSnapshot,
  type RetrySeed,
  type RetryTerminalReason,
  type RetryUsageTotals,
  emptyRetryAttemptTokens,
  emptyRetryUsage,
} from "./retry-policy.ts";

export const RETRY_LEDGER_SCHEMA = 1 as const;

const PERIODS = ["daily", "weekly", "monthly"] as const;
const PHASES = new Set<RetryPhase>(["initial", "waiting", "in-flight", "terminal"]);
const FAILURE_KINDS = new Set<RetryFailureKind>([
  "transient",
  "empty-output",
  "permanent",
  "aborted",
  "unknown",
  "storage",
]);
const CORRUPT_BACKUP_LIMIT = 5;
const STABLE_CODE_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const CYCLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type RetryRecords = Partial<Record<ReportPeriod, Record<string, RetryEntry>>>;

interface RetryLedgerDocument {
  schema: typeof RETRY_LEDGER_SCHEMA;
  records: RetryRecords;
  /**
   * 已从可见 records 裁剪的 terminal key 墓碑（period → key → 终态 code）。
   * 墓碑必须全量保留，不得让「曾终态失败」的 key 静默重开新 cycle：
   * beginAttempt 命中墓碑即拒绝，只有 beginForce（手动强制）才开新 cycle。
   * 空表不落盘字段，兼容既有 schema:1 文档。
   */
  terminalKeys?: Partial<Record<ReportPeriod, Record<string, string>>>;
}

export interface RetryAttemptInput extends RetrySeed {
  cycleId?: string;
}

export interface RetryLedgerOptions {
  now?: () => number;
  createCycleId?: () => string;
  renameFile?: (from: string, to: string) => Promise<void>;
}

export type RetryLedgerErrorCode = "retry-ledger-corrupt" | "retry-ledger-storage";

export class RetryLedgerError extends Error {
  readonly code: RetryLedgerErrorCode;

  constructor(code: RetryLedgerErrorCode, message: string) {
    super(message);
    this.name = "RetryLedgerError";
    this.code = code;
  }
}

export interface RetryLedgerPort {
  list(): Promise<RetryEntry[]>;
  listDue(now: number, lastRun: Partial<Record<ReportPeriod, string>>): Promise<RetryEntry[]>;
  get(period: ReportPeriod, key: string): Promise<RetryEntry | undefined>;
  beginAttempt(input: RetryAttemptInput, now?: number): Promise<RetryClaim | null>;
  beginForce(input: RetrySeed, now?: number): Promise<RetryEntry>;
  recordAttempt(
    claim: RetryClaim,
    observation: RetryAttemptObservation,
    now?: number,
  ): Promise<RetryClaim | null>;
  recordFailure(claim: RetryClaim, failure: RetryFailure, now?: number): Promise<RetryEntry | null>;
  /** keep 中的 cycle 保持原 phase（storage-terminal fail-closed），不回落 waiting。 */
  recover(now?: number, keep?: readonly RetryIndexKey[]): Promise<RetryEntry[]>;
  clear(claim: RetryClaim): Promise<boolean>;
  reconcile(
    lastRun: Partial<Record<ReportPeriod, string>>,
    indexed: readonly RetryIndexKey[],
  ): Promise<RetryEntry[]>;
}

interface BackupEntry {
  name: string;
  timestamp: number;
  suffix: number;
}

const ledgerChains = new Map<string, Promise<void>>();

export function retryLedgerFile(root: string): string {
  return join(root, "reports", "retry-ledger.json");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function storageError(): RetryLedgerError {
  return new RetryLedgerError("retry-ledger-storage", "retry ledger storage operation failed");
}

function corruptError(): RetryLedgerError {
  return new RetryLedgerError(
    "retry-ledger-corrupt",
    "retry ledger is quarantined; manual recovery is required",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isStableCode(value: unknown): value is string {
  return typeof value === "string" && STABLE_CODE_RE.test(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value);
}

function isValidWindow(period: ReportPeriod, entry: Record<string, unknown>): boolean {
  const { key, startDay, endDay } = entry;
  if (!isDateKey(startDay) || !isDateKey(endDay) || startDay > endDay) return false;
  if (period === "monthly") {
    return isMonthKey(key) && startDay.slice(0, 7) === key;
  }
  return isDateKey(key) && key === startDay;
}

function parseRoute(value: unknown): RetryRouteSnapshot | null {
  if (!isRecord(value)) return null;
  const allowed =
    value.reasoningEffort === undefined
      ? ["provider", "model"]
      : ["provider", "model", "reasoningEffort"];
  if (!hasExactKeys(value, allowed)) return null;
  if (typeof value.provider !== "string" || typeof value.model !== "string") return null;
  if (value.reasoningEffort !== undefined && typeof value.reasoningEffort !== "string") {
    return null;
  }
  return value.reasoningEffort === undefined
    ? { provider: value.provider, model: value.model }
    : {
        provider: value.provider,
        model: value.model,
        reasoningEffort: value.reasoningEffort,
      };
}

function parseReason(value: unknown): RetryTerminalReason | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["code", "kind"])) return null;
  if (!isStableCode(value.code) || typeof value.kind !== "string") return null;
  if (!FAILURE_KINDS.has(value.kind as RetryFailureKind)) return null;
  return { code: value.code, kind: value.kind as RetryFailureKind };
}

function parseMetric(value: unknown): number | null | undefined {
  return value === null
    ? null
    : typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
}

function parseAttemptTokens(value: unknown): RetryAttemptTokens | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "totalTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
    ])
  ) {
    return null;
  }
  const parsed: RetryAttemptTokens = emptyRetryAttemptTokens();
  for (const key of [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const) {
    const metric = parseMetric(value[key]);
    if (metric === undefined) return null;
    parsed[key] = metric;
  }
  return parsed;
}

function parseUsage(value: unknown): RetryUsageTotals | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "totalTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "durationMs",
    ])
  ) {
    return null;
  }
  const tokens = parseAttemptTokens({
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    reasoningTokens: value.reasoningTokens,
    totalTokens: value.totalTokens,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
  });
  if (tokens === null) return null;
  const durationMs = parseMetric(value.durationMs);
  if (durationMs === undefined) return null;
  return { ...tokens, durationMs };
}

function parseObservation(value: unknown): RetryAttemptObservation | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["attempt", "result", "code", "status", "durationMs", "tokens"])
  ) {
    return null;
  }
  const durationMs = parseMetric(value.durationMs);
  if (durationMs === undefined) return null;
  const tokens = parseAttemptTokens(value.tokens);
  if (tokens === null) return null;
  if (
    !Number.isInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    (value.result !== "success" && value.result !== "failure") ||
    (value.status !== "success" &&
      value.status !== "retry" &&
      value.status !== "terminal" &&
      value.status !== "aborted") ||
    (value.code !== null && !isStableCode(value.code)) ||
    (value.result === "success" && value.code !== null) ||
    (value.result === "failure" && value.code === null) ||
    (value.result === "success" && value.status !== "success") ||
    (value.result === "failure" && value.status === "success") ||
    (value.status === "retry" && (value.attempt as number) > RETRY_MAX_ATTEMPTS)
  ) {
    return null;
  }
  return {
    attempt: value.attempt as number,
    result: value.result,
    code: value.code as string | null,
    status: value.status as RetryAttemptObservation["status"],
    durationMs,
    tokens,
  };
}

function parseObservationCollection(
  value: Record<string, unknown>,
): { attemptObservations: RetryAttemptObservation[]; usage: RetryUsageTotals } | null {
  if (!Array.isArray(value.attemptObservations)) return null;
  const attemptObservations: RetryAttemptObservation[] = [];
  for (const [index, rawObservation] of value.attemptObservations.entries()) {
    const observation = parseObservation(rawObservation);
    if (observation === null || observation.attempt !== index + 1) return null;
    attemptObservations.push(observation);
  }
  if (attemptObservations.length > RETRY_MAX_ATTEMPTS + 1) return null;
  const usage = parseUsage(value.usage);
  if (usage === null) return null;
  const expectedUsage = usageFromRetryObservations(attemptObservations);
  if (
    expectedUsage.inputTokens !== usage.inputTokens ||
    expectedUsage.outputTokens !== usage.outputTokens ||
    expectedUsage.reasoningTokens !== usage.reasoningTokens ||
    expectedUsage.totalTokens !== usage.totalTokens ||
    expectedUsage.cacheReadTokens !== usage.cacheReadTokens ||
    expectedUsage.cacheWriteTokens !== usage.cacheWriteTokens ||
    expectedUsage.durationMs !== usage.durationMs
  ) {
    return null;
  }
  return { attemptObservations, usage };
}

function observationCountMatchesState(
  phase: RetryPhase,
  attempts: number,
  observationCount: number,
): boolean {
  // B2 兼容路径允许尚未调用 recordAttempt 就完成状态转移；一旦存在事实，
  // 观测序列必须与自动重试计数严格对应。
  if (observationCount === 0) return true;
  if (phase === "initial") return false;
  if (phase === "waiting") return observationCount === attempts;
  if (phase === "in-flight") {
    return observationCount === attempts || observationCount === attempts + 1;
  }
  return observationCount === attempts + 1;
}

function parseEntryState(
  value: Record<string, unknown>,
  reason: RetryTerminalReason | null,
): boolean {
  const phase = value.phase as RetryPhase;
  const attempts = value.attempts as number;
  if (phase === "terminal") {
    return value.terminal === true && reason !== null && value.nextRetryAt === null;
  }
  if (value.terminal || reason !== null) return false;
  if (phase === "in-flight" && value.nextRetryAt !== null) return false;
  if ((phase === "initial" || phase === "waiting") && !isFiniteTimestamp(value.nextRetryAt)) {
    return false;
  }
  return phase !== "initial" || attempts === 0;
}

function parseEntry(period: ReportPeriod, key: string, value: unknown): RetryEntry | null {
  if (!isRecord(value)) return null;
  const legacyKeys = [
    "period",
    "key",
    "startDay",
    "endDay",
    "route",
    "attempts",
    "maxAttempts",
    "nextRetryAt",
    "terminal",
    "reason",
    "cycleId",
    "phase",
  ];
  const hasObservations = Object.hasOwn(value, "attemptObservations");
  const hasUsage = Object.hasOwn(value, "usage");
  if (hasObservations !== hasUsage) return null;
  const expectedKeys = hasObservations
    ? [...legacyKeys, "attemptObservations", "usage"]
    : legacyKeys;
  if (!hasExactKeys(value, expectedKeys)) return null;
  if (value.period !== period || value.key !== key || !isValidWindow(period, value)) return null;
  const route = parseRoute(value.route);
  if (route === null) return null;
  if (
    !Number.isInteger(value.attempts) ||
    (value.attempts as number) < 0 ||
    (value.attempts as number) > RETRY_MAX_ATTEMPTS ||
    value.maxAttempts !== RETRY_MAX_ATTEMPTS ||
    typeof value.terminal !== "boolean" ||
    typeof value.cycleId !== "string" ||
    !CYCLE_ID_RE.test(value.cycleId) ||
    typeof value.phase !== "string" ||
    !PHASES.has(value.phase as RetryPhase) ||
    (value.nextRetryAt !== null && !isFiniteTimestamp(value.nextRetryAt))
  ) {
    return null;
  }

  const reason = parseReason(value.reason);
  if (reason === null && value.reason !== null) return null;
  const observations = hasObservations ? parseObservationCollection(value) : null;
  if (hasObservations && observations === null) return null;
  const attemptObservations = observations?.attemptObservations ?? [];
  const usage = observations?.usage ?? emptyRetryUsage();
  const phase = value.phase as RetryPhase;
  const attempts = value.attempts as number;
  if (
    hasObservations &&
    !observationCountMatchesState(phase, attempts, attemptObservations.length)
  ) {
    return null;
  }
  if (!parseEntryState(value, reason)) return null;

  return {
    period,
    key,
    startDay: value.startDay as string,
    endDay: value.endDay as string,
    route,
    attempts,
    maxAttempts: RETRY_MAX_ATTEMPTS,
    nextRetryAt: value.nextRetryAt as number | null,
    terminal: value.terminal,
    reason,
    cycleId: value.cycleId,
    phase,
    attemptObservations,
    usage,
  };
}

function parseTerminalKeys(value: unknown): RetryLedgerDocument["terminalKeys"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("invalid retry ledger terminal keys");
  const parsed: Record<string, Record<string, string>> = {};
  for (const [period, bucket] of Object.entries(value)) {
    if (!PERIODS.includes(period as ReportPeriod) || !isRecord(bucket)) {
      throw new Error("invalid retry ledger terminal key period");
    }
    for (const [key, code] of Object.entries(bucket)) {
      if (!key || !isStableCode(code)) throw new Error("invalid retry ledger terminal key");
      parsed[period] = { ...(parsed[period] ?? {}), [key]: code };
    }
  }
  return parsed as RetryLedgerDocument["terminalKeys"];
}

function parseDocument(value: unknown): RetryLedgerDocument {
  if (!isRecord(value)) {
    throw new Error("invalid retry ledger document");
  }
  const hasTerminalKeys = Object.hasOwn(value, "terminalKeys");
  const expectedKeys = hasTerminalKeys
    ? ["schema", "records", "terminalKeys"]
    : ["schema", "records"];
  if (!hasExactKeys(value, expectedKeys)) {
    throw new Error("invalid retry ledger document");
  }
  if (value.schema !== RETRY_LEDGER_SCHEMA || !isRecord(value.records)) {
    throw new Error("invalid retry ledger schema");
  }
  const terminalKeys = parseTerminalKeys(value.terminalKeys);

  const records: RetryRecords = {};
  for (const period of PERIODS) {
    const rawPeriod = value.records[period];
    if (rawPeriod === undefined) continue;
    if (!isRecord(rawPeriod)) throw new Error("invalid retry ledger period");
    const bucket: Record<string, RetryEntry> = {};
    for (const [key, rawEntry] of Object.entries(rawPeriod)) {
      if (!key || key.includes("/") || key.includes("\\")) {
        throw new Error("invalid retry ledger key");
      }
      const entry = parseEntry(period, key, rawEntry);
      if (entry === null) throw new Error("invalid retry ledger entry");
      bucket[key] = entry;
    }
    records[period] = bucket;
  }

  for (const period of Object.keys(value.records)) {
    if (!PERIODS.includes(period as ReportPeriod)) {
      throw new Error("unknown retry ledger period");
    }
  }
  return {
    schema: RETRY_LEDGER_SCHEMA,
    records,
    ...(terminalKeys === undefined ? {} : { terminalKeys }),
  };
}

function cloneEntry(entry: RetryEntry): RetryEntry {
  return {
    ...entry,
    route:
      entry.route.reasoningEffort === undefined
        ? { provider: entry.route.provider, model: entry.route.model }
        : { ...entry.route },
    reason: entry.reason === null ? null : { ...entry.reason },
    attemptObservations: entry.attemptObservations.map((observation) => ({
      ...observation,
      tokens: { ...observation.tokens },
    })),
    usage: { ...entry.usage },
  };
}

function cloneTerminalKeys(
  terminalKeys: RetryLedgerDocument["terminalKeys"],
): RetryLedgerDocument["terminalKeys"] {
  if (terminalKeys === undefined) return undefined;
  const clone: Record<string, Record<string, string>> = {};
  for (const period of PERIODS) {
    const bucket = terminalKeys[period];
    if (bucket === undefined) continue;
    clone[period] = { ...bucket };
  }
  return clone as RetryLedgerDocument["terminalKeys"];
}

function cloneDocument(document: RetryLedgerDocument): RetryLedgerDocument {
  const records: RetryRecords = {};
  for (const period of PERIODS) {
    const bucket = document.records[period];
    if (bucket === undefined) continue;
    records[period] = Object.fromEntries(
      Object.entries(bucket).map(([key, entry]) => [key, cloneEntry(entry)]),
    );
  }
  const terminalKeys = cloneTerminalKeys(document.terminalKeys);
  return {
    schema: RETRY_LEDGER_SCHEMA,
    records,
    ...(terminalKeys === undefined ? {} : { terminalKeys }),
  };
}

/** 记录 terminal 墓碑并按 key 升序全量保留，确保序列化稳定且终态 key 不复活。 */
function rememberTerminalKey(
  document: RetryLedgerDocument,
  period: ReportPeriod,
  key: string,
  reason: RetryTerminalReason | null,
): void {
  const terminalKeys = document.terminalKeys ?? {};
  const bucket = { ...(terminalKeys[period] ?? {}) };
  bucket[key] = reason?.code ?? "terminal";
  terminalKeys[period] = Object.fromEntries(
    Object.keys(bucket)
      .sort()
      .map((entryKey) => [entryKey, bucket[entryKey]!] as const),
  );
  document.terminalKeys = terminalKeys;
}

function isTerminalKey(document: RetryLedgerDocument, period: ReportPeriod, key: string): boolean {
  return document.terminalKeys?.[period]?.[key] !== undefined;
}

/** reconcile/clear 命中即视为该 key 已闭环，墓碑随之失效。 */
function forgetTerminalKey(document: RetryLedgerDocument, period: ReportPeriod, key: string): void {
  const bucket = document.terminalKeys?.[period];
  if (bucket === undefined || bucket[key] === undefined) return;
  const next = { ...bucket };
  delete next[key];
  if (Object.keys(next).length === 0) {
    const terminalKeys = { ...document.terminalKeys };
    delete terminalKeys[period];
    document.terminalKeys =
      Object.keys(terminalKeys).length === 0
        ? undefined
        : (terminalKeys as RetryLedgerDocument["terminalKeys"]);
    return;
  }
  document.terminalKeys = { ...document.terminalKeys, [period]: next };
}

function pruneTerminalEntries(document: RetryLedgerDocument): RetryLedgerDocument {
  const next = cloneDocument(document);
  for (const period of PERIODS) {
    const bucket = next.records[period];
    if (bucket === undefined) continue;
    const terminalKeys = Object.keys(bucket)
      .filter((key) => bucket[key]!.terminal)
      .sort();
    // 裁掉的 terminal 记录留墓碑：key 仍属「已终态」，不得自动重开 cycle。
    for (const key of terminalKeys.slice(0, -1)) {
      rememberTerminalKey(next, period, key, bucket[key]!.reason);
      delete bucket[key];
    }
  }
  return next;
}

function flatten(document: RetryLedgerDocument): RetryEntry[] {
  const entries: RetryEntry[] = [];
  for (const period of PERIODS) {
    const bucket = document.records[period];
    if (bucket === undefined) continue;
    for (const key of Object.keys(bucket).sort()) entries.push(cloneEntry(bucket[key]!));
  }
  return entries;
}

function emptyDocument(): RetryLedgerDocument {
  return { schema: RETRY_LEDGER_SCHEMA, records: {} };
}

function serializeDocument(document: RetryLedgerDocument): string {
  const pruned = pruneTerminalEntries(document);
  const terminalKeys = cloneTerminalKeys(pruned.terminalKeys);
  const payload: RetryLedgerDocument =
    terminalKeys === undefined
      ? { schema: RETRY_LEDGER_SCHEMA, records: pruned.records }
      : { schema: RETRY_LEDGER_SCHEMA, records: pruned.records, terminalKeys };
  return JSON.stringify(payload);
}

function entryAt(
  document: RetryLedgerDocument,
  period: ReportPeriod,
  key: string,
): RetryEntry | undefined {
  const entry = document.records[period]?.[key];
  return entry === undefined ? undefined : cloneEntry(entry);
}

function setEntry(document: RetryLedgerDocument, entry: RetryEntry): void {
  const checked = parseEntry(entry.period, entry.key, entry);
  if (checked === null) throw new Error("invalid retry ledger entry");
  const bucket = document.records[entry.period] ?? {};
  bucket[entry.key] = checked;
  document.records[entry.period] = bucket;
}

function sameRoute(left: RetryRouteSnapshot, right: RetryRouteSnapshot): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort
  );
}

function sameReason(left: RetryTerminalReason | null, right: RetryTerminalReason | null): boolean {
  if (left === null || right === null) return left === right;
  return left.code === right.code && left.kind === right.kind;
}

function sameTokens(left: RetryAttemptTokens, right: RetryAttemptTokens): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningTokens === right.reasoningTokens &&
    left.totalTokens === right.totalTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens
  );
}

function sameObservations(
  left: readonly RetryAttemptObservation[],
  right: readonly RetryAttemptObservation[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (observation, index) =>
        observation.attempt === right[index]?.attempt &&
        observation.result === right[index]?.result &&
        observation.code === right[index]?.code &&
        observation.status === right[index]?.status &&
        observation.durationMs === right[index]?.durationMs &&
        sameTokens(observation.tokens, right[index]?.tokens ?? emptyRetryAttemptTokens()),
    )
  );
}

function sameUsage(left: RetryUsageTotals, right: RetryUsageTotals): boolean {
  return sameTokens(left, right) && left.durationMs === right.durationMs;
}

function claimMatchesCurrent(claim: RetryClaim, current: RetryEntry): boolean {
  const claimed = claim.entry;
  return (
    claim.cycleId === current.cycleId &&
    claimed.period === current.period &&
    claimed.key === current.key &&
    claimed.startDay === current.startDay &&
    claimed.endDay === current.endDay &&
    sameRoute(claimed.route, current.route) &&
    claimed.attempts === current.attempts &&
    claimed.nextRetryAt === current.nextRetryAt &&
    claimed.terminal === current.terminal &&
    sameReason(claimed.reason, current.reason) &&
    claimed.phase === current.phase &&
    sameObservations(claimed.attemptObservations, current.attemptObservations) &&
    sameUsage(claimed.usage, current.usage)
  );
}

function deleteEntry(document: RetryLedgerDocument, period: ReportPeriod, key: string): void {
  const bucket = document.records[period];
  if (bucket === undefined) return;
  delete bucket[key];
  if (Object.keys(bucket).length === 0) delete document.records[period];
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (
      ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EBADF", "EISDIR"].includes(
        errorCode(error) ?? "",
      )
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function ensureReportsDirectory(root: string): Promise<string> {
  const reports = join(root, "reports");
  try {
    await mkdir(reports, { recursive: true, mode: 0o700 });
    await chmod(reports, 0o700);
    return reports;
  } catch {
    throw storageError();
  }
}

async function ensureCorruptMarker(reports: string): Promise<void> {
  const marker = join(reports, "retry-ledger.json.corrupt");
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(marker, "wx", 0o600);
  } catch (error: unknown) {
    if (errorCode(error) === "EEXIST") return;
    throw storageError();
  }
  try {
    await handle.writeFile("retry-ledger-corrupt\n", "utf8");
    await handle.sync();
  } catch {
    throw storageError();
  } finally {
    await handle.close().catch(() => {});
  }
  try {
    await syncDirectory(reports);
  } catch {
    throw storageError();
  }
}

async function moveToBackupNoClobber(file: string, backupBase: string): Promise<string> {
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? backupBase : `${backupBase}-${suffix}`;
    try {
      await link(file, candidate);
    } catch (linkError: unknown) {
      if (errorCode(linkError) === "EEXIST") continue;
      if (
        !["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(errorCode(linkError) ?? "")
      ) {
        throw linkError;
      }
      try {
        await copyFile(file, candidate, constants.COPYFILE_EXCL);
      } catch (copyError: unknown) {
        if (errorCode(copyError) === "EEXIST") continue;
        throw copyError;
      }
    }
    await chmod(candidate, 0o600);
    await unlink(file);
    return candidate;
  }
}

function backupEntries(names: readonly string[], prefix: string): BackupEntry[] {
  const entries: BackupEntry[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(\d+)(?:-(\d+))?$/.exec(name.slice(prefix.length));
    if (match === null) continue;
    entries.push({
      name,
      timestamp: Number(match[1]),
      suffix: Number(match[2] ?? 0),
    });
  }
  return entries.sort(
    (left, right) => left.timestamp - right.timestamp || left.suffix - right.suffix,
  );
}

async function rotateBackups(
  reports: string,
  file: string,
  protectedBackup: string,
): Promise<void> {
  const prefix = "retry-ledger.json.bak-";
  const entries = backupEntries(await readdir(reports), prefix);
  const protectedPath = resolve(protectedBackup);
  const removable = entries.filter((entry) => resolve(join(reports, entry.name)) !== protectedPath);
  const removeCount = Math.max(0, removable.length - (CORRUPT_BACKUP_LIMIT - 1));
  for (const entry of removable.slice(0, removeCount)) {
    await unlink(join(reports, entry.name));
  }
  await syncDirectory(dirname(file));
}

async function quarantineCorrupt(root: string, file: string, now: number): Promise<never> {
  const reports = await ensureReportsDirectory(root);
  await ensureCorruptMarker(reports);
  try {
    const backup = await moveToBackupNoClobber(file, `${file}.bak-${now}`);
    await rotateBackups(reports, file, backup);
  } catch {
    throw storageError();
  }
  throw corruptError();
}

async function readDocumentUnlocked(root: string, now: number): Promise<RetryLedgerDocument> {
  const file = retryLedgerFile(root);
  const reports = dirname(file);
  if (existsSafe(join(reports, "retry-ledger.json.corrupt"))) throw corruptError();

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return emptyDocument();
    throw storageError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCorrupt(root, file, now);
  }
  try {
    return pruneTerminalEntries(parseDocument(parsed));
  } catch {
    await quarantineCorrupt(root, file, now);
    throw corruptError();
  }
}

function existsSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

async function writeDocumentUnlocked(
  root: string,
  document: RetryLedgerDocument,
  renameFile: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const file = retryLedgerFile(root);
  const reports = await ensureReportsDirectory(root);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryExists = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(serializeDocument(document), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameFile(temporary, file);
    temporaryExists = false;
    await chmod(file, 0o600);
    await syncDirectory(reports);
  } catch {
    if (temporaryExists) await unlink(temporary).catch(() => {});
    throw storageError();
  }
}

function withRootLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(root);
  const previous = ledgerChains.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  ledgerChains.set(key, tail);
  return run.finally(() => {
    if (ledgerChains.get(key) === tail) ledgerChains.delete(key);
  });
}

function operationNow(options: RetryLedgerOptions, explicit: number | undefined): number {
  const value = explicit ?? options.now?.() ?? Date.now();
  if (!isFiniteTimestamp(value)) {
    throw new Error("retry ledger now must be a non-negative safe integer");
  }
  return value;
}

export function createRetryLedger(root: string, options: RetryLedgerOptions = {}): RetryLedgerPort {
  if (root.length === 0) throw new Error("retry ledger root must not be empty");
  const renameFile = options.renameFile ?? rename;
  const createCycleId = options.createCycleId ?? randomUUID;

  const read = (): Promise<RetryLedgerDocument> =>
    readDocumentUnlocked(root, operationNow(options, undefined));
  const write = (document: RetryLedgerDocument): Promise<void> =>
    writeDocumentUnlocked(root, document, renameFile);

  return {
    list: () => withRootLock(root, async () => flatten(await read())),

    listDue: (now, lastRun) =>
      withRootLock(root, async () => {
        const document = await read();
        return flatten(document).filter((entry) => {
          if (entry.terminal || (entry.phase !== "initial" && entry.phase !== "waiting")) {
            return false;
          }
          if (entry.nextRetryAt === null || entry.nextRetryAt > now) return false;
          const completed = lastRun[entry.period];
          return completed === undefined || entry.key > completed;
        });
      }),

    get: (period, key) =>
      withRootLock(root, async () => {
        const document = await read();
        if (!key || key.includes("/") || key.includes("\\")) return undefined;
        return entryAt(document, period, key);
      }),

    beginAttempt: (input, explicitNow) =>
      withRootLock(root, async () => {
        const now = operationNow(options, explicitNow);
        const document = await read();
        const current = entryAt(document, input.period, input.key);
        if (current === undefined && isTerminalKey(document, input.period, input.key)) {
          // 墓碑：该 key 曾终态失败，不得自动重开 cycle（只有 beginForce 可开新 cycle）。
          return null;
        }
        if (current !== undefined) {
          if (input.cycleId === undefined) return null;
          const claim = policyBeginAttempt(current, now, input.cycleId);
          if (claim === null) return null;
          setEntry(document, claim.entry);
          await write(document);
          return claim;
        }

        const initial = createInitialEntry(input, now, input.cycleId ?? createCycleId());
        const claim = policyBeginAttempt(initial, now, initial.cycleId);
        if (claim === null) throw new Error("retry ledger could not create initial claim");
        setEntry(document, claim.entry);
        await write(document);
        return claim;
      }),

    beginForce: (input, explicitNow) =>
      withRootLock(root, async () => {
        const now = operationNow(options, explicitNow);
        const document = await read();
        const current = entryAt(document, input.period, input.key);
        const cycleId = createCycleId();
        if (current?.cycleId === cycleId) throw new Error("retry ledger cycleId must be fresh");
        const forced = policyBeginForce(input, now, cycleId);
        // manual force 显式开新 cycle：墓碑随之失效。
        forgetTerminalKey(document, input.period, input.key);
        setEntry(document, forced);
        await write(document);
        return cloneEntry(forced);
      }),

    recordAttempt: (claim, observation, explicitNow) =>
      withRootLock(root, async () => {
        operationNow(options, explicitNow);
        const document = await read();
        const current = entryAt(document, claim.entry.period, claim.entry.key);
        if (current === undefined || !claimMatchesCurrent(claim, current)) return null;
        const next = addRetryObservation(claim, observation);
        setEntry(document, next.entry);
        await write(document);
        return { cycleId: next.cycleId, entry: cloneEntry(next.entry) };
      }),

    recordFailure: (claim, failure, explicitNow) =>
      withRootLock(root, async () => {
        const now = operationNow(options, explicitNow);
        const document = await read();
        const current = entryAt(document, claim.entry.period, claim.entry.key);
        if (current === undefined || !claimMatchesCurrent(claim, current)) return null;
        const next = policyRecordFailure(claim, failure, now);
        if (next === null) return null;
        setEntry(document, next);
        await write(document);
        return cloneEntry(next);
      }),

    recover: (explicitNow, keep) =>
      withRootLock(root, async () => {
        const now = operationNow(options, explicitNow);
        const document = await read();
        const held = new Set(
          (keep ?? [])
            .filter((item) => item.cycleId !== undefined)
            .map((item) => `${item.period}:${item.key}:${item.cycleId}`),
        );
        let changed = false;
        for (const period of PERIODS) {
          const bucket = document.records[period];
          if (bucket === undefined) continue;
          for (const [key, entry] of Object.entries(bucket)) {
            // storage-terminal 围栏内的 cycle 保持原 phase：不得回落 waiting 自动重跑。
            if (held.has(`${period}:${key}:${entry.cycleId}`)) continue;
            const recovered = policyRecover(entry, now);
            if (recovered !== entry) {
              bucket[key] = recovered;
              changed = true;
            }
          }
        }
        if (changed) await write(document);
        return flatten(document);
      }),

    clear: (claim) =>
      withRootLock(root, async () => {
        const document = await read();
        const current = entryAt(document, claim.entry.period, claim.entry.key);
        if (current === undefined || !claimMatchesCurrent(claim, current)) return false;
        deleteEntry(document, claim.entry.period, claim.entry.key);
        await write(document);
        return true;
      }),

    reconcile: (lastRun, indexed) =>
      withRootLock(root, async () => {
        const document = await read();
        const removed: RetryEntry[] = [];
        for (const entry of flatten(document)) {
          if (!shouldReconcileRetry(entry, lastRun, indexed)) continue;
          removed.push(entry);
          deleteEntry(document, entry.period, entry.key);
          forgetTerminalKey(document, entry.period, entry.key);
        }
        if (removed.length > 0) await write(document);
        return removed;
      }),
  };
}
