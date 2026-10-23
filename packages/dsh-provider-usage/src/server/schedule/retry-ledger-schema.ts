/**
 * dsh-provider-usage — 报告重试状态账本：schema 校验与解析纯面（#1174 阶段 2）。
 *
 * 本模块是重试账本的解析叶子：只依赖 config 域的 ReportPeriod 与 retry-policy 的
 * 值/类型，不依赖 document、storage 与工厂面，也不碰 node: 文件系统。
 *
 * 契约面（RetryLedgerDocument / RetryLedgerError / RetryLedgerPort / Options）在本模块
 * 单一物理定义，其他模块 import；原路径 retry-ledger.ts 逐个 named re-export 保持
 * 既有 32 个出口与符号身份（禁 export *）。本模块只判定「这份数据是否可读」，
 * 读盘、损坏隔离与写盘语义在 retry-ledger-storage.ts，装配在 retry-ledger.ts。
 */

import type { ReportPeriod } from "../config/interface.ts";
import {
  statusAgreesWithResult,
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

export const PERIODS = ["daily", "weekly", "monthly"] as const;
const PERIOD_SET: ReadonlySet<string> = new Set<ReportPeriod>(PERIODS);
const PHASES: ReadonlySet<string> = new Set<RetryPhase>([
  "initial",
  "waiting",
  "in-flight",
  "terminal",
]);

/** period 键收窄（类型谓词，取代 PERIODS.includes(x as ReportPeriod) 的断言逃逸）。 */
function isReportPeriod(value: string): value is ReportPeriod {
  return PERIOD_SET.has(value);
}

/** 生命周期相位收窄（类型谓词）。 */
function isRetryPhase(value: unknown): value is RetryPhase {
  return typeof value === "string" && PHASES.has(value);
}

/** 已登记尝试次数收窄：0..RETRY_MAX_ATTEMPTS 的整数。 */
function isRetryAttemptCounter(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= RETRY_MAX_ATTEMPTS
  );
}

/** 下次重试时刻收窄：null（不排期）或非负安全整数。 */
function isRetryNextRetryAt(value: unknown): value is number | null {
  return value === null || isFiniteTimestamp(value);
}
const FAILURE_KINDS = new Set<RetryFailureKind>([
  "transient",
  "empty-output",
  "permanent",
  "aborted",
  "unknown",
  "storage",
]);
const STABLE_CODE_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const CYCLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type RetryRecords = Partial<Record<ReportPeriod, Record<string, RetryEntry>>>;

export interface RetryLedgerDocument {
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

export function isFiniteTimestamp(value: unknown): value is number {
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

/** 单条 attempt 观测的精确键集合（读盘口径，缺键/多键即拒）。 */
const OBSERVATION_KEYS = ["attempt", "result", "code", "status", "durationMs", "tokens"] as const;

function isObservationResult(value: unknown): value is "success" | "failure" {
  return value === "success" || value === "failure";
}

function isObservationStatus(value: unknown): value is RetryAttemptObservation["status"] {
  return value === "success" || value === "retry" || value === "terminal" || value === "aborted";
}

/** code 收窄：null（无失败码）或稳定码形态。 */
function isObservationCode(value: unknown): value is string | null {
  return value === null || isStableCode(value);
}

/** attempt 收窄：≥1 的整数。 */
function isObservationAttempt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** 观测标量字段收窄（类型谓词承担 narrowing，取代读盘路径的 as 逃逸）。 */
export function narrowObservationScalars(
  value: Record<string, unknown>,
): Pick<RetryAttemptObservation, "attempt" | "result" | "code" | "status"> | null {
  if (!isObservationAttempt(value.attempt)) return null;
  if (!isObservationResult(value.result)) return null;
  if (!isObservationStatus(value.status)) return null;
  if (!isObservationCode(value.code)) return null;
  return {
    attempt: value.attempt,
    result: value.result,
    code: value.code,
    status: value.status,
  };
}

/**
 * 观测跨字段一致性（result⇔code 必填性、result⇔status、status⇔attempt 上限）。
 * 与 retry-policy 的 requireObservationConsistency 同口径——读盘校验只判真假、
 * 不抛错（抛错面在写入口）。
 */
export function hasConsistentObservationOutcome(observation: RetryAttemptObservation): boolean {
  if (observation.result === "success" && observation.code !== null) return false;
  if (observation.result === "failure" && observation.code === null) return false;
  if (!statusAgreesWithResult(observation)) return false;
  if (observation.status === "retry" && observation.attempt > RETRY_MAX_ATTEMPTS) return false;
  return true;
}

export function parseObservation(value: unknown): RetryAttemptObservation | null {
  if (!isRecord(value) || !hasExactKeys(value, OBSERVATION_KEYS)) return null;
  const durationMs = parseMetric(value.durationMs);
  if (durationMs === undefined) return null;
  const tokens = parseAttemptTokens(value.tokens);
  if (tokens === null) return null;
  const scalars = narrowObservationScalars(value);
  if (scalars === null) return null;
  const observation: RetryAttemptObservation = { ...scalars, durationMs, tokens };
  return hasConsistentObservationOutcome(observation) ? observation : null;
}

/**
 * 观测序列连续性（纯函数）：第 i 项的 attempt 必须是 i+1（跳号/重号皆拒），
 * 任一项非法则整序列拒。
 */
export function collectSequentialObservations(
  raw: readonly unknown[],
): RetryAttemptObservation[] | null {
  const attemptObservations: RetryAttemptObservation[] = [];
  for (const [index, rawObservation] of raw.entries()) {
    const observation = parseObservation(rawObservation);
    if (observation === null || observation.attempt !== index + 1) return null;
    attemptObservations.push(observation);
  }
  return attemptObservations;
}

/**
 * usage 合计自洽（纯函数）：落盘 usage 必须等于按观测序列重算的结果——
 * 杜绝手改/半写账本里 usage 与观测互相矛盾的成本失真。
 */
export function usageMatchesObservations(
  usage: RetryUsageTotals,
  attemptObservations: readonly RetryAttemptObservation[],
): boolean {
  return sameUsage(usageFromRetryObservations(attemptObservations), usage);
}

function parseObservationCollection(
  value: Record<string, unknown>,
): { attemptObservations: RetryAttemptObservation[]; usage: RetryUsageTotals } | null {
  if (!Array.isArray(value.attemptObservations)) return null;
  const attemptObservations = collectSequentialObservations(value.attemptObservations);
  if (attemptObservations === null) return null;
  if (attemptObservations.length > RETRY_MAX_ATTEMPTS + 1) return null;
  const usage = parseUsage(value.usage);
  if (usage === null) return null;
  return usageMatchesObservations(usage, attemptObservations)
    ? { attemptObservations, usage }
    : null;
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

/** 终态条目形态：terminal 恒真、终态原因非空、不再排期。 */
export function isWellFormedTerminalState(
  value: Record<string, unknown>,
  reason: RetryTerminalReason | null,
): boolean {
  return value.terminal === true && reason !== null && value.nextRetryAt === null;
}

/**
 * 非终态条目不变量：terminal/reason 须同时为空；in-flight 不排期；
 * initial/waiting 必有有限 nextRetryAt；initial 必零尝试。
 */
export function isWellFormedLiveState(
  value: Record<string, unknown>,
  reason: RetryTerminalReason | null,
  phase: RetryPhase,
  attempts: number,
): boolean {
  if (value.terminal || reason !== null) return false;
  if (phase === "in-flight" && value.nextRetryAt !== null) return false;
  if ((phase === "initial" || phase === "waiting") && !isFiniteTimestamp(value.nextRetryAt)) {
    return false;
  }
  return phase !== "initial" || attempts === 0;
}

/** 条目状态机自洽（终态与非终态两套不变量，见上）。 */
export function parseEntryState(
  value: Record<string, unknown>,
  reason: RetryTerminalReason | null,
  phase: RetryPhase,
  attempts: number,
): boolean {
  if (phase === "terminal") return isWellFormedTerminalState(value, reason);
  return isWellFormedLiveState(value, reason, phase, attempts);
}

/** 无观测序列的历史条目键集合（schema:1 基线形态）。 */
const LEGACY_ENTRY_KEYS = [
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
] as const;

/** 观测载荷两键须同在同缺——只带其一的条目视为半写账本，拒。 */
export function hasExpectedEntryKeys(value: Record<string, unknown>): boolean {
  const hasObservations = Object.hasOwn(value, "attemptObservations");
  if (hasObservations !== Object.hasOwn(value, "usage")) return false;
  const expectedKeys = hasObservations
    ? [...LEGACY_ENTRY_KEYS, "attemptObservations", "usage"]
    : LEGACY_ENTRY_KEYS;
  return hasExactKeys(value, expectedKeys);
}

/** 条目身份面：period/key 对位 + 窗口合法 + 路由快照可解析。 */
export function parseEntryIdentity(
  value: Record<string, unknown>,
  period: ReportPeriod,
  key: string,
): { startDay: string; endDay: string; route: RetryRouteSnapshot } | null {
  if (value.period !== period || value.key !== key || !isValidWindow(period, value)) return null;
  const route = parseRoute(value.route);
  if (route === null) return null;
  return {
    startDay: value.startDay as string,
    endDay: value.endDay as string,
    route,
  };
}

export interface NarrowedEntryFields {
  attempts: number;
  terminal: boolean;
  nextRetryAt: number | null;
  cycleId: string;
  phase: RetryPhase;
  reason: RetryTerminalReason | null;
}

/** 条目标量字段收窄：尝试计数、终态标记、排期时刻、cycleId、相位、终态原因。 */
export function narrowEntryFields(value: Record<string, unknown>): NarrowedEntryFields | null {
  if (value.maxAttempts !== RETRY_MAX_ATTEMPTS) return null;
  if (!isRetryAttemptCounter(value.attempts)) return null;
  if (typeof value.terminal !== "boolean") return null;
  if (typeof value.cycleId !== "string" || !CYCLE_ID_RE.test(value.cycleId)) return null;
  if (!isRetryPhase(value.phase)) return null;
  if (!isRetryNextRetryAt(value.nextRetryAt)) return null;
  const reason = parseReason(value.reason);
  if (reason === null && value.reason !== null) return null;
  return {
    attempts: value.attempts,
    terminal: value.terminal,
    nextRetryAt: value.nextRetryAt,
    cycleId: value.cycleId,
    phase: value.phase,
    reason,
  };
}

/** 观测载荷：缺两键（历史条目）视作零观测空载荷。 */
export function parseEntryPayload(
  value: Record<string, unknown>,
): { attemptObservations: RetryAttemptObservation[]; usage: RetryUsageTotals } | null {
  if (!Object.hasOwn(value, "attemptObservations")) {
    return { attemptObservations: [], usage: emptyRetryUsage() };
  }
  return parseObservationCollection(value);
}

/** 观测事实与状态机自洽（观测条数对应自动重试计数 + 条目状态机不变量）。 */
export function isEntryCoherent(
  value: Record<string, unknown>,
  fields: NarrowedEntryFields,
  observationCount: number,
): boolean {
  if (!observationCountMatchesState(fields.phase, fields.attempts, observationCount)) {
    return false;
  }
  return parseEntryState(value, fields.reason, fields.phase, fields.attempts);
}

/** 条目装配（纯函数）：身份面 + 标量面 + 观测载荷 → RetryEntry。 */
export function buildRetryEntry(
  period: ReportPeriod,
  key: string,
  identity: { startDay: string; endDay: string; route: RetryRouteSnapshot },
  fields: NarrowedEntryFields,
  payload: { attemptObservations: RetryAttemptObservation[]; usage: RetryUsageTotals },
): RetryEntry {
  return {
    period,
    key,
    startDay: identity.startDay,
    endDay: identity.endDay,
    route: identity.route,
    attempts: fields.attempts,
    maxAttempts: RETRY_MAX_ATTEMPTS,
    nextRetryAt: fields.nextRetryAt,
    terminal: fields.terminal,
    reason: fields.reason,
    cycleId: fields.cycleId,
    phase: fields.phase,
    attemptObservations: payload.attemptObservations,
    usage: payload.usage,
  };
}

export function parseEntry(period: ReportPeriod, key: string, value: unknown): RetryEntry | null {
  if (!isRecord(value)) return null;
  if (!hasExpectedEntryKeys(value)) return null;
  const identity = parseEntryIdentity(value, period, key);
  if (identity === null) return null;
  const fields = narrowEntryFields(value);
  if (fields === null) return null;
  const payload = parseEntryPayload(value);
  if (payload === null) return null;
  if (!isEntryCoherent(value, fields, payload.attemptObservations.length)) return null;
  return buildRetryEntry(period, key, identity, fields, payload);
}

function parseTerminalKeys(value: unknown): RetryLedgerDocument["terminalKeys"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("invalid retry ledger terminal keys");
  const parsed: Record<string, Record<string, string>> = {};
  for (const [period, bucket] of Object.entries(value)) {
    if (!isReportPeriod(period) || !isRecord(bucket)) {
      throw new Error("invalid retry ledger terminal key period");
    }
    for (const [key, code] of Object.entries(bucket)) {
      if (!key || !isStableCode(code)) throw new Error("invalid retry ledger terminal key");
      parsed[period] = { ...(parsed[period] ?? {}), [key]: code };
    }
  }
  return parsed as RetryLedgerDocument["terminalKeys"];
}

/** 文档外壳键集合：terminalKeys 有无两形态（键多/键缺一律拒）。 */
export function hasExpectedDocumentKeys(value: Record<string, unknown>): boolean {
  const expectedKeys = Object.hasOwn(value, "terminalKeys")
    ? ["schema", "records", "terminalKeys"]
    : ["schema", "records"];
  return hasExactKeys(value, expectedKeys);
}

/** 单个 period 桶解析（key 不得含路径分隔符；条目须全量合法）。 */
export function parseRetryPeriodBucket(
  period: ReportPeriod,
  rawPeriod: unknown,
): Record<string, RetryEntry> {
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
  return bucket;
}

/** 未知 period 拒绝（须在全部条目校验之后——判词顺序即错误优先级）。 */
export function assertKnownPeriodsOnly(raw: Record<string, unknown>): void {
  for (const period of Object.keys(raw)) {
    if (!isReportPeriod(period)) {
      throw new Error("unknown retry ledger period");
    }
  }
}

export function parseRetryRecords(raw: Record<string, unknown>): RetryRecords {
  const records: RetryRecords = {};
  for (const period of PERIODS) {
    const rawPeriod = raw[period];
    if (rawPeriod === undefined) continue;
    records[period] = parseRetryPeriodBucket(period, rawPeriod);
  }
  assertKnownPeriodsOnly(raw);
  return records;
}

export function parseDocument(value: unknown): RetryLedgerDocument {
  if (!isRecord(value)) {
    throw new Error("invalid retry ledger document");
  }
  if (!hasExpectedDocumentKeys(value)) {
    throw new Error("invalid retry ledger document");
  }
  if (value.schema !== RETRY_LEDGER_SCHEMA || !isRecord(value.records)) {
    throw new Error("invalid retry ledger schema");
  }
  const terminalKeys = parseTerminalKeys(value.terminalKeys);
  const records = parseRetryRecords(value.records);
  return {
    schema: RETRY_LEDGER_SCHEMA,
    records,
    ...(terminalKeys === undefined ? {} : { terminalKeys }),
  };
}

export function sameTokens(left: RetryAttemptTokens, right: RetryAttemptTokens): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningTokens === right.reasoningTokens &&
    left.totalTokens === right.totalTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens
  );
}

export function sameUsage(left: RetryUsageTotals, right: RetryUsageTotals): boolean {
  return sameTokens(left, right) && left.durationMs === right.durationMs;
}
