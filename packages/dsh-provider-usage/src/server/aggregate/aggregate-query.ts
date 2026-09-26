/**
 * dsh-provider-usage/trend — 查询投影纯函数。
 *
 * 为什么独立成模块：趋势查询面（序列/堆叠/窗口摘要/目录投影）的计算与
 * TrendAggregator 的状态容器解耦——本模块全部函数以 days/dirDays/rows 显式传参，
 * 不接触 this（防「拆文件 = 共享 this」坏味道，layer-architecture.md §4 D-2）；
 * 主类保留状态容器与需要 this 的 IO/记账方法，查询方法变成薄壳委托。
 * 依赖方向无环：aggregate-query → types / charts / aggregate-rows；aggregator → 三者。
 *
 * 守恒边界（对账口径见 unit-trend-ledger.test.ts）：dirRows() 输出 = 目录桶
 * 快照 + 每日残差投影（归 TREND_UNIDENTIFIED）；无 dir 键的旧格式行只进聚合面不进
 * 目录面——目录维度守恒以「有 dir 事实」为界。小时面（buildHourRows）不做残差投影
 * （detail/counter 行必有 time，旧分片缺小时是物理缺失，报告侧 coveredDays 守卫降级）。
 */
import { dayKey, lastNDayKeys } from "../../shared/interface.ts";
import { emptyCell, diffToken } from "./aggregate-rows.ts";
import {
  sumToken,
  TREND_ROW_VERSION,
  TREND_UNIDENTIFIED,
  type TrendCell,
  type TrendDirRow,
  type TrendHourRow,
  type TrendMetric,
} from "../shared/interface.ts";
export type { TrendMetric } from "../shared/interface.ts";

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
  /** 上一窗口数据是否完整（起点早于数据起点 = false；false 时环比不可比）。 */
  prevComplete: boolean;
}

/** cell 的指标取值（#768 A波5：canonical 已下沉 server/shared/trend.ts，本文件 re-export 门面保留旧址兼容）。 */
export { metricValue } from "../shared/interface.ts";
import { metricValue } from "../shared/interface.ts";

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

/** 内存日桶的最早 day key（无数据返回 null；day key 字典序即时间序）。 */
function firstDayKeyOf(days: Map<string, unknown>): string | null {
  let first: string | null = null;
  for (const day of days.keys()) {
    if (first === null || day < first) first = day;
  }
  return first;
}

/** 粒度桶键序列（升序，含当前桶）。 */
function granKeysFor(n: number, gran: TrendGranularity, now: number): string[] {
  if (gran === "week") return lastNWeekKeys(n, now);
  if (gran === "month") return lastNMonthKeys(n, now);
  return lastNDayKeys(n, now);
}

/** 桶键 → 本地日区间。 */
function granRangeForKey(key: string, gran: TrendGranularity): { start: string; end: string } {
  if (gran === "week") return weekRange(key);
  if (gran === "month") return monthRange(key);
  return { start: key, end: key };
}

/** 目录行的十数值字段（cell/row 形态通用；键序即落盘字段序）。 */
type DirCellValues = Pick<
  TrendCell,
  "input" | "output" | "cacheRead" | "cacheWrite" | "calls" | "turns" | "toolCalls"
>;

/** cell → 目录行的十数值字段（浅展开；字段名同构，直接搬）。 */
function cellValues(cell: TrendCell): DirCellValues {
  return {
    input: cell.input,
    output: cell.output,
    cacheRead: cell.cacheRead,
    cacheWrite: cell.cacheWrite,
    calls: cell.calls,
    turns: cell.turns,
    toolCalls: cell.toolCalls,
  };
}

/** 同键目录行合并（null-aware 求和；counts 独立累加）。 */
function mergeDirCells(cur: TrendDirRow, add: DirCellValues): void {
  cur.input = sumToken(cur.input, add.input);
  cur.output = sumToken(cur.output, add.output);
  cur.cacheRead = sumToken(cur.cacheRead, add.cacheRead);
  cur.cacheWrite = sumToken(cur.cacheWrite, add.cacheWrite);
  cur.calls += add.calls;
  cur.turns += add.turns;
  cur.toolCalls += add.toolCalls;
}

/** 聚合面逐日合计（cells：day → provider → model 三层求和）。 */
function sumCellsByDay(
  days: Map<string, Map<string, Map<string | null, TrendCell>>>,
): Map<string, TrendCell> {
  const aggByDay = new Map<string, TrendCell>();
  for (const [day, providers] of days) {
    const cell = cellBucketOf(aggByDay, day);
    for (const models of providers.values()) {
      for (const c of models.values()) {
        cell.input = sumToken(cell.input, c.input);
        cell.output = sumToken(cell.output, c.output);
        cell.cacheRead = sumToken(cell.cacheRead, c.cacheRead);
        cell.cacheWrite = sumToken(cell.cacheWrite, c.cacheWrite);
        cell.calls += c.calls;
        cell.turns += c.turns;
        cell.toolCalls += c.toolCalls;
      }
    }
  }
  return aggByDay;
}

/** 目录面逐日合计（dirDays：day → dir 两层求和；无目录事实返回空壳零值）。 */
function sumDirCellsByDay(cells: Map<string, TrendCell> | undefined): TrendCell {
  const total = emptyCell();
  for (const c of cells?.values() ?? []) {
    total.input = sumToken(total.input, c.input);
    total.output = sumToken(total.output, c.output);
    total.cacheRead = sumToken(total.cacheRead, c.cacheRead);
    total.cacheWrite = sumToken(total.cacheWrite, c.cacheWrite);
    total.calls += c.calls;
    total.turns += c.turns;
    total.toolCalls += c.toolCalls;
  }
  return total;
}

/** 日桶取用（缺桶建空壳）。 */
function cellBucketOf(byDay: Map<string, TrendCell>, day: string): TrendCell {
  const existing = byDay.get(day);
  if (existing !== undefined) return existing;
  const created = emptyCell();
  byDay.set(day, created);
  return created;
}

/** 残差 token 的正残差保留（非正归 null——不产生负柱）。 */
function positiveToken(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

/** 残差计数的正残差保留（非正归 0——不产生负柱）。 */
function positiveCount(value: number): number {
  return value > 0 ? value : 0;
}

/**
 * 是否存在正残差：四个 token 维度与三个计数字段同构判定
 * （`(x ?? 0) > 0` 与 positiveToken(x) !== null 等价；负残差与全零同样判否）。
 */
function hasResidual(residual: TrendCell): boolean {
  return (
    residual.calls > 0 ||
    residual.turns > 0 ||
    residual.toolCalls > 0 ||
    positiveToken(residual.input) !== null ||
    positiveToken(residual.output) !== null ||
    positiveToken(residual.cacheRead) !== null ||
    positiveToken(residual.cacheWrite) !== null
  );
}

/**
 * 单日残差投影行（聚合面 − 目录面，null-aware：双方皆 null → 无残差；单侧 null 按 0 计）。
 * 全零/全负残差返回 null（不补造行）：全零 = 该日目录面已覆盖全量（新分片常态）；
 * 负残差 = 目录面多于聚合面，属数据不一致征兆（README「总量守恒」节已注明该边界
 * 不保证恒等），同样不产行。
 */
function residualRowOf(
  day: string,
  agg: TrendCell,
  dirCells: Map<string, TrendCell> | undefined,
): TrendDirRow | null {
  const dir = sumDirCellsByDay(dirCells);
  const residual: TrendCell = {
    input: diffToken(agg.input, dir.input),
    output: diffToken(agg.output, dir.output),
    cacheRead: diffToken(agg.cacheRead, dir.cacheRead),
    cacheWrite: diffToken(agg.cacheWrite, dir.cacheWrite),
    calls: agg.calls - dir.calls,
    turns: agg.turns - dir.turns,
    toolCalls: agg.toolCalls - dir.toolCalls,
  };
  if (!hasResidual(residual)) return null;
  return {
    v: TREND_ROW_VERSION,
    kind: "dir",
    day,
    dir: TREND_UNIDENTIFIED,
    input: positiveToken(residual.input),
    output: positiveToken(residual.output),
    cacheRead: positiveToken(residual.cacheRead),
    cacheWrite: positiveToken(residual.cacheWrite),
    calls: positiveCount(residual.calls),
    turns: positiveCount(residual.turns),
    toolCalls: positiveCount(residual.toolCalls),
  };
}

/** 日区间闭区间判定（本地日字典序；窗口过滤的唯一口径）。 */
function inDayRange(day: string, range: { start: string; end: string }): boolean {
  return day >= range.start && day <= range.end;
}

/**
 * 当前/上一窗口的日区间对（两个 summary 面共用）。
 * prevKeys = 同长键序列整体前移 n 桶（day/week/month 各自步进语义），保证不与当前窗口重叠。
 */
function windowRanges(
  n: number,
  gran: TrendGranularity,
  now: number,
): { curRange: { start: string; end: string }; prevRange: { start: string; end: string } } {
  const keys = granKeysFor(n, gran, now);
  const curRange = {
    start: granRangeForKey(keys[0], gran).start,
    end: granRangeForKey(keys[keys.length - 1], gran).end,
  };
  const prevKeys = granKeysFor(n, gran, prevWindowAnchorFor(now, n, gran));
  const prevRange = {
    start: granRangeForKey(prevKeys[0], gran).start,
    end: granRangeForKey(prevKeys[prevKeys.length - 1], gran).end,
  };
  return { curRange, prevRange };
}

/** 堆叠序列的峰值桶与取值最大段（两个 summary 面共用同一遍历口径）。 */
function peakAndTopOf(series: TrendStackPoint[]): {
  peakKey: string | null;
  top: { provider: string; model: string | null; value: number } | null;
} {
  let peakKey: string | null = null;
  let peakVal = -1;
  let top: { provider: string; model: string | null; value: number } | null = null;
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
  return { peakKey, top };
}

/** 堆叠单桶的段合计（null-aware；空桶 null）。 */
function partsTotal(parts: TrendStackPart[]): number | null {
  let total: number | null = null;
  for (const pt of parts) total = sumToken(total, pt.value);
  return total;
}

/** 段入桶（同 id 累加，首次出现按 byModel 形态定型 provider/model）。 */
function addStackPart(
  partsMap: Map<string, TrendStackPart>,
  id: string,
  provider: string,
  model: string | null,
  value: number | null,
): void {
  const cur = partsMap.get(id);
  if (cur === undefined) partsMap.set(id, { provider, model, value });
  else cur.value = sumToken(cur.value, value);
}

/** provider 面的段 id（byModel 时细到 provider+model；两处取用须同式）。 */
function providerPartId(p: string, m: string | null, byModel: boolean): string {
  return byModel ? `${p}\u0000${m ?? ""}` : p;
}

/** 图例并集（窗口内出现过的段；byModel 时键与段 id 同式）。 */
function legendOf(
  series: TrendStackPoint[],
  byModel: boolean,
): Array<{ provider: string; model: string | null }> {
  const legend = new Map<string, { provider: string; model: string | null }>();
  for (const point of series) {
    for (const pt of point.parts) {
      legend.set(providerPartId(pt.provider, pt.model, byModel), {
        provider: pt.provider,
        model: byModel ? pt.model : null,
      });
    }
  }
  return [...legend.values()];
}

/** 单日桶内按 provider（可选 model 细分）累加各段取值。 */
function accumulateCellParts(
  partsMap: Map<string, TrendStackPart>,
  models: Map<string, Map<string | null, TrendCell>>,
  provider: string | undefined,
  byModel: boolean,
  metric: TrendMetric,
): void {
  for (const [p, cells] of models) {
    if (provider !== undefined && p !== provider) continue;
    for (const [m, cell] of cells) {
      addStackPart(
        partsMap,
        providerPartId(p, m, byModel),
        p,
        byModel ? m : null,
        metricValue(cell, metric),
      );
    }
  }
}

/** 单桶堆叠点（桶日区间一次算全，桶内只做窗口过滤与段累加）。 */
function stackPointOf(
  key: string,
  range: { start: string; end: string },
  days: Map<string, Map<string, Map<string | null, TrendCell>>>,
  provider: string | undefined,
  byModel: boolean,
  metric: TrendMetric,
): TrendStackPoint {
  const partsMap = new Map<string, TrendStackPart>();
  for (const [day, models] of days) {
    if (!inDayRange(day, range)) continue;
    accumulateCellParts(partsMap, models, provider, byModel, metric);
  }
  const parts = [...partsMap.values()];
  return { key, parts, total: partsTotal(parts) };
}

/** 单桶目录堆叠点（目录面语义：段 id 即目录键，model 恒 null）。 */
function dirStackPointOf(
  key: string,
  range: { start: string; end: string },
  rows: TrendDirRow[],
  dir: string | undefined,
  metric: TrendMetric,
): TrendStackPoint {
  const partsMap = new Map<string, TrendStackPart>();
  for (const row of rows) {
    if (!inDayRange(row.day, range)) continue;
    if (dir !== undefined && row.dir !== dir) continue;
    addStackPart(partsMap, row.dir, row.dir, null, metricValue(row, metric));
  }
  const parts = [...partsMap.values()];
  return { key, parts, total: partsTotal(parts) };
}

/** 上一窗口锚点（把 now 前移 n 桶，得到 prevKeys 与当前窗口不重叠的时点）。 */
function prevWindowAnchorFor(now: number, n: number, gran: TrendGranularity): number {
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
function rangeCellsOf(
  days: Map<string, Map<string, Map<string | null, TrendCell>>>,
  range: { start: string; end: string },
  provider?: string,
): Array<{ provider: string; model: string | null; cell: TrendCell }> {
  const out: Array<{ provider: string; model: string | null; cell: TrendCell }> = [];
  for (const [day, models] of days) {
    if (day < range.start || day > range.end) continue;
    for (const [p, cells] of models) {
      if (provider !== undefined && p !== provider) continue;
      for (const [m, cell] of cells) out.push({ provider: p, model: m, cell });
    }
  }
  return out;
}

/** 单日取值（provider 过滤可选；跨 model 求和；aggregator.seriesDays 委托用）。 */
export function dayValueOf(
  days: Map<string, Map<string, Map<string | null, TrendCell>>>,
  day: string,
  metric: TrendMetric,
  provider?: string,
): number | null {
  const models = days.get(day);
  if (models === undefined) return null;
  let acc: number | null = null;
  for (const [p, cells] of models) {
    if (provider !== undefined && p !== provider) continue;
    for (const cell of cells.values()) acc = sumToken(acc, metricValue(cell, metric));
  }
  return acc;
}

/** 日区间取值（[startDay, endDay] 闭区间，按本地日字典序比较；aggregator 序列方法委托用）。 */
export function rangeValueOf(
  days: Map<string, Map<string, Map<string | null, TrendCell>>>,
  range: { start: string; end: string },
  metric: TrendMetric,
  provider?: string,
): number | null {
  let acc: number | null = null;
  for (const [day, models] of days) {
    if (day < range.start || day > range.end) continue;
    for (const [p, cells] of models) {
      if (provider !== undefined && p !== provider) continue;
      for (const cell of cells.values()) acc = sumToken(acc, metricValue(cell, metric));
    }
  }
  return acc;
}

/**
 * 堆叠柱序列（/trend 路由数据源）：每时间桶按 provider（byModel 时细到
 * provider+model）拆段；providers 为图例并集（窗口内出现过的段）。
 */
export function buildStackedSeries(
  days: Map<string, Map<string, Map<string | null, TrendCell>>>,
  n: number,
  gran: TrendGranularity,
  metric: TrendMetric,
  provider: string | undefined,
  byModel: boolean,
  now: number,
): { series: TrendStackPoint[]; providers: Array<{ provider: string; model: string | null }> } {
  const keys = granKeysFor(n, gran, now);
  // 桶日区间一次算全（原实现对每桶在 days 日循环内重复调 granRange）
  const ranges = new Map(keys.map((k) => [k, granRangeForKey(k, gran)] as const));
  const series = keys.map((key) =>
    stackPointOf(key, ranges.get(key)!, days, provider, byModel, metric),
  );
  return { series, providers: legendOf(series, byModel) };
}

/**
 * 堆叠柱序列（目录维度）。语义与 seriesStacked 同构：
 * 每时间桶按目录拆段；dirs 为图例并集（窗口内出现过的目录段，含未识别桶）。
 * dir 过滤可选（单目录形态——未识别桶键同为合法过滤值）。
 */
export function buildDirStackedSeries(
  rows: TrendDirRow[],
  n: number,
  gran: TrendGranularity,
  metric: TrendMetric,
  dir: string | undefined,
  now: number,
): { series: TrendStackPoint[]; dirs: Array<{ dir: string }> } {
  const keys = granKeysFor(n, gran, now);
  const ranges = new Map(keys.map((k) => [k, granRangeForKey(k, gran)] as const));
  // 行快照提出桶循环（原实现每桶 this.dirRows() 全量快照，O(桶×行)
  // 单请求重复；与 seriesStacked 同策略——range 一次算全 + 快照单次
  // 取用，桶循环内只做窗口过滤消费）。
  const series = keys.map((key) => dirStackPointOf(key, ranges.get(key)!, rows, dir, metric));
  const legend = new Set<string>();
  for (const point of series) {
    for (const pt of point.parts) legend.add(pt.provider);
  }
  return { series, dirs: [...legend].sort().map((d) => ({ dir: d })) };
}

/**
 * 窗口摘要（当前 n 桶 + 上一同等窗口环比基准）。
 * @param stackSeries 可选传入路由已算好的堆叠序列（n/gran/metric/provider 必须与本
 *   调用一致）——复用峰值/Top 遍历，消除单请求双算；缺省时内部自算。
 */
export function buildWindowSummary(
  days: Map<string, Map<string, Map<string | null, TrendCell>>>,
  n: number,
  gran: TrendGranularity,
  metric: TrendMetric,
  provider: string | undefined,
  now: number,
  stackSeries?: TrendStackPoint[],
): TrendWindowSummary {
  const { curRange, prevRange } = windowRanges(n, gran, now);
  // 复用路由已算的 stack 序列（消除单请求双算；缺省自算保持独立可用）
  const series =
    stackSeries ?? buildStackedSeries(days, n, gran, metric, provider, false, now).series;
  const { peakKey, top } = peakAndTopOf(series);
  const totals = { total: null as number | null, calls: 0, turns: 0, toolCalls: 0 };
  for (const { cell } of rangeCellsOf(days, curRange, provider)) {
    totals.total = sumToken(totals.total, metricValue(cell, metric));
    totals.calls += cell.calls;
    totals.turns += cell.turns;
    totals.toolCalls += cell.toolCalls;
  }
  return {
    ...totals,
    peakKey,
    top,
    prevTotal: rangeValueOf(days, prevRange, metric, provider),
    // 上一窗口起点早于数据起点（内存最早日，即留存/起算边缘）→ 基准不完整，环比不可比
    prevComplete: prevRange.start >= (firstDayKeyOf(days) ?? "9999-12-31"),
  };
}

/**
 * 窗口摘要（目录维度）。curRange/prevRange 语义与
 * windowSummary 完全同构：当前窗口总量/调用数/峰值桶/目录 top 段 + 上一窗口环比。
 * prevComplete 语义对齐：prev 窗口起点早于**目录面数据起点**（dirRows 最早日；
 * 残差投影后该起点等于聚合面数据起点，故与 windowSummary 同值）→ 不可比。
 */
export function buildDirWindowSummary(
  rows: TrendDirRow[],
  n: number,
  gran: TrendGranularity,
  metric: TrendMetric,
  dir: string | undefined,
  now: number,
  dirSeries?: TrendStackPoint[],
): TrendWindowSummary {
  const { curRange, prevRange } = windowRanges(n, gran, now);
  const series = dirSeries ?? buildDirStackedSeries(rows, n, gran, metric, dir, now).series;
  const { peakKey, top } = peakAndTopOf(series);
  // 单遍遍历（原实现 3 次全量遍历 rows——最早日 + 当前窗口 + 上一
  // 窗口各一遍；窗口区间互斥，同遍累加语义不变）。
  const scan = scanDirWindow(rows, dir, curRange, prevRange, metric);
  return {
    total: scan.total,
    calls: scan.calls,
    turns: scan.turns,
    toolCalls: scan.toolCalls,
    peakKey,
    top,
    prevTotal: scan.prevTotal,
    // 与 windowSummary.prevComplete 同口径：prev 窗口起点早于目录数据起点 → 环比不可比
    prevComplete: prevRange.start >= (scan.firstDirDay ?? "9999-12-31"),
  };
}

/** 目录面单遍扫描：最早日 + 当前窗口合计 + 上一窗口合计（窗口区间互斥）。 */
function scanDirWindow(
  rows: TrendDirRow[],
  dir: string | undefined,
  curRange: { start: string; end: string },
  prevRange: { start: string; end: string },
  metric: TrendMetric,
): {
  firstDirDay: string | null;
  total: number | null;
  calls: number;
  turns: number;
  toolCalls: number;
  prevTotal: number | null;
} {
  let firstDirDay: string | null = null;
  let total: number | null = null;
  let calls = 0;
  let turns = 0;
  let toolCalls = 0;
  let prevTotal: number | null = null;
  for (const row of rows) {
    if (firstDirDay === null || row.day < firstDirDay) firstDirDay = row.day;
    if (dir !== undefined && row.dir !== dir) continue;
    if (inDayRange(row.day, curRange)) {
      total = sumToken(total, metricValue(row, metric));
      calls += row.calls;
      turns += row.turns;
      toolCalls += row.toolCalls;
    }
    if (inDayRange(row.day, prevRange)) {
      prevTotal = sumToken(prevTotal, metricValue(row, metric));
    }
  }
  return { firstDirDay, total, calls, turns, toolCalls, prevTotal };
}

/**
 * 目录窗口总量表（目录范围口径影响 + 目录分布数据源）：
 * 给定日区间内按目录聚合 calls 与 metric 总量（calls 降序）。
 */
export function buildDirTotals(
  rows: TrendDirRow[],
  startDay: string,
  endDay: string,
  metric: TrendMetric = "total",
): Array<{ dir: string; calls: number; total: number | null }> {
  const byDir = new Map<string, { dir: string; calls: number; total: number | null }>();
  for (const row of rows) {
    if (row.day < startDay || row.day > endDay) continue;
    let cur = byDir.get(row.dir);
    if (cur === undefined) {
      cur = { dir: row.dir, calls: 0, total: null };
      byDir.set(row.dir, cur);
    }
    cur.calls += row.calls;
    cur.total = sumToken(cur.total, metricValue(row, metric));
  }
  return [...byDir.values()].sort((a, b) => b.calls - a.calls);
}

/**
 * 全量目录日桶快照（day 升序；报告快照与统计目录分布数据源）。
 *
 * 权威口径：dirDays 单源快照——apply 平行累加 + rebuild 双分支读回
 * 已覆盖全部 dir 事实，不再折算 pending 行（旧折算侧与 dirDays 并存时双算：
 * 同事实重建 → 2×；互补事实 → 按键去重丢数；实测同日重启续 apply input 17 → 7）。
 *
 * 残差投影（取代「重建时补造」）：目录面 = dirDays 快照 + 每日残差。
 * 残差(day) = 该日聚合面（cells，全量事实）− 该日 dirDays 合计（有目录归属的事实），
 * 非零则投影为一条 `{day, dir: TREND_UNIDENTIFIED}` 行——语义即「该日无目录信息的
 * 数据」。这样两个查询面的日总量恒等（目录面 = 聚合面），且**不会双算**：
 *
 * - 旧分片（无 kind:"dir" 行的 agg 行）：cells 有值、dirDays 空 → 残差
 *   = 全量 → 历史柱恢复且不丢数（此前 dir 面历史全 null，实测差 20 倍）；
 * - 新分片（agg + dir 并存，同一批事实的两个投影）：cells 含 agg 行、dirDays 含 dir 行
 *   → 残差 ≈ 0（同一事实相减相消）→ 不补造、不双算；故**禁止**在 rebuild 里对
 *   agg 行补造未识别桶（会与 dir 行双算，反例：9-05 的 rjk2 calls=22 会变 44）；
 * - 混版日（升级当天：旧 agg 行 + 新 dir 行并存）：残差 = 旧 agg 部分 → 归未识别，
 *   新 dir 行照常分目录，既不丢升级前的历史、也不把新数据算进未识别；
 * - 当日未压实：apply 对 cells 与 dirDays 平行累加 → 残差 ≈ 0。
 *
 * 不变量：∀day 目录面日合计 == 聚合面日合计（残差为负即数据不一致——目录行多于聚合行，
 * 属双算/漂移征兆，投影按 0 处理并保持数值可解释，不产生负柱）。
 * 残留边界（文档化口径）：残差只有日粒度（dirDays 无 provider 维度），故「无目录信息的
 * 数据」只能整体归未识别桶，无法细分到 provider/model——目录面与 provider 面本互斥
 * （见 routes/ui.ts 的 dir/byDir 分流），无消费方需要该交叉维度。
 */
export function buildDirRows(
  days: Map<string, Map<string, Map<string | null, TrendCell>>>,
  dirDays: Map<string, Map<string, TrendCell>>,
): TrendDirRow[] {
  // 输出容器按 (day, dir) 唯一：dirDays 桶与残差行可能撞同一键（混版日已有
  // (unidentified) 桶时），撞键即合并数值，绝不产出重复键行（公开面契约）。
  // 保持 dirDays 分支的插入序（day 升序、day 内 dir 键插入序）——下游 dirTotals
  // 用稳定排序，行序变化会改变「候选 calls 降序」的并列顺序。
  const out: TrendDirRow[] = [];
  const byKey = new Map<string, TrendDirRow>();
  const put = (row: TrendDirRow): void => {
    const key = `${row.day}\u0000${row.dir}`;
    const cur = byKey.get(key);
    if (cur === undefined) {
      byKey.set(key, row);
      out.push(row);
      return;
    }
    mergeDirCells(cur, row);
  };
  for (const day of [...dirDays.keys()].sort()) {
    for (const [dir, cell] of dirDays.get(day)!) {
      put({ v: TREND_ROW_VERSION, kind: "dir", day, dir, ...cellValues(cell) });
    }
  }
  // 每日残差：聚合面（cells）− 目录面（dirDays）。cells 的键是 day → provider →
  // model，逐层求和得该日全量；dirDays 的键是 day → dir，同法求该日目录合计。
  const aggByDay = sumCellsByDay(days);
  // 残差按 day 升序处理（cells 的 Map 键序是插入序，时钟回拨会让旧日新桶排在末尾；
  // 公开方法契约声明 day 升序，故此处显式排序，不依赖插入序）。
  for (const day of [...aggByDay.keys()].sort()) {
    const residual = residualRowOf(day, aggByDay.get(day)!, dirDays.get(day));
    // 无残差不补造行；同键（该日已有 (unidentified) 桶，混版日常态）由 put 合并到
    // 既有行，保证 (day, dir) 键唯一。
    if (residual !== null) put(residual);
  }
  // 顺序契约：dirDays 分支按 day 升序、day 内按 dir 键插入序输出；残差行按 day
  // 升序追加在尾段（已显式排序，不依赖 cells 插入序）。**不做全局 sort(day, dir)**：
  // 它会把残差行的未识别键排到该日首位（"(" 字典序最前），改变 dirTotals 的插入序；
  // dirTotals 用稳定排序（同 calls 保持插入序），下游「候选 calls 降序」并列顺序
  // 因此会被打破。
  return out;
}

/**
 * 全量小时日桶快照（day 升序、hour 升序；报告快照 byHour/byPeriod/peakHour/
 * coveredDays 数据源）。
 * 权威口径（对齐 dirRows 单源约定）：hourDays 单源快照——apply 平行累加 + rebuild
 * 双分支读回已覆盖全部 hour 事实，不折算 pending（防双算）；**不做残差投影**
 * （detail/counter 必有 time、无缺键事实；旧分片缺 hour 行是物理缺失，报告侧
 * coveredDays 守卫负责降级，不投影补造伪事实）。
 */
export function buildHourRows(hourDays: Map<string, Map<number, TrendCell>>): TrendHourRow[] {
  const out: TrendHourRow[] = [];
  for (const day of [...hourDays.keys()].sort()) {
    const byHour = hourDays.get(day)!;
    for (const hour of [...byHour.keys()].sort((a, b) => a - b)) {
      const cell = byHour.get(hour)!;
      out.push({
        v: TREND_ROW_VERSION,
        kind: "hour",
        day,
        hour,
        input: cell.input,
        output: cell.output,
        cacheRead: cell.cacheRead,
        cacheWrite: cell.cacheWrite,
        calls: cell.calls,
        turns: cell.turns,
        toolCalls: cell.toolCalls,
      });
    }
  }
  return out;
}
