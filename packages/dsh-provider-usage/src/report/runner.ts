/**
 * dsh-provider-usage/report — 报告生成执行器与索引读取辅助。
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { errorMessage } from "../../../../shared/host-utils.js";
import { dayKey, escHtml } from "../charts.ts";
import { metricValue } from "../trend/aggregator.ts";
import type { TrendTracker } from "../trend/index.ts";
import { sumToken, type TrendCell } from "../trend/types.ts";
import { promptFor, type ReportConfig, type ReportPeriod } from "./config.ts";
import { reportBodyToHtml } from "./format.ts";
import {
  buildStatsSnapshot,
  generateReport,
  type ReportMeta,
  type ReportMetaSummary,
  type ReportStatsSnapshot,
} from "./generate.ts";
import type { DueReport } from "./schedule.ts";

export function reportsDir(root: string): string {
  return join(root, "reports");
}

export function reportIndexFile(root: string): string {
  return join(root, "reports", "index.jsonl");
}

// #629 P1 解析记忆化缓存（readReportIndex 专用；键=historyRoot，值=stat 失效键+投影）。
interface IndexCacheEntry {
  stamp: string;
  value: ReportMeta[];
}
const indexCache = new Map<string, IndexCacheEntry>();
// 命中/未命中计数（测试可观测：确定性证明「重复读不再重解析」，不依赖时钟度量）
let indexCacheHits = 0;
let indexCacheMisses = 0;

/** 测试隔离钩子：清空解析缓存与计数（防同进程多测试块跨 root 残留；生产路径无需调用）。 */
export function __clearReportIndexCacheForTests(): void {
  indexCache.clear();
  indexCacheHits = 0;
  indexCacheMisses = 0;
}

/** 测试观测钩子：缓存命中/未命中计数（#629 P1 验收「可测」：连续读 hits 只增 1 次 miss）。 */
export function __reportIndexCacheStatsForTests(): { hits: number; misses: number } {
  return { hits: indexCacheHits, misses: indexCacheMisses };
}

export function reportHtmlFile(root: string, period: ReportPeriod, key: string): string {
  return join(root, "reports", `${period}-${key}.html`);
}

export function reportMetaFile(root: string, period: ReportPeriod, key: string): string {
  return join(root, "reports", `${period}-${key}.meta.json`);
}

function shiftDayKey(key: string, n: number): string {
  const [y, mo, d] = key.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  dt.setDate(dt.getDate() + n);
  return dayKey(dt.getTime());
}

function windowDayCount(startDay: string, endDay: string): number {
  return Math.round((Date.parse(endDay) - Date.parse(startDay)) / 86400000) + 1;
}

/** 环比基准：同长度窗口整体前移（[startDay-len, startDay-1]）的 total 求和（null-aware）。 */
export function prevWindowTotal(
  buckets: Array<{ day: string; providers: Array<{ provider: string; model: string | null; cell: TrendCell }> }>,
  startDay: string,
  endDay: string,
): number | null {
  const len = windowDayCount(startDay, endDay);
  const prevStart = shiftDayKey(startDay, -len);
  const prevEnd = shiftDayKey(startDay, -1);
  let acc: number | null = null;
  for (const { day, providers } of buckets) {
    if (day < prevStart || day > prevEnd) continue;
    for (const { cell } of providers) acc = sumToken(acc, metricValue(cell, "total"));
  }
  return acc;
}

export function summaryOf(snapshot: ReportStatsSnapshot): ReportMetaSummary {
  return {
    total: snapshot.totals.total,
    calls: snapshot.totals.calls,
    activeDays: snapshot.activeDays,
    windowDays: snapshot.windowDays,
    longestStreak: snapshot.longestStreak,
    wowRatio: snapshot.wowRatio,
    peakDay: snapshot.peakDay,
  };
}

export function optionalNotifier(ctx: Context): {
  send: (req: { source: string; kind: string; severity: string; title: string; body: string }) => Promise<unknown>;
  registerKind?: (reg: { id: string; label: string }) => unknown;
} | null {
  try {
    const n = (ctx as { get?: (name: string, strict?: boolean) => unknown }).get?.("wingsky.notifier", false);
    if (n !== null && typeof n === "object" && typeof (n as { send?: unknown }).send === "function") {
      return n as {
        send: (req: { source: string; kind: string; severity: string; title: string; body: string }) => Promise<unknown>;
        registerKind?: (reg: { id: string; label: string }) => unknown;
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function notifyReport(
  ctx: Context,
  reportCfg: ReportConfig,
  meta: ReportMeta,
  snapshot: ReportStatsSnapshot,
  sanitizeDiagnostic: (s: string) => string,
): void {
  if (!reportCfg.push.enabled) return;
  const notifier = optionalNotifier(ctx);
  if (notifier === null) return;
  const total = snapshot.totals.total;
  const body = `${meta.period} ${meta.key}（${meta.startDay} ~ ${meta.endDay}）：token 总量 ${
    total === null ? "无数据" : total.toLocaleString("en-US")
  }，调用 ${snapshot.totals.calls} 次。详情见 dsh 设置页用量报告。`;
  notifier
    .send({ source: "@wingsky-1/dsh-provider-usage", kind: "provider-usage:report", severity: "info", title: "用量报告", body })
    .catch((e: unknown) => console.warn(`[dsh-provider-usage] report: 推送失败（不影响主流程）：${sanitizeDiagnostic(errorMessage(e))}`));
}

function reportHtmlDocument(meta: ReportMeta, bodyText: string): string {
  const title = `${meta.period} ${meta.key} 用量报告`;
  return [
    "<!doctype html>",
    `<html lang="zh-CN"><head><meta charset="utf-8"><title>${escHtml(title)}</title></head>`,
    `<body><article class="dou-report-body">${reportBodyToHtml(bodyText)}</article></body></html>`,
  ].join("");
}

export async function persistReport(historyRoot: string, meta: ReportMeta, bodyText: string): Promise<void> {
  const dir = reportsDir(historyRoot);
  const htmlFile = reportHtmlFile(historyRoot, meta.period, meta.key);
  const metaFile = reportMetaFile(historyRoot, meta.period, meta.key);
  const indexFile = reportIndexFile(historyRoot);

  await mkdir(dir, { recursive: true });
  const tmpHtml = `${htmlFile}.${Date.now()}.tmp`;
  await writeFile(tmpHtml, reportHtmlDocument(meta, bodyText), { mode: 0o600 });
  await rename(tmpHtml, htmlFile);

  const tmpMeta = `${metaFile}.${Date.now()}.tmp`;
  await writeFile(tmpMeta, JSON.stringify(meta, null, 2), { mode: 0o600 });
  await rename(tmpMeta, metaFile);

  await appendFile(indexFile, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
}

export async function runDueReport(params: {
  due: DueReport;
  trend: TrendTracker;
  ctx: Context;
  reportCfg: ReportConfig;
  historyRoot: string;
  sanitizeDiagnostic: (s: string) => string;
}): Promise<ReportMeta> {
  const { due, trend, ctx, reportCfg, historyRoot, sanitizeDiagnostic } = params;
  const buckets = trend.buckets();
  // #633 分片 b C1 接线：目录维度日汇总行进快照（trend.dirRows 含今日桶，口径见
  // aggregator.dirRows）。残差投影后（本次修复）旧数据（无 dir 行的分片）不再得到
  // 空数组——其「无目录信息」的用量经残差归入 (unidentified) 桶，故 byDirectory 与
  // totals 同口径（实测旧分片：byDirectory=[{unidentified,31,7481}] = totals）。
  // 真正无任何用量时 dirRows 才为空数组（报告链路另有 totals.calls===0 的空窗口短路）。
  // #633 分片 b B4：报告配置目录范围非空时，byDirectory 只含所选目录（目录维度
  // 投影可精确过滤）；totals/byDay/byProvider 保持全量口径——压实后的 agg 行无
  // dir 键（明细行的 dir×provider 关联在日切压实即收敛为两个独立投影），provider/
  // day 维度按目录精确归属在本数据面上不可行（分片 a 既定数据边界，非实现缺口）。
  // 占比口径自洽：模板目录占比 = byDirectory[i].total ÷ totals.total，报告呈
  // 「全量统计 + 所选目录分布」口径；缺省「全部」（空数组）零过滤。
  const scopeDirs = reportCfg.directories ?? [];
  const dirRows = trend.dirRows();
  const scopedDirRows = scopeDirs.length === 0
    ? dirRows
    : dirRows.filter((r) => scopeDirs.includes(r.dir));
  const snapshot = buildStatsSnapshot({
    period: due.period,
    startDay: due.startDay,
    endDay: due.endDay,
    buckets,
    dirRows: scopedDirRows,
    // #662：小时维度日汇总行进快照（trend.hourRows 内存单源快照，含今日桶）。
    // 覆盖度守卫在 buildStatsSnapshot 内完成：coveredDays < windowDays 时
    // byHour/byPeriod/peakHour 整体置 null（升级期部分天缺 hour 事实 → 时段段降级）。
    hourRows: trend.hourRows(),
    prevTotal: prevWindowTotal(buckets, due.startDay, due.endDay),
  });
  if (snapshot.totals.calls === 0) {
    return {
      period: due.period,
      key: due.key,
      startDay: due.startDay,
      endDay: due.endDay,
      provider: reportCfg.provider,
      model: reportCfg.model,
      generatedAt: Date.now(),
      durationMs: 0,
      ok: true,
      noData: true,
    };
  }
  const result = await generateReport({
    llm: ctx.llm,
    period: due.period,
    key: due.key,
    startDay: due.startDay,
    endDay: due.endDay,
    statsJson: JSON.stringify(snapshot, null, 2),
    promptTemplate: promptFor(reportCfg, due.period),
    provider: reportCfg.provider,
    model: reportCfg.model,
  });
  if (!result.meta.ok) throw new Error(result.meta.error ?? "报告生成失败");
  const meta: ReportMeta = { ...result.meta, summary: summaryOf(snapshot) };
  await persistReport(historyRoot, meta, result.body);
  notifyReport(ctx, reportCfg, meta, snapshot, sanitizeDiagnostic);
  return meta;
}

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

/**
 * 读报告历史索引（#626 读侧投影：按 (period,key) 去重，保留 generatedAt 最新一条
 * ——「一行/窗口=最新版」；index.jsonl 保持 append-only 不改写）。
 * 返回按时间倒序（最新在前），与既有消费方语义一致。
 *
 * #629 P1 解析记忆化：index.jsonl 为 append-only 单写者（本进程 persistReport），
 * 同版本文件的解析结果必然一致，故按 stat 失效键（size + mtimeMs）缓存「原始全文
 * → 解析+去重+排序投影」。任务执行/手动生成路由每轮复用缓存，不再随 index 行数
 * 线性重解析（文件未变时 O(1)；文件变化只重解析一次并刷新缓存，仍优于逐调用全量）。
 * - 失效以 stat 为唯一事实源，不基于时钟假设——写入方经 appendFile 后 mtime/size
 *   必变，不会读到过期投影；
 * - 文件缺失 → 不缓存（空表），避免 -ENOENT 竞态窗口把「暂不可见」钉死成永久空；
 * - stat 失败（竞态删除/权限）→ 回落全量读+解析（降级路径，语义与原实现一致）；
 * - 单进程内存态缓存，无跨进程共享面（多实例经 DSH_HOME/profile 天然隔离）。
 */
export async function readReportIndex(historyRoot: string): Promise<ReportMeta[]> {
  const file = reportIndexFile(historyRoot);
  let raw: string;
  let stamp: string;
  try {
    const st = await stat(file);
    stamp = `${st.size}:${st.mtimeMs}`;
    const cached = indexCache.get(historyRoot);
    if (cached !== undefined && cached.stamp === stamp) {
      indexCacheHits += 1;
      return [...cached.value]; // 浅拷贝防调用方改写污染缓存（O(n) 拷贝远轻于重解析）
    }
    raw = await readFile(file, "utf8");
  } catch {
    // 文件缺失或 stat 失败：回落全量读+解析（缺失时 readFile 也失败 → 空表），不缓存
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return [];
    }
    stamp = "";
  }
  indexCacheMisses += 1;
  const records = parseReportIndexLines(raw);
  const newest = new Map<string, ReportMeta>();
  for (const r of records) {
    const id = `${r.period}:${r.key}`;
    const cur = newest.get(id);
    if (cur === undefined || r.generatedAt > cur.generatedAt) newest.set(id, r);
  }
  const value = [...newest.values()].sort((a, b) => b.generatedAt - a.generatedAt);
  if (stamp !== "") indexCache.set(historyRoot, { stamp, value });
  return [...value]; // 与命中路径对称：浅拷贝防调用方就地突变污染缓存
}
