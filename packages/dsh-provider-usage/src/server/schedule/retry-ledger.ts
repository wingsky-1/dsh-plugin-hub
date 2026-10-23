import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import { resolve } from "node:path";
import {
  isFiniteTimestamp,
  type RetryLedgerDocument,
  type RetryLedgerOptions,
  type RetryLedgerPort,
} from "./retry-ledger-schema.ts";
import {
  claimMatchesCurrent,
  cloneEntry,
  deleteEntry,
  entryAt,
  flatten,
  forgetTerminalKey,
  isTerminalKey,
  recoverDocument,
  setEntry,
} from "./retry-ledger-document.ts";
import { readDocumentUnlocked, writeDocumentUnlocked } from "./retry-ledger-storage.ts";
import {
  beginAttempt as policyBeginAttempt,
  beginForce as policyBeginForce,
  createInitialEntry,
  recordFailure as policyRecordFailure,
  shouldReconcileRetry,
  addRetryObservation,
  type RetryEntry,
} from "./retry-policy.ts";

const ledgerChains = new Map<string, Promise<void>>();

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
        const changed = recoverDocument(document, now, keep);
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

// ------------------------------------------------------------------ 既有出口（32 个）
// 纯重构：不增不减不改名。禁 export * —— 逐个列举让「删出口」在 diff 里显形。
// 当前无消费者的深路径出口同样保留：删出口属公共 API 变更，须另走红线评审。
// 来源按物理定义处分列：schema（校验/解析）· document（变换/等价）· storage（落盘）。

export {
  RETRY_LEDGER_SCHEMA,
  RetryLedgerError,
  narrowObservationScalars,
  hasConsistentObservationOutcome,
  parseObservation,
  collectSequentialObservations,
  usageMatchesObservations,
  isWellFormedTerminalState,
  isWellFormedLiveState,
  parseEntryState,
  hasExpectedEntryKeys,
  parseEntryIdentity,
  narrowEntryFields,
  parseEntryPayload,
  isEntryCoherent,
  buildRetryEntry,
  parseEntry,
  hasExpectedDocumentKeys,
  parseRetryPeriodBucket,
  assertKnownPeriodsOnly,
  parseRetryRecords,
  parseDocument,
} from "./retry-ledger-schema.ts";
export type {
  RetryAttemptInput,
  RetryLedgerOptions,
  RetryLedgerErrorCode,
  RetryLedgerPort,
} from "./retry-ledger-schema.ts";
export {
  sameObservations,
  sameEntryWindow,
  sameEntryCycle,
  claimMatchesCurrent,
} from "./retry-ledger-document.ts";
export { retryLedgerFile } from "./retry-ledger-storage.ts";
