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

function stableErrorCode(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null) {
    const value = (error as { code?: unknown; message?: unknown }).code;
    if (typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(value)) return value;
  }
  return fallback;
}

export class ReportTaskQueue {
  private readonly tasks = new Map<string, ReportTask>();
  private tail: Promise<unknown> = Promise.resolve();
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

  /** force 入口：prepare 成功后才把任务交给队列。 */
  submitForce(input: ReportTaskInput): Promise<ReportTaskSubmission> {
    const operation = this.forceTail.then(async () => {
      if (this.prepareForce !== undefined) await this.prepareForce(input);
      return this.enqueue(input, true);
    });
    this.forceTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private enqueue(input: ReportTaskInput, force: boolean): ReportTaskSubmission {
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
    this.tail = this.tail.then(() => this.run(task)).catch(() => undefined);
    this.prune();
    return { taskId: task.id, existing: false };
  }

  get(taskId: string): ReportTask | undefined {
    return this.tasks.get(taskId);
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
    const cutoff = this.now() - this.ttlMs;
    for (const [id, task] of this.tasks) {
      if ((task.status === "done" || task.status === "failed") && task.updatedAt < cutoff) {
        this.tasks.delete(id);
      }
    }
    while (this.tasks.size > this.maxTasks) {
      let oldest: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, task] of this.tasks) {
        if (task.status !== "done" && task.status !== "failed") continue;
        if (task.createdAt < oldestAt) {
          oldestAt = task.createdAt;
          oldest = id;
        }
      }
      if (oldest === null) break;
      this.tasks.delete(oldest);
    }
  }
}
