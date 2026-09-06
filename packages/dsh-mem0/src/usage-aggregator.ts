/**
 * dsh-mem0 — DSH 提供商用量聚合（供 LLM 下拉的「用量徽标」展示）。
 *
 * 数据源：dsh-provider-usage 的 trend/agg 日分片（~/.dsh/dsh-provider-usage/trend/agg/YYYY-MM-DD.jsonl），
 * 每行 {v:1, kind:"agg", day, provider, model, input, output, cacheRead, cacheWrite, calls, ...}。
 *
 * #612 设计纪律：
 * 1. 防御式读取——目录缺失/坏行/版本不符一律跳过，绝不阻塞 provider 下拉；
 * 2. 静默降级——任何失败都返回空 Map（前端不显示徽标），而非报错；
 * 3. 低耦合——provider-usage 对本模块零感知；文件布局变化时静默失效。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dshHome } from "../../../shared/dsh-home.js";

export interface ProviderUsageStat {
  /** 近 N 天累计调用次数。 */
  calls: number;
  /** 近 N 天累计输出 token 数。 */
  outputTokens: number;
  /** 有用量记录的最近一天（YYYY-MM-DD），无则空串。 */
  lastDay: string;
}

const USAGE_AGG_DIR = join(dshHome(), "dsh-provider-usage", "trend", "agg");
/** 聚合窗口：近 7 天。 */
const USAGE_WINDOW_DAYS = 7;
/** 最多读取的分片文件数（防御异常膨胀目录）。 */
const MAX_SHARDS = 10;

/**
 * 汇总近 7 天各 provider 的用量（provider 维度，跨 model 求和）。
 * 返回 Map<providerId, ProviderUsageStat>；数据缺失/损坏时返回空 Map。
 */
export function aggregateProviderUsage(now = new Date()): Map<string, ProviderUsageStat> {
  const result = new Map<string, ProviderUsageStat>();
  try {
    if (!existsSync(USAGE_AGG_DIR)) return result;

    // 取修改时间最近的若干分片（trend 按天落盘，天然按日期命名）
    const files = readdirSync(USAGE_AGG_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .slice(-MAX_SHARDS);
    if (files.length === 0) return result;

    // 窗口起点（含当天，共 7 天）
    const windowStart = new Date(now.getTime() - (USAGE_WINDOW_DAYS - 1) * 86_400_000);
    const windowStartDay = toDayString(windowStart);

    for (const file of files) {
      const day = file.replace(/\.jsonl$/, "");
      if (day < windowStartDay) continue;
      const text = readFileSync(join(USAGE_AGG_DIR, file), "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let row: unknown;
        try {
          row = JSON.parse(trimmed);
        } catch {
          continue; // 坏行跳过
        }
        if (!row || typeof row !== "object") continue;
        const rec = row as Record<string, unknown>;
        if (rec.v !== 1 || rec.kind !== "agg") continue; // 版本不符/非聚合行跳过
        const provider = typeof rec.provider === "string" ? rec.provider : "";
        if (!provider) continue;
        const calls = typeof rec.calls === "number" && Number.isFinite(rec.calls) ? rec.calls : 0;
        const output = typeof rec.output === "number" && Number.isFinite(rec.output) ? rec.output : 0;
        const prev = result.get(provider) ?? { calls: 0, outputTokens: 0, lastDay: "" };
        prev.calls += calls;
        prev.outputTokens += output;
        if (day > prev.lastDay) prev.lastDay = day;
        result.set(provider, prev);
      }
    }
  } catch {
    // 任何异常一律静默降级为空结果（徽标不显示，主流程不受影响）
    return new Map();
  }
  return result;
}

function toDayString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
