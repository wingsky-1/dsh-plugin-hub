/**
 * dsh-provider-usage/trend — 内存聚合（#503 M1）。
 *
 * 两级聚合（方案定稿）：
 * - cells：day×provider(×model) 桶，apply 时实时累加（含未压实的历史日）；
 * - pending：当日 per-step 明细/计数行（未压实窗口），支撑今日按小时/按会话细分
 *   与日切压实的落盘素材；日切时压实为 day×provider(×model) 聚合行并丢弃明细。
 *
 * 双算防线：明细/计数行在 apply 时已进 cells，压实只做「落盘形态转换」
 * （明细行 → 聚合行），绝不再次累加 cells；重启重建时聚合行与当日明细行
 * 二选一来源（agg 分片存在即权威，见 store 约定），同样不双算。
 *
 * null 语义：桶内 token 求和 null-aware（无任何有效数字保持 null）；
 * 调用/轮次/工具计数独立累加，与 token 有无无关。
 */
import { dayKey, lastNDayKeys } from "../charts.ts";
import {
  sumToken,
  TREND_ROW_VERSION,
  type TrendAggRow,
  type TrendCell,
  type TrendCounterRow,
  type TrendDetailRow,
  type TrendTokens,
} from "./types.ts";
import type { TrendCallRecord, TrendCorrectRecord, TrendCounterRecord, TrendEmit } from "./collector.ts";

/** 聚合指标（序列查询的取值维度；total = 四项 token 之和）。 */
export type TrendMetric = "total" | "input" | "output" | "cacheRead" | "cacheWrite" | "calls";

/** 序列粒度。 */
export type TrendGranularity = "day" | "week" | "month";

/** 堆叠柱单段（一个 provider 或 provider+model 组合在一个时间桶内的取值）。 */
export interface TrendStackPart {
  provider: string;
  model: string | null;
  value: number | null;
}

/** 堆叠柱单根（一个时间桶）。 */
export interface TrendStackPoint {
  /** 桶键：day=YYYY-MM-DD / week=周首日 / month=YYYY-MM。 */
  key: string;
  parts: TrendStackPart[];
  /** 各段之和（null-aware；空桶 null）。 */
  total: number | null;
}

/** 窗口摘要（趋势页汇总卡数据源）。 */
export interface TrendWindowSummary {
  /** 当前窗口指标总量。 */
  total: number | null;
  calls: number;
  turns: number;
  toolCalls: number;
  /** 峰值桶键（total 最大的时间桶；无数据 null）。 */
  peakKey: string | null;
  /** 取值最大的适配器段。 */
  top: { provider: string; model: string | null; value: number } | null;
  /** 上一同等窗口指标总量（环比基准；无数据 null）。 */
  prevTotal: number | null;
  /** 上一窗口数据是否完整（起点早于数据起点 = false；false 时环比不可比，#503 M2.1）。 */
  prevComplete: boolean;
}

/** 未压实行（内存持有；flush 时持久化，压实后移除）。 */
export interface PendingEntry {
  row: TrendDetailRow | TrendCounterRow;
  /** 已 append 到当日分片（重启重建的行也为 true，防二次落盘）。 */
  persisted: boolean;
}

/** 单元格空壳。 */
function emptyCell(): TrendCell {
  return { input: null, output: null, cacheRead: null, cacheWrite: null, calls: 0, turns: 0, toolCalls: 0 };
}

export class TrendAggregator {
  /** day → provider → model(null 允许) → cell。 */
  private days = new Map<string, Map<string, Map<string | null, TrendCell>>>();
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

  private applyCall(r: TrendCallRecord): void {
    const day = dayKey(r.time);
    const cell = this.cellOf(day, r.provider, r.model);
    cell.calls += 1;
    if (r.tokens !== null) {
      cell.input = sumToken(cell.input, r.tokens.input);
      cell.output = sumToken(cell.output, r.tokens.output);
      cell.cacheRead = sumToken(cell.cacheRead, r.tokens.cacheRead);
      cell.cacheWrite = sumToken(cell.cacheWrite, r.tokens.cacheWrite);
    }
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

  /** 明细行 token 变更的 cell 增量修正。 */
  private retokenCell(row: TrendDetailRow, next: TrendTokens): void {
    const cell = this.cellOf(row.day, row.provider, row.model);
    cell.input = sumToken(cell.input, sub(row.input, next.input));
    cell.output = sumToken(cell.output, sub(row.output, next.output));
    cell.cacheRead = sumToken(cell.cacheRead, sub(row.cacheRead, next.cacheRead));
    cell.cacheWrite = sumToken(cell.cacheWrite, sub(row.cacheWrite, next.cacheWrite));
  }

  private applyCounter(r: TrendCounterRecord): void {
    const day = dayKey(r.time);
    const cell = this.cellOf(day, r.provider, r.model);
    cell.turns += r.turns;
    cell.toolCalls += r.toolCalls;
    const row: TrendCounterRow = {
      v: TREND_ROW_VERSION,
      kind: "counter",
      time: r.time,
      day,
      session: r.session,
      provider: r.provider,
      model: r.model,
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
  rebuild(rows: Array<TrendAggRow | TrendDetailRow | TrendCounterRow>, persistedRows: boolean): void {
    for (const row of rows) {
      if (row.kind === "agg") {
        const cell = this.cellOf(row.day, row.provider, row.model);
        mergeCell(cell, row);
        continue;
      }
      if (row.kind === "detail") {
        const cell = this.cellOf(row.day, row.provider, row.model);
        cell.calls += 1;
        cell.input = sumToken(cell.input, row.input);
        cell.output = sumToken(cell.output, row.output);
        cell.cacheRead = sumToken(cell.cacheRead, row.cacheRead);
        cell.cacheWrite = sumToken(cell.cacheWrite, row.cacheWrite);
      } else {
        const cell = this.cellOf(row.day, row.provider, row.model);
        cell.turns += row.turns;
        cell.toolCalls += row.toolCalls;
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
   * 日切压实（纯计算）：把给定日的明细/计数行折叠为聚合行返回，**不从 pending 移除**。
   * 供 flush 压实路径「先算 → IO → 成功后才消费」的安全序使用（IO 失败内存行保留）。
   * cells 不动（apply 时已累加，压实只做落盘形态转换，绝不二次累加）。
   */
  rollupRowsOf(day: string): TrendAggRow[] {
    const byKey = new Map<string, TrendAggRow>();
    for (const p of this.pending) {
      if (p.row.day !== day) continue;
      const row = p.row;
      const key = `${row.provider}\u0000${row.model ?? ""}`;
      let agg = byKey.get(key);
      if (agg === undefined) {
        agg = {
          v: TREND_ROW_VERSION,
          kind: "agg",
          day,
          provider: row.provider,
          model: row.model,
          input: null,
          output: null,
          cacheRead: null,
          cacheWrite: null,
          calls: 0,
          turns: 0,
          toolCalls: 0,
        };
        byKey.set(key, agg);
      }
      if (row.kind === "detail") {
        agg.calls += 1;
        agg.input = sumToken(agg.input, row.input);
        agg.output = sumToken(agg.output, row.output);
        agg.cacheRead = sumToken(agg.cacheRead, row.cacheRead);
        agg.cacheWrite = sumToken(agg.cacheWrite, row.cacheWrite);
      } else {
        agg.turns += row.turns;
        agg.toolCalls += row.toolCalls;
      }
    }
    return [...byKey.values()];
  }

  /** 消费给定日的 pending 行（压实 IO 全部成功后调用；cells 不动）。 */
  dropPending(day: string): void {
    this.pending = this.pending.filter((p) => p.row.day !== day);
  }

  /** 裁剪内存日桶（prune 同步收缩，长期运行不重启时 days 有界；cells 随桶整体丢弃）。 */
  pruneDays(beforeDay: string): number {
    let removed = 0;
    for (const day of [...this.days.keys()]) {
      if (day < beforeDay) {
        this.days.delete(day);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * 日切压实（一步式）：折叠为聚合行返回并从 pending 移除。
   * 仅供启动自愈等「无并发 IO 失败窗口」的同步场景使用；flush 压实路径
   * 一律走 rollupRowsOf + dropPending 两步式（IO 失败内存行保留，防丢数）。
   */
  rollupDay(day: string): TrendAggRow[] {
    const rows = this.rollupRowsOf(day);
    this.dropPending(day);
    return rows;
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
    return lastNDayKeys(n, now).map((day) => ({ day, value: this.dayValue(day, metric, provider) }));
  }

  /** 近 n 周序列（周一起点；key = 周首日 day key）。 */
  seriesWeeks(n: number, now: number, metric: TrendMetric, provider?: string): Array<{ day: string; value: number | null }> {
    const keys = lastNWeekKeys(n, now);
    return keys.map((day) => ({ day, value: this.rangeValue(weekRange(day), metric, provider) }));
  }

  /** 近 n 月序列（key = YYYY-MM）。 */
  seriesMonths(n: number, now: number, metric: TrendMetric, provider?: string): Array<{ day: string; value: number | null }> {
    const keys = lastNMonthKeys(n, now);
    return keys.map((key) => ({ day: key, value: this.rangeValue(monthRange(key), metric, provider) }));
  }

  /**
   * 堆叠柱序列（/trend 路由数据源）：每时间桶按 provider（byModel 时细到
   * provider+model）拆段；providers 为图例并集（窗口内出现过的段）。
   */
  seriesStacked(
    n: number,
    gran: TrendGranularity,
    metric: TrendMetric,
    provider: string | undefined,
    byModel: boolean,
    now: number,
  ): { series: TrendStackPoint[]; providers: Array<{ provider: string; model: string | null }> } {
    const keys = this.granKeys(n, gran, now);
    // 桶日区间一次算全（评审 P1-2：原实现对每桶在 days 日循环内重复调 granRange）
    const ranges = new Map(keys.map((k) => [k, this.granRange(k, gran)] as const));
    const series: TrendStackPoint[] = keys.map((key) => {
      const partsMap = new Map<string, TrendStackPart>();
      const range = ranges.get(key)!;
      for (const [day, models] of this.days) {
        if (day < range.start || day > range.end) continue;
        for (const [p, cells] of models) {
          if (provider !== undefined && p !== provider) continue;
          for (const [m, cell] of cells) {
            const id = byModel ? `${p}\u0000${m ?? ""}` : p;
            const v = metricValue(cell, metric);
            const cur = partsMap.get(id);
            if (cur !== undefined) cur.value = sumToken(cur.value, v);
            else partsMap.set(id, { provider: p, model: byModel ? m : null, value: v });
          }
        }
      }
      const parts = [...partsMap.values()];
      let total: number | null = null;
      for (const pt of parts) total = sumToken(total, pt.value);
      return { key, parts, total };
    });
    const legend = new Map<string, { provider: string; model: string | null }>();
    for (const point of series) {
      for (const pt of point.parts) {
        legend.set(byModel ? `${pt.provider}\u0000${pt.model ?? ""}` : pt.provider, {
          provider: pt.provider,
          model: byModel ? pt.model : null,
        });
      }
    }
    return { series, providers: [...legend.values()] };
  }

  /**
   * 窗口摘要（当前 n 桶 + 上一同等窗口环比基准）。
   * @param stackSeries 可选传入路由已算好的堆叠序列（n/gran/metric/provider 必须与本
   *   调用一致）——复用峰值/Top 遍历，消除单请求双算（评审 P1-2）；缺省时内部自算。
   */
  windowSummary(
    n: number,
    gran: TrendGranularity,
    metric: TrendMetric,
    provider: string | undefined,
    now: number,
    stackSeries?: TrendStackPoint[],
  ): TrendWindowSummary {
    const keys = this.granKeys(n, gran, now);
    const curRange = {
      start: this.granRange(keys[0], gran).start,
      end: this.granRange(keys[keys.length - 1], gran).end,
    };
    // 上一窗口：同长键序列整体前移 n 桶（day/week/month 各自步进语义）
    const prevKeys = this.granKeys(n, gran, this.prevWindowAnchor(now, n, gran));
    const prevRange = {
      start: this.granRange(prevKeys[0], gran).start,
      end: this.granRange(prevKeys[prevKeys.length - 1], gran).end,
    };
    let total: number | null = null;
    let calls = 0;
    let turns = 0;
    let toolCalls = 0;
    let peakKey: string | null = null;
    let peakVal = -1;
    let top: { provider: string; model: string | null; value: number } | null = null;
    // 复用路由已算的 stack 序列（评审 P1-2：消除单请求双算；缺省自算保持独立可用）
    const series = stackSeries ?? this.seriesStacked(n, gran, metric, provider, false, now).series;
    for (const point of series) {
      if (point.total !== null && point.total > peakVal) {
        peakVal = point.total;
        peakKey = point.key;
      }
      for (const pt of point.parts) {
        if (pt.value !== null && (top === null || pt.value > top.value)) {
          top = { provider: pt.provider, model: pt.model, value: pt.value };
        }
      }
    }
    for (const { cell } of this.rangeCells(curRange, provider)) {
      total = sumToken(total, metricValue(cell, metric));
      calls += cell.calls;
      turns += cell.turns;
      toolCalls += cell.toolCalls;
    }
    return {
      total,
      calls,
      turns,
      toolCalls,
      peakKey,
      top,
      prevTotal: this.rangeValue(prevRange, metric, provider),
      // 上一窗口起点早于数据起点（内存最早日，即留存/起算边缘）→ 基准不完整，环比不可比（#503 M2.1）
      prevComplete: prevRange.start >= (firstDayKeyOf(this.days) ?? "9999-12-31"),
    };
  }

  // ---------------------------------------------------------------- 内部

  /** 粒度桶键序列（升序，含当前桶）。 */
  private granKeys(n: number, gran: TrendGranularity, now: number): string[] {
    if (gran === "week") return lastNWeekKeys(n, now);
    if (gran === "month") return lastNMonthKeys(n, now);
    return lastNDayKeys(n, now);
  }

  /** 桶键 → 本地日区间。 */
  private granRange(key: string, gran: TrendGranularity): { start: string; end: string } {
    if (gran === "week") return weekRange(key);
    if (gran === "month") return monthRange(key);
    return { start: key, end: key };
  }

  /** 上一窗口锚点（把 now 前移 n 桶，得到 prevKeys 与当前窗口不重叠的时点）。 */
  private prevWindowAnchor(now: number, n: number, gran: TrendGranularity): number {
    const d = new Date(now);
    if (gran === "month") {
      d.setMonth(d.getMonth() - n);
      return d.getTime();
    }
    const days = gran === "week" ? n * 7 : n;
    d.setDate(d.getDate() - days);
    return d.getTime();
  }

  /** 日区间内的全部 (provider, model, cell)（升序日；provider 过滤可选）。 */
  private rangeCells(range: { start: string; end: string }, provider?: string): Array<{ provider: string; model: string | null; cell: TrendCell }> {
    const out: Array<{ provider: string; model: string | null; cell: TrendCell }> = [];
    for (const [day, models] of this.days) {
      if (day < range.start || day > range.end) continue;
      for (const [p, cells] of models) {
        if (provider !== undefined && p !== provider) continue;
        for (const [m, cell] of cells) out.push({ provider: p, model: m, cell });
      }
    }
    return out;
  }

  /** 单日取值（provider 过滤可选；跨 model 求和）。 */
  private dayValue(day: string, metric: TrendMetric, provider?: string): number | null {
    const models = this.days.get(day);
    if (models === undefined) return null;
    let acc: number | null = null;
    for (const [p, cells] of models) {
      if (provider !== undefined && p !== provider) continue;
      for (const cell of cells.values()) acc = sumToken(acc, metricValue(cell, metric));
    }
    return acc;
  }

  /** 日区间取值（[startDay, endDay] 闭区间，按本地日字典序比较）。 */
  private rangeValue(range: { start: string; end: string }, metric: TrendMetric, provider?: string): number | null {
    let acc: number | null = null;
    for (const [day, models] of this.days) {
      if (day < range.start || day > range.end) continue;
      for (const [p, cells] of models) {
        if (provider !== undefined && p !== provider) continue;
        for (const cell of cells.values()) acc = sumToken(acc, metricValue(cell, metric));
      }
    }
    return acc;
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
}

// ---------------------------------------------------------------- 纯函数

/** token 差（cell 回退用）：有值→null 时增量为 -old（cell 同步扣减，保证内存聚合
 *  与校正后的落盘明细一致）；双方皆 null 增量 0（null-aware 无变化）。 */
function sub(oldV: number | null, newV: number | null): number | null {
  if (newV === null) return oldV === null ? null : -oldV;
  if (oldV === null) return newV;
  return newV - oldV;
}

/** 内存日桶的最早 day key（无数据返回 null；day key 字典序即时间序）。 */
function firstDayKeyOf(days: Map<string, unknown>): string | null {
  let first: string | null = null;
  for (const day of days.keys()) {
    if (first === null || day < first) first = day;
  }
  return first;
}

/** 聚合行并入 cell（重建用；null-aware）。 */
function mergeCell(cell: TrendCell, row: TrendAggRow): void {
  cell.calls += row.calls;
  cell.turns += row.turns;
  cell.toolCalls += row.toolCalls;
  cell.input = sumToken(cell.input, row.input);
  cell.output = sumToken(cell.output, row.output);
  cell.cacheRead = sumToken(cell.cacheRead, row.cacheRead);
  cell.cacheWrite = sumToken(cell.cacheWrite, row.cacheWrite);
}

/** cell 的指标取值（total = 四项 token 之和）。 */
export function metricValue(cell: TrendCell, metric: TrendMetric): number | null {
  switch (metric) {
    case "total":
      return sumToken(sumToken(cell.input, cell.output), sumToken(cell.cacheRead, cell.cacheWrite));
    case "input":
      return cell.input;
    case "output":
      return cell.output;
    case "cacheRead":
      return cell.cacheRead;
    case "cacheWrite":
      return cell.cacheWrite;
    case "calls":
      return cell.calls;
  }
}

/**
 * 聚合行合并（flush 压实写盘前与既有聚合分片合并——迟到旧日行场景防覆盖丢数；
 * null-aware 求和，同 (provider, model) 键累加）。
 */
export function mergeAggRows(base: TrendAggRow[], add: TrendAggRow[]): TrendAggRow[] {
  const byKey = new Map<string, TrendAggRow>();
  for (const r of [...base, ...add]) {
    const key = `${r.provider}\u0000${r.model ?? ""}`;
    const cur = byKey.get(key);
    if (cur === undefined) {
      byKey.set(key, { ...r });
      continue;
    }
    cur.calls += r.calls;
    cur.turns += r.turns;
    cur.toolCalls += r.toolCalls;
    cur.input = sumToken(cur.input, r.input);
    cur.output = sumToken(cur.output, r.output);
    cur.cacheRead = sumToken(cur.cacheRead, r.cacheRead);
    cur.cacheWrite = sumToken(cur.cacheWrite, r.cacheWrite);
  }
  return [...byKey.values()];
}

/** 周一为起点的周首日 day key（本地时区；DST 安全——逐日回退不用毫秒减法）。 */
export function weekStartKey(t: number): string {
  const d = new Date(t);
  const dow = d.getDay(); // 0=周日
  const back = (dow + 6) % 7; // 距周一的天数
  d.setDate(d.getDate() - back);
  return dayKey(d.getTime());
}

/** 近 n 个周首日 key（升序，含当前周）。 */
export function lastNWeekKeys(n: number, now: number): string[] {
  const d = new Date(now);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const keys: string[] = [];
  for (let i = 0; i < n; i += 1) {
    keys.unshift(dayKey(d.getTime()));
    d.setDate(d.getDate() - 7);
  }
  return keys;
}

/** 近 n 个月 key（YYYY-MM，升序，含当月；本地时区逐月回退）。 */
export function lastNMonthKeys(n: number, now: number): string[] {
  const d = new Date(now);
  const keys: string[] = [];
  for (let i = 0; i < n; i += 1) {
    keys.unshift(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
  }
  return keys;
}

/** 月 key 的日区间（本地日字典序；月末取该月最后一天，DST 安全）。 */
export function monthRange(key: string): { start: string; end: string } {
  const [y, m] = key.split("-").map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0); // 次月 0 日 = 本月末日
  return { start: dayKey(start.getTime()), end: dayKey(end.getTime()) };
}

/** 周首日 key 的日区间（7 天）。 */
export function weekRange(weekStart: string): { start: string; end: string } {
  const [y, m, d] = weekStart.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const endDate = new Date(y, m - 1, d + 6);
  return { start: dayKey(start.getTime()), end: dayKey(endDate.getTime()) };
}
