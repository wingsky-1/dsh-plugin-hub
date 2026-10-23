/**
 * dsh-provider-usage — 报告重试状态账本：文档变换面（#1174 阶段 2）。
 *
 * 纯变换：克隆 / terminal 墓碑维护 / 查表 / 等价判定 / recover 推进。不做 IO、
 * 不改调用顺序；recover 的变换部分收敛为 recoverDocument，由 retry-ledger.ts 的工厂
 * 在 read 之后、changed 时 write 之前调用。
 *
 * 单向依赖 schema 面（parseEntry / RETRY_LEDGER_SCHEMA / 文档类型 / sameTokens /
 * sameUsage / PERIODS 的唯一定义在 retry-ledger-schema.ts），不依赖 storage 与工厂面。
 */

import type { ReportPeriod } from "../config/interface.ts";
import {
  RETRY_LEDGER_SCHEMA,
  PERIODS,
  parseEntry,
  sameTokens,
  sameUsage,
  type RetryLedgerDocument,
  type RetryRecords,
} from "./retry-ledger-schema.ts";
import {
  recover as policyRecover,
  type RetryAttemptObservation,
  type RetryClaim,
  type RetryEntry,
  type RetryIndexKey,
  type RetryRouteSnapshot,
  type RetryTerminalReason,
} from "./retry-policy.ts";

export function cloneEntry(entry: RetryEntry): RetryEntry {
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

export function isTerminalKey(
  document: RetryLedgerDocument,
  period: ReportPeriod,
  key: string,
): boolean {
  return document.terminalKeys?.[period]?.[key] !== undefined;
}

/** reconcile/clear 命中即视为该 key 已闭环，墓碑随之失效。 */
export function forgetTerminalKey(
  document: RetryLedgerDocument,
  period: ReportPeriod,
  key: string,
): void {
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

export function pruneTerminalEntries(document: RetryLedgerDocument): RetryLedgerDocument {
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

export function flatten(document: RetryLedgerDocument): RetryEntry[] {
  const entries: RetryEntry[] = [];
  for (const period of PERIODS) {
    const bucket = document.records[period];
    if (bucket === undefined) continue;
    for (const key of Object.keys(bucket).sort()) entries.push(cloneEntry(bucket[key]!));
  }
  return entries;
}

export function emptyDocument(): RetryLedgerDocument {
  return { schema: RETRY_LEDGER_SCHEMA, records: {} };
}

export function serializeDocument(document: RetryLedgerDocument): string {
  const pruned = pruneTerminalEntries(document);
  const terminalKeys = cloneTerminalKeys(pruned.terminalKeys);
  const payload: RetryLedgerDocument =
    terminalKeys === undefined
      ? { schema: RETRY_LEDGER_SCHEMA, records: pruned.records }
      : { schema: RETRY_LEDGER_SCHEMA, records: pruned.records, terminalKeys };
  return JSON.stringify(payload);
}

export function entryAt(
  document: RetryLedgerDocument,
  period: ReportPeriod,
  key: string,
): RetryEntry | undefined {
  const entry = document.records[period]?.[key];
  return entry === undefined ? undefined : cloneEntry(entry);
}

export function setEntry(document: RetryLedgerDocument, entry: RetryEntry): void {
  const checked = parseEntry(entry.period, entry.key, entry);
  if (checked === null) throw new Error("invalid retry ledger entry");
  const bucket = document.records[entry.period] ?? {};
  bucket[entry.key] = checked;
  document.records[entry.period] = bucket;
}

export function sameRoute(left: RetryRouteSnapshot, right: RetryRouteSnapshot): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort
  );
}

export function sameReason(
  left: RetryTerminalReason | null,
  right: RetryTerminalReason | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.code === right.code && left.kind === right.kind;
}

/**
 * 单条观测等价。右侧缺席即不等价（调用方已先比长度，越界只可能来自越界读取）；
 * tokens 缺席视作全空，与历史实现的 `right?.[i]?.tokens ?? empty` 口径一致。
 */
export function sameObservation(
  left: RetryAttemptObservation,
  right: RetryAttemptObservation | undefined,
): boolean {
  if (right === undefined) return false;
  return (
    left.attempt === right.attempt &&
    left.result === right.result &&
    left.code === right.code &&
    left.status === right.status &&
    left.durationMs === right.durationMs &&
    sameTokens(left.tokens, right.tokens)
  );
}

export function sameObservations(
  left: readonly RetryAttemptObservation[],
  right: readonly RetryAttemptObservation[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((observation, index) => sameObservation(observation, right[index]));
}

/** 条目窗口身份等价（period/key/窗口首末日）。 */
export function sameEntryWindow(left: RetryEntry, right: RetryEntry): boolean {
  return (
    left.period === right.period &&
    left.key === right.key &&
    left.startDay === right.startDay &&
    left.endDay === right.endDay
  );
}

/** 条目周期状态等价（尝试次数/排期/终态标记/相位）。 */
export function sameEntryCycle(left: RetryEntry, right: RetryEntry): boolean {
  return (
    left.attempts === right.attempts &&
    left.nextRetryAt === right.nextRetryAt &&
    left.terminal === right.terminal &&
    left.phase === right.phase
  );
}

export function claimMatchesCurrent(claim: RetryClaim, current: RetryEntry): boolean {
  const claimed = claim.entry;
  return (
    claim.cycleId === current.cycleId &&
    sameEntryWindow(claimed, current) &&
    sameEntryCycle(claimed, current) &&
    sameRoute(claimed.route, current.route) &&
    sameReason(claimed.reason, current.reason) &&
    sameObservations(claimed.attemptObservations, current.attemptObservations) &&
    sameUsage(claimed.usage, current.usage)
  );
}

export function deleteEntry(
  document: RetryLedgerDocument,
  period: ReportPeriod,
  key: string,
): void {
  const bucket = document.records[period];
  if (bucket === undefined) return;
  delete bucket[key];
  if (Object.keys(bucket).length === 0) delete document.records[period];
}

/**
 * recover 的纯变换部分：按 keep 围栏跳过 storage-terminal cycle，其余条目按
 * policyRecover 就地推进，返回是否发生过改写。
 *
 * 逐字搬移自原 recover 端口实现，不改判断语义；是否落盘由调用方按返回值决定。
 */
export function recoverDocument(
  document: RetryLedgerDocument,
  now: number,
  keep?: readonly RetryIndexKey[],
): boolean {
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
  return changed;
}
