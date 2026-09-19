/**
 * dsh-provider-usage — server/config 域：报告配置持久化（#768 D1）。
 *
 * 本文件只回答「配置存哪、怎么写才不断」：historyRoot/reports/config.json
 *（0600，tmp+rename 原子写，ui-config.ts 同款模式）。
 * 读侧缺失/损坏回退默认归一化，写侧一律经 normalize.ts 单答案落盘——
 * 迁移域最终落盘走 upgrade/storage-layout.ts 的同字面量路径（迁移只动旧形态，
 * 不另开归一化）；两条路对「什么算合法数据」的答案同源（本文件 normalize）。
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { normalizeReportConfig } from "./normalize.ts";
import { DEFAULT_REPORT_CONFIG } from "./shape.ts";
import type { ReportConfig } from "./shape.ts";

/** 报告配置持久化文件（historyRoot 下，0600）。 */
export function reportConfigFile(root: string): string {
  return `${root}/reports/config.json`;
}

/** 读取报告配置（文件缺失/损坏回退默认；读后一律经 normalizeReportConfig 归一化）。 */
export async function readReportConfig(root: string): Promise<ReportConfig> {
  try {
    const text = await readFile(reportConfigFile(root), "utf8");
    return normalizeReportConfig(JSON.parse(text));
  } catch {
    return { ...DEFAULT_REPORT_CONFIG };
  }
}

/** 原子写报告配置（tmp + rename，0600；reports/ 目录缺失时先建）。 */
export async function writeReportConfig(root: string, cfg: ReportConfig): Promise<void> {
  const file = reportConfigFile(root);
  await mkdir(`${root}/reports`, { recursive: true });
  const tmp = `${file}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(normalizeReportConfig(cfg)), { mode: 0o600 });
  await rename(tmp, file);
}
