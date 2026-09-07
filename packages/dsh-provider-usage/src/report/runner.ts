/**
 * dsh-provider-usage/report — 报告生成执行器与索引读取辅助。
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  const snapshot = buildStatsSnapshot({
    period: due.period,
    startDay: due.startDay,
    endDay: due.endDay,
    buckets,
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
 */
export async function readReportIndex(historyRoot: string): Promise<ReportMeta[]> {
  let raw: string;
  try {
    raw = await readFile(reportIndexFile(historyRoot), "utf8");
  } catch {
    return [];
  }
  const records = parseReportIndexLines(raw);
  const newest = new Map<string, ReportMeta>();
  for (const r of records) {
    const id = `${r.period}:${r.key}`;
    const cur = newest.get(id);
    if (cur === undefined || r.generatedAt > cur.generatedAt) newest.set(id, r);
  }
  return [...newest.values()].sort((a, b) => b.generatedAt - a.generatedAt);
}
