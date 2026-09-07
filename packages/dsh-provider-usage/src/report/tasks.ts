/**
 * dsh-provider-usage/report — 报告生成任务队列（#625/#626）。
 *
 * 形态（方案定稿）：手动「立即生成」与定时 tick 共用的单一执行入口。
 * - 串行单飞：任务经 promise 链依次执行（等价于既有 reportMutex 语义），
 *   但「提交」与「执行」解耦——HTTP 只等入队，不等 LLM；
 * - 入队去重：#625 P0——同 (period,key) 已有 queued/running 任务时返回同一
 *   taskId，杜绝 tick 每 60s 提交与手动并发把同窗口任务堆成串行重复生成；
 * - 幂等下沉：本队列不判幂等——执行器（apply 层注入）负责「执行前重查 index，
 *   已有成功记录且非 force → 直接复用」，路由层另有前置短路，双保险；
 * - 不持久化：进程重启在途任务自然丢失，lastRun 未推进 → 下次 tick 按幂等
 *   判定补跑（收敛性由 lastRun 保证）；
 * - 资源：done/failed 任务按 TTL 修剪（默认 10min）与上限裁剪（默认 50）。
 */
import { randomUUID } from "node:crypto";
import type { ReportPeriod } from "./config.ts";
import type { ReportMeta } from "./generate.ts";

export type ReportTaskStatus = "queued" | "running" | "done" | "failed";

/** 任务输入（窗口 + force 标志）。 */
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
  /** done 后携带生成 meta（reused 时亦携带既有记录）。 */
  meta?: ReportMeta;
  /** #629 P2：done 且 meta 来自幂等短路复用（非新生成）时为 true——status 响应透传，客户端对称提示「已复用」。 */
  reused?: boolean;
  /** failed 时携带脱敏错误信息。 */
  error?: string;
}

/** 执行器结果：meta 可为既有记录（reused 短路）或新生成。 */
export interface ReportTaskResult {
  meta?: ReportMeta;
  reused?: boolean;
}

export interface ReportTaskQueueOptions {
  /** 串行执行器：负责幂等下沉、生成、lastRun 推进；抛错 → 任务 failed（不推进 lastRun）。 */
  executor: (input: ReportTaskInput) => Promise<ReportTaskResult>;
  /** 注入时钟（测试）。 */
  now?: () => number;
  /** 诊断出口。 */
  warn?: (msg: string) => void;
  /** done/failed 任务留存（默认 600000 = 10min）。 */
  ttlMs?: number;
  /** 任务表上限（默认 50）。 */
  maxTasks?: number;
}

export class ReportTaskQueue {
  private readonly tasks = new Map<string, ReportTask>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly executor: (input: ReportTaskInput) => Promise<ReportTaskResult>;
  private readonly now: () => number;
  private readonly warn: (msg: string) => void;
  private readonly ttlMs: number;
  private readonly maxTasks: number;

  constructor(opts: ReportTaskQueueOptions) {
    this.executor = opts.executor;
    this.now = opts.now ?? Date.now;
    this.warn = opts.warn ?? ((msg: string) => console.warn(`[dsh-provider-usage] report: ${msg}`));
    this.ttlMs = opts.ttlMs ?? 600_000;
    this.maxTasks = opts.maxTasks ?? 50;
  }

  /**
   * 提交任务（非阻塞，立即返回 taskId）。
   * 同 (period,key) 已有 queued/running 任务 → 返回既有 taskId（去重）；
   * 新提交 force=true 且既有任务 force=false → 升级既有任务 force（重新生成
   * 语义不因去重丢失，#626）。
   */
  submit(input: ReportTaskInput): { taskId: string; existing: boolean } {
    for (const t of this.tasks.values()) {
      if ((t.status === "queued" || t.status === "running") && t.period === input.period && t.key === input.key) {
        if (input.force === true && t.force === false) t.force = true;
        return { taskId: t.id, existing: true };
      }
    }
    const now = this.now();
    const task: ReportTask = {
      id: randomUUID(),
      period: input.period,
      key: input.key,
      startDay: input.startDay,
      endDay: input.endDay,
      force: input.force === true,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.tail = this.tail.then(() => this.run(task)).catch(() => {});
    this.prune();
    return { taskId: task.id, existing: false };
  }

  /** 查询任务；未知 taskId → undefined。 */
  get(taskId: string): ReportTask | undefined {
    return this.tasks.get(taskId);
  }

  private async run(task: ReportTask): Promise<void> {
    task.status = "running";
    task.updatedAt = this.now();
    try {
      const res = await this.executor({
        period: task.period,
        key: task.key,
        startDay: task.startDay,
        endDay: task.endDay,
        force: task.force,
      });
      task.status = "done";
      task.meta = res.meta;
      task.reused = res.reused === true;
      task.updatedAt = this.now();
    } catch (e: unknown) {
      // 失败（含执行器内部已捕获后的再抛）不推进 lastRun：执行器约定
      task.status = "failed";
      task.error = e instanceof Error ? e.message : String(e);
      task.updatedAt = this.now();
      this.warn(`task ${task.period} ${task.key} 执行失败：${task.error}`);
    }
  }

  /** 修剪：超龄 done/failed 淘汰 + 超上限时裁剪最旧的 done/failed（queued/running 不裁）。 */
  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, t] of this.tasks) {
      if ((t.status === "done" || t.status === "failed") && t.updatedAt < cutoff) this.tasks.delete(id);
    }
    while (this.tasks.size > this.maxTasks) {
      let oldest: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, t] of this.tasks) {
        if (t.status !== "done" && t.status !== "failed") continue; // 在途任务不裁
        if (t.createdAt < oldestAt) {
          oldestAt = t.createdAt;
          oldest = id;
        }
      }
      if (oldest === null) break;
      this.tasks.delete(oldest);
    }
  }
}