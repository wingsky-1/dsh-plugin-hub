/**
 * dsh-provider-usage/report — report index.jsonl 格式解析（阶段二 D8：自 runner 移出）。
 *
 * E3（lastRun 推导）与 E4（读侧投影）共同依赖的**纯解析**原语；本文件无状态无缓存
 * （indexCache 记忆化留在 runner 读侧，防双份缓存漂移——阶段四目录化后归
 * domain2/common/，是该目录「无状态无缓存」边界的组成部分）。
 */
import type { ReportMeta } from "../execute/interface.ts";

/**
 * 解析 index.jsonl 全文为记录数组（坏行跳过、字段白名单过滤）。
 * 公共解析：readReportIndex（读侧投影）与 lastRun 推导（#624）共用，
 * 防止两处解析漂移。
 */
export function parseReportIndexLines(raw: string): ReportMeta[] {
  const out: ReportMeta[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (s.length === 0) continue;
    try {
      const obj = JSON.parse(s) as ReportMeta | null;
      if (
        obj !== null && typeof obj === "object" &&
        typeof obj.key === "string" &&
        (obj.period === "daily" || obj.period === "weekly" || obj.period === "monthly")
      ) {
        out.push(obj);
      }
    } catch {
      // 坏行跳过
    }
  }
  return out;
}