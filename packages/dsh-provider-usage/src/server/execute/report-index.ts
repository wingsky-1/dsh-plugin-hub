/**
 * dsh-provider-usage — server/execute 域：report index.jsonl 格式解析
 * （#768 D3，由 domain2/common/report-index.ts 搬入，零行为变更）。
 *
 * lastRun 推导（server/schedule/store.ts 经 ScheduleDeps 端口注入复用，C 波单向化）与读侧投影
 * （同域 runner.ts readReportIndex）共同依赖的**纯解析**原语；本文件
 * 无状态无缓存（indexCache 记忆化留在 runner 读侧，防双份缓存漂移）。
 * ReportMeta 类型直引同域 generate.ts 物理定义（type-only，不经本域
 * interface.ts 中转，防 impl → interface → impl 类型环）。
 */
import type { ReportMeta } from "./generate.ts";

/**
 * 解析 index.jsonl 全文为记录数组（坏行跳过、字段白名单过滤）。
 * 公共解析：readReportIndex（读侧投影）与 lastRun 推导共用，
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
        obj !== null &&
        typeof obj === "object" &&
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
