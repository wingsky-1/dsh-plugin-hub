/**
 * dsh-provider-usage — server/schedule 域：报告调度器。
 *
 * 组合根提供 historyRoot-scoped coordinator 后，启动顺序固定为
 * recover → lastRun/index reconciliation → 注册 interval → 首轮 tick。
 * ready 之前 tick 直接返回；recovery/storage 失败保持 fail-closed。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
  /** keep 中的 cycle 保持原 phase（storage-terminal fail-closed），不回落 waiting。 */
  recover(now?: number, keep?: readonly RetryIndexKey[]): Promise<RetryEntry[]>;
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

/** 到期项的账本索引键（period:key）。 */
export function dueReportKey(due: Pick<DueReport, "period" | "key">): string {
  return `${due.period}:${due.key}`;
}

/** 账本条目降为到期项（终态过滤在合并侧做，此处不预判）。 */
export function dueReportOf(entry: RetryEntry): DueReport {
  return { period: entry.period, key: entry.key, startDay: entry.startDay, endDay: entry.endDay };
}

/**
 * 到期集合合并（纯函数）：
 * - 配置候选中，账本里**没有**对应条目的直接提交（尚未进入重试账本的首次窗口）；
 * - 账本 listDue 命中的非终态条目一律补提（已认领但未闭环的窗口不得漏跑）；
 * - 同键以先到者占位（Map 保持插入序，与历史实现的提交顺序一致）。
 */
export function mergeDueReports(
  current: readonly DueReport[],
  entries: readonly RetryEntry[],
  due: readonly RetryEntry[],
): DueReport[] {
  const byKey = new Map<string, RetryEntry>();
  for (const entry of entries) byKey.set(dueReportKey(entry), entry);
  const dueKeys = new Set<string>();
  for (const entry of due) dueKeys.add(dueReportKey(entry));
  const merged = new Map<string, DueReport>();
  for (const candidate of current) {
    const key = dueReportKey(candidate);
    if (byKey.get(key) === undefined || dueKeys.has(key)) merged.set(key, candidate);
  }
  for (const entry of due) {
    if (entry.terminal) continue;
    merged.set(dueReportKey(entry), dueReportOf(entry));
  }
  return [...merged.values()];
}

/** ledger 口径的到期集合：reconcile 后重算候选，再与账本非终态到期项合并。 */
async function collectLedgerDue(
  coordinator: ReportStateCoordinator,
  config: ReportConfig,
  now: () => number,
  lastRun: Partial<Record<ReportPeriod, string>>,
  listIndexed: (() => Promise<RetryIndexKey[]>) | undefined,
): Promise<DueReport[]> {
  const indexed = listIndexed === undefined ? [] : await listIndexed();
  await coordinator.reconcile(lastRun, indexed);
  const effectiveLastRun = await coordinator.readLastRun();
  const current = pendingReports(config, now(), effectiveLastRun);
  const entries = await coordinator.list();
  const due = await coordinator.listDue(now(), effectiveLastRun);
  return mergeDueReports(current, entries, due);
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
      // Legacy index rows without cycleId are trusted only when no live ledger entry exists; current cycles still require exact cycleId fencing.
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

  /** tick 前置闸门：已释放 / 正在 tick / 未 ready / 恢复失败——任一成立即跳过本轮。 */
  private blocked(): boolean {
    return this.disposed || this.ticking || !this.readyState || this.recoveryError;
  }

  /**
   * 本轮到期集合。coordinator 缺席时只认配置候选；存在时先 reconcile 再重算，
   * 并与账本里的非终态到期项合并（见 mergeDueReports）。
   */
  private async collectDue(): Promise<DueReport[]> {
    const coordinator = this.coordinator;
    const lastRun =
      coordinator === undefined ? await readLastRun(this.root) : await coordinator.readLastRun();
    const current = pendingReports(this.config, this.now(), lastRun);
    if (coordinator === undefined) return current;
    return collectLedgerDue(coordinator, this.config, this.now, lastRun, this.listIndexed);
  }

  /** 失败诊断：coordinator 缺席时给原始 message，在场时只给稳定错误码（不外泄原文）。 */
  private reportFailure(context: string, error: unknown): void {
    this.warn(
      this.coordinator === undefined
        ? `${context}：${error instanceof Error ? error.message : String(error)}`
        : `${context}（${diagnosticCode(error, "storage")}）`,
    );
  }

  /** 一轮检查：ready 前直接返回；合并当前候选与已有 ledger 的非终态到期项。 */
  async tick(): Promise<void> {
    if (this.blocked()) return;
    this.ticking = true;
    try {
      for (const due of await this.collectDue()) {
        try {
          await this.onDue(due);
        } catch (error: unknown) {
          this.reportFailure(`${due.period} ${due.key} 提交失败`, error);
        }
      }
    } catch (error: unknown) {
      this.reportFailure("tick 异常", error);
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
  /** 幂等补完半提交事务（不含 ledger recover 本身；启动由 recover 串联调用）。 */
  recoverFence(): Promise<RetryFenceDocument>;
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

/**
 * 事务围栏（#1010 残余 E）：commit 顺序为 persist → 半提交 marker → lastRun →
 * ledger.clear。marker 让「产物已落盘但 lastRun/clear 未完成」的半提交状态在崩溃
 * 或 storage 失败后可被幂等识别并补完：既不回滚已推进的 lastRun，也不重跑模型。
 *
 * 形态为 reports/retry-fence.json（0600 原子写）：
 * - commits[]：本 cycle 已完成 persist，恢复时补写 lastRun 并清账；
 * - storageTerminals[]：storage 失败且 terminalize 写入失败，恢复时保持
 *   in-flight（fail-closed），不得回落 waiting 自动重跑。
 */
export interface RetryFenceMarker {
  period: ReportPeriod;
  key: string;
  cycleId: string;
}

interface RetryFenceDocument {
  schema: 1;
  commits: RetryFenceMarker[];
  storageTerminals: RetryFenceMarker[];
}

export function retryFenceFile(root: string): string {
  return join(root, "reports", "retry-fence.json");
}

function sameMarker(left: RetryFenceMarker, right: RetryFenceMarker): boolean {
  return left.period === right.period && left.key === right.key && left.cycleId === right.cycleId;
}

function upsertMarker(list: RetryFenceMarker[], marker: RetryFenceMarker): void {
  const index = list.findIndex((item) => sameMarker(item, marker));
  if (index < 0) list.push(marker);
  else list[index] = marker;
}

function emptyFence(): RetryFenceDocument {
  return { schema: 1, commits: [], storageTerminals: [] };
}

function parseFence(raw: string): RetryFenceDocument {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error("invalid retry fence");
  const record = parsed as Record<string, unknown>;
  if (record.schema !== 1) throw new Error("invalid retry fence schema");
  const readMarkers = (value: unknown): RetryFenceMarker[] => {
    if (!Array.isArray(value)) throw new Error("invalid retry fence markers");
    return value.map((item) => {
      if (typeof item !== "object" || item === null) throw new Error("invalid retry fence marker");
      const marker = item as Record<string, unknown>;
      if (
        typeof marker.period !== "string" ||
        typeof marker.key !== "string" ||
        typeof marker.cycleId !== "string"
      ) {
        throw new Error("invalid retry fence marker fields");
      }
      return {
        period: marker.period as ReportPeriod,
        key: marker.key,
        cycleId: marker.cycleId,
      };
    });
  };
  return {
    schema: 1,
    commits: readMarkers(record.commits),
    storageTerminals: readMarkers(record.storageTerminals),
  };
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

/** claim 所指条目的窗口身份等价。 */
export function sameClaimWindow(left: RetryClaim, right: RetryEntry): boolean {
  return (
    left.entry.period === right.period &&
    left.entry.key === right.key &&
    left.entry.startDay === right.startDay &&
    left.entry.endDay === right.endDay
  );
}

/** claim 所指条目的周期状态等价。 */
export function sameClaimCycle(left: RetryClaim, right: RetryEntry): boolean {
  return (
    left.entry.phase === right.phase &&
    left.entry.attempts === right.attempts &&
    left.entry.terminal === right.terminal &&
    left.entry.nextRetryAt === right.nextRetryAt
  );
}

/** claim 仍指向当前条目（cycle 围栏）：身份、周期状态与成本载荷全等。 */
function sameClaim(left: RetryClaim, right: RetryEntry | undefined): boolean {
  if (right === undefined) return false;
  return (
    left.cycleId === right.cycleId &&
    sameClaimWindow(left, right) &&
    sameClaimCycle(left, right) &&
    JSON.stringify(left.entry.attemptObservations) === JSON.stringify(right.attemptObservations) &&
    JSON.stringify(left.entry.usage) === JSON.stringify(right.usage)
  );
}

function isCurrentIndexFact(
  current: RetryEntry | undefined,
  indexed: Pick<RetryIndexKey, "cycleId">,
): boolean {
  if (current === undefined) return indexed.cycleId === undefined;
  return (
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

/** 读围栏文档；缺失即空围栏；损坏 fail-closed（不静默当空）。 */
async function readFence(root: string): Promise<RetryFenceDocument> {
  let raw: string;
  try {
    raw = await readFile(retryFenceFile(root), "utf8");
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === "ENOENT") return emptyFence();
    throw new ReportStateStorageError();
  }
  try {
    return parseFence(raw);
  } catch {
    throw new ReportStateStorageError();
  }
}

/** 原子写围栏文档（0600 临时文件 → rename）；写失败即 storage 失败。 */
async function writeFence(root: string, document: RetryFenceDocument): Promise<void> {
  const file = retryFenceFile(root);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(document), { mode: 0o600 });
    await rename(temporary, file);
  } catch {
    await unlink(temporary).catch(() => {});
    throw new ReportStateStorageError();
  }
}

/**
 * storage 终态落盘：先写 ledger 的 terminal 记录；写失败则落 storage-terminal
 * 围栏标记（durable），使 recover 不会把该 cycle 回落为 waiting 自动重跑。
 */
async function terminalize(
  root: string,
  ledger: RetryLedgerPort,
  claim: RetryClaim,
  now: number,
  code: ReportStateStorageCode = "report-state-storage",
): Promise<void> {
  try {
    await ledger.recordFailure(claim, { kind: "storage", code }, now);
    return;
  } catch {
    // 原始存储错误不越过包边界；改以围栏标记保持 fail-closed。
  }
  const marker: RetryFenceMarker = {
    period: claim.entry.period,
    key: claim.entry.key,
    cycleId: claim.cycleId,
  };
  const fence = await readFence(root).catch(() => emptyFence());
  upsertMarker(fence.storageTerminals, marker);
  await writeFence(root, fence);
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

  /**
   * 补完半提交事务：产物已落盘、lastRun/clear 未完成的 cycle 在恢复时幂等收尾
   * （monotonic 推进 lastRun + CAS 清账）。旧 cycle 标记（force 已开新 cycle）与
   * 已终结记录一律丢弃，绝不让旧产物清掉新 cycle 的账。
   */
  const finishHalfCommits = async (fence: RetryFenceDocument): Promise<RetryFenceDocument> => {
    if (fence.commits.length === 0 && fence.storageTerminals.length === 0) return fence;
    const live = await ledger.list();
    let advanced = await read(root);
    for (const marker of fence.commits) {
      const entry = live.find(
        (item) =>
          item.period === marker.period &&
          item.key === marker.key &&
          item.cycleId === marker.cycleId,
      );
      if (entry === undefined || entry.terminal) continue;
      advanced = monotonic(advanced, marker.period, marker.key);
      await write(root, () => advanced);
      await ledger.clear({ cycleId: marker.cycleId, entry });
    }
    // storage-terminal 标记：记录已不存在（clear 成功）即过期；仍在则保留 fail-closed。
    const next: RetryFenceDocument = {
      schema: 1,
      commits: [],
      storageTerminals: fence.storageTerminals.filter((marker) =>
        live.some(
          (item) =>
            item.period === marker.period &&
            item.key === marker.key &&
            item.cycleId === marker.cycleId,
        ),
      ),
    };
    await writeFence(root, next);
    return next;
  };

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
    // recover 前先补完半提交事务；storage-terminal 围栏内的 cycle 保持 in-flight，
    // 不回落 waiting 自动重跑（fail-closed：只有 manual force 才开新 cycle）。
    recover: (at?: number) =>
      locked(async () => {
        const stamp = at ?? now();
        const fence = await readFence(root);
        await finishHalfCommits(fence);
        return ledger.recover(stamp, fence.storageTerminals);
      }),
    recoverFence: () => locked(() => readFence(root).then(finishHalfCommits)),
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
        const marker: RetryFenceMarker = {
          period: input.result.meta.period,
          key: input.result.meta.key,
          cycleId: input.claim.cycleId,
        };
        try {
          await input.persist();
        } catch {
          await terminalize(root, ledger, input.claim, now(), "report-persist-failed");
          throw new ReportStateStorageError("report-persist-failed");
        }
        // 半提交标记先于 lastRun 落盘：其后任一步失败都可被恢复流程幂等补完，
        // 不会让「产物已写、lastRun/clear 未完成」被当作普通 storage 失败重跑。
        const fence = await readFence(root);
        upsertMarker(fence.commits, marker);
        await writeFence(root, fence);
        try {
          await write(root, (previous) =>
            monotonic(previous, input.result.meta.period, input.result.meta.key),
          );
        } catch {
          // 半提交已标记：交由恢复流程补完，不得写 storage terminal 覆盖已落盘产物。
          throw new ReportStateStorageError();
        }
        try {
          const cleared = await ledger.clear(input.claim);
          await writeFence(root, {
            ...fence,
            commits: fence.commits.filter((item) => !sameMarker(item, marker)),
          });
          return cleared;
        } catch {
          // 同上：clear 失败是可恢复的半提交，不是 storage 终态（不反向回滚 lastRun）。
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
        if (current === undefined) return true;
        return ledger.clear({ cycleId: current.cycleId, entry: current });
      }),
    migrateLastRun: async (warn, parseIndex) => {
      // Schema migration remains store-owned; run it under the same root lock.
      return locked(() => ensureLastRunMigrated(root, warn, parseIndex));
    },
  };
}
