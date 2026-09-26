/**
 * dsh-provider-usage — 报告生成任务队列。
 *
 * 队列只负责串行、去重与 force 生命周期；retry claim/cycle 仍由 executor 在
 * 真正开始执行前通过 coordinator 获取。force 请求先 durable prepare，再进入
 * 队列；运行中的旧 cycle 不被改写，后续 force cycle 独立排队。
 */

import { randomUUID } from "node:crypto";
import type { ReportPeriod } from "../config/interface.ts";
import type { ReportMeta } from "../execute/interface.ts";

export type ReportTaskStatus = "queued" | "running" | "done" | "failed";

/** 任务输入（窗口 + force 标志；不携带 ledger/cycle 字段）。 */
export interface ReportTaskInput {
  period: ReportPeriod;
  key: string;
  startDay: string;
  endDay: string;
  force?: boolean;
}

/** 任务状态记录（对外可查）。 */
export interface ReportTask {
  id: string;
  period: ReportPeriod;
  key: string;
  startDay: string;
  endDay: string;
  force: boolean;
  status: ReportTaskStatus;
  createdAt: number;
  updatedAt: number;
  meta?: ReportMeta;
  reused?: boolean;
  /** 生产队列只保存稳定错误 code；旧无 retry seam 保留兼容文本。 */
  error?: string;
}

export interface ReportTaskResult {
  meta?: ReportMeta;
  reused?: boolean;
}

export interface ReportTaskQueueOptions {
  executor: (input: ReportTaskInput) => Promise<ReportTaskResult>;
  now?: () => number;
  warn?: (msg: string) => void;
  ttlMs?: number;
  maxTasks?: number;
  /** force=true 时先 durable prepare；成功后才接受任务。 */
  prepareForce?: (input: ReportTaskInput) => Promise<void>;
  /** 生产组合根开启稳定错误码；旧测试/兼容调用未开启时保留旧文本。 */
  sanitizeErrors?: boolean;
}

export interface ReportTaskSubmission {
  taskId: string;
  existing: boolean;
}

interface TaskRuntime {
  scheduled: boolean;
  running: boolean;
}

type ResolveSubmission = (value: ReportTaskSubmission) => void;
type RejectSubmission = (reason?: unknown) => void;

interface PendingForce {
  readonly key: string;
  readonly task: ReportTask;
  readonly input: ReportTaskInput;
  readonly submissionExisting: boolean;
  normalRequested: boolean;
  prepared: boolean;
  settled: boolean;
  readonly operation: Promise<ReportTaskSubmission>;
  readonly resolve: ResolveSubmission;
  readonly reject: RejectSubmission;
}

function taskKey(input: Pick<ReportTaskInput, "period" | "key">): string {
  return `${input.period}\u0000${input.key}`;
}

function stableErrorCode(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null) {
    const value = (error as { code?: unknown; message?: unknown }).code;
    if (typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(value)) return value;
  }
  return fallback;
}

export class ReportTaskQueue {
  private readonly tasks = new Map<string, ReportTask>();
  private readonly runtimes = new Map<string, TaskRuntime>();
  private readonly pendingForces = new Map<string, PendingForce>();
  private readonly preparedForceTasks = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  /** 保留 force prepare+activate 的全局串行语义；reservation 只屏蔽普通 submit。 */
  private forceTail: Promise<unknown> = Promise.resolve();
  private readonly executor: (input: ReportTaskInput) => Promise<ReportTaskResult>;
  private readonly now: () => number;
  private readonly warn: (msg: string) => void;
  private readonly ttlMs: number;
  private readonly maxTasks: number;
  private readonly prepareForce?: (input: ReportTaskInput) => Promise<void>;
  private readonly sanitizeErrors: boolean;

  constructor(opts: ReportTaskQueueOptions) {
    this.executor = opts.executor;
    this.now = opts.now ?? Date.now;
    this.warn = opts.warn ?? ((msg: string) => console.warn(`[dsh-provider-usage] report: ${msg}`));
    this.ttlMs = opts.ttlMs ?? 600_000;
    this.maxTasks = opts.maxTasks ?? 50;
    this.prepareForce = opts.prepareForce;
    this.sanitizeErrors = opts.sanitizeErrors ?? false;
  }

  /**
   * 提交非 force 任务（同步兼容入口）。force=true 的生产路径应调用 submitForce；
   * 没有 prepareForce 时仍按旧测试语义执行，但不会伪造 durable force。
   */
  submit(input: ReportTaskInput): ReportTaskSubmission {
    return this.enqueue(input, input.force === true);
  }

  /** force 入口：同步登记 reservation，durable prepare 成功后才激活 task。 */
  submitForce(input: ReportTaskInput): Promise<ReportTaskSubmission> {
    const key = taskKey(input);
    const pending = this.pendingForces.get(key);
    if (pending !== undefined) return pending.operation;

    const queued = this.findQueued(input);
    if (queued !== undefined && queued.force && this.preparedForceTasks.has(queued.id)) {
      return Promise.resolve({ taskId: queued.id, existing: true });
    }

    const wasNormal = queued !== undefined && !queued.force;
    const task = queued ?? this.createTask(input, true);
    task.force = true;
    const reservation = this.createPendingForce(input, task, queued !== undefined, wasNormal);
    this.pendingForces.set(key, reservation);
    this.prune();

    if (this.prepareForce === undefined) {
      this.activateForce(reservation);
      return reservation.operation;
    }

    const operation = this.forceTail.then(async () => {
      try {
        await this.prepareForce?.(input);
        this.activateForce(reservation);
      } catch (error: unknown) {
        this.rejectForce(reservation, error);
      }
    });
    this.forceTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return reservation.operation;
  }

  private enqueue(input: ReportTaskInput, force: boolean): ReportTaskSubmission {
    const pending = this.pendingForces.get(taskKey(input));
    if (pending !== undefined) {
      if (!force) pending.normalRequested = true;
      return { taskId: pending.task.id, existing: true };
    }

    for (const task of this.tasks.values()) {
      if (task.period !== input.period || task.key !== input.key) continue;
      if (task.status === "queued") {
        if (force) task.force = true;
        return { taskId: task.id, existing: true };
      }
      if (task.status === "running" && !force) {
        return { taskId: task.id, existing: true };
      }
      // running + force intentionally falls through to a later cycle.
    }

    const task = this.createTask(input, force);
    this.schedule(task);
    this.prune();
    return { taskId: task.id, existing: false };
  }

  private findQueued(input: ReportTaskInput): ReportTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.period === input.period && task.key === input.key && task.status === "queued") {
        return task;
      }
    }
    return undefined;
  }

  private createTask(input: ReportTaskInput, force: boolean): ReportTask {
    const now = this.now();
    const task: ReportTask = {
      id: randomUUID(),
      period: input.period,
      key: input.key,
      startDay: input.startDay,
      endDay: input.endDay,
      force,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.runtimes.set(task.id, { scheduled: false, running: false });
    return task;
  }

  private createPendingForce(
    input: ReportTaskInput,
    task: ReportTask,
    submissionExisting: boolean,
    normalRequested: boolean,
  ): PendingForce {
    let resolveOperation!: ResolveSubmission;
    let rejectOperation!: RejectSubmission;
    const operation = new Promise<ReportTaskSubmission>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    return {
      key: taskKey(input),
      task,
      input,
      submissionExisting,
      normalRequested,
      prepared: false,
      settled: false,
      operation,
      resolve: resolveOperation,
      reject: rejectOperation,
    };
  }

  private activateForce(reservation: PendingForce): void {
    if (reservation.settled) return;
    if (this.pendingForces.get(reservation.key) !== reservation) return;
    reservation.prepared = true;
    this.pendingForces.delete(reservation.key);
    this.preparedForceTasks.add(reservation.task.id);
    if (reservation.task.status === "queued") this.schedule(reservation.task);
    reservation.settled = true;
    reservation.resolve({
      taskId: reservation.task.id,
      existing: reservation.submissionExisting,
    });
  }

  private rejectForce(reservation: PendingForce, error: unknown): void {
    if (reservation.settled) return;
    if (this.pendingForces.get(reservation.key) !== reservation) return;
    this.pendingForces.delete(reservation.key);
    this.preparedForceTasks.delete(reservation.task.id);
    reservation.settled = true;

    if (reservation.normalRequested) {
      // A normal submit was already accepted (or is single-flighting on this
      // reservation): run it without force so a failed prepare cannot strand it.
      reservation.task.force = false;
      if (reservation.task.status === "queued") this.schedule(reservation.task);
    } else {
      // No ordinary request depends on this placeholder. Keep the public task
      // terminal for status compatibility, but never leave a queued gate behind.
      reservation.task.status = "failed";
      reservation.task.error = this.sanitizeErrors
        ? stableErrorCode(error, "force-prepare-failed")
        : error instanceof Error
          ? error.message
          : String(error);
      reservation.task.updatedAt = this.now();
      this.prune();
    }
    reservation.reject(error);
  }

  get(taskId: string): ReportTask | undefined {
    return this.tasks.get(taskId);
  }

  private schedule(task: ReportTask): void {
    const runtime = this.runtimes.get(task.id);
    if (runtime === undefined || runtime.scheduled || runtime.running) return;
    runtime.scheduled = true;
    this.tail = this.tail.then(() => this.runScheduled(task)).catch(() => undefined);
  }

  private async runScheduled(task: ReportTask): Promise<void> {
    const runtime = this.runtimes.get(task.id);
    if (runtime === undefined) return;
    runtime.scheduled = false;
    if (task.status !== "queued") return;

    const pending = this.pendingForces.get(taskKey(task));
    if (pending?.task.id === task.id && !pending.prepared) {
      // Do not hold the global tail while this key waits for durable prepare.
      return;
    }

    runtime.running = true;
    try {
      await this.run(task);
    } finally {
      runtime.running = false;
    }
  }

  private async run(task: ReportTask): Promise<void> {
    task.status = "running";
    task.updatedAt = this.now();
    try {
      const result = await this.executor({
        period: task.period,
        key: task.key,
        startDay: task.startDay,
        endDay: task.endDay,
        force: task.force,
      });
      task.status = "done";
      task.meta = result.meta;
      task.reused = result.reused === true;
      task.updatedAt = this.now();
    } catch (error: unknown) {
      task.status = "failed";
      if (this.sanitizeErrors) {
        const code = stableErrorCode(error, "generation-failed");
        task.error = code;
        this.warn(`task ${task.period} ${task.key} 执行失败（${code}）`);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        task.error = message;
        this.warn(`task ${task.period} ${task.key} 执行失败：${message}`);
      }
      task.updatedAt = this.now();
    }
  }

  private prune(): void {
    this.dropExpired();
    this.enforceCapacity();
  }

  /** 淘汰策略一：已结算且超出 TTL 的任务。 */
  private dropExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, task] of this.tasks) {
      if (isSettled(task) && task.updatedAt < cutoff) this.forget(id);
    }
  }

  /**
   * 淘汰策略二：超容量时逐个挤掉最老的已结算任务。
   * 在跑的（queued/running）不可挤——容量超限且无可挤时保留现状，等其结算。
   */
  private enforceCapacity(): void {
    while (this.tasks.size > this.maxTasks) {
      const oldest = this.oldestSettledId();
      if (oldest === null) break;
      this.forget(oldest);
    }
  }

  /** 最老的已结算任务 id；无已结算任务返回 null。 */
  private oldestSettledId(): string | null {
    let oldest: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, task] of this.tasks) {
      if (!isSettled(task)) continue;
      if (task.createdAt < oldestAt) {
        oldestAt = task.createdAt;
        oldest = id;
      }
    }
    return oldest;
  }

  /** 任务本体与两处旁挂表（runtime 句柄、force 预置任务）同步移除。 */
  private forget(id: string): void {
    this.tasks.delete(id);
    this.runtimes.delete(id);
    this.preparedForceTasks.delete(id);
  }
}

/** 已结算（不再占用执行槽、可被淘汰）的任务状态判定。 */
export function isSettled(task: Pick<ReportTask, "status">): boolean {
  return task.status === "done" || task.status === "failed";
}
