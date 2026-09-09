/**
 * dsh-provider-usage/trend — 查询投影纯函数（D2 aggregator 拆分的纯函数层之二，#670 阶段三）。
 *
 * 为什么独立成模块：趋势查询面（序列/堆叠/窗口摘要/目录投影）的计算与
 * TrendAggregator 的状态容器解耦——本模块全部函数以 days/dirDays/rows 显式传参，
 * 不接触 this（防「拆文件 = 共享 this」坏味道，layer-architecture.md §4 D-2）；
 * 主类保留状态容器与需要 this 的 IO/记账方法，查询方法变成薄壳委托。
 * 依赖方向无环：aggregate-query → types / charts / aggregate-rows；aggregator → 三者。
 *
 * 守恒边界（R8 不变量4，unit-trend-ledger.test.ts 对账口径）：dirRows() 输出 = 目录桶
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
} from "../collect/interface.ts";

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
function rangeCellsOf(days: Map<string, Map<string, Map<string | null, TrendCell>>>, range: { start: string; end: string }, provider?: string): Array<{ provider: string; model: string | null; cell: TrendCell }> {
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
export function dayValueOf(days: Map<string, Map<string, Map<string | null, TrendCell>>>, day: string, metric: TrendMetric, provider?: string): number | null {
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
export function rangeValueOf(days: Map<string, Map<string, Map<string | null, TrendCell>>>, range: { start: string; end: string }, metric: TrendMetric, provider?: string): number | null {
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
  // 桶日区间一次算全（评审 P1-2：原实现对每桶在 days 日循环内重复调 granRange）
  const ranges = new Map(keys.map((k) => [k, granRangeForKey(k, gran)] as const));
  const series: TrendStackPoint[] = keys.map((key) => {
    const partsMap = new Map<string, TrendStackPart>();
    const range = ranges.get(key)!;
    for (const [day, models] of days) {
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
 * 堆叠柱序列（目录维度；#633 分片 b B1 数据接口）。语义与 seriesStacked 同构：
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
  // 复核 P1-3：行快照提出桶循环（原实现每桶 this.dirRows() 全量快照，O(桶×行)
  // 单请求重复；对齐 seriesStacked 的 P1-2 先例——range 一次算全 + 快照单次
  // 取用，桶循环内只做窗口过滤消费）。
  const series: TrendStackPoint[] = keys.map((key) => {
    const partsMap = new Map<string, TrendStackPart>();
    const range = ranges.get(key)!;
    for (const row of rows) {
      if (row.day < range.start || row.day > range.end) continue;
      if (dir !== undefined && row.dir !== dir) continue;
      const v = metricValue(row, metric);
      const cur = partsMap.get(row.dir);
      if (cur !== undefined) cur.value = sumToken(cur.value, v);
      else partsMap.set(row.dir, { provider: row.dir, model: null, value: v });
    }
    const parts = [...partsMap.values()];
    let total: number | null = null;
    for (const pt of parts) total = sumToken(total, pt.value);
    return { key, parts, total };
  });
  const legend = new Set<string>();
  for (const point of series) {
    for (const pt of point.parts) legend.add(pt.provider);
  }
  return { series, dirs: [...legend].sort().map((d) => ({ dir: d })) };
}

/**
 * 窗口摘要（当前 n 桶 + 上一同等窗口环比基准）。
 * @param stackSeries 可选传入路由已算好的堆叠序列（n/gran/metric/provider 必须与本
 *   调用一致）——复用峰值/Top 遍历，消除单请求双算（评审 P1-2）；缺省时内部自算。
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
  const keys = granKeysFor(n, gran, now);
  const curRange = {
    start: granRangeForKey(keys[0], gran).start,
    end: granRangeForKey(keys[keys.length - 1], gran).end,
  };
  // 上一窗口：同长键序列整体前移 n 桶（day/week/month 各自步进语义）
  const prevKeys = granKeysFor(n, gran, prevWindowAnchorFor(now, n, gran));
  const prevRange = {
    start: granRangeForKey(prevKeys[0], gran).start,
    end: granRangeForKey(prevKeys[prevKeys.length - 1], gran).end,
  };
  let total: number | null = null;
  let calls = 0;
  let turns = 0;
  let toolCalls = 0;
  let prevTotal: number | null = null;
  let peakKey: string | null = null;
  let peakVal = -1;
  let top: { provider: string; model: string | null; value: number } | null = null;
  // 复用路由已算的 stack 序列（评审 P1-2：消除单请求双算；缺省自算保持独立可用）
  const series = stackSeries ?? buildStackedSeries(days, n, gran, metric, provider, false, now).series;
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
  for (const { cell } of rangeCellsOf(days, curRange, provider)) {
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
    prevTotal: rangeValueOf(days, prevRange, metric, provider),
    // 上一窗口起点早于数据起点（内存最早日，即留存/起算边缘）→ 基准不完整，环比不可比（#503 M2.1）
    prevComplete: prevRange.start >= (firstDayKeyOf(days) ?? "9999-12-31"),
  };
}

/**
 * 窗口摘要（目录维度；#633 分片 b B1 数据接口）。curRange/prevRange 语义与
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
  let total: number | null = null;
  let calls = 0;
  let turns = 0;
  let toolCalls = 0;
  let prevTotal: number | null = null;
  let peakKey: string | null = null;
  let peakVal = -1;
  let top: { provider: string; model: string | null; value: number } | null = null;
  const series = dirSeries ?? buildDirStackedSeries(rows, n, gran, metric, dir, now).series;
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
  let firstDirDay: string | null = null;
  // 复核 P1-3：单遍遍历（原实现 3 次全量遍历 rows——最早日 + 当前窗口 + 上一
  // 窗口各一遍；窗口区间互斥，同遍累加语义不变）。
  for (const row of rows) {
    if (firstDirDay === null || row.day < firstDirDay) firstDirDay = row.day;
    const inDir = dir === undefined || row.dir === dir;
    if (inDir && row.day >= curRange.start && row.day <= curRange.end) {
      total = sumToken(total, metricValue(row, metric));
      calls += row.calls;
      turns += row.turns;
      toolCalls += row.toolCalls;
    }
    if (inDir && row.day >= prevRange.start && row.day <= prevRange.end) {
      prevTotal = sumToken(prevTotal, metricValue(row, metric));
    }
  }
  return {
    total,
    calls,
    turns,
    toolCalls,
    peakKey,
    top,
    prevTotal,
    // 与 windowSummary.prevComplete 同口径：prev 窗口起点早于目录数据起点 → 环比不可比
    prevComplete: prevRange.start >= (firstDirDay ?? "9999-12-31"),
  };
}

/**
 * 目录窗口总量表（#633 分片 b B4 目录范围口径影响 + B1 目录分布数据源）：
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
 * 全量目录日桶快照（day 升序；#633 分片 b 报告快照与统计目录分布数据源）。
 *
 * 权威口径（复核 P1-1）：dirDays 单源快照——apply 平行累加 + rebuild 双分支读回
 * 已覆盖全部 dir 事实，不再折算 pending 行（旧折算侧与 dirDays 并存时双算：
 * 同事实重建 → 2×；互补事实 → 按键去重丢数；实测同日重启续 apply input 17 → 7）。
 *
 * 残差投影（本次修复，取代「重建时补造」）：目录面 = dirDays 快照 + 每日残差。
 * 残差(day) = 该日聚合面（cells，全量事实）− 该日 dirDays 合计（有目录归属的事实），
 * 非零则投影为一条 `{day, dir: TREND_UNIDENTIFIED}` 行——语义即「该日无目录信息的
 * 数据」。这样两个查询面的日总量恒等（目录面 = 聚合面），且**不会双算**：
 *
 * - 旧分片（#633 之前的 agg 行，无 kind:"dir" 行）：cells 有值、dirDays 空 → 残差
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
    cur.input = sumToken(cur.input, row.input);
    cur.output = sumToken(cur.output, row.output);
    cur.cacheRead = sumToken(cur.cacheRead, row.cacheRead);
    cur.cacheWrite = sumToken(cur.cacheWrite, row.cacheWrite);
    cur.calls += row.calls;
    cur.turns += row.turns;
    cur.toolCalls += row.toolCalls;
  };
  for (const day of [...dirDays.keys()].sort()) {
    for (const [dir, cell] of dirDays.get(day)!) {
      put({ v: TREND_ROW_VERSION, kind: "dir", day, dir, input: cell.input, output: cell.output, cacheRead: cell.cacheRead, cacheWrite: cell.cacheWrite, calls: cell.calls, turns: cell.turns, toolCalls: cell.toolCalls });
    }
  }
  // 每日残差：聚合面（cells）− 目录面（dirDays）。cells 的键是 day → provider →
  // model，逐层求和得该日全量；dirDays 的键是 day → dir，同法求该日目录合计。
  const aggByDay = new Map<string, TrendCell>();
  for (const [day, providers] of days) {
    let cell = aggByDay.get(day);
    if (cell === undefined) {
      cell = emptyCell();
      aggByDay.set(day, cell);
    }
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
  // 残差按 day 升序处理（cells 的 Map 键序是插入序，时钟回拨会让旧日新桶排在末尾；
  // 公开方法契约声明 day 升序，故此处显式排序，不依赖插入序）。
  for (const day of [...aggByDay.keys()].sort()) {
    const cell = aggByDay.get(day)!;
    let dirInput: number | null = null;
    let dirOutput: number | null = null;
    let dirCacheRead: number | null = null;
    let dirCacheWrite: number | null = null;
    let dirCalls = 0;
    let dirTurns = 0;
    let dirToolCalls = 0;
    const dirs = dirDays.get(day);
    if (dirs !== undefined) {
      for (const c of dirs.values()) {
        dirInput = sumToken(dirInput, c.input);
        dirOutput = sumToken(dirOutput, c.output);
        dirCacheRead = sumToken(dirCacheRead, c.cacheRead);
        dirCacheWrite = sumToken(dirCacheWrite, c.cacheWrite);
        dirCalls += c.calls;
        dirTurns += c.turns;
        dirToolCalls += c.toolCalls;
      }
    }
    // 残差 = 聚合面 − 目录面（null-aware：双方皆 null → 0/无残差；单侧 null 按 0 计）
    const input = diffToken(cell.input, dirInput);
    const output = diffToken(cell.output, dirOutput);
    const cacheRead = diffToken(cell.cacheRead, dirCacheRead);
    const cacheWrite = diffToken(cell.cacheWrite, dirCacheWrite);
    const calls = cell.calls - dirCalls;
    const turns = cell.turns - dirTurns;
    const toolCalls = cell.toolCalls - dirToolCalls;
    // 全部为 0/空 = 该日目录面已覆盖全量（新分片常态）→ 不补造行。
    // 负残差（目录面多于聚合面）同样走此分支（不产行）：属数据不一致征兆
    // （例如明细目录误落 dir 行——已由 readDetailShard 白名单阻断），此时目录面
    // 日合计会大于聚合面，README「总量守恒」节已注明该边界不保证恒等。
    const hasResidual =
      calls > 0 || turns > 0 || toolCalls > 0 || (input ?? 0) > 0 || (output ?? 0) > 0 || (cacheRead ?? 0) > 0 || (cacheWrite ?? 0) > 0;
    if (!hasResidual) continue;
    // 同键（该日已有 (unidentified) 桶，混版日常态）由 put 合并到既有行，
    // 保证 (day, dir) 键唯一；负值按 0 处理（不产生负柱）。
    put({
      v: TREND_ROW_VERSION,
      kind: "dir",
      day,
      dir: TREND_UNIDENTIFIED,
      input: input !== null && input > 0 ? input : null,
      output: output !== null && output > 0 ? output : null,
      cacheRead: cacheRead !== null && cacheRead > 0 ? cacheRead : null,
      cacheWrite: cacheWrite !== null && cacheWrite > 0 ? cacheWrite : null,
      calls: calls > 0 ? calls : 0,
      turns: turns > 0 ? turns : 0,
      toolCalls: toolCalls > 0 ? toolCalls : 0,
    });
  }
  // 顺序契约：dirDays 分支按 day 升序、day 内按 dir 键插入序输出；残差行按 day
  // 升序追加在尾段（已显式排序，不依赖 cells 插入序）。**不做全局 sort(day, dir)**：
  // 它会把残差行的未识别键排到该日首位（"(" 字典序最前），改变 dirTotals 的插入序；
  // dirTotals 用稳定排序（同 calls 保持插入序），下游「候选 calls 降序」并列顺序
  // 因此会被打破。
  return out;
}

/**
 * 全量小时日桶快照（day 升序、hour 升序；#662 报告快照 byHour/byPeriod/peakHour/
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