/**
 * dsh-provider-usage/trend — 内存聚合主类（#503 M1；D2 拆分后 #670 阶段三）。
 *
 * 两级聚合（方案定稿）：
 * - cells：day×provider(×model) 桶，apply 时实时累加（含未压实的历史日）；
 * - pending：当日 per-step 明细/计数行（未压实窗口），支撑今日按小时/按会话细分
 *   与日切压实的落盘素材；日切时压实为 day×provider(×model) 聚合行并丢弃明细。
 *
 * #662 小时维度（hourDays）：day→hour(0-23)→cell 桶，与 dirDays 同模式——apply
 * 平行累加（hourOfDay 现算自事件 time）、rebuild 双分支读回（hour 行直接入桶 +
 * 当日明细/计数行折算入桶）、retokenCell 第三面修正、pruneDays 联动删除；
 * 不设残差投影（detail/counter 行必有 time、无缺键事实；旧分片缺小时是物理缺失，
 * 投影救不回且会造伪事实）——「小时面=聚合面」守恒由 rollupSnapshot 同源折算
 * （同一事实的第三个投影）+ 覆盖度守卫 + 测试断言共同保证。
 *
 * 双算防线：明细/计数行在 apply 时已进 cells，压实只做「落盘形态转换」
 * （明细行 → 聚合行），绝不再次累加 cells；重启重建时聚合行与当日明细行
 * 二选一来源（agg 分片存在即权威，见 store 约定），同样不双算。
 *
 * null 语义：桶内 token 求和 null-aware（无任何有效数字保持 null）；
 * 调用/轮次/工具计数独立累加，与 token 有无无关。
 *
 * D2 拆分（#670 阶段三）：本文件只保留状态容器（days/dirDays/hourDays/pending）与
 * 需要访问状态的方法——apply/rebuild/rollupSnapshot/consume/prune 等 IO 与状态操作；
 * 压实转换纯函数迁至 aggregate-rows.ts，查询投影纯函数迁至 aggregate-query.ts
 * （二者均参数显式传入、不接触 this，防「拆文件 = 共享 this」坏味道；公开导出面
 * 经本文件尾部 re-export 保持可达，src/index.ts 与 src/report/*.ts 的 import 路径不变）。
 */
import { dayKey, lastNDayKeys } from "../../shared/charts.ts";
import {
  sumToken,
  hourOfDay,
  TREND_ROW_VERSION,
  type TrendAggRow,
  type TrendCell,
  type TrendCounterRow,
  type TrendDetailRow,
  type TrendDirRow,
  type TrendHourRow,
  type TrendTokens,
} from "../collect/types.ts";
import type { TrendCallRecord, TrendCorrectRecord, TrendCounterRecord, TrendEmit } from "../collect/collector.ts";
import {
  emptyCell,
  emptyAggRow,
  emptyDirRow,
  emptyHourRow,
  addDetailTo,
  addCounterTo,
  mergeCell,
  sub,
} from "./aggregate-rows.ts";
import {
  lastNWeekKeys,
  lastNMonthKeys,
  monthRange,
  weekRange,
  dayValueOf,
  rangeValueOf,
  buildDirRows,
  buildHourRows,
  buildStackedSeries,
  buildDirStackedSeries,
  buildWindowSummary,
  buildDirWindowSummary,
  buildDirTotals,
  type TrendGranularity,
  type TrendMetric,
  type TrendStackPoint,
  type TrendWindowSummary,
} from "./aggregate-query.ts";

/** 未压实行（内存持有；flush 时持久化，压实后移除）。 */
export interface PendingEntry {
  row: TrendDetailRow | TrendCounterRow;
  /** 已 append 到当日分片（重启重建的行也为 true，防二次落盘）。 */
  persisted: boolean;
}

export class TrendAggregator {
  /** day → provider → model(null 允许) → cell。 */
  private days = new Map<string, Map<string, Map<string | null, TrendCell>>>();
  /**
   * #633 A3：day → dir → cell（目录维度日汇总内存态）。
   * 生命周期与 days 同步（复核 P1-1 统一口径）：apply 实时累加 → rebuild 的
   * dir 汇总行与明细/计数行（有 dir 键者）双向读回 → 压实消费不删（与
   * cells 同策略，跨天后目录查询面历史柱不失——dirRows 纯内存无分片回读）
   * → prune 同步收缩（pruneDays 联动删除）。
   * 权威口径（复核 P1-1）：dirDays 是目录维度的唯一事实源——apply 平行累加 +
   * rebuild 双分支读回已覆盖全部 dir 事实，dirRows() 只做快照不再折算 pending
   * （单源无重无漏：同事实并存时折算会 2×，互补事实并存时按键去重会丢）。
   */
  private dirDays = new Map<string, Map<string, TrendCell>>();
  /**
   * #662：day → hour(0-23) → cell（小时维度日汇总内存态）。
   * 生命周期与 days/dirDays 同步（复核 P1-1 统一口径）：apply 实时累加 → rebuild
   * 双分支读回（hour 行 mergeCell + 当日明细/计数行折算）→ 压实消费不删（与
   * cells/dirDays 同策略，跨天后小时面历史不丢——hourRows 纯内存无分片回读）
   * → prune 同步收缩（pruneDays 联动删除）。
   * 权威口径：hourDays 是小时维度的唯一事实源——apply 平行累加 + rebuild 双分支
   * 读回已覆盖全部 hour 事实，hourRows() 只做快照（同 dirRows 单源无重无漏）。
   * 不做残差投影（与 dir 本质差异见文件头注释）；「小时面=聚合面」守恒由
   * rollupSnapshot 同源折算 + 报告侧 coveredDays 守卫 + 测试断言共同保证。
   */
  private hourDays = new Map<string, Map<number, TrendCell>>();
  /** 未压实明细/计数行（跨日可能：时钟回拨把旧日事件记进对应日分片）。 */
  private pending: PendingEntry[] = [];

  // ---------------------------------------------------------------- 实时记账

  /** 应用一条定稿记录（collector emit 出口）。 */
  apply(e: TrendEmit): void {
    switch (e.type) {
      case "call":
        this.applyCall(e.record);
        return;
      case "correct":
        this.applyCorrect(e.record);
        return;
      case "counter":
        this.applyCounter(e.record);
        return;
    }
  }

  /** call 量累加进 cell（applyCall / rebuild 明细行共用，cells 与 dirCells 同构复用）。 */
  private addCall(cell: TrendCell, tokens: TrendTokens | null): void {
    cell.calls += 1;
    if (tokens !== null) {
      cell.input = sumToken(cell.input, tokens.input);
      cell.output = sumToken(cell.output, tokens.output);
      cell.cacheRead = sumToken(cell.cacheRead, tokens.cacheRead);
      cell.cacheWrite = sumToken(cell.cacheWrite, tokens.cacheWrite);
    }
  }

  private applyCall(r: TrendCallRecord): void {
    const day = dayKey(r.time);
    this.addCall(this.cellOf(day, r.provider, r.model), r.tokens);
    this.addCall(this.dirCellOf(day, r.dir), r.tokens); // #633 A3：目录维度平行累加（同 record 不二次 emit）
    this.addCall(this.hourCellOf(day, hourOfDay(r.time)), r.tokens); // #662：小时维度平行累加（hourOfDay 与 dayKey 同源，日界一致）
    const row: TrendDetailRow = {
      v: TREND_ROW_VERSION,
      kind: "detail",
      time: r.time,
      day,
      session: r.session,
      turn: r.turn,
      step: r.step,
      retry: r.retry,
      provider: r.provider,
      model: r.model,
      dir: r.dir, // #633 A1：目录归属落盘（collector.dirOf 已保证 sanitize 后 basename 或未识别桶，不重复净化）
      input: r.tokens?.input ?? null,
      output: r.tokens?.output ?? null,
      cacheRead: r.tokens?.cacheRead ?? null,
      cacheWrite: r.tokens?.cacheWrite ?? null,
      calls: 1,
      ...(r.interrupted === true ? { interrupted: true as const } : {}),
    };
    this.pending.push({ row, persisted: false });
  }

  /** 校正：覆盖未压实窗口内同 fold 键最后一条明细的 token（已压实的不追溯）。 */
  private applyCorrect(r: TrendCorrectRecord): void {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const { row } = this.pending[i];
      if (
        row.kind === "detail" &&
        row.session === r.session &&
        row.turn === r.turn &&
        row.step === r.step &&
        row.retry === r.retry
      ) {
        this.retokenCell(row, r.tokens); // 先回退旧值再累加新值（cell 增量一致）
        row.input = r.tokens.input;
        row.output = r.tokens.output;
        row.cacheRead = r.tokens.cacheRead;
        row.cacheWrite = r.tokens.cacheWrite;
        return;
      }
    }
    /* 未找到（已压实/重启后迟到）：校正窗口已关闭，按口径不追溯 */
  }

  /**
   * 明细行 token 变更的 cell 增量修正。
   * 复核 P1-1：cells 与 dirDays 双面同步修正——dirDays 单源化后（dirRows 只读
   * 快照、不再折算 pending），applyCorrect 的行值变更必须同步回目录桶，否则
   * 目录查询面与 cells/落盘行漂移（修正前折算侧取 pending 行新值掩盖了漂移，
   * 单源化后漂移会固化）。两桶增量一致（同 sub 差值），null-aware。
   */
  private retokenCell(row: TrendDetailRow, next: TrendTokens): void {
    const deltas: TrendTokens = {
      input: sub(row.input, next.input),
      output: sub(row.output, next.output),
      cacheRead: sub(row.cacheRead, next.cacheRead),
      cacheWrite: sub(row.cacheWrite, next.cacheWrite),
    };
    const cell = this.cellOf(row.day, row.provider, row.model);
    cell.input = sumToken(cell.input, deltas.input);
    cell.output = sumToken(cell.output, deltas.output);
    cell.cacheRead = sumToken(cell.cacheRead, deltas.cacheRead);
    cell.cacheWrite = sumToken(cell.cacheWrite, deltas.cacheWrite);
    if (row.dir !== undefined) {
      const dirCell = this.dirCellOf(row.day, row.dir);
      dirCell.input = sumToken(dirCell.input, deltas.input);
      dirCell.output = sumToken(dirCell.output, deltas.output);
      dirCell.cacheRead = sumToken(dirCell.cacheRead, deltas.cacheRead);
      dirCell.cacheWrite = sumToken(dirCell.cacheWrite, deltas.cacheWrite);
    }
    // #662：小时面第三面修正——applyCorrect 的行值变更必须同步回小时桶（dirDays
    // 单源化后折算侧不再兜底；hourOfDay 与 apply 时同源现算，桶键一致）。
    const hourCell = this.hourCellOf(row.day, hourOfDay(row.time));
    hourCell.input = sumToken(hourCell.input, deltas.input);
    hourCell.output = sumToken(hourCell.output, deltas.output);
    hourCell.cacheRead = sumToken(hourCell.cacheRead, deltas.cacheRead);
    hourCell.cacheWrite = sumToken(hourCell.cacheWrite, deltas.cacheWrite);
  }

  /** counter 量累加进 cell（applyCounter / rebuild 计数行共用）。 */
  private addCounter(cell: TrendCell, turns: number, toolCalls: number): void {
    cell.turns += turns;
    cell.toolCalls += toolCalls;
  }

  private applyCounter(r: TrendCounterRecord): void {
    const day = dayKey(r.time);
    this.addCounter(this.cellOf(day, r.provider, r.model), r.turns, r.toolCalls);
    this.addCounter(this.dirCellOf(day, r.dir), r.turns, r.toolCalls); // #633 A3：目录维度平行累加
    this.addCounter(this.hourCellOf(day, hourOfDay(r.time)), r.turns, r.toolCalls); // #662：小时维度平行累加
    const row: TrendCounterRow = {
      v: TREND_ROW_VERSION,
      kind: "counter",
      time: r.time,
      day,
      session: r.session,
      provider: r.provider,
      model: r.model,
      dir: r.dir, // #633 A1：目录归属落盘（同 detail 行约定）
      turns: r.turns,
      toolCalls: r.toolCalls,
    };
    this.pending.push({ row, persisted: false });
  }

  // ---------------------------------------------------------------- 重建（重启载入）

  /**
   * 重启重建：重放分片行进内存（cells 更新 + 未压实行登记）。
   * @param rows 校验过的分片行（agg 权威行 + 当日明细/计数行）
   * @param persistedRows 这些行是否已落盘（agg 行无意义；明细/计数行来自分片 = true）
   */
  rebuild(rows: Array<TrendAggRow | TrendDetailRow | TrendCounterRow | TrendDirRow | TrendHourRow>, persistedRows: boolean): void {
    for (const row of rows) {
      if (row.kind === "agg") {
        const cell = this.cellOf(row.day, row.provider, row.model);
        mergeCell(cell, row);
        continue;
      }
      // #633 A3：dir 汇总行重建 → 只进目录维度桶（cells 累加只发生在事件路径与
      // detail/counter 行重建，防双重计数）
      if (row.kind === "dir") {
        mergeCell(this.dirCellOf(row.day, row.dir), row);
        continue;
      }
      // #662：hour 汇总行重建 → 只进小时维度桶（同 dir 行：防双重计数、不进 pending）
      if (row.kind === "hour") {
        mergeCell(this.hourCellOf(row.day, row.hour), row);
        continue;
      }
      if (row.kind === "detail") {
        this.addCall(this.cellOf(row.day, row.provider, row.model), {
          input: row.input,
          output: row.output,
          cacheRead: row.cacheRead,
          cacheWrite: row.cacheWrite,
        });
        // 复核 P1-1：明细行 rebuild 双面入账（与 cells 同策略）——dirDays 是目录
        // 维度唯一事实源（dirRows 纯快照不折算 pending），重建明细行的 dir 事实
        // 必须在此落桶，否则重启后目录查询面丢「分片明细形态存在、dirDays 缺失」
        // 的事实（自愈/当日重建两条路径同病；实测 Day0 input 10 → 7）。
        if (row.dir !== undefined) {
          this.addCall(this.dirCellOf(row.day, row.dir), {
            input: row.input,
            output: row.output,
            cacheRead: row.cacheRead,
            cacheWrite: row.cacheWrite,
          });
        }
        // #662：明细行 rebuild 第三面入账——hourDays 是小时维度唯一事实源，
        // 重建明细行的 hour 事实必须在此落桶（hourOfDay 与 apply 同源现算；
        // 已落盘 hour 行由上方 hour 分支直接入桶，两条路径不重叠）。
        this.addCall(this.hourCellOf(row.day, hourOfDay(row.time)), {
          input: row.input,
          output: row.output,
          cacheRead: row.cacheRead,
          cacheWrite: row.cacheWrite,
        });
      } else {
        this.addCounter(this.cellOf(row.day, row.provider, row.model), row.turns, row.toolCalls);
        // 复核 P1-1：计数行 rebuild 同上（turns/toolCalls 平行落 dir 桶）。
        if (row.dir !== undefined) {
          this.addCounter(this.dirCellOf(row.day, row.dir), row.turns, row.toolCalls);
        }
        // #662：计数行 rebuild 第三面入账（同 detail 行分支）。
        this.addCounter(this.hourCellOf(row.day, hourOfDay(row.time)), row.turns, row.toolCalls);
      }
      this.pending.push({ row, persisted: persistedRows });
    }
  }

  // ---------------------------------------------------------------- 压实（日切）

  /** 存在未持久化行的日 key（升序去重）。 */
  unpersistedDays(): string[] {
    const days = new Set<string>();
    for (const p of this.pending) {
      if (!p.persisted) days.add(p.row.day);
    }
    return [...days].sort();
  }

  /** pending 全部日 key（升序去重；压实遍历用）。 */
  pendingDays(): string[] {
    const days = new Set<string>();
    for (const p of this.pending) days.add(p.row.day);
    return [...days].sort();
  }

  /** 给定日是否存在未持久化的行（压实前置条件：该日必须已全部落盘）。 */
  hasUnpersisted(day: string): boolean {
    return this.pending.some((p) => p.row.day === day && !p.persisted);
  }

  /**
   * 取走全部未持久化行（对象引用快照；await 间隙新到的行是独立对象，不受影响）。
   * 行本身保留在 pending（cells 已计入；压实前一直是今日细分查询与压实的素材）。
   */
  takeUnpersisted(): PendingEntry[] {
    return this.pending.filter((p) => !p.persisted);
  }

  /** 精确标记快照条目已持久化（append 成功后调用；只翻转快照内的对象）。 */
  markPersisted(entries: PendingEntry[]): void {
    for (const p of entries) p.persisted = true;
  }

  /**
   * 全量目录日桶快照（day 升序；#633 分片 b 报告快照与统计目录分布数据源）。
   * 委托 buildDirRows——权威口径（dirDays 单源 + 每日残差归未识别）见 buildDirRows 注释。
   */
  dirRows(): TrendDirRow[] {
    return buildDirRows(this.days, this.dirDays);
  }

  /**
   * 全量小时日桶快照（day 升序、hour 升序；#662 报告快照数据源）。
   * 委托 buildHourRows——hourDays 单源快照、不做残差投影（口径见 buildHourRows 注释）。
   */
  hourRows(): TrendHourRow[] {
    return buildHourRows(this.hourDays);
  }

  /**
   * 堆叠柱序列（目录维度；#633 分片 b B1 数据接口）。语义与 seriesStacked 同构：
   * 每时间桶按目录拆段；dirs 为图例并集（窗口内出现过的目录段，含未识别桶）。
   * dir 过滤可选（单目录形态——未识别桶键同为合法过滤值）。
   */
  dirStacked(
    n: number,
    gran: TrendGranularity,
    metric: TrendMetric,
    dir: string | undefined,
    now: number,
  ): { series: TrendStackPoint[]; dirs: Array<{ dir: string }> } {
    return buildDirStackedSeries(this.dirRows(), n, gran, metric, dir, now);
  }

  /**
   * 窗口摘要（目录维度；#633 分片 b B1 数据接口）。curRange/prevRange 语义与
   * windowSummary 完全同构：当前窗口总量/调用数/峰值桶/目录 top 段 + 上一窗口环比。
   * prevComplete 语义对齐：prev 窗口起点早于**目录面数据起点**（dirRows 最早日；
   * 残差投影后该起点等于聚合面数据起点，故与 windowSummary 同值）→ 不可比。
   */
  dirWindowSummary(
    n: number,
    gran: TrendGranularity,
    metric: TrendMetric,
    dir: string | undefined,
    now: number,
    dirSeries?: TrendStackPoint[],
  ): TrendWindowSummary {
    return buildDirWindowSummary(this.dirRows(), n, gran, metric, dir, now, dirSeries);
  }

  /**
   * 目录窗口总量表（#633 分片 b B4 目录范围口径影响 + B1 目录分布数据源）：
   * 给定日区间内按目录聚合 calls 与 metric 总量（calls 降序）。
   */
  dirTotals(
    startDay: string,
    endDay: string,
    metric: TrendMetric = "total",
  ): Array<{ dir: string; calls: number; total: number | null }> {
    return buildDirTotals(this.dirRows(), startDay, endDay, metric);
  }

  /**
   * 给定日的目录维度折算行（读侧投影；#633 A4）。
   * 实现委托 {@link rollupSnapshot}——与压实路径共用同一份折算逻辑，保证「读侧
   * 看到的行」与「压实写入的行」永远同源（单一事实源，防两套实现漂移）。
   */
  takeDirUnpersisted(day: string): TrendDirRow[] {
    return this.rollupSnapshot(day).dirRows;
  }

  /**
   * 压实快照（#654）：一次遍历同时产出「该日 pending 行的身份快照」与「同源折算的
   * agg / dir 行」。
   *
   * 为什么必须同源：压实是「折算 → 落盘 → 消费」三段式，中间隔着若干 await。若消费
   * 时按日键重新查询（旧 dropPending(day) 的实现），await 期间新到达的同日行既没被
   * 折算、也没落盘，却会被连带删除（永久丢行 + 内存/磁盘漂移）。这里返回的 consumed
   * 与 aggRows/dirRows 出自同一批行，调用方持久化成功后只消费 consumed——新到达的行
   * 留待下一轮压实。
   *
   * 折算口径与 #633 A4 一致：dir 键缺失的行只进 agg 行（目录维度为加性可选键，
   * 缺键 = 无 dir 事实可折叠，不在折算侧补造）。cells/dirDays 不动（apply 时已累加，
   * 压实只做落盘形态转换，绝不二次累加）。
   */
  rollupSnapshot(day: string): { consumed: PendingEntry[]; aggRows: TrendAggRow[]; dirRows: TrendDirRow[]; hourRows: TrendHourRow[] } {
    const consumed: PendingEntry[] = [];
    const aggByKey = new Map<string, TrendAggRow>();
    const dirByKey = new Map<string, TrendDirRow>();
    // #662：小时档同源折算——key 为本地时区钟点（hourOfDay 现算自行 time，与
    // apply/rebuild 同源；「落盘即定型」的生成点唯一 helper）。
    const hourByKey = new Map<number, TrendHourRow>();
    for (const p of this.pending) {
      if (p.row.day !== day) continue;
      consumed.push(p);
      const row = p.row;
      const aggKey = `${row.provider}\u0000${row.model ?? ""}`;
      let agg = aggByKey.get(aggKey);
      if (agg === undefined) {
        agg = emptyAggRow(day, row.provider, row.model);
        aggByKey.set(aggKey, agg);
      }
      let dirAgg: TrendDirRow | undefined;
      if (row.dir !== undefined) {
        dirAgg = dirByKey.get(row.dir);
        if (dirAgg === undefined) {
          dirAgg = emptyDirRow(day, row.dir);
          dirByKey.set(row.dir, dirAgg);
        }
      }
      const h = hourOfDay(row.time);
      const hourAgg = hourByKey.get(h);
      let hour: TrendHourRow;
      if (hourAgg === undefined) {
        hour = emptyHourRow(day, h);
        hourByKey.set(h, hour);
      } else {
        hour = hourAgg;
      }
      if (row.kind === "detail") {
        addDetailTo(agg, row);
        if (dirAgg !== undefined) addDetailTo(dirAgg, row);
        addDetailTo(hour, row);
      } else {
        addCounterTo(agg, row.turns, row.toolCalls);
        if (dirAgg !== undefined) addCounterTo(dirAgg, row.turns, row.toolCalls);
        addCounterTo(hour, row.turns, row.toolCalls);
      }
    }
    return { consumed, aggRows: [...aggByKey.values()], dirRows: [...dirByKey.values()], hourRows: [...hourByKey.values()] };
  }

  /**
   * 给定日的折算聚合行（读侧投影；纯读不消费）。
   * 实现委托 {@link rollupSnapshot}——与压实路径共用同一份折算逻辑（单一事实源）。
   */
  rollupRowsOf(day: string): TrendAggRow[] {
    return this.rollupSnapshot(day).aggRows;
  }

  /**
   * 按身份消费 pending 行（压实 IO 全部成功后调用；#654）。
   * 只删除传入快照（{@link rollupSnapshot} 的 consumed）内的 entry——await 期间新到达
   * 的同日行不在快照内，保留到下一轮压实。空数组为 no-op，重复 entry 幂等。
   *
   * cells/dirDays 不动（压实只做落盘形态转换，绝不二次累加）。复核 P1-1：dirDays 亦
   * 不随消费联动删除——目录查询面（dirRows 纯内存快照）无分片回读，删桶 = 跨天历史
   * 柱全 null；压实事实已固化在 dir 分片 + dirDays，只随 pruneDays 收缩。
   */
  consume(entries: readonly PendingEntry[]): void {
    if (entries.length === 0) return;
    const doomed = new Set(entries);
    this.pending = this.pending.filter((p) => !doomed.has(p));
  }

  /**
   * 按日键消费 pending 行（兼容面）。
   * @deprecated #654：按日键删除会在压实 await 窗口内连带删除新到达的同日行（丢行），
   * 不再用于压实路径。新代码请用 {@link rollupSnapshot} + {@link consume}（按身份消费）；
   * 本方法保留仅为不破坏已发布的公开面，实现已委托为「按日取快照后按身份消费」。
   */
  dropPending(day: string, today: string): void {
    void today;
    this.consume(this.pending.filter((p) => p.row.day === day));
  }

  /**
   * 裁剪内存日桶（prune 同步收缩，长期运行不重启时 days 有界；cells 随桶整体丢弃）。
   * #633 复核 M1：dirDays 联动删除（与压实消费对称，生命周期与 days 一致；
   * 独立遍历不依赖 days 键集，纯 dir 日桶（无 agg 行的防御形态）也能清）。
   */
  pruneDays(beforeDay: string): number {
    let removed = 0;
    for (const day of [...this.days.keys()]) {
      if (day < beforeDay) {
        this.days.delete(day);
        removed += 1;
      }
    }
    for (const day of [...this.dirDays.keys()]) {
      if (day < beforeDay) this.dirDays.delete(day);
    }
    // #662：hourDays 与 days/dirDays 生命周期同步（独立遍历，防纯 hour 日桶残留）
    for (const day of [...this.hourDays.keys()]) {
      if (day < beforeDay) this.hourDays.delete(day);
    }
    return removed;
  }

  /**
   * 日切压实（一步式）：折叠为聚合行返回并从 pending 移除。
   * 仅供启动自愈等「无并发 IO 失败窗口」的同步场景使用；flush 压实路径一律走
   * rollupSnapshot + consume 两步式（IO 失败内存行保留，防丢数）。
   * #633 A4：返回混存行——agg 行在前、dir 行在后（writeAggDay 写入约定）。
   * today 参数保留（与调用方注入时钟同源的语义锚点；消费已不依赖日键，见 consume）。
   */
  rollupDay(day: string, today: string): Array<TrendAggRow | TrendDirRow | TrendHourRow> {
    void today;
    const { consumed, aggRows, dirRows, hourRows } = this.rollupSnapshot(day);
    this.consume(consumed);
    return [...aggRows, ...dirRows, ...hourRows];
  }

  /** 从内存 pending 移除给定日已全部落盘的登记（重启自愈删除明细分片后同步内存视图）。 */
  forgetPersisted(day: string): void {
    this.pending = this.pending.filter((p) => !(p.row.day === day && p.persisted));
  }

  // ---------------------------------------------------------------- 查询

  /** 全量桶快照（day 升序；M2 路由与堆叠柱状的数据源）。 */
  buckets(): Array<{ day: string; providers: Array<{ provider: string; model: string | null; cell: TrendCell }> }> {
    const out: Array<{ day: string; providers: Array<{ provider: string; model: string | null; cell: TrendCell }> }> = [];
    for (const day of [...this.days.keys()].sort()) {
      const providers: Array<{ provider: string; model: string | null; cell: TrendCell }> = [];
      for (const [provider, models] of this.days.get(day)!) {
        for (const [model, cell] of models) {
          providers.push({ provider, model, cell });
        }
      }
      out.push({ day, providers });
    }
    return out;
  }

  /** 近 n 日序列（含今日；空日补 null——零 usage 语义，非 0）。 */
  seriesDays(n: number, now: number, metric: TrendMetric, provider?: string): Array<{ day: string; value: number | null }> {
    return lastNDayKeys(n, now).map((day) => ({ day, value: dayValueOf(this.days, day, metric, provider) }));
  }

  /** 近 n 周序列（周一起点；key = 周首日 day key）。 */
  seriesWeeks(n: number, now: number, metric: TrendMetric, provider?: string): Array<{ day: string; value: number | null }> {
    const keys = lastNWeekKeys(n, now);
    return keys.map((day) => ({ day, value: rangeValueOf(this.days, weekRange(day), metric, provider) }));
  }

  /** 近 n 月序列（key = YYYY-MM）。 */
  seriesMonths(n: number, now: number, metric: TrendMetric, provider?: string): Array<{ day: string; value: number | null }> {
    const keys = lastNMonthKeys(n, now);
    return keys.map((key) => ({ day: key, value: rangeValueOf(this.days, monthRange(key), metric, provider) }));
  }

  /**
   * 堆叠柱序列（/trend 路由数据源）：每时间桶按 provider（byModel 时细到
   * provider+model）拆段；providers 为图例并集（窗口内出现过的段）。
   * 委托 buildStackedSeries（days 显式传参，查询投影纯计算）。
   */
  seriesStacked(
    n: number,
    gran: TrendGranularity,
    metric: TrendMetric,
    provider: string | undefined,
    byModel: boolean,
    now: number,
  ): { series: TrendStackPoint[]; providers: Array<{ provider: string; model: string | null }> } {
    return buildStackedSeries(this.days, n, gran, metric, provider, byModel, now);
  }

  /**
   * 窗口摘要（当前 n 桶 + 上一同等窗口环比基准）。
   * 委托 buildWindowSummary；stackSeries 可选传入路由已算好的堆叠序列复用遍历
   * （须与 n/gran/metric/provider 同参，见 aggregator.windowSummary 契约）。
   */
  windowSummary(
    n: number,
    gran: TrendGranularity,
    metric: TrendMetric,
    provider: string | undefined,
    now: number,
    stackSeries?: TrendStackPoint[],
  ): TrendWindowSummary {
    return buildWindowSummary(this.days, n, gran, metric, provider, now, stackSeries);
  }

  /** 统计摘要（health 观测面）。 */
  stats(): { days: number; pendingRows: number; unpersistedRows: number } {
    return {
      days: this.days.size,
      pendingRows: this.pending.length,
      unpersistedRows: this.pending.filter((p) => !p.persisted).length,
    };
  }

  // ---------------------------------------------------------------- 内部（桶构建）

  private cellOf(day: string, provider: string, model: string | null): TrendCell {
    let providers = this.days.get(day);
    if (providers === undefined) {
      providers = new Map();
      this.days.set(day, providers);
    }
    let models = providers.get(provider);
    if (models === undefined) {
      models = new Map();
      providers.set(provider, models);
    }
    let cell = models.get(model);
    if (cell === undefined) {
      cell = emptyCell();
      models.set(model, cell);
    }
    return cell;
  }

  /** dir 维度日桶定位（仿 cellOf；day → dir → cell，缺桶逐级补建；#633 A3）。 */
  private dirCellOf(day: string, dir: string): TrendCell {
    let dirs = this.dirDays.get(day);
    if (dirs === undefined) {
      dirs = new Map();
      this.dirDays.set(day, dirs);
    }
    let cell = dirs.get(dir);
    if (cell === undefined) {
      cell = emptyCell();
      dirs.set(dir, cell);
    }
    return cell;
  }

  /** hour 维度日桶定位（仿 cellOf/dirCellOf；day → hour(0-23) → cell，缺桶逐级补建；#662）。 */
  private hourCellOf(day: string, hour: number): TrendCell {
    let hours = this.hourDays.get(day);
    if (hours === undefined) {
      hours = new Map();
      this.hourDays.set(day, hours);
    }
    let cell = hours.get(hour);
    if (cell === undefined) {
      cell = emptyCell();
      hours.set(hour, cell);
    }
    return cell;
  }
}

// ---------------------------------------------------------------- 纯函数 re-export（公开面兼容）

// 以下符号原定义于本文件，D2 拆分迁至 aggregate-rows.ts / aggregate-query.ts 后经此处
// re-export——src/index.ts、src/report/*.ts 与 lib 产物对 "trend/aggregator.ts" 的
// import 路径保持不变（纯内部移动，公开导出面不破坏）。
export {
  metricValue,
  weekStartKey,
  lastNWeekKeys,
  lastNMonthKeys,
  monthRange,
  weekRange,
} from "./aggregate-query.ts";
export { mergeAggRows, mergeDirRows, mergeHourRows } from "./aggregate-rows.ts";
export type {
  TrendGranularity,
  TrendMetric,
  TrendStackPart,
  TrendStackPoint,
  TrendWindowSummary,
} from "./aggregate-query.ts";