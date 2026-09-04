/**
 * dsh-provider-usage/trend — TrendTracker 组合根（#503 M1）。
 *
 * collector（事件折叠）→ aggregator（内存聚合）→ store（按天分片 JSONL）的组合：
 * - 刷盘三挂点（方案定稿）：3~5s 防抖 + `session/flush` 官方排空点 + dispose await；
 * - 启动重建：聚合分片（权威）+ 当日明细分片 → 内存聚合；过去日明细分片自愈压实；
 * - 崩溃安全：压实先原子写聚合分片再删明细分片；同日并存时聚合权威（见 store）；
 * - 已知边界（文档化口径）：kill -9 丢防抖窗口数据（事件路线无重扫兜底）；
 *   统计自挂载时点起算。
 */
import { dayKey } from "../charts.ts";
import { TrendAggregator, mergeAggRows, type TrendGranularity, type TrendMetric, type TrendStackPoint, type TrendWindowSummary } from "./aggregator.ts";
import { TrendCollector } from "./collector.ts";
import { TrendStore } from "./store.ts";
import { safeId } from "./types.ts";

export interface TrendTrackerOptions {
  /** 存储根（<historyRoot>/trend）。 */
  root: string;
  /** 聚合分片保留天数（默认 180，可配）。 */
  retentionDays?: number;
  /** 防抖毫秒（方案定稿 3~5s；默认 4s）。 */
  flushDebounceMs?: number;
  /** 注入时钟（测试用；默认 Date.now）。 */
  now?: () => number;
  /** 诊断出口（默认 console.warn）。 */
  warn?: (msg: string) => void;
}

export class TrendTracker {
  private readonly collector: TrendCollector;
  private readonly aggregator: TrendAggregator;
  private readonly store: TrendStore;
  private readonly now: () => number;
  private readonly warn: (msg: string) => void;
  private readonly flushDebounceMs: number;
  private readonly retentionDays: number;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private disposed = false;
  private lastFlushAt: number | null = null;

  private constructor(
    resolved: {
      retentionDays: number;
      flushDebounceMs: number;
      now: () => number;
      warn: (msg: string) => void;
    },
    store: TrendStore,
  ) {
    this.now = resolved.now;
    this.warn = resolved.warn;
    this.flushDebounceMs = resolved.flushDebounceMs;
    this.retentionDays = resolved.retentionDays;
    this.store = store;
    this.aggregator = new TrendAggregator();
    this.collector = new TrendCollector({
      now: resolved.now,
      emit: (e) => {
        this.aggregator.apply(e);
        this.markDirty();
      },
    });
  }

  /** 启动：载入分片重建内存聚合 + 过去日明细分片自愈压实。 */
  static async start(opts: TrendTrackerOptions): Promise<TrendTracker> {
    const resolved = {
      retentionDays: opts.retentionDays ?? 180,
      flushDebounceMs: opts.flushDebounceMs ?? 4000,
      now: opts.now ?? Date.now,
      warn: opts.warn ?? ((msg: string) => console.warn(`[dsh-provider-usage] trend: ${msg}`)),
    };
    const tracker = new TrendTracker(resolved, new TrendStore({ root: opts.root, warn: resolved.warn }));
    await tracker.rebuildFromDisk();
    return tracker;
  }

  /** 重启重建（崩溃安全约定：聚合分片权威；过去日明细自愈压实，见模块注释）。 */
  private async rebuildFromDisk(): Promise<void> {
    const today = dayKey(this.now());
    for (const day of await this.store.listAggDays()) {
      this.aggregator.rebuild(await this.store.readAggShard(day), false);
    }
    for (const day of await this.store.listDetailDays()) {
      const rows = await this.store.readDetailShard(day);
      if (day < today) {
        if (await this.store.hasAggShard(day)) {
          // 压实残留（崩溃于写聚合后、删明细前）：聚合权威 → 忽略明细并删除
          await this.store.deleteDetailShard(day);
          continue;
        }
        if (rows.length === 0) continue;
        // 崩溃于压实前：明细权威 → 重建进内存后立即压实（自愈）
        this.aggregator.rebuild(rows, true);
        const aggRows = this.aggregator.rollupDay(day);
        await this.store.writeAggDay(day, aggRows);
        await this.store.deleteDetailShard(day);
      } else {
        // 当日明细：重建进内存（已落盘，防二次 append）
        this.aggregator.rebuild(rows, true);
      }
    }
  }

  // ---------------------------------------------------------------- 事件入口

  /**
   * session/event 入口（apply 挂接）。session 取 id 防御；异常由 collector 内部
   * try/catch 吞掉（单事件失败不连坐）。
   */
  handleEvent(session: unknown, event: Parameters<TrendCollector["handleEvent"]>[1]): void {
    const id = session !== null && typeof session === "object" ? safeId((session as { id?: unknown }).id) : null;
    if (id === null) return;
    this.collector.handleEvent(id, event);
  }

  /** session/disposed 入口：per-session 状态清理（缓冲 GC 三重保险之一）。 */
  handleDisposed(session: unknown): void {
    const id = session !== null && typeof session === "object" ? safeId((session as { id?: unknown }).id) : null;
    if (id === null) return;
    this.collector.handleDisposed(id);
  }

  // ---------------------------------------------------------------- 刷盘

  private markDirty(): void {
    if (this.disposed) return;
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, this.flushDebounceMs);
    (this.flushTimer as { unref?: () => void }).unref?.();
  }

  /**
   * 排空：未落盘行 append 到日分片 → 过去日压实（先聚合分片后删明细，崩溃安全序）。
   * 并发调用经链式串行；失败不抛（下轮防抖重试），成功行才标记已持久化。
   */
  async flushNow(): Promise<void> {
    if (this.disposed) return;
    const run = this.flushChain.then(() => this.flushInner());
    this.flushChain = run.catch(() => {});
    return run;
  }

  private async flushInner(): Promise<void> {
    const today = dayKey(this.now());
    // 1. 持久化未落盘行（含时钟回拨落入过去日的行——先落明细再压实，防丢；
    //    快照精确标记：await 间隙新到的行是独立对象，不误标）
    const dirtyDays = this.aggregator.unpersistedDays();
    if (dirtyDays.length > 0) {
      const snapshot = this.aggregator.takeUnpersisted();
      const ok = await this.store.appendRows(snapshot.map((p) => p.row));
      if (ok) this.aggregator.markPersisted(snapshot);
    }
    // 2. 过去日压实（仅该日明细已全部落盘才压，防内存压掉磁盘没落的数据；
    //    写盘前与既有聚合分片合并——迟到旧日行二次压实时防覆盖丢数）
    for (const day of this.aggregator.pendingDays()) {
      if (day >= today) continue;
      if (this.aggregator.hasUnpersisted(day)) continue; // 上一步失败：留到下轮
      const pendingAgg = this.aggregator.rollupDay(day);
      const existing = await this.store.readAggShard(day);
      await this.store.writeAggDay(day, mergeAggRows(existing, pendingAgg));
      await this.store.deleteDetailShard(day);
    }
    this.lastFlushAt = this.now();
  }

  /** dispose：清防抖 timer + 最终排空（cordis disposer await 本方法）。 */
  async dispose(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.disposed = true;
    try {
      await this.flushInner();
    } catch (e: unknown) {
      this.warn(`dispose 刷盘失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 留存清理（挂 apply 现有 10min prune 周期）。返回删除文件数。 */
  async prune(): Promise<number> {
    const cutoff = dayKey(this.now() - this.retentionDays * 86400000);
    return this.store.prune(cutoff);
  }

  // ---------------------------------------------------------------- 查询（M2 路由消费）

  /** 日序列（近 n 日）。 */
  seriesDays(n: number, metric: TrendMetric, provider?: string): Array<{ day: string; value: number | null }> {
    return this.aggregator.seriesDays(n, this.now(), metric, provider);
  }

  /** 周序列（近 n 周，周一起点）。 */
  seriesWeeks(n: number, metric: TrendMetric, provider?: string): Array<{ day: string; value: number | null }> {
    return this.aggregator.seriesWeeks(n, this.now(), metric, provider);
  }

  /** 月序列（近 n 月）。 */
  seriesMonths(n: number, metric: TrendMetric, provider?: string): Array<{ day: string; value: number | null }> {
    return this.aggregator.seriesMonths(n, this.now(), metric, provider);
  }

  /** 全量桶快照（堆叠柱状/Top 适配器数据源）。 */
  buckets(): ReturnType<TrendAggregator["buckets"]> {
    return this.aggregator.buckets();
  }

  /** 堆叠柱序列（M2 /trend 路由数据源；n 由粒度决定：日 30 / 周 12 / 月 12）。 */
  seriesStacked(
    n: number,
    gran: TrendGranularity,
    metric: TrendMetric,
    provider?: string,
    byModel = false,
  ): { series: TrendStackPoint[]; providers: Array<{ provider: string; model: string | null }> } {
    return this.aggregator.seriesStacked(n, gran, metric, provider, byModel, this.now());
  }

  /** 窗口摘要（趋势页汇总卡）。 */
  windowSummary(n: number, gran: TrendGranularity, metric: TrendMetric, provider?: string): TrendWindowSummary {
    return this.aggregator.windowSummary(n, gran, metric, provider, this.now());
  }

  /** 统计自挂载时点起算提示的数据源：最早有数据的本地日 key（无数据 null）。 */
  firstRecordedDay(): string | null {
    const days = this.aggregator.buckets();
    return days.length > 0 ? days[0].day : null;
  }

  /** 健康观测（/health 附带）。 */
  stats(): { days: number; pendingRows: number; unpersistedRows: number; lastFlushAt: number | null } {
    return { ...this.aggregator.stats(), lastFlushAt: this.lastFlushAt };
  }
}
