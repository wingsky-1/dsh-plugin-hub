/**
 * dsh-provider-usage/report — 报告目录候选查询工厂（阶段二 D8：apply 闭包收敛）。
 *
 * 装配层零隐藏可变状态：目录候选清单（#633 分片 b2 B4）从 apply 内联闭包
 * 提取为注入式查询面，路由经 ReportRoutesContext.listDirs 消费。
 * 出口净化（sanitizeDirName）与未识别桶归位（TREND_UNIDENTIFIED）在此单一收敛。
 */
import type { TrendTracker } from "../aggregate/interface.ts";
import { sanitizeDirName, TREND_UNIDENTIFIED } from "../collect/interface.ts";

export function makeListDirs(trend: TrendTracker): () => Array<{ dir: string; calls: number; total: number | null }> {
  return () =>
    trend.dirTotals("0000-01-01", "9999-12-31").map((r) => ({
      ...r,
      dir: sanitizeDirName(r.dir) ?? TREND_UNIDENTIFIED,
    }));
}