/**
 * dsh-provider-usage — 使用趋势纯函数层（#503 M2.1）。
 *
 * 从 trend.ts 拆出的零 React 依赖模块：格式化 / 档位生成 / 桶键语义 / SVG 生成器。
 * 单测可直接 node 加载（trend.ts 顶部 import react，node 测试环境不可用）。
 * 宿主聚合数据（provider 名/键）不受信，凡进 SVG 文本一律 escHtml；
 * tooltip 走 React 文本节点（trend.ts 内），不经本模块。
 */
import { escHtml } from "../charts.ts";
import { t } from "../../../../shared/client/i18n.js";

/** 趋势粒度。 */
export type TrendGran = "day" | "week" | "month";

/** token 数紧凑格式化（1,234 / 12.3K / 4.56M / 1.2B；null = 零 usage 语义，显示 -）。 */
export function fmtCompact(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

/** 环比符号与方向（基准不完整/无基准 null）。 */
export function trendDelta(cur: number | null, prev: number | null, prevComplete = true): { text: string; up: boolean; down: boolean } | null {
  if (!prevComplete || cur === null || prev === null || prev === 0) return null;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const sign = pct >= 0 ? "+" : "";
  return { text: `${sign}${pct.toFixed(1)}%`, up: pct > 0, down: pct < 0 };
}

/** X 轴桶键标签：日/周 MM-DD；月 YY-MM（修复 M2 slice(5) 对月键丢年份、跨年不可辨）。 */
export function fmtAxisLabel(key: string, gran: TrendGran): string {
  return gran === "month" ? key.slice(2) : key.slice(5);
}

/** 桶键人话化（汇总卡峰值 / tooltip 标题；i18n）。 */
export function fmtBucketHuman(key: string, gran: TrendGran): string {
  if (gran === "month") return t("trendPeakMonth", { y: key.slice(0, 4), m: String(Number(key.slice(5, 7))) });
  const day = key.slice(5);
  return gran === "week" ? t("trendPeakWeek", { day }) : t("trendPeakDay", { day });
}

/** 桶的起点本地日 key（边缘判定用；day=自身 / week=周一键即起点 / month=当月 1 日）。 */
export function bucketStartKey(key: string, gran: TrendGran): string {
  if (gran === "month") return `${key}-01`;
  return key; // day 与 week（week 键本身即周一首日）
}

/**
 * 范围档位（客户端与宿主 clamp 同一套口径；留存按「天」裁、桶数与天数是两种口径）：
 * cap = day→min(retention, 90)、week→⌈retention/7⌉、month→⌈retention/30⌉。
 * 日档封顶 90（>90 桶在设置面板绘图区糊成一面墙，更长跨度由周/月承担——评审 P1-3）。
 */
export function trendRangeOptions(gran: TrendGran, retentionDays: number): number[] {
  const retention = Math.max(1, Math.floor(retentionDays));
  const cap = gran === "day" ? Math.min(retention, 90) : gran === "week" ? Math.ceil(retention / 7) : Math.ceil(retention / 30);
  const candidates = gran === "day" ? [7, 30, 90, 180] : gran === "week" ? [4, 13, 26] : [3, 6, 12];
  const opts = candidates.filter((c) => c <= cap);
  return opts.length > 0 ? opts : [Math.max(1, Math.min(cap, 30))];
}

/** 默认档：日30/周13/月6；默认值被留存裁掉时取最大可得档。 */
export function trendDefaultRange(gran: TrendGran, retentionDays: number): number {
  const opts = trendRangeOptions(gran, retentionDays);
  const def = gran === "day" ? 30 : gran === "week" ? 13 : 6;
  return opts.includes(def) ? def : opts[opts.length - 1];
}

/**
 * 动态 nice 刻度（#503 M2.1 后续）：按数据最大值自动推导步长与刻度序列——
 * 步长取 1/2/2.5/5×10^k（目标 ~5 段），顶格 = ceil(max/step)×step（贴合数据，
 * 不再是固定 0/½/max 三档）。ticks 含 0 与顶格，刻度线数 5~7 条随数据浮动；
 * 浮点用 i×step 索引式累积防误差。
 */
export function niceTicks(maxV: number): { ticks: number[]; top: number } {
  if (!(maxV > 0) || !Number.isFinite(maxV)) return { ticks: [0, 1], top: 1 };
  const rawStep = maxV / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const segs = Math.ceil(maxV / step);
  const top = segs * step;
  const ticks: number[] = [];
  for (let i = 0; i <= segs; i += 1) ticks.push(i * step);
  return { ticks, top };
}

/** 图表系列离散色：前四复用宿主状态色变量（浅/暗跟随），溢出轮转稳定离散色。 */
const CHART_COLORS: string[] = [
  "var(--dsw-alias-state-info-primary,#4a7dde)",
  "var(--dsw-alias-state-success-primary,#3f9d63)",
  "var(--dsw-alias-state-warn-primary,#d9a13c)",
  "var(--dsw-alias-state-error-primary,#d64545)",
  "#8a63d2",
  "#2fa3b8",
  "#c76a8f",
  "#6b7f99",
];

/** 稳定字符串哈希（段 → 色槽，跨渲染稳定）。 */
function hashSlot(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/** 段取色（命中前四变量色的段按哈希全距取，保持分配稳定）。 */
export function seriesColor(id: string): string {
  return CHART_COLORS[hashSlot(id) % CHART_COLORS.length];
}

/** 渲染桶（组件把宿主 series 折叠成的展示形态；segs 已滤隐藏段、按 stackOrder 排序）。 */
export interface RenderBar {
  key: string;
  segs: Array<{ id: string; value: number }>;
  /** 可见段合计（tooltip 用）。 */
  visibleTotal: number | null;
  /** 无数据桶（total===null；数据模型下 null 三态不可区分，统一「无数据」）。 */
  none: boolean;
  /** 部分桶标记：ongoing=进行中（尾桶）/ edge=留存或起算边缘（首桶侧）。 */
  mark: "ongoing" | "edge" | null;
}

const SVG_W = 560;
const SVG_H = 190;
const SVG_PL = 44;
const SVG_PR = 8;
const SVG_PT = 12;
const SVG_PB = 30; // 两行轴标签（日粒度日期 + 周/月键）
const PLOT_H = SVG_H - SVG_PT - SVG_PB;
const XW = SVG_W - SVG_PL - SVG_PR;

/** 网格 + Y 轴刻度（两形态共用）。 */
function gridParts(ticks: number[], yOf: (v: number) => number): string[] {
  const parts: string[] = [];
  for (const gv of ticks) {
    const gy = yOf(gv);
    parts.push(`<line x1="${SVG_PL}" y1="${gy.toFixed(1)}" x2="${SVG_W - SVG_PR}" y2="${gy.toFixed(1)}" style="stroke:var(--dsw-alias-border-l2,#e8eaf0);stroke-width:1;${gv === 0 ? "" : "stroke-dasharray:3 3;"}"/>`);
    parts.push(`<text x="${SVG_PL - 4}" y="${(gy + 3).toFixed(1)}" text-anchor="end" style="font-size:9.5px;fill:var(--dsw-alias-label-tertiary,#9aa0ab)">${escHtml(fmtCompact(gv))}</text>`);
  }
  return parts;
}

/** X 轴标签（均匀抽稀，首尾必显）。 */
function axisLabelParts(bars: RenderBar[], gran: TrendGran): string[] {
  const parts: string[] = [];
  const gap = XW / bars.length;
  const labelStep = Math.max(1, Math.ceil(bars.length / 8));
  bars.forEach((b, i) => {
    if (i % labelStep !== 0 && i !== bars.length - 1) return;
    const cx = SVG_PL + gap * i + gap / 2;
    const anchor = i === 0 ? "start" : i === bars.length - 1 ? "end" : "middle";
    parts.push(`<text x="${cx.toFixed(1)}" y="${SVG_H - 16}" text-anchor="${anchor}" style="font-size:9.5px;fill:var(--dsw-alias-label-tertiary,#9aa0ab)">${escHtml(fmtAxisLabel(b.key, gran))}</text>`);
  });
  return parts;
}

/** 桶组公共包装：data-bucket（容器事件委托锚点）+ 整列命中区。 */
function bucketGroup(i: number, colX: number, colW: number, inner: string): string {
  return `<g data-bucket="${i}" style="cursor:pointer">${inner}<rect x="${colX.toFixed(1)}" y="${SVG_PT}" width="${colW.toFixed(1)}" height="${PLOT_H}" style="fill:transparent"/></g>`;
}

/**
 * 堆叠柱状 SVG（M2 基础上 M2.1 增强）：空桶虚位、部分桶描边、data-bucket 委托锚点、
 * 月键标签修复。segs 为可见段（hidden 已滤），Y 域由调用方按全量段算（隐藏不缩轴）。
 */
export function stackedBarsSvg(opts: { bars: RenderBar[]; gran: TrendGran; ticks: number[] }): string {
  const { bars, gran, ticks } = opts;
  const yMax = ticks[ticks.length - 1];
  if (bars.length === 0 || XW <= 0) return "";
  const gap = XW / bars.length;
  const barW = Math.max(2, Math.min(18, gap * 0.62));
  const yOf = (v: number): number => SVG_PT + (1 - v / yMax) * PLOT_H;
  const parts: string[] = [...gridParts(ticks, yOf)];
  bars.forEach((b, i) => {
    const cx = SVG_PL + gap * i + gap / 2;
    const x = cx - barW / 2;
    const segs: string[] = [];
    if (b.none) {
      // 空桶虚位：统一「无数据」（tooltip 标注；挂载前/超保留期不做三态区分）
      segs.push(`<rect x="${x.toFixed(1)}" y="${(SVG_H - SVG_PB - 2).toFixed(1)}" width="${barW.toFixed(1)}" height="2" rx="1" style="fill:var(--dsw-alias-label-tertiary,#9aa0ab);fill-opacity:.45"/>`);
    }
    let acc = 0;
    for (const seg of b.segs) {
      const y1 = yOf(acc);
      acc += seg.value;
      const y2 = yOf(acc);
      segs.push(`<rect x="${x.toFixed(1)}" y="${y2.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, y1 - y2).toFixed(1)}" rx="1" style="fill:${seriesColor(seg.id)};fill-opacity:.9"/>`);
    }
    // 部分桶描边：进行中=警示色虚线；留存/起算边缘=灰点线（值天然偏低防误读）
    if (b.mark !== null && acc > 0) {
      const stroke = b.mark === "ongoing" ? "var(--dsw-alias-state-warn-primary,#d9a13c)" : "var(--dsw-alias-label-tertiary,#9aa0ab)";
      segs.push(`<rect x="${(x - 2.5).toFixed(1)}" y="${yOf(acc).toFixed(1)}" width="${(barW + 5).toFixed(1)}" height="${(SVG_H - SVG_PB - yOf(acc)).toFixed(1)}" rx="4" style="fill:none;stroke:${stroke};stroke-width:1;stroke-dasharray:${b.mark === "ongoing" ? "3 2" : "1.5 2.5"}"/>`);
    }
    parts.push(bucketGroup(i, cx - gap / 2, gap, segs.join("")));
  });
  parts.push(...axisLabelParts(bars, gran));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${SVG_H}" role="img" aria-label="${escHtml(t("trendTitle"))}" style="width:100%;height:auto;display:block">${parts.join("")}</svg>`;
}

/**
 * 堆叠面积 SVG（M2.1 新增；月粒度默认形态）：趋势连续性优先、保留 provider 构成。
 * 逐 id 画带状 path（自底堆叠）；null 桶断开为独立连续段；禁用平滑曲线
 * （Catmull-Rom 过冲会产生负面积视觉失真——方案 §3.3 定稿）。
 */
export function stackedAreasSvg(opts: { bars: RenderBar[]; gran: TrendGran; ticks: number[]; stackOrder: string[] }): string {
  const { bars, gran, ticks, stackOrder } = opts;
  const yMax = ticks[ticks.length - 1];
  if (bars.length === 0 || XW <= 0) return "";
  const gap = XW / bars.length;
  const yOf = (v: number): number => SVG_PT + (1 - v / yMax) * PLOT_H;
  const parts: string[] = [...gridParts(ticks, yOf)];
  const byId = bars.map((b) => new Map(b.segs.map((s) => [s.id, s.value] as const)));
  const bases = bars.map(() => 0);
  for (const id of stackOrder) {
    // 连续段：该桶无此段（或被隐藏）时断开
    let run: Array<{ x: number; top: number; bottom: number }> = [];
    const flush = (): void => {
      if (run.length === 0) return;
      let d = `M${run[0].x.toFixed(1)} ${run[0].top.toFixed(1)}`;
      for (let k = 1; k < run.length; k += 1) d += ` L${run[k].x.toFixed(1)} ${run[k].top.toFixed(1)}`;
      for (let k = run.length - 1; k >= 0; k -= 1) d += ` L${run[k].x.toFixed(1)} ${run[k].bottom.toFixed(1)}`;
      parts.push(`<path d="${d} Z" style="fill:${seriesColor(id)};fill-opacity:.26;stroke:${seriesColor(id)};stroke-width:1;stroke-opacity:.5"/>`);
      run = [];
    };
    bars.forEach((_, i) => {
      const v = byId[i].get(id);
      if (v === undefined) {
        flush();
        return;
      }
      const x = SVG_PL + gap * i + gap / 2;
      run.push({ x, top: yOf(bases[i] + v), bottom: yOf(bases[i]) });
      bases[i] += v;
    });
    flush();
  }
  // 交互命中区与柱状同构（整列透明 rect，data-bucket 委托）；空桶同样给虚位（两形态一致）
  bars.forEach((b, i) => {
    const cx = SVG_PL + gap * i + gap / 2;
    const inner = b.none
      ? `<rect x="${(cx - Math.max(1.5, Math.min(9, gap * 0.31))).toFixed(1)}" y="${(SVG_H - SVG_PB - 2).toFixed(1)}" width="${Math.max(3, Math.min(18, gap * 0.62)).toFixed(1)}" height="2" rx="1" style="fill:var(--dsw-alias-label-tertiary,#9aa0ab);fill-opacity:.45"/>`
      : "";
    parts.push(bucketGroup(i, cx - gap / 2, gap, inner));
  });
  parts.push(...axisLabelParts(bars, gran));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${SVG_H}" role="img" aria-label="${escHtml(t("trendTitle"))}" style="width:100%;height:auto;display:block">${parts.join("")}</svg>`;
}
