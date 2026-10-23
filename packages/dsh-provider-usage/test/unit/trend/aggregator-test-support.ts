import type { TrendAggregator } from "../../../src/server/aggregate/interface.ts";
import type {
  TrendCallRecord,
  TrendCell,
  TrendCounterRecord,
  TrendEmit,
} from "../../../src/server/collect/interface.ts";

export const HOUR = 3600_000;

/** 旧格式 call 定稿（无 dir 键）：聚合器遇缺键跳过目录累加（与显式未识别桶不等价——
 * 补 dir 会改变 dirDays，故保持缺键原样，仅做类型面收敛）。 */
export const callOf = (record: Omit<TrendCallRecord, "dir"> & { dir?: string }): TrendEmit => ({
  type: "call",
  record: record as TrendCallRecord,
});

/** 旧格式 counter 定稿（无 dir 键 + 宽松计数；同上缺键语义）。 */
export const counterOf = (
  record: Omit<TrendCounterRecord, "dir" | "turns" | "toolCalls"> & {
    dir?: string;
    turns?: number;
    toolCalls?: number;
  },
): TrendEmit => ({ type: "counter", record: record as TrendCounterRecord });

// prettier-ignore
export function cellTotals(
  agg: TrendAggregator,
  day: string,
  provider = "deepseek"
): TrendCell | null {
  const b = agg.buckets().find((d) => d.day === day);
  if (!b) return null;
  const p = b.providers.find((x) => x.provider === provider);
  return p ? p.cell : null;
}
