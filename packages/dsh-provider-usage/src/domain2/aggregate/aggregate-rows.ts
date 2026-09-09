/**
 * dsh-provider-usage/trend — 压实转换纯函数（D2 aggregator 拆分的纯函数层之一，#670 阶段三）。
 *
 * 为什么独立成模块：TrendAggregator（src/trend/aggregator.ts）原 1300+ 行混合「状态容器 +
 * IO 方法」与纯函数转换；拆分后本模块只含行形态转换——明细/计数行并入聚合/目录/小时行、
 * 汇总行合并（merge*）、null-aware token 差（sub/diffToken）与空行构造。全部参数显式传入、
 * 不接触 this：防「拆文件 = 共享 this」坏味道（layer-architecture.md §4 D-2 前置约定，
 * 需状态者一律留在主类）。本模块无 import 环（只依赖 types.ts）。
 *
 * null 语义（与聚合面一致）：token 求和 null-aware（sumToken）——缺失维度不参与求和；
 * 0 是有效数字参与求和（校正把数字改 null 时 cell 残留 0 属既有增量语义，见 sub 注释）。
 */
import {
  sumToken,
  TREND_ROW_VERSION,
  type TrendAggRow,
  type TrendCell,
  type TrendDetailRow,
  type TrendDirRow,
  type TrendHourRow,
} from "../collect/types.ts";

/** token 差（cell 回退用）：有值→null 时增量为 -old（cell 同步扣减，保证内存聚合
 *  与校正后的落盘明细一致）；双方皆 null 增量 0（null-aware 无变化）。 */
export function sub(oldV: number | null, newV: number | null): number | null {
  if (newV === null) return oldV === null ? null : -oldV;
  if (oldV === null) return newV;
  return newV - oldV;
}

/**
 * 残差投影的 token 差（#633 修复）：聚合面 − 目录面，null-aware。
 * 双方皆 null → null（无该维度事实）；单侧 null 按 0 参与（另一侧有值即有残差）；
 * 负值保留给调用方判定（调用方按 0 处理并依赖「日总量恒等」断言暴露不一致）。
 */
export function diffToken(aggV: number | null, dirV: number | null): number | null {
  if (aggV === null && dirV === null) return null;
  return (aggV ?? 0) - (dirV ?? 0);
}

/** 单元格空壳（桶缺位时补建）。 */
export function emptyCell(): TrendCell {
  return { input: null, output: null, cacheRead: null, cacheWrite: null, calls: 0, turns: 0, toolCalls: 0 };
}

/** 空聚合行（压实折算起点；字段与 mergeCell 消费的 agg 行同构）。 */
export function emptyAggRow(day: string, provider: string, model: string | null): TrendAggRow {
  return {
    v: TREND_ROW_VERSION,
    kind: "agg",
    day,
    provider,
    model,
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    calls: 0,
    turns: 0,
    toolCalls: 0,
  };
}

/** 空目录汇总行（#633 A4；与 agg 行十数值字段同构，仅键换成 dir）。 */
export function emptyDirRow(day: string, dir: string): TrendDirRow {
  return {
    v: TREND_ROW_VERSION,
    kind: "dir",
    day,
    dir,
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    calls: 0,
    turns: 0,
    toolCalls: 0,
  };
}

/** 空小时汇总行（#662；与 agg/dir 行同构，键换成 hour；「落盘即定型」的产出起点）。 */
export function emptyHourRow(day: string, hour: number): TrendHourRow {
  return {
    v: TREND_ROW_VERSION,
    kind: "hour",
    day,
    hour,
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    calls: 0,
    turns: 0,
    toolCalls: 0,
  };
}

/** 明细行并入聚合/目录/小时汇总行（三者字段同构，同函数复用；null-aware 求和）。 */
export function addDetailTo(agg: TrendAggRow | TrendDirRow | TrendHourRow, row: TrendDetailRow): void {
  agg.calls += 1;
  agg.input = sumToken(agg.input, row.input);
  agg.output = sumToken(agg.output, row.output);
  agg.cacheRead = sumToken(agg.cacheRead, row.cacheRead);
  agg.cacheWrite = sumToken(agg.cacheWrite, row.cacheWrite);
}

/** 计数行并入聚合/目录/小时汇总行（同上，同函数复用）。 */
export function addCounterTo(agg: TrendAggRow | TrendDirRow | TrendHourRow, turns: number, toolCalls: number): void {
  agg.turns += turns;
  agg.toolCalls += toolCalls;
}

/** 聚合行并入 cell（重建用；null-aware。agg/dir/hour 汇总行十数值字段同构，同函数复用）。 */
export function mergeCell(cell: TrendCell, row: TrendAggRow | TrendDirRow | TrendHourRow): void {
  cell.calls += row.calls;
  cell.turns += row.turns;
  cell.toolCalls += row.toolCalls;
  cell.input = sumToken(cell.input, row.input);
  cell.output = sumToken(cell.output, row.output);
  cell.cacheRead = sumToken(cell.cacheRead, row.cacheRead);
  cell.cacheWrite = sumToken(cell.cacheWrite, row.cacheWrite);
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

/**
 * dir 汇总行合并（#633 A4 flush 压实写盘前与既有聚合分片内的 dir 行合并——
 * 迟到旧日行场景防覆盖丢数；十数值字段与 mergeAggRows 完全同构，null-aware
 * 求和，同 dir 键累加。输出保持输入相对顺序：base 在前（dir 行位于分片尾段））。
 */
export function mergeDirRows(base: TrendDirRow[], add: TrendDirRow[]): TrendDirRow[] {
  const byKey = new Map<string, TrendDirRow>();
  for (const r of [...base, ...add]) {
    const cur = byKey.get(r.dir);
    if (cur === undefined) {
      byKey.set(r.dir, { ...r });
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

/**
 * hour 汇总行合并（#662，flush 压实写盘前与既有聚合分片内的 hour 行合并——
 * 迟到旧日行二次压实防丢防重；与 mergeDirRows 完全同构，同 hour 键累加，
 * 输出保持输入相对顺序：base 在前（hour 行位于分片尾段））。
 */
export function mergeHourRows(base: TrendHourRow[], add: TrendHourRow[]): TrendHourRow[] {
  const byKey = new Map<number, TrendHourRow>();
  for (const r of [...base, ...add]) {
    const cur = byKey.get(r.hour);
    if (cur === undefined) {
      byKey.set(r.hour, { ...r });
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