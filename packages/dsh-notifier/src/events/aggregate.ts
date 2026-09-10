/**
 * dsh-notifier — 完成风暴聚合批处理器（M0 纯搬移自 index.ts 装配层）。
 *
 * 职责：把「完成通知风暴聚合」（done / subagent-done）从 index.ts 装配层
 * 原样搬移为独立模块——行为零变化，仅注入面显式化：
 *  - getWindowMs(): 实时读取完成聚合窗口（配置热更新即时生效）
 *  - notify(kind, detail): 单条完成通知出口（由装配层接回 notify 主入口）
 *
 * 语义（与搬移前完全一致）：
 *  - 首条「完成」立即原样通知（单条场景零感知延迟）；
 *  - 同时起 doneMergeWindowMs 窗口（0=关闭聚合），窗口内到达的后续完成只
 *    累积标题与计数，窗口到点**补发一条聚合通知**（「另有 N 个任务已完成」）；
 *  - 窗口定时器 unref，卸载时由 dispose() 清空，防句柄吊死进程。
 */
export interface DoneBatcher {
  /** 入队一条完成（首条立即通知 + 起窗口；窗口内后续只累积）。 */
  enqueue(kind: string, title: string | undefined, durationMs: number): void;
  /** 立即结算当前窗口（含手动触发；幂等）。 */
  flush(): void;
  /** 清理定时器与批次（fiber 卸载时调用）。 */
  dispose(): void;
}

/** createDoneBatcher 的注入面。 */
export interface DoneBatcherOptions {
  /** 实时读取完成聚合窗口毫秒数（0 = 关闭聚合，每条即时通知）。 */
  getWindowMs(): number;
  /** 单条完成通知出口（等价搬移前的 notify(kind, detail)）。 */
  notify(kind: string, detail: { taskTitle?: string; durationMs?: number; mergedCount?: number }): boolean;
}

/** 完成标题退化的固定文案（与搬移前一致）。 */
function fallbackLabel(kind: string): string {
  return kind === "subagent-done" ? "子任务" : "任务";
}

/** 创建完成风暴聚合批处理器。 */
export function createDoneBatcher(options: DoneBatcherOptions): DoneBatcher {
  const { getWindowMs, notify } = options;
  /** 当前批次（null = 无窗口在跑）。 */
  let batch: { kind: string; count: number; titles: string[] } | null = null;
  /** 批次结算定时器。 */
  let timer: NodeJS.Timeout | null = null;

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const current = batch;
    batch = null;
    // 窗口内还有后续完成 → 补发聚合条（首波已单独通知，这里汇总其余）
    if (current !== null && current.count > 1) {
      notify(current.kind, { taskTitle: current.titles.slice(1).join("、"), mergedCount: current.count - 1 });
    }
  }

  function enqueue(kind: string, title: string | undefined, durationMs: number): void {
    const label = title ?? fallbackLabel(kind);
    const mergeMs = getWindowMs();
    if (mergeMs <= 0) {
      // 完成聚合已关闭：每条完成即时通知（不合并）
      notify(kind, { taskTitle: label, durationMs });
      return;
    }
    if (batch === null) {
      notify(kind, { taskTitle: label, durationMs });
      batch = { kind, count: 1, titles: [label] };
      timer = setTimeout(flush, mergeMs);
      timer.unref();
      return;
    }
    if (batch.kind !== kind) {
      flush();
      enqueue(kind, title, durationMs);
      return;
    }
    batch.count += 1;
    batch.titles.push(label);
    if (batch.titles.length > 4) batch.titles = batch.titles.slice(-4);
  }

  return { enqueue, flush, dispose: flush };
}
