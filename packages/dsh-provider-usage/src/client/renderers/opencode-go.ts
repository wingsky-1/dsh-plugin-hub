/**
 * dsh-provider-usage — 内置 OpenCode Go 客户端渲染器（M1 迁移）。
 *
 * 把现有浮窗面板的「三窗口迷你图卡片」渲染逻辑迁移为契约化渲染器
 * （ClientProviderRenderer）：render(ctx) 把卡片画进 ctx.mount。
 * - 归一化数据 ProviderUsage.windows（每窗口 key/name/percent/limit/resetsAt/
 *   resetPeriodMs）驱动卡片头与迷你图；
 * - 历史采样 v1 单序列 [ts, rolling, weekly, monthly]，列序 = windows 顺序；
 * - 行为与旧实现一致：每窗口独立自适应 y 轴、100% 配额参考线、重置线、
 *   平滑面积图、降采样、手机端字号补偿、ResizeObserver 重排。
 *
 * 色板（主题变量 + 浅色回退，明暗自适应）与观察周期沿用旧 CHART_SERIES 语义。
 */
import type { ClientProviderRenderer, ProviderUsage, RenderContext, UsageWindow } from "../../contracts.js";
import { ADAPTER_CONTRACT_VERSION } from "../../contracts.js";
// 样式独立文件（build-client .css text-loader 构建期内联）
import STYLE from "../style.css";

export { STYLE };

// ---------------------------------------------------------------- 窗口配置

/** [key, 中文名, 颜色, 展示限额, x 轴观察周期(ms), 重置周期(ms)]。 */
const CHART_SERIES: Array<[string, string, string, number | string, number | null, number]> = [
  ["rolling", "5h 滚动", "var(--dsw-alias-state-business-primary,#3b82f6)", 12, 12 * 3600000, 5 * 3600000],
  ["weekly", "每周", "var(--dsw-alias-state-warn-primary,#c9820b)", 30, 7 * 86400000, 7 * 86400000],
  ["monthly", "每月", "var(--dsw-alias-state-success-primary,#0f9d6e)", 60, 30 * 86400000, 30 * 86400000],
];

const CHART_MAX_POINTS = 300; // 降采样上限（约每像素一点）

/** 样式注入标记（唯一，防重复）。 */
export const STYLE_MARK = "dou-style";

/** 注入样式（幂等；apply 过早 head 未就绪时挂 DOMContentLoaded 重试）。 */
export function injectStyle(): void {
  if (document.head === null) {
    document.addEventListener("DOMContentLoaded", () => injectStyle(), { once: true });
    return;
  }
  if (document.querySelector(`style[data-${STYLE_MARK}]`) !== null) return;
  const style = document.createElement("style");
  style.setAttribute(`data-${STYLE_MARK}`, "");
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/** el() helper：children 第三位置 / attrs.children、dataset、onX、class/text/checked 等。 */
export function el(tag: string, attrs: Record<string, unknown> | undefined, children?: unknown): HTMLElement {
  const node = document.createElement(tag);
  if (attrs !== undefined && attrs !== null) {
    let kids = attrs.children;
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (key === "children" || value === undefined || value === null) continue;
      if (key === "class") node.className = String(value);
      else if (key === "text") node.textContent = String(value);
      else if (key === "dataset") Object.assign(node.dataset, value as Record<string, string>);
      else if (key === "style" && typeof value === "object") Object.assign(node.style, value as Partial<CSSStyleDeclaration>);
      else if (key === "checked") (node as HTMLInputElement).checked = Boolean(value);
      else if (key === "disabled") (node as HTMLButtonElement).disabled = Boolean(value);
      else if (key === "hidden") node.hidden = Boolean(value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else node.setAttribute(key, String(value));
    }
    if (Array.isArray(attrs.children)) kids = attrs.children;
  }
  const list = Array.isArray(children) ? children : [children];
  for (const item of list) {
    if (item === undefined || item === null) continue;
    node.appendChild(typeof item === "string" ? document.createTextNode(item) : (item as Node));
  }
  return node;
}

// ---------------------------------------------------------------- 数值/时间辅助（沿用旧实现）

function fmtReset(iso: string | undefined): string {
  if (typeof iso !== "string" || iso === "") return "未知";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtAxisTime(ts: number, spanMs: number, dateOnly: boolean): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1);
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  if (dateOnly) return `${mm}-${dd}`;
  if (spanMs >= 7 * 86400000) return `${mm}-${dd}`;
  if (spanMs >= 86400000) return `${mm}-${dd} ${hh}:${mi}`;
  return `${hh}:${mi}`;
}

function axisLabelWidthPx(spanMs: number, fontSizePx: number, dateOnly: boolean): number {
  let chars: number;
  if (dateOnly) chars = "MM-dd".length;
  else if (spanMs >= 7 * 86400000) chars = "MM-dd".length;
  else if (spanMs >= 86400000) chars = "MM-dd HH:mm".length;
  else chars = "HH:mm".length;
  return Math.ceil(chars * fontSizePx * 0.62) + 4;
}

function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm < 1.5) return mag;
  if (norm < 3.5) return 2 * mag;
  if (norm < 7.5) return 5 * mag;
  return 10 * mag;
}

function niceDomain(pcts: number[]): [number, number] {
  const vals: number[] = [];
  for (const v of pcts) if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
  if (vals.length === 0) return [0, 100];
  let dmin = vals[0];
  let dmax = vals[0];
  for (const v of vals) {
    if (v < dmin) dmin = v;
    if (v > dmax) dmax = v;
  }
  const step = niceStep((dmax - dmin) / 3);
  let lo = Math.max(0, Math.floor(dmin / step) * step);
  let hi = Math.ceil(dmax / step) * step;
  const minSpan = Math.max(3 * step, 2);
  if (hi - lo < minSpan) {
    const mid = (dmin + dmax) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
    if (lo < 0) {
      hi += -lo;
      lo = 0;
    }
    if (hi > 100) {
      lo = Math.max(0, lo - (hi - 100));
      hi = 100;
    }
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
  }
  if (dmax >= 90 && hi < 100) hi = 100;
  if (hi > 100) hi = 100;
  if (lo >= hi) lo = Math.max(0, hi - 5);
  return [lo, hi];
}

function fmtPctTick(v: number): string {
  return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + "%";
}

function timeTickStep(spanMs: number): number {
  if (spanMs <= 10 * 60000) return 2 * 60000;
  if (spanMs <= 45 * 60000) return 5 * 60000;
  if (spanMs <= 3 * 3600000) return 15 * 60000;
  if (spanMs <= 12 * 3600000) return 3600000;
  if (spanMs <= 3 * 86400000) return 3 * 3600000;
  if (spanMs <= 7 * 86400000) return 6 * 3600000;
  if (spanMs <= 30 * 86400000) return 86400000;
  return 7 * 86400000;
}

function timeTicks(t0: number, t1: number, minGapMs: number): number[] {
  let step = timeTickStep(t1 - t0);
  const gapOk = (s: number): boolean => !(minGapMs > 0) || s >= minGapMs;
  for (let guard = 0; guard < 8; guard += 1) {
    const first = Math.ceil(t0 / step) * step;
    let count = 0;
    for (let t = first; t <= t1 + 1; t += step) count += 1;
    if (count <= 6 && gapOk(step)) break;
    step *= 2;
  }
  const out: number[] = [];
  const start = Math.ceil(t0 / step) * step;
  for (let tt = start; tt <= t1 + 1; tt += step) out.push(tt);
  if (out.length < 2) return [t0, t1];
  return out;
}

function trendOf(pcts: Array<number | null>): { delta: number; up: boolean; down: boolean } | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const v of pcts) if (typeof v === "number") { first = v; break; }
  for (let j = pcts.length - 1; j >= 0; j -= 1) if (typeof pcts[j] === "number") { last = pcts[j]; break; }
  if (first === null || last === null) return null;
  const d = last - first;
  return { delta: Math.round(d * 10) / 10, up: d > 0.05, down: d < -0.05 };
}

function resetTicks(resetsAt: string | undefined, periodMs: number, t0: number, t1: number): number[] {
  if (typeof resetsAt !== "string" || resetsAt === "" || !(periodMs > 0)) return [];
  const r = new Date(resetsAt).getTime();
  if (Number.isNaN(r)) return [];
  const out: number[] = [];
  if (r >= t0 && r <= t1) out.push(r);
  let ts = r - periodMs;
  for (let guard = 0; guard < 40 && ts >= t0; guard += 1) {
    out.push(ts);
    ts -= periodMs;
  }
  out.sort((a, b) => a - b);
  return out;
}

/** 相对时间（数据新鲜度）。 */
export function fmtAge(ts: number | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  const diff = Date.now() - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
  if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
  return Math.floor(diff / 86400000) + " 天前";
}

function downsample(points: Array<{ x: number; y: number }>, maxPoints: number): Array<{ x: number; y: number }> {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < points.length; i += step) {
    const start = Math.floor(i);
    const end = Math.min(points.length - 1, Math.floor(i + step));
    let best = start;
    for (let j = start + 1; j <= end; j += 1) if (points[j].y > points[best].y) best = j;
    out.push(points[best]);
  }
  const lastPt = points[points.length - 1];
  if (out[out.length - 1] !== lastPt) out.push(lastPt);
  return out;
}

function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length < 2) return "";
  let d = "M " + pts[0].x.toFixed(1) + " " + pts[0].y.toFixed(1);
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function miniChartSvgMarkup(
  samples: Array<Array<number | null>>,
  col: number,
  color: string,
  lo: number,
  hi: number,
  drawXAxis: boolean,
  resetAt: string | undefined,
  resetPeriodMs: number,
  fontScale: number,
  dateOnly: boolean,
): string {
  const t0 = samples[0][0] as number;
  const t1 = samples[samples.length - 1][0] as number;
  const spanMs = t1 > t0 ? t1 - t0 : 60000;
  const W = 320;
  const H = 100;
  const PL = 34;
  const PR = 6;
  const PT = 14;
  const PB = 16;
  const xw = W - PL - PR;
  const plotH = H - PT - PB;
  const fsBase = 9.5;
  const sf = typeof fontScale === "number" && fontScale > 0 ? fontScale : 1;
  const fs = (fsBase / sf).toFixed(2);
  const fs100 = (9 / sf).toFixed(2);
  const xOf = (ts: number): number => PL + ((ts - t0) / spanMs) * xw;
  const yOf = (pct: number): number => PT + ((hi - pct) / (hi - lo)) * plotH;

  const parts: string[] = [];
  const resets = resetTicks(resetAt, resetPeriodMs, t0, t1);
  for (const rr of resets) {
    const rx = xOf(rr);
    parts.push(`<line x1="${rx.toFixed(1)}" y1="${PT}" x2="${rx.toFixed(1)}" y2="${(PT + plotH).toFixed(1)}" style="stroke:var(--dsw-alias-label-tertiary,#9aa0ab);stroke-width:1;stroke-dasharray:2 3;stroke-opacity:.55"><title>窗口重置点</title></line>`);
    parts.push(`<path d="M ${rx.toFixed(1)} ${PT} l 3.5 3.5 l -7 0 z" style="fill:var(--dsw-alias-label-tertiary,#9aa0ab);fill-opacity:.55"/>`);
  }
  const gridVals = [lo, (lo + hi) / 2, hi];
  for (const gv of gridVals) {
    const gy = yOf(gv);
    parts.push(`<line x1="${PL}" y1="${gy.toFixed(1)}" x2="${(W - PR)}" y2="${gy.toFixed(1)}" style="stroke:var(--dsw-alias-border-l2,#e8eaf0);stroke-width:1;stroke-dasharray:3 3"/>`);
    parts.push(`<text x="${(PL - 4)}" y="${(gy + 3).toFixed(1)}" text-anchor="end" style="font-size:${fs}px">${fmtPctTick(gv)}</text>`);
  }
  if (lo <= 100 && 100 <= hi && hi - lo > 0.01) {
    const ly = yOf(100);
    parts.push(`<line x1="${PL}" y1="${ly.toFixed(1)}" x2="${(W - PR)}" y2="${ly.toFixed(1)}" style="stroke:var(--dsw-alias-state-error-primary,#d64545);stroke-width:1;stroke-dasharray:4 3;stroke-opacity:.65"/>`);
    parts.push(`<text x="${(W - PR - 2)}" y="${(ly - 3).toFixed(1)}" text-anchor="end" style="fill:var(--dsw-alias-state-error-primary,#d64545);font-size:${fs100}px">100%</text>`);
  }
  const line: Array<{ x: number; y: number }> = [];
  for (const s of samples) {
    const pct = s[col];
    if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
    const clamped = Math.min(Math.max(pct, lo), hi);
    line.push({ x: xOf(s[0] as number), y: yOf(clamped) });
  }
  if (line.length >= 2) {
    const lpts = downsample(line, CHART_MAX_POINTS);
    const d = smoothPath(lpts);
    const first = lpts[0];
    const lastPt = lpts[lpts.length - 1];
    const bottom = PT + plotH;
    const areaD = `${d} L ${lastPt.x.toFixed(1)} ${bottom} L ${first.x.toFixed(1)} ${bottom} Z`;
    parts.push(`<path d="${areaD}" style="fill:${color};fill-opacity:.13"/>`);
    parts.push(`<path d="${d}" style="fill:none;stroke:${color};stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round"/>`);
    parts.push(`<circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="2.6" style="fill:${color};stroke:var(--dsw-alias-bg-base,#fdfdfd);stroke-width:1.2"/>`);
  }
  if (drawXAxis) {
    const labelPx = axisLabelWidthPx(spanMs, parseFloat(fs), dateOnly);
    const minGapMs = (labelPx * spanMs) / xw;
    const ticks = timeTicks(t0, t1, minGapMs);
    for (let k = 0; k < ticks.length; k += 1) {
      const tx = xOf(ticks[k]);
      const anchor = k === 0 ? "start" : k === ticks.length - 1 ? "end" : "middle";
      parts.push(`<text x="${tx.toFixed(1)}" y="${(H - 4)}" text-anchor="${anchor}" style="font-size:${fs}px">${fmtAxisTime(ticks[k], spanMs, dateOnly)}</text>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

function trendEl(pcts: Array<number | null>): HTMLElement | null {
  const t = trendOf(pcts);
  if (t === null) return null;
  let cls: string;
  let txt: string;
  if (t.up) {
    cls = "dou-trend-up";
    txt = `▲ +${t.delta}%`;
  } else if (t.down) {
    cls = "dou-trend-down";
    txt = `▼ ${t.delta}%`;
  } else {
    cls = "dou-trend-flat";
    txt = `— ${t.delta}%`;
  }
  return el("span", { class: cls, text: txt, title: "较区间首个采样点" });
}

// ---------------------------------------------------------------- 卡片渲染

function usageChartHead(s: [string, string, string, number | string, number | null, number], win: UsageWindow, pcts: Array<number | null>): HTMLElement {
  const pct = win && typeof win.percent === "number" ? win.percent : null;
  const reset = win && win.resetsAt ? `重置 ${fmtReset(win.resetsAt)}` : "";
  return el("div", { class: "dou-cardHead" }, [
    el("div", { class: "dou-cardMeta" }, [
      el("span", { class: "dou-legendDot", style: { background: s[2] } }),
      el("h4", { class: "dou-cardName", text: s[1] }),
      el("span", { class: "dou-cardCur", text: pct === null ? "--" : `${pct}%` }),
      trendEl(pcts),
    ]),
    el("p", { class: "dou-cardLimit", text: `限额 ${s[3]}${reset !== "" ? ` · ${reset}` : ""}` }),
  ]);
}

function paintCharts(jobs: Array<{ box: HTMLElement; samples: Array<Array<number | null>>; col: number; color: string; domain: [number, number]; resetsAt: string | undefined; period: number; fontScale: number; dateOnly: boolean }>): void {
  for (const job of jobs) {
    const w = job.box.clientWidth || 320;
    const fontScale = w / 320;
    job.box.innerHTML = miniChartSvgMarkup(job.samples, job.col, job.color, job.domain[0], job.domain[1], true, job.resetsAt, job.period, fontScale, job.dateOnly);
  }
}

/** 渲染三窗口迷你图卡片区（行为与旧 renderCharts 一致）。 */
export function renderCharts(container: HTMLElement, data: ProviderUsage | null, history: { samples?: Array<Array<number | null>>; count?: number } | null | undefined, chartsResizeObs: ResizeObserver | null): ResizeObserver | null {
  if (chartsResizeObs !== null) {
    try { chartsResizeObs.disconnect(); } catch { /* 忽略 */ }
    chartsResizeObs = null;
  }
  container.textContent = "";
  const samples: Array<Array<number | null>> | null =
    history !== null && history !== undefined && Array.isArray(history.samples) ? history.samples : null;
  const allEnough = samples !== null && samples.length >= 2;
  const windows: UsageWindow[] = data && data.windows ? data.windows : [];
  const jobs: Array<{ box: HTMLElement; samples: Array<Array<number | null>>; col: number; color: string; domain: [number, number]; resetsAt: string | undefined; period: number; fontScale: number; dateOnly: boolean }> = [];
  let ci = 0;
  for (const win of windows) {
    const s = CHART_SERIES[ci] ?? null;
    ci += 1;
    if (s === null) continue;
    // 历史列：v1 单序列 [ts, col...]，列序 = windows 顺序
    const col = ci;
    let winSamples: Array<Array<number | null>> | null = samples;
    if (allEnough && s[4] !== null && s[4] > 0) {
      const tail = samples[samples.length - 1][0] as number;
      const cut = tail - s[4];
      winSamples = samples.filter((sp) => (sp[0] as number) >= cut);
    }
    const pcts: Array<number | null> = winSamples === null ? [] : winSamples.map((sp) => sp[col]);
    const card = el("div", { class: "dou-card" });
    card.appendChild(usageChartHead(s, win, pcts));
    if (winSamples !== null && winSamples.length >= 2) {
      const hasPoint = pcts.some((v) => typeof v === "number");
      const box = el("div", { class: "dou-miniChart" });
      if (hasPoint) {
        jobs.push({
          box,
          samples: winSamples,
          col,
          color: s[2],
          domain: niceDomain(pcts as number[]),
          resetsAt: win.resetsAt,
          period: s[5],
          fontScale: 1,
          dateOnly: s[0] === "weekly" || s[0] === "monthly",
        });
      } else {
        box.appendChild(el("p", { class: "dou-chartEmpty", text: "该窗口暂无历史采样" }));
      }
      card.appendChild(box);
    } else if (allEnough) {
      card.appendChild(el("p", { class: "dou-chartEmpty", text: "该时间范围内采样不足（<2 点），随时间积累后显示。" }));
    } else {
      const msg = history === null || history === undefined
        ? "加载中…"
        : "数据采集中：每次刷新记录一个采样点（约每分钟一次），≥2 个点后显示趋势。";
      card.appendChild(el("p", { class: "dou-chartEmpty", text: msg }));
    }
    container.appendChild(card);
  }
  paintCharts(jobs);
  if (typeof ResizeObserver === "function" && container.isConnected) {
    chartsResizeObs = new ResizeObserver(() => { paintCharts(jobs); });
    chartsResizeObs.observe(container);
  }
  return chartsResizeObs;
}

// ---------------------------------------------------------------- 渲染器

/** 渲染上下文（扩展：history 供迷你图）。 */
export interface OpenCodeGoRenderContext extends RenderContext {
  history?: { samples?: Array<Array<number | null>>; count?: number };
}

/** 内置 OpenCode Go 客户端渲染器。 */
export const openCodeGoClientRenderer: ClientProviderRenderer & { renderOpenCodeGo(ctx: OpenCodeGoRenderContext): () => void } = {
  version: ADAPTER_CONTRACT_VERSION,
  // issue #29：去除重复项 "opencode-go"（原数组 ["opencode-go", "opencode", "opencode-go"]）
  providers: ["opencode-go", "opencode"],
  // R2：与内置适配器配对（仅该 provider 启用内置时用本渲染器）
  adapterId: "opencode-go-builtin",
  render(ctx: RenderContext) {
    return this.renderOpenCodeGo(ctx as OpenCodeGoRenderContext);
  },
  renderOpenCodeGo(ctx: OpenCodeGoRenderContext) {
    injectStyle();
    let chartsResizeObs: ResizeObserver | null = null;
    chartsResizeObs = renderCharts(ctx.mount, ctx.data ?? null, ctx.history, chartsResizeObs);
    return () => {
      if (chartsResizeObs !== null) {
        try { chartsResizeObs.disconnect(); } catch { /* 忽略 */ }
        chartsResizeObs = null;
      }
    };
  },
};