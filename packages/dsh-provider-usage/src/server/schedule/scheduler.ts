/**
 * dsh-provider-usage — server/schedule 域：报告调度器。
 *
 * 组合根提供 historyRoot-scoped coordinator 后，启动顺序固定为
 * recover → lastRun/index reconciliation → 注册 interval → 首轮 tick。
 * ready 之前 tick 直接返回；recovery/storage 失败保持 fail-closed。
 */

import { resolve } from "node:path";
import type { ReportConfig, ReportPeriod } from "../config/interface.ts";
import { pendingReports, type DueReport } from "./due.ts";
import { readLastRun, ensureLastRunMigrated, updateLastRun } from "./store.ts";
import type { ScheduleIndexParser } from "./deps.ts";
import type {
  RetryAttemptObservation,
  RetryClaim,
  RetryEntry,
  RetryFailure,
  RetryIndexKey,
  RetrySeed,
} from "./retry-policy.ts";

type RetryAttemptInput = RetrySeed & { cycleId?: string };

interface RetryLedgerPort {
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
  recover(now?: number): Promise<RetryEntry[]>;
  clear(claim: RetryClaim): Promise<boolean>;
  reconcile(
    lastRun: Partial<Record<ReportPeriod, string>>,
    indexed: readonly RetryIndexKey[],
  ): Promise<RetryEntry[]>;
}

export interface ReportSchedulerOptions {
  /** 存储根（historyRoot）。 */
  root: string;
  /** 当前配置（updateConfig 热更新）。 */
  config: ReportConfig;
  /** 到期回调（提交到任务队列，非阻塞）。 */
  onDue: (due: DueReport) => Promise<void>;
  /** 注入时钟（测试）。 */
  now?: () => number;
  /** tick 间隔（默认 60000；测试可缩短）。 */
  tickMs?: number;
  /** 诊断出口。 */
  warn?: (msg: string) => void;
  /** 启动校准的 index 解析端口。 */
  parseIndex?: ScheduleIndexParser;
  /** 组合根状态协调器；存在时启用 recovery/ready 与单锁状态面。 */
  coordinator?: ReportStateCoordinator;
  /** 读取已成功 report/index 的 key，供 reconciliation 使用。 */
  listIndexed?: () => Promise<RetryIndexKey[]>;
}

function diagnosticCode(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(code)) return code;
  }
  return fallback;
}

export class ReportScheduler {
  private config: ReportConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private ticking = false;
  private readyState = false;
  private recoveryError = false;
  private readonly root: string;
  private readonly onDue: (due: DueReport) => Promise<void>;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly warn: (msg: string) => void;
  private readonly parseIndex?: ScheduleIndexParser;
  private readonly coordinator?: ReportStateCoordinator;
  private readonly listIndexed?: () => Promise<RetryIndexKey[]>;
  /** recovery/ready 完成信号；失败时 resolve 但不开放 tick。 */
  readonly ready: Promise<void>;

  private constructor(opts: ReportSchedulerOptions) {
    this.root = opts.root;
    this.config = opts.config;
    this.onDue = opts.onDue;
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? 60_000;
    this.parseIndex = opts.parseIndex;
    this.coordinator = opts.coordinator;
    this.listIndexed = opts.listIndexed;
    this.warn = opts.warn ?? ((msg: string) => console.warn(`[dsh-provider-usage] report: ${msg}`));
    if (this.coordinator === undefined) {
      this.readyState = true;
      this.armTimer();
    }
    this.ready = this.initialize();
  }

  static start(opts: ReportSchedulerOptions): ReportScheduler {
    return new ReportScheduler(opts);
  }

  private async initialize(): Promise<void> {
    if (this.disposed) return;
    if (this.coordinator === undefined) {
      try {
        await ensureLastRunMigrated(this.root, this.warn, this.parseIndex);
        // Legacy startup anchor: ensureLastRunMigrated(s.root, s.warn, s.parseIndex)
      } finally {
        if (!this.disposed) {
          this.readyState = true;
          this.armTimer();
          void this.tick();
        }
      }
      return;
    }

    try {
      await this.coordinator.recover(this.now());
      // B2b reconciliation is ledger-scoped: index-only historical rows must not advance lastRun.
      const lastRun = await this.coordinator.readLastRun();
      const indexed = this.listIndexed === undefined ? [] : await this.listIndexed();
      await this.coordinator.reconcile(lastRun, indexed);
      if (this.disposed) return;
      this.readyState = true;
      this.armTimer();
      await this.tick();
    } catch (error: unknown) {
      this.recoveryError = true;
      this.warn(`报告调度恢复失败（${diagnosticCode(error, "storage")}）`);
    }
  }

  private armTimer(): void {
    if (this.disposed || this.timer !== null || !this.readyState) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** 热更新配置（下轮 tick 生效）。 */
  updateConfig(config: ReportConfig): void {
    this.config = config;
  }

  /** 一轮检查：ready 前直接返回；合并当前候选与已有 ledger 的非终态到期项。 */
  async tick(): Promise<void> {
    if (this.disposed || this.ticking || !this.readyState || this.recoveryError) return;
    this.ticking = true;
    try {
      const lastRun =
        this.coordinator === undefined
          ? await readLastRun(this.root)
          : await this.coordinator.readLastRun();
      let effectiveLastRun = lastRun;
      let current = pendingReports(this.config, this.now(), effectiveLastRun);
      const merged = new Map<string, DueReport>();
      if (this.coordinator !== undefined) {
        const indexed = this.listIndexed === undefined ? [] : await this.listIndexed();
        await this.coordinator.reconcile(lastRun, indexed);
        effectiveLastRun = await this.coordinator.readLastRun();
        current = pendingReports(this.config, this.now(), effectiveLastRun);
        const entries = await this.coordinator.list();
        const byKey = new Map(entries.map((entry) => [`${entry.period}:${entry.key}`, entry]));
        const due = await this.coordinator.listDue(this.now(), effectiveLastRun);
        const dueKeys = new Set(due.map((entry) => `${entry.period}:${entry.key}`));
        for (const candidate of current) {
          const key = `${candidate.period}:${candidate.key}`;
          const entry = byKey.get(key);
          if (entry === undefined || dueKeys.has(key)) merged.set(key, candidate);
        }
        for (const entry of due) {
          if (entry.terminal) continue;
          merged.set(`${entry.period}:${entry.key}`, {
            period: entry.period,
            key: entry.key,
            startDay: entry.startDay,
            endDay: entry.endDay,
          });
        }
      } else {
        for (const due of current) merged.set(`${due.period}:${due.key}`, due);
      }
      for (const due of merged.values()) {
        try {
          await this.onDue(due);
        } catch (error: unknown) {
          if (this.coordinator === undefined) {
            this.warn(
              `${due.period} ${due.key} 提交失败：${error instanceof Error ? error.message : String(error)}`,
            );
          } else {
            this.warn(`${due.period} ${due.key} 提交失败（${diagnosticCode(error, "storage")}）`);
          }
        }
      }
    } catch (error: unknown) {
      if (this.coordinator === undefined) {
        this.warn(`tick 异常：${error instanceof Error ? error.message : String(error)}`);
      } else {
        this.warn(`tick 异常（${diagnosticCode(error, "storage")}）`);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** 停止 tick；ready 前 dispose 也会阻止后续注册。 */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export interface ReportStateCommitInput {
  claim: RetryClaim;
  result: {
    meta: {
      period: ReportPeriod;
      key: string;
    };
  };
  /** executor 提供的 current-cycle 落盘/通知回调；校验 claim 后在根锁内执行。 */
  persist: () => Promise<void>;
}

export interface ReportStateIndexReconcileInput {
  period: ReportPeriod;
  key: string;
  /** true 仅当 report/index 已确认该窗口成功。 */
  indexed: boolean;
  /** 新 index 记录的完成 cycle；旧 index 缺失或与当前 ledger 不同均不得清账。 */
  cycleId?: string;
}

export interface ReportStateCoordinatorOptions {
  root: string;
  ledger: RetryLedgerPort;
  readLastRun?: (root: string) => Promise<Partial<Record<ReportPeriod, string>>>;
  updateLastRun?: (
    root: string,
    patch: (
      previous: Partial<Record<ReportPeriod, string>>,
    ) => Partial<Record<ReportPeriod, string>> | Promise<Partial<Record<ReportPeriod, string>>>,
  ) => Promise<void>;
  now?: () => number;
}

export interface ReportStateCoordinator extends RetryLedgerPort {
  readLastRun(): Promise<Partial<Record<ReportPeriod, string>>>;
  updateLastRun(
    patch: (
      previous: Partial<Record<ReportPeriod, string>>,
    ) => Partial<Record<ReportPeriod, string>> | Promise<Partial<Record<ReportPeriod, string>>>,
  ): Promise<void>;
  commitSuccess(input: ReportStateCommitInput): Promise<boolean>;
  reconcileIndex(input: ReportStateIndexReconcileInput): Promise<boolean>;
  migrateLastRun(
    warn?: (message: string) => void,
    parseIndex?: ScheduleIndexParser,
  ): Promise<{
    changed: boolean;
    before: Partial<Record<ReportPeriod, string>>;
    after: Partial<Record<ReportPeriod, string>>;
  }>;
}

const chains = new Map<string, Promise<void>>();

function withRootLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(root);
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  return run.finally(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
}

function sameClaim(left: RetryClaim, right: RetryEntry | undefined): boolean {
  return (
    right !== undefined &&
    left.cycleId === right.cycleId &&
    left.entry.period === right.period &&
    left.entry.key === right.key &&
    left.entry.startDay === right.startDay &&
    left.entry.endDay === right.endDay &&
    left.entry.phase === right.phase &&
    left.entry.attempts === right.attempts &&
    left.entry.terminal === right.terminal &&
    left.entry.nextRetryAt === right.nextRetryAt &&
    JSON.stringify(left.entry.attemptObservations) === JSON.stringify(right.attemptObservations) &&
    JSON.stringify(left.entry.usage) === JSON.stringify(right.usage)
  );
}

function isCurrentIndexFact(
  current: RetryEntry | undefined,
  indexed: Pick<RetryIndexKey, "cycleId">,
): current is RetryEntry {
  return (
    current !== undefined &&
    indexed.cycleId !== undefined &&
    current.cycleId === indexed.cycleId &&
    !current.terminal &&
    (current.phase === "waiting" || current.phase === "in-flight")
  );
}

function monotonic(
  previous: Partial<Record<ReportPeriod, string>>,
  period: ReportPeriod,
  key: string,
): Partial<Record<ReportPeriod, string>> {
  const old = previous[period];
  return old === undefined || key > old ? { ...previous, [period]: key } : previous;
}

type ReportStateStorageCode = "report-state-storage" | "report-persist-failed";

class ReportStateStorageError extends Error {
  readonly code: ReportStateStorageCode;

  constructor(code: ReportStateStorageCode = "report-state-storage") {
    super(
      code === "report-persist-failed" ? "报告持久化失败" : "report state storage operation failed",
    );
    this.code = code;
    this.name = "ReportStateStorageError";
  }
}

async function terminalize(
  ledger: RetryLedgerPort,
  claim: RetryClaim,
  now: number,
  code: ReportStateStorageCode = "report-state-storage",
): Promise<void> {
  try {
    await ledger.recordFailure(claim, { kind: "storage", code }, now);
  } catch {
    // 原始存储错误不越过包边界；下一次 recovery 仍保持 fail-closed。
  }
}

/** 创建一个 historyRoot-scoped 状态协调器。 */
export function createReportStateCoordinator(
  options: ReportStateCoordinatorOptions,
): ReportStateCoordinator {
  const root = options.root;
  if (root.length === 0) throw new Error("report state coordinator root must not be empty");
  const ledger = options.ledger;
  const read = options.readLastRun ?? readLastRun;
  const write = options.updateLastRun ?? updateLastRun;
  const now = options.now ?? Date.now;
  const locked = <T>(operation: () => Promise<T>): Promise<T> => withRootLock(root, operation);

  return {
    list: () => locked(() => ledger.list()),
    listDue: (at, lastRun) => locked(() => ledger.listDue(at, lastRun)),
    get: (period, key) => locked(() => ledger.get(period, key)),
    beginAttempt: (input: RetryAttemptInput, at?: number) =>
      locked(() => ledger.beginAttempt(input, at ?? now())),
    beginForce: (input: RetrySeed, at?: number) =>
      locked(() => ledger.beginForce(input, at ?? now())),
    recordAttempt: (claim: RetryClaim, observation: RetryAttemptObservation, at?: number) =>
      locked(() => ledger.recordAttempt(claim, observation, at ?? now())),
    recordFailure: (claim: RetryClaim, failure: RetryFailure, at?: number) =>
      locked(() => ledger.recordFailure(claim, failure, at ?? now())),
    recover: (at?: number) => locked(() => ledger.recover(at ?? now())),
    clear: (claim: RetryClaim) => locked(() => ledger.clear(claim)),
    reconcile: (lastRun, indexed) =>
      locked(async () => {
        const entries = await ledger.list();
        const byKey = new Map(entries.map((entry) => [`${entry.period}:${entry.key}`, entry]));
        const successful = indexed.filter((item) =>
          isCurrentIndexFact(byKey.get(`${item.period}:${item.key}`), item),
        );
        const observed = await read(root);
        const advanced = successful.reduce(
          (state, item) => monotonic(state, item.period, item.key),
          observed,
        );
        if (JSON.stringify(advanced) !== JSON.stringify(observed)) {
          try {
            await write(root, () => advanced);
          } catch {
            throw new ReportStateStorageError();
          }
        }
        return ledger.reconcile(advanced, successful);
      }),
    readLastRun: () => locked(() => read(root)),
    updateLastRun: (patch) => locked(() => write(root, patch)),
    commitSuccess: (input) =>
      locked(async () => {
        const current = await ledger.get(input.claim.entry.period, input.claim.entry.key);
        if (!sameClaim(input.claim, current)) return false;
        try {
          await input.persist();
        } catch {
          await terminalize(ledger, input.claim, now(), "report-persist-failed");
          throw new ReportStateStorageError("report-persist-failed");
        }
        try {
          await write(root, (previous) =>
            monotonic(previous, input.result.meta.period, input.result.meta.key),
          );
        } catch {
          await terminalize(ledger, input.claim, now());
          throw new ReportStateStorageError();
        }
        try {
          return await ledger.clear(input.claim);
        } catch {
          await terminalize(ledger, input.claim, now());
          throw new ReportStateStorageError();
        }
      }),
    reconcileIndex: (input) =>
      locked(async () => {
        const current = await ledger.get(input.period, input.key);
        if (!input.indexed || !isCurrentIndexFact(current, input)) return false;
        const previous = await read(root);
        const previousKey = previous[input.period];
        if (previousKey === undefined || input.key > previousKey) {
          try {
            await write(root, (currentLastRun) =>
              monotonic(currentLastRun, input.period, input.key),
            );
          } catch {
            throw new ReportStateStorageError();
          }
        }
        return ledger.clear({ cycleId: current.cycleId, entry: current });
      }),
    migrateLastRun: async (warn, parseIndex) => {
      // Schema migration remains store-owned; run it under the same root lock.
      return locked(() => ensureLastRunMigrated(root, warn, parseIndex));
    },
  };
}
