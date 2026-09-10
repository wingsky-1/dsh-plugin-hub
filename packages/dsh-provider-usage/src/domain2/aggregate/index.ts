/**
 * dsh-provider-usage/trend — TrendTracker 组合根。
 *
 * collector（事件折叠）→ aggregator（内存聚合）→ store（按天分片 JSONL）的组合：
 * - 刷盘三挂点（方案定稿）：3~5s 防抖 + `session/flush` 官方排空点 + dispose await；
 * - 启动重建：聚合分片（权威，agg+dir+hour 混存全量读回，dir/hour 行进内存
 *   目录/小时视图）＋ 当日明细分片 → 内存聚合；过去日明细分片自愈压实；
 * - 崩溃安全：压实先原子写聚合分片再删明细分片；同日并存时聚合权威（见 store）；
 * - 已知边界（文档化口径）：kill -9 丢防抖窗口数据（事件路线无重扫兜底）；
 *   统计自挂载时点起算。
 */
import { dayKey } from "../../shared/interface.ts";
import {
  TrendAggregator,
  mergeAggRows,
  mergeDirRows,
  mergeHourRows,
  type TrendGranularity,
  type TrendMetric,
  type TrendStackPoint,
  type TrendWindowSummary,
} from "./aggregator.ts";
import { TrendCollector } from "../collect/interface.ts";
import { TrendStore } from "./store.ts";
import type { TrendAggRow, TrendDirRow, TrendHourRow } from "../collect/interface.ts";
import { safeId } from "../collect/interface.ts";

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
  /**
   * 目录归属解析器（可选）：输入 session id，返回 cwd 原始值
   * 或 undefined（store 无该 session / header.cwd 缺失）。抛错由 collector 捕获归
   * 未识别桶；缺省 = 不接 store（纯离线/测试），目录恒归未识别桶。
   */
  resolveCwd?: (session: string) => string | undefined;
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
      resolveCwd?: (session: string) => string | undefined;
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
      resolveCwd: resolved.resolveCwd, // 目录归属透传（collector 侧 per-session 惰性单查）
      emit: (e) => {
        this.aggregator.apply(e);
        this.markDirty();
      },
      // 归属异常（主源与 message.source 副源不一致等）经统一诊断出口告警
      onAnomaly: (msg) => resolved.warn(`归属异常：${msg}`),
    });
  }

  /** 启动：载入分片重建内存聚合 + 过去日明细分片自愈压实。 */
  static async start(opts: TrendTrackerOptions): Promise<TrendTracker> {
    const resolved = {
      retentionDays: opts.retentionDays ?? 180,
      flushDebounceMs: opts.flushDebounceMs ?? 4000,
      now: opts.now ?? Date.now,
      warn: opts.warn ?? ((msg: string) => console.warn(`[dsh-provider-usage] trend: ${msg}`)),
      resolveCwd: opts.resolveCwd,
    };
    const tracker = new TrendTracker(resolved, new TrendStore({ root: opts.root, warn: resolved.warn }));
    await tracker.rebuildFromDisk();
    return tracker;
  }

  /** 重启重建（崩溃安全约定：聚合分片权威；过去日明细自愈压实，见模块注释）。 */
  private async rebuildFromDisk(): Promise<void> {
    const today = dayKey(this.now());
    for (const day of await this.store.listAggDays()) {
      // 混存分片全量读回（agg+dir）——dir 行经 rebuild 的 dir 分支
      // mergeCell 进 dirDays（重启后内存目录视图恢复，分片 b 视图假设成立）；
      // agg 行照旧进 cells。dir 行不进 cells/pending（rebuild 内 continue），
      // 防双计语义与读回前一致。
      this.aggregator.rebuild(await this.store.readAggDayShard(day), false);
    }
    for (const day of await this.store.listDetailDays()) {
      const rows = await this.store.readDetailShard(day);
      if (day < today) {
        if (await this.store.hasAggShard(day)) {
          // 压实残留（崩溃于写聚合后、删明细前）：聚合权威 → 忽略明细并删除
          await this.store.deleteDetailShard(day);
          continue;
        }
        if (rows.length === 0) {
          // 白名单读（detail|counter）后为空 = 该明细分片只含非明细行（agg/dir 误落，
          // 或全为坏行）。此类分片永无压实素材，`continue` 会让它每轮重建都被重扫
          // 却永不清理——直接删除（无重建价值；坏行已由 readShard 告警留痕）。
          await this.store.deleteDetailShard(day);
          continue;
        }
        // 崩溃于压实前：明细权威 → 重建进内存后立即压实（自愈）
        this.aggregator.rebuild(rows, true);
        const aggRows = this.aggregator.rollupDay(day, today);
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
    //    快照精确标记：await 间隙新到的行是独立对象，不误标；
    //    按日成功集标记：部分日失败时成功日不重复 append（防崩溃重建双算））
    const dirtyDays = this.aggregator.unpersistedDays();
    if (dirtyDays.length > 0) {
      const snapshot = this.aggregator.takeUnpersisted();
      const okDays = await this.store.appendRows(snapshot.map((p) => p.row));
      if (okDays.size > 0) {
        this.aggregator.markPersisted(snapshot.filter((p) => okDays.has(p.row.day)));
      }
    }
    // 2. 过去日压实（仅该日明细已全部落盘才压，防内存压掉磁盘没落的数据；
    //    两步式安全序：先纯计算聚合行 → 既有聚合合并 → 原子写 → 删明细分片 →
    //    全部成功后才消费内存行（任一步失败内存行保留，防丢数）。
    //    逐日 try/catch：单日失败记 warn 留待下轮，保证 flushInner 永不 reject——
    //    防抖路径 void 调用不产生 unhandledRejection，session/flush 官方排空点
    //    不向宿主 checkpoint 传播插件内部错误（不连坐约定）。
    for (const day of this.aggregator.pendingDays()) {
      if (day >= today) continue;
      if (this.aggregator.hasUnpersisted(day)) continue; // 上一步失败：留到下轮
      try {
        // 折算与消费取同一份身份快照——下面三个 await 期间新到达的同日行既不入
        // 本次折算、也不被消费，留待下一轮压实（旧实现按日键删除会连带丢掉这些行）。
        const { consumed, aggRows: pendingAgg, dirRows: pendingDir, hourRows: pendingHour } = this.aggregator.rollupSnapshot(day);
        // 既有聚合分片全量取回（agg+dir+hour 混存）——若仍走
        // readAggShard（只取 agg 行），整日原子重写会把分片内既有 dir/hour 行抹掉；
        // 三组必须各自与既有行合并后一起重写（迟到旧日行二次压实防丢防重——
        // 漏合并 hour 行 → 分片内既有小时数据被抹，P0）。
        const existing = await this.store.readAggDayShard(day);
        const aggRows = mergeAggRows(
          existing.filter((r): r is TrendAggRow => r.kind === "agg"),
          pendingAgg,
        );
        const dirRows = mergeDirRows(
          existing.filter((r): r is TrendDirRow => r.kind === "dir"),
          pendingDir,
        );
        const hourRows = mergeHourRows(
          existing.filter((r): r is TrendHourRow => r.kind === "hour"),
          pendingHour,
        );
        await this.store.writeAggDay(day, [...aggRows, ...dirRows, ...hourRows]); // agg 前、dir 中、hour 后（写入约定）
        // 聚合事实落盘后立即按身份消费。若把消费放在 deleteDetailShard 之后，
        // 删除失败时内存行保留，下一轮会拿「已含本轮值的聚合分片」再 merge 一次 →
        // 磁盘双算（实测 agg 20/2 vs 内存 10/1）。消费后 pending 不再含该日，下轮不再
        // 压实；残留的明细分片由重启时的「聚合权威」分支自愈删除。
        this.aggregator.consume(consumed);
        await this.store.deleteDetailShard(day);
      } catch (e: unknown) {
        this.warn(`压实失败（${day}）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.lastFlushAt = this.now();
  }

  /** dispose：清防抖 timer + 等待进行中的一轮收敛 + 最终排空（cordis disposer await）。 */
  async dispose(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.disposed = true;
    try {
      // 与进行中的 flushNow 串行（并发压实的迟写覆盖丢数窗口）
      await this.flushChain.catch(() => {});
      await this.flushInner();
    } catch (e: unknown) {
      this.warn(`dispose 刷盘失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 留存清理（挂 apply 现有 10min prune 周期）：磁盘 cutoff 前分片 + 内存日桶同步收缩。 */
  async prune(): Promise<number> {
    const cutoff = dayKey(this.now() - this.retentionDays * 86400000);
    const removed = await this.store.prune(cutoff);
    this.aggregator.pruneDays(cutoff);
    return removed;
  }

  // ---------------------------------------------------------------- 查询

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

  /**
   * 全量目录日桶快照（报告快照 dirRows 输入与统计目录分布数据源；
   * 今日桶经 pending 同源折算补齐，见 aggregator.dirRows）。
   */
  dirRows(): ReturnType<TrendAggregator["dirRows"]> {
    return this.aggregator.dirRows();
  }

  /** 堆叠柱序列（目录维度；/trend 路由 dir 过滤数据源）。 */
  dirStacked(
    n: number,
    gran: TrendGranularity,
    metric: TrendMetric,
    dir?: string,
  ): { series: TrendStackPoint[]; dirs: Array<{ dir: string }> } {
    return this.aggregator.dirStacked(n, gran, metric, dir, this.now());
  }

  /** 窗口摘要（目录维度；/trend 路由 dir 过滤汇总卡数据源）。 */
  dirWindowSummary(
    n: number,
    gran: TrendGranularity,
    metric: TrendMetric,
    dir?: string,
    dirSeries?: TrendStackPoint[],
  ): TrendWindowSummary {
    return this.aggregator.dirWindowSummary(n, gran, metric, dir, this.now(), dirSeries);
  }

  /** 目录窗口总量表（报告快照目录范围过滤数据源）。 */
  dirTotals(startDay: string, endDay: string, metric: TrendMetric = "total"): Array<{ dir: string; calls: number; total: number | null }> {
    return this.aggregator.dirTotals(startDay, endDay, metric);
  }

  /**
   * 全量小时日桶快照（报告快照 byHour/byPeriod/peakHour/coveredDays 数据源）。
   * 内存 hourDays 单源快照（apply 平行累加 + rebuild 双分支读回，不折算 pending；
   * 无残差投影——旧分片缺 hour 行是物理缺失，报告侧 coveredDays 守卫降级）。
   */
  hourRows(): ReturnType<TrendAggregator["hourRows"]> {
    return this.aggregator.hourRows();
  }

  /** 堆叠柱序列（/trend 路由数据源；n 由粒度决定：日 30 / 周 12 / 月 12）。 */
  seriesStacked(
    n: number,
    gran: TrendGranularity,
    metric: TrendMetric,
    provider?: string,
    byModel = false,
  ): { series: TrendStackPoint[]; providers: Array<{ provider: string; model: string | null }> } {
    return this.aggregator.seriesStacked(n, gran, metric, provider, byModel, this.now());
  }

  /**
   * 窗口摘要（趋势页汇总卡）。stackSeries 可选传入路由已算的堆叠序列复用遍历
   * （须与 n/gran/metric/provider 同参，见 aggregator.windowSummary）。
   */
  windowSummary(n: number, gran: TrendGranularity, metric: TrendMetric, provider?: string, stackSeries?: TrendStackPoint[]): TrendWindowSummary {
    return this.aggregator.windowSummary(n, gran, metric, provider, this.now(), stackSeries);
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
