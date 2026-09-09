/**
 * dsh-provider-usage — 适配器共享图表/转义/日界工具库（issue #215 方案 a 落地）。
 *
 * 背景：图表渲染能力此前在 opencode-go.ts 与 deepseek-official.ts 中重复实现且语义
 * 不一（降采样 opencode 取区间最大、deepseek 取区间起点）。本文件收编为单一实现，
 * 经 FetchContext/PanelInput 的 optional `utils` 字段注入给适配器（含用户 mjs）：
 * - 用户 mjs 鸭子类型下 utils 可选——mjs 适配器一律 `const U = input.utils` 后
 *   优先消费注入工具，缺失时回退文件内私有副本/兜底（见各适配器转写注释）；
 * - 内置 mjs 因自包含/路径约束无法 import 编译后 charts，图表函数一律经注入获取；
 *   `dayKey`/`lastNDayKeys` 这类 3 行纯函数允许 mjs 内保留私有副本并注释「同源需同步」。
 *
 * 收编范围（用户已认可抽取面）：
 * - 自 opencode-go.ts：fmtAxisTime / axisLabelWidthPx / niceStep / niceDomain /
 *   fmtPctTick / timeTickStep / timeTicks / trendOf / resetTicks / downsample
 *   （统一 peak 语义=区间取最大，issue 诉求②）/ smoothPath / miniChartSvgMarkup
 *   → 更名 miniAreaSvg 并参数化（resetsAt 类型放宽）；
 * - 自 deepseek-official.ts：dayKey / lastNDayKeys / fin / h（escHtml）/ ea（escAttr）。
 * 明确不下沉（用户拍板）：getJson；dailyBarsSvg/balanceSvg 柱图化（DS 业务耦合，
 * 记入 issue #215 评论作后续候选）；aggregateDaily/classifyIntervalDs/峰谷徽标等业务逻辑。
 *
 * 使用约定：本文件不 import contracts.ts（避免环）；契约侧仅 import type。
 */

// ------------------------------------------------------------------ 数值安全化

/** 数值安全化：非有限返回 null；有限则 clamp 到 [min,max] 再返回（自 deepseek-official）。 */
export function fin(v: number, min = -Number.MAX_VALUE, max = Number.MAX_VALUE): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(Math.max(v, min), max);
}

// ------------------------------------------------------------------ 日界（自 deepseek-official，同源）

/** 本地时区日期 key（禁用 toISOString——UTC 归组会使东八区每天 00:00–08:00 的采样划入前一天）。 */
export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 近 n 个自然日 key 列表（含今日；逐日 setDate 回退生成，DST/跨月/跨年安全，禁用毫秒减法）。 */
export function lastNDayKeys(n: number, now: number): string[] {
  const d = new Date(now);
  const keys: string[] = [];
  for (let i = 0; i < n; i += 1) {
    keys.unshift(dayKey(d.getTime()));
    d.setDate(d.getDate() - 1);
  }
  return keys;
}

// ------------------------------------------------------------------ HTML 转义（自 deepseek-official，同源）

/** HTML 转义：& < > " ' 全部转义为实体（元素内容上下文用）。 */
export function escHtml(s: unknown): string {
  const str = s === null || s === undefined ? "" : String(s);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 属性上下文转义：不信任宿主 esc 一定转义引号，属性插值一律走本函数。 */
export function escAttr(s: unknown): string {
  return escHtml(s);
}

// ------------------------------------------------------------------ 迷你面积图（自 opencode-go miniChartSvgMarkup，更名 + 参数化）

/** 重置时间戳归一化：ISO 字符串 / epoch 毫秒数 / 空值 → epochMs 或 undefined。 */
export function toEpochMs(v: string | number | undefined | null): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** 重置标记 tick：resetsAt 归一化后落在窗口内 + 按周期外推历史点。 */
export function resetTicks(resetsAt: string | number | undefined | null, periodMs: number, t0: number, t1: number): number[] {
  const r = toEpochMs(resetsAt);
  if (r === undefined || !(periodMs > 0)) return [];
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

/** x 轴时间标签格式化（自 opencode-go；dateOnly/观察跨度决定粒度）。 */
export function fmtAxisTime(ts: number, spanMs: number, dateOnly: boolean): string {
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

/** x 轴标签宽度估计（自 opencode-go；用于时间刻度最小间距，含手机字号补偿语义）。 */
export function axisLabelWidthPx(spanMs: number, fontSizePx: number, dateOnly: boolean): number {
  let chars: number;
  if (dateOnly) chars = "MM-dd".length;
  else if (spanMs >= 7 * 86400000) chars = "MM-dd".length;
  else if (spanMs >= 86400000) chars = "MM-dd HH:mm".length;
  else chars = "HH:mm".length;
  return Math.ceil(chars * fontSizePx * 0.62) + 4;
}

/** 好看步长：1/2/5×10^k（自 opencode-go）。 */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm < 1.5) return mag;
  if (norm < 3.5) return 2 * mag;
  if (norm < 7.5) return 5 * mag;
  return 10 * mag;
}

/** 百分比域自适应（自 opencode-go；dmax≥90 强制抬到 100 的 100% 参考线语义保留）。 */
export function niceDomain(pcts: number[]): [number, number] {
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

/** y 轴百分比刻度文案（自 opencode-go）。 */
export function fmtPctTick(v: number): string {
  return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + "%";
}

/** 时间刻度步长（自 opencode-go）。 */
export function timeTickStep(spanMs: number): number {
  if (spanMs <= 10 * 60000) return 2 * 60000;
  if (spanMs <= 45 * 60000) return 5 * 60000;
  if (spanMs <= 3 * 3600000) return 15 * 60000;
  if (spanMs <= 12 * 3600000) return 3600000;
  if (spanMs <= 3 * 86400000) return 3 * 3600000;
  if (spanMs <= 7 * 86400000) return 6 * 3600000;
  if (spanMs <= 30 * 86400000) return 86400000;
  return 7 * 86400000;
}

/** 时间刻度序列（自 opencode-go；≤6 个 + 标签最小间距约束）。 */
export function timeTicks(t0: number, t1: number, minGapMs: number): number[] {
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

/** 趋势判定（自 opencode-go；首末有效点之差，±0.05 死区）。 */
export function trendOf(pcts: Array<number | null>): { delta: number; up: boolean; down: boolean } | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const v of pcts) if (typeof v === "number") { first = v; break; }
  for (let j = pcts.length - 1; j >= 0; j -= 1) if (typeof pcts[j] === "number") { last = pcts[j]; break; }
  if (first === null || last === null) return null;
  const d = last - first;
  return { delta: Math.round(d * 10) / 10, up: d > 0.05, down: d < -0.05 };
}

/** 降采样（统一 peak 语义：区间取最大值；末点恒保留——issue #215 诉求②，deepseek 旧 first 语义作废）。 */
export function downsample(points: Array<{ x: number; y: number }>, maxPoints: number): Array<{ x: number; y: number }> {
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

/** 平滑路径（自 opencode-go；Catmull-Rom → 三次贝塞尔）。 */
export function smoothPath(pts: Array<{ x: number; y: number }>): string {
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

/** 迷你面积图 SVG 字符串（opencode-go miniChartSvgMarkup 更名 + resetsAt 类型放宽；行为一致）。 */
export function miniAreaSvg(opts: {
  samples: Array<{ x: number; y: number }>;
  color: string;
  lo: number;
  hi: number;
  resetsAt: string | number | undefined | null;
  resetPeriodMs: number;
  dateOnly: boolean;
}): string {
  const { samples, color, lo, hi, resetsAt, resetPeriodMs, dateOnly } = opts;
  if (samples.length < 2) return "";
  const t0 = samples[0].x;
  const t1 = samples[samples.length - 1].x;
  const spanMs = t1 > t0 ? t1 - t0 : 60000;
  const W = 320;
  const H = 100;
  const PL = 34;
  const PR = 6;
  const PT = 14;
  const PB = 16;
  const xw = W - PL - PR;
  const plotH = H - PT - PB;
  const fs = 9.5;
  const fs100 = 9;
  const xOf = (ts: number): number => PL + ((ts - t0) / spanMs) * xw;
  const yOf = (pct: number): number => PT + ((hi - pct) / (hi - lo)) * plotH;

  const parts: string[] = [];
  const resets = resetTicks(resetsAt, resetPeriodMs, t0, t1);
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
    const clamped = Math.min(Math.max(s.y, lo), hi);
    line.push({ x: xOf(s.x), y: yOf(clamped) });
  }
  if (line.length >= 2) {
    const lpts = downsample(line, 300);
    const d = smoothPath(lpts);
    const first = lpts[0];
    const lastPt = lpts[lpts.length - 1];
    const bottom = PT + plotH;
    const areaD = `${d} L ${lastPt.x.toFixed(1)} ${bottom} L ${first.x.toFixed(1)} ${bottom} Z`;
    parts.push(`<path d="${areaD}" style="fill:${color};fill-opacity:.13"/>`);
    parts.push(`<path d="${d}" style="fill:none;stroke:${color};stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round"/>`);
    parts.push(`<circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="2.6" style="fill:${color};stroke:var(--dsw-alias-bg-base,#fdfdfd);stroke-width:1.2"/>`);
  }
  const labelPx = axisLabelWidthPx(spanMs, fs, dateOnly);
  const minGapMs = (labelPx * spanMs) / xw;
  const ticks = timeTicks(t0, t1, minGapMs);
  for (let k = 0; k < ticks.length; k += 1) {
    const tx = xOf(ticks[k]);
    const anchor = k === 0 ? "start" : k === ticks.length - 1 ? "end" : "middle";
    parts.push(`<text x="${tx.toFixed(1)}" y="${(H - 4)}" text-anchor="${anchor}" style="font-size:${fs}px">${fmtAxisTime(ticks[k], spanMs, dateOnly)}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

// ------------------------------------------------------------------ 注入面

/**
 * 适配器共享工具集（issue #215 方案 a 的注入面）。
 * 宿主端经 FetchContext.utils / PanelInput.utils 注入；mjs 鸭子类型下字段可选，
 * 适配器内 `const U = input.utils` 后优先消费，缺失时回退文件内私有副本/兜底。
 */
export interface AdapterUtils {
  /** 迷你面积图 SVG 字符串（opencode-go miniChartSvgMarkup 同行为）。 */
  miniAreaSvg: typeof miniAreaSvg;
  /** 数值安全化 + clamp。 */
  fin: typeof fin;
  /** 本地时区日期 key（YYYY-MM-DD）。 */
  dayKey: typeof dayKey;
  /** 近 n 个自然日 key 列表（含今日）。 */
  lastNDayKeys: typeof lastNDayKeys;
  /** HTML 转义（& < > " '，元素内容上下文）。 */
  escHtml: typeof escHtml;
  /** 属性上下文转义（引号必转）。 */
  escAttr: typeof escAttr;
  /** 百分比域自适应。 */
  niceDomain: typeof niceDomain;
  /** 趋势判定。 */
  trendOf: typeof trendOf;
  /** 时间刻度序列。 */
  timeTicks: typeof timeTicks;
  /** 重置标记 tick 序列（resetsAt 支持 ISO 字符串 / epochMs）。 */
  resetTicks: typeof resetTicks;
  /** 降采样（peak 语义）。 */
  downsample: typeof downsample;
  /** 平滑路径。 */
  smoothPath: typeof smoothPath;
}

/** 宿主端默认工具集（适配器未注入时兜底，保证内置/用户 mjs 单测直调仍可用）。 */
export const ADAPTER_UTILS: AdapterUtils = {
  miniAreaSvg,
  fin,
  dayKey,
  lastNDayKeys,
  escHtml,
  escAttr,
  niceDomain,
  trendOf,
  timeTicks,
  resetTicks,
  downsample,
  smoothPath,
};
