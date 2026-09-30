/**
 * dsh-provider-usage — 使用趋势纯函数层。
 *
 * 从 trend.tsx 拆出的零 React 依赖模块：格式化 / 档位生成 / 桶键语义 / SVG 生成器。
 * 单测可直接 node 加载（trend.tsx 顶部 import react，node 测试环境不可用）。
 * 宿主聚合数据（provider 名/键）不受信，凡进 SVG 文本一律 escHtml；
 * tooltip 走 React 文本节点（trend.ts 内），不经本模块。
 */
import { escHtml } from "../shared/charts.ts";
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
export function trendDelta(
  cur: number | null,
  prev: number | null,
  prevComplete = true,
): { text: string; up: boolean; down: boolean } | null {
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
  if (gran === "month")
    return t("trendPeakMonth", { y: key.slice(0, 4), m: String(Number(key.slice(5, 7))) });
  const day = key.slice(5);
  return gran === "week" ? t("trendPeakWeek", { day }) : t("trendPeakDay", { day });
}

/** 桶的起点本地日 key（边缘判定用；day=自身 / week=周一键即起点 / month=当月 1 日）。 */
export function bucketStartKey(key: string, gran: TrendGran): string {
  if (gran === "month") return `${key}-01`;
  return key; // day 与 week（week 键本身即周一首日）
}

// ---------------------------------------------------------------- 目录维度展示

/**
 * 未识别目录桶键（与宿主 TREND_UNIDENTIFIED 字面一致；客户端不 import 宿主模块，
 * 字面一致性由 smoke 源码契约断言锁定）。
 */
export const DIR_UNIDENTIFIED = "(unidentified)";

/**
 * 目录段堆叠 id（目录面段 id；与 provider 面 partId 同构——目录行 model 恒 null）。
 * 宿主响应不受信：dir 非字符串（null/缺失）防御归未识别桶，防异常值进 stackOrder/
 * hidden 集合与图例渲染（B3 客户端侧兜底）。
 */
export function dirStackId(dir: unknown): string {
  return typeof dir === "string" && dir.length > 0 ? dir : DIR_UNIDENTIFIED;
}

/**
 * 目录键 → 展示名（B2/B3）：
 * - 未识别桶键 → i18n「未识别」人话（恒出现为有标签条目，不空串不消失）；
 * - 空串/非字符串/剥控制字符后为空 → 归未识别展示（宿主 sanitize 后理论不可达，
 *   客户端防御兜底，杜绝异常值渲染为空标签）；
 * - 其余原样展示（宿主落盘即 basename 净化值，无路径分隔符无控制字符）。
 * 纯展示转换：value 仍用原始键（筛选参数、图例 id），display 只进文本节点。
 */
export function dirDisplayLabel(dir: unknown): string {
  if (typeof dir !== "string" || dir.length === 0) return t("trendDirUnidentified");
  if (dir === DIR_UNIDENTIFIED) return t("trendDirUnidentified");
  // 剥控制字符与宿主 sanitizeDirName 同口径（C0 + DEL + C1：0x00-1F / 0x7F /
  // 0x80-9F；权威定义在 collect/types.ts，出口各处口径一致）
  const cleaned = dir.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  if (cleaned.length === 0 || cleaned.trim().length === 0) return t("trendDirUnidentified");
  return cleaned;
}

/**
 * 目录图例/下拉条目是否携带口径注释（title）：未识别桶注明「无目录信息的会话」
 * 口径（B2 UI 注明面）；具名目录不加注释（title 悬停内容与目录名重复无信息量）。
 */
export function dirNeedsScopeNote(dir: unknown): boolean {
  return dirDisplayLabel(dir) === t("trendDirUnidentified");
}

// ---------------------------------------------------------------- 目录/适配器两维互斥

/**
 * /trend 请求参数构造（从 trend.tsx useEffect 抽出的纯函数；含两维三态互斥）：
 * - dirFilter 非空 → dir=<键>（目录过滤面，宿主返回该目录子集 + dirs 图例）；
 * - 否则 provider 为空 → byDir=1（「全部目录」全目录拆段面，多目录可区分）；
 * - 否则（adapter 过滤，含 byModel）→ 纯 provider 面请求，零目录参数。
 * 两维数据面互斥：目录面无 provider 数据，provider=X × byDir=1 交叉必空——
 * 参数层三态杜绝交叉面发出（渲染层控件隐藏只是第二道防线）。
 * n 键写入值取 range（组件解析后的生效档位；现调用点 n 与 range 同源
 * effectiveRange 恒等传入，签名保留「请求意图 / 生效档位」双分位）。
 */
export function trendRequestParams(
  gran: string,
  metric: string,
  n: number,
  provider: string,
  byModel: boolean,
  dirFilter: string,
  range: number,
): URLSearchParams {
  const params = new URLSearchParams({ granularity: gran, metric, n: String(range) });
  if (dirFilter !== "") params.set("dir", dirFilter);
  else if (provider === "") params.set("byDir", "1");
  if (provider !== "") params.set("provider", provider);
  if (byModel) params.set("byModel", "1");
  return params;
}

/**
 * 统计口径档位（A1 L1）。宿主 /trend 有两个**互斥数据面**：目录面（byDir=1 / dir=）
 * 与 provider 面（provider= / byModel=），目录行不带 provider 关联。
 * 「模型」档当前不可选：宿主 dirStacked 忽略 byModel（ui-routes/trend.ts:135），
 * 点了必然落回目录面——故分段器里 disabled + 就地说明，不画一个点了就空的格子。
 */
export type TrendCaliber = "dir" | "provider" | "model";

/** 口径档位表（三值恒显，永不条件渲染；顺序即分段器视觉顺序）。 */
export const CALIBERS: ReadonlyArray<TrendCaliber> = ["dir", "provider", "model"];

/** 「模型」档可用性：宿主 dirStacked 面不接 byModel，当前恒不可选。 */
export function isCaliberAvailable(c: TrendCaliber): boolean {
  return c !== "model";
}

/**
 * 口径 → /trend 请求参数（A1：三值口径取代「适配器下拉 + 目录下拉 + 按模型复选框」
 * 三个互斥清零的控件）。映射与原先三态互斥同构，但入口从一个分段器：
 * - dir      + 无对象 → byDir=1（全目录拆段面）
 * - dir      + 有对象 → dir=<键>
 * - provider + 无对象 → 不带任何目录参数（provider 面全集）
 * - provider + 有对象 → provider=<名>
 * - model                → 不可选（isCaliberAvailable 恒假），落到 provider 面
 * byModel 恒不携带：只有「模型」口径会用到它，而该口径不可选。
 */
export function trendRequestParamsFor(
  caliber: TrendCaliber,
  gran: string,
  metric: string,
  range: number,
  object: string,
): URLSearchParams {
  const params = new URLSearchParams({ granularity: gran, metric, n: String(range) });
  const face: TrendCaliber = isCaliberAvailable(caliber) ? caliber : "provider";
  if (face === "dir") {
    if (object !== "") params.set("dir", object);
    else params.set("byDir", "1");
  } else if (object !== "") {
    params.set("provider", object);
  }
  return params;
}

/**
 * 口径切换时对象筛选是否会被重置（A1：对象筛选**不静默清零**）。
 * 目录键与 provider 名是两个命名空间，跨口径携带的值必然落空 → 返回 true，
 * 调用点据此给「已重置为全部…」的可撤销提示；同名对象两边都存在则保留。
 */
export function caliberResetsObject(
  from: TrendCaliber,
  to: TrendCaliber,
  object: string,
  candidateInTo: (value: string) => boolean,
): boolean {
  if (object === "") return false;
  if (from === to) return false;
  return !candidateInTo(object);
}

/**
 * 范围档位（客户端与宿主 clamp 同一套口径；留存按「天」裁、桶数与天数是两种口径）：
 * cap = day→min(retention, 90)、week→⌈retention/7⌉、month→⌈retention/30⌉。
 * 日档封顶 90（>90 桶在设置面板绘图区糊成一面墙，更长跨度由周/月承担）。
 */
export function trendRangeOptions(gran: TrendGran, retentionDays: number): number[] {
  const retention = Math.max(1, Math.floor(retentionDays));
  const cap =
    gran === "day"
      ? Math.min(retention, 90)
      : gran === "week"
        ? Math.ceil(retention / 7)
        : Math.ceil(retention / 30);
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
 * 动态 nice 刻度：按数据最大值自动推导步长与刻度序列——
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

/**
 * Y 域刻度：口径 = 每桶全量段合计 point.total（与汇总卡「峰值」同源）——
 * 堆叠图每桶的视觉高度是段之和，按单段最大值推域时多段桶的堆叠顶必然溢出轴顶
 * （遗留：刻度算法已动态化，喂入的最大值仍是单段口径）。
 * total 含隐藏段 → hidden 不缩轴（与汇总卡全段口径一致）。
 */
export function trendYTicks(series: Array<{ total: number | null }>): {
  ticks: number[];
  top: number;
} {
  let maxV = 0;
  for (const point of series) {
    if (point.total !== null && point.total > maxV) maxV = point.total;
  }
  return niceTicks(maxV);
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

/**
 * 图表几何契约（C-1）：**viewBox 的 1 user unit = 1 CSS px**。
 *
 * 旧实现固定 viewBox 560×190 + style="width:100%;height:auto"，浏览器按容器宽把整张图
 * 等比缩小——375px 宿主弹窗实测把内容列压到 56px，缩放系数 0.100，轴文字落到 0.9px、
 * 桶命中区落到 0.5px（PC 1440 下轴字也只有 8.6px）。改为「viewBox 宽度 = 调用点用
 * ResizeObserver 实测的内容盒宽」后，字号与命中区是真实 CSS px，不再随容器缩水。
 *
 * 代价：宽度不再是模块常量，几何必须每次渲染按实测宽重算（本段所有辅助函数因此都吃
 * ChartGeom 而不再读全局常量）。**不引入 @media 断点**——.dsu-surface-card 上限 560
 * 使桌面内容列恒定，800px 平板 column 布局的内容列反而比桌面宽，按视口断点会判反；
 * 窄容器判定与降级由调用点拿同一个 ResizeObserver 量出的宽度给出。
 */

/** 绘图区宽度下限（clamp）：窄于此值不画柱体，调用点走 C-3 兜底。 */
export const CHART_MIN_W = 200;
/**
 * 窄容器降级阈值（实测 375px 宿主弹窗把内容列压到 56px，远低于此值）。
 * 根因在宿主设置弹窗的容器宽度，插件侧改不了，只能在此降级、不能根治。
 */
export const CHART_FALLBACK_W = 240;
const SVG_H = 190;
const SVG_PR = 8;
const SVG_PT = 16;
const SVG_PB = 26;
const AXIS_FONT_PX = 10;
/** 10px 字号下紧凑数字串的平均字宽（实测 5~6px），用于左边距自适应。 */
const Y_LABEL_CHAR_W = 5.6;
/** 每条 X 标签至少要的横向间距（防相邻标签粘连）。 */
const X_LABEL_PITCH = 64;

/** 按实测容器宽解出的绘图区几何（所有 SVG 辅助函数的唯一坐标事实源）。 */
export interface ChartGeom {
  W: number;
  H: number;
  pl: number;
  pr: number;
  pt: number;
  pb: number;
  plotW: number;
  plotH: number;
}

/**
 * 按实测容器宽解几何：左边距随**最长 Y 刻度标签**自适应（不再写死 44px）。
 * measuredW <= 0（尚未测量 / 容器 display:none）时 clamp 到下限，调用点另行
 * 按「未测量」走空图表分支，不拿下限值当真值渲染。
 */
export function chartGeom(measuredW: number, ticks: number[]): ChartGeom {
  const W = Math.max(CHART_MIN_W, Math.round(measuredW));
  const longest = ticks.reduce((m, v) => Math.max(m, fmtCompact(v).length), 0);
  const pl = Math.max(22, Math.round(longest * Y_LABEL_CHAR_W) + 8);
  return {
    W: W,
    H: SVG_H,
    pl: pl,
    pr: SVG_PR,
    pt: SVG_PT,
    pb: SVG_PB,
    plotW: Math.max(1, W - pl - SVG_PR),
    plotH: SVG_H - SVG_PT - SVG_PB,
  };
}

/** 网格 + Y 轴刻度（两形态共用）。 */
function gridParts(g: ChartGeom, ticks: number[], yOf: (v: number) => number): string[] {
  const parts: string[] = [];
  for (const gv of ticks) {
    const gy = yOf(gv);
    parts.push(
      `<line x1="${g.pl}" y1="${gy.toFixed(1)}" x2="${(g.W - g.pr).toFixed(1)}" y2="${gy.toFixed(1)}" style="stroke:var(--dsw-alias-border-l2,#e8eaf0);stroke-width:1;${gv === 0 ? "" : "stroke-dasharray:3 3;"}"/>`,
    );
    parts.push(
      `<text x="${g.pl - 4}" y="${(gy + 3).toFixed(1)}" text-anchor="end" style="font-size:${AXIS_FONT_PX}px;fill:var(--dsw-alias-label-tertiary,#9aa0ab)">${escHtml(fmtCompact(gv))}</text>`,
    );
  }
  return parts;
}

/** X 轴标签（按实测绘图宽定条数、均匀抽稀，首尾必显）。 */
function axisLabelParts(g: ChartGeom, bars: RenderBar[], gran: TrendGran): string[] {
  const parts: string[] = [];
  const gap = g.plotW / bars.length;
  const maxLabels = Math.max(2, Math.min(8, Math.floor(g.plotW / X_LABEL_PITCH)));
  const labelStep = Math.max(1, Math.ceil(bars.length / maxLabels));
  bars.forEach((b, i) => {
    if (i % labelStep !== 0 && i !== bars.length - 1) return;
    const cx = g.pl + gap * i + gap / 2;
    const anchor = i === 0 ? "start" : i === bars.length - 1 ? "end" : "middle";
    parts.push(
      `<text x="${cx.toFixed(1)}" y="${(g.H - 8).toFixed(1)}" text-anchor="${anchor}" style="font-size:${AXIS_FONT_PX}px;fill:var(--dsw-alias-label-tertiary,#9aa0ab)">${escHtml(fmtAxisLabel(b.key, gran))}</text>`,
    );
  });
  return parts;
}

/** 桶组公共包装：data-bucket（容器事件委托锚点）+ 整列命中区。 */
function bucketGroup(g: ChartGeom, i: number, colX: number, colW: number, inner: string): string {
  return `<g data-bucket="${i}" style="cursor:pointer">${inner}<rect x="${colX.toFixed(1)}" y="${g.pt}" width="${colW.toFixed(1)}" height="${g.plotH}" style="fill:transparent"/></g>`;
}

/**
 * 峰值桶图上标注（A2：峰值不再占一张汇总卡，改成图上一个可定位的标记）。
 * 三角标 + 桶键文字都属装饰，语义仍由 tooltip / 移动端详情块承担（图上不重复播报），
 * 故整组走 aria-hidden——只加 role="img" 反而会与外层 svg 的 role="img" 争可访问名。
 */
function peakAnnotation(
  g: ChartGeom,
  peakIndex: number,
  peakKey: string,
  gran: TrendGran,
  gap: number,
): string[] {
  if (!(peakIndex >= 0) || peakKey === "") return [];
  const cx = g.pl + gap * peakIndex + gap / 2;
  return [
    `<g aria-hidden="true" style="pointer-events:none"><path d="M${cx.toFixed(1)} ${(g.pt - 8).toFixed(1)} l4 6 h-8 z" style="fill:var(--dsw-alias-state-warn-primary,#d9a13c)"/><text x="${cx.toFixed(1)}" y="${(g.pt - 11).toFixed(1)}" text-anchor="middle" style="font-size:${AXIS_FONT_PX}px;fill:var(--dsw-alias-label-tertiary,#9aa0ab)">${escHtml(fmtAxisLabel(peakKey, gran))}</text></g>`,
  ];
}

/** SVG 外壳：1 user unit = 1 CSS px（显式 px 宽高，不再 width:100%/height:auto 等比缩放）。 */
function svgShell(g: ChartGeom, parts: string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${g.W} ${g.H}" width="${g.W}" height="${g.H}" role="img" aria-label="${escHtml(t("trendTitle"))}" style="display:block;width:${g.W}px;height:${g.H}px">${parts.join("")}</svg>`;
}

/**
 * 堆叠柱状 SVG：空桶虚位、部分桶描边、data-bucket 委托锚点、月键标签修复。
 * segs 为可见段（hidden 已滤），Y 域由调用方按全量段算（隐藏不缩轴）。
 * width = 调用点实测的内容盒宽（C-1：不再等比缩放）。
 */
export function stackedBarsSvg(opts: {
  bars: RenderBar[];
  gran: TrendGran;
  ticks: number[];
  width: number;
  peakIndex?: number;
  peakKey?: string | null;
}): string {
  const { bars, gran, ticks, width, peakIndex, peakKey } = opts;
  const yMax = ticks[ticks.length - 1];
  if (bars.length === 0) return "";
  const g = chartGeom(width, ticks);
  const gap = g.plotW / bars.length;
  const barW = Math.max(2, Math.min(18, gap * 0.62));
  const yOf = (v: number): number => g.pt + (1 - v / yMax) * g.plotH;
  const parts: string[] = [...gridParts(g, ticks, yOf)];
  bars.forEach((b, i) => {
    const cx = g.pl + gap * i + gap / 2;
    const x = cx - barW / 2;
    const segs: string[] = [];
    if (b.none) {
      // 空桶虚位：统一「无数据」（tooltip 标注；挂载前/超保留期不做三态区分）
      segs.push(
        `<rect x="${x.toFixed(1)}" y="${(g.pt + g.plotH - 2).toFixed(1)}" width="${barW.toFixed(1)}" height="2" rx="1" style="fill:var(--dsw-alias-label-tertiary,#9aa0ab);fill-opacity:.45"/>`,
      );
    }
    let acc = 0;
    for (const seg of b.segs) {
      const y1 = yOf(acc);
      acc += seg.value;
      const y2 = yOf(acc);
      segs.push(
        `<rect x="${x.toFixed(1)}" y="${y2.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, y1 - y2).toFixed(1)}" rx="1" style="fill:${seriesColor(seg.id)};fill-opacity:.9"/>`,
      );
    }
    // 部分桶描边：进行中=警示色虚线；留存/起算边缘=灰点线（值天然偏低防误读）
    if (b.mark !== null && acc > 0) {
      const stroke =
        b.mark === "ongoing"
          ? "var(--dsw-alias-state-warn-primary,#d9a13c)"
          : "var(--dsw-alias-label-tertiary,#9aa0ab)";
      segs.push(
        `<rect x="${(x - 2.5).toFixed(1)}" y="${yOf(acc).toFixed(1)}" width="${(barW + 5).toFixed(1)}" height="${(g.pt + g.plotH - yOf(acc)).toFixed(1)}" rx="4" style="fill:none;stroke:${stroke};stroke-width:1;stroke-dasharray:${b.mark === "ongoing" ? "3 2" : "1.5 2.5"}"/>`,
      );
    }
    parts.push(bucketGroup(g, i, cx - gap / 2, gap, segs.join("")));
  });
  parts.push(...axisLabelParts(g, bars, gran));
  parts.push(...peakAnnotation(g, peakIndex ?? -1, peakKey ?? "", gran, gap));
  return svgShell(g, parts);
}

/**
 * 堆叠面积 SVG（趋势连续性优先、保留 provider 构成）。
 * 逐 id 画带状 path（自底堆叠）；null 桶断开为独立连续段；禁平滑曲线
 * （Catmull-Rom 过冲会产生负面积视觉失真——方案 §3.3 定稿）。
 */
export function stackedAreasSvg(opts: {
  bars: RenderBar[];
  gran: TrendGran;
  ticks: number[];
  stackOrder: string[];
  width: number;
  peakIndex?: number;
  peakKey?: string | null;
}): string {
  const { bars, gran, ticks, stackOrder, width, peakIndex, peakKey } = opts;
  const yMax = ticks[ticks.length - 1];
  if (bars.length === 0) return "";
  const g = chartGeom(width, ticks);
  const gap = g.plotW / bars.length;
  const yOf = (v: number): number => g.pt + (1 - v / yMax) * g.plotH;
  const parts: string[] = [...gridParts(g, ticks, yOf)];
  const byId = bars.map((b) => new Map(b.segs.map((s) => [s.id, s.value] as const)));
  const bases = bars.map(() => 0);
  for (const id of stackOrder) {
    // 连续段：该桶无此段（或被隐藏）时断开
    let run: Array<{ x: number; top: number; bottom: number }> = [];
    const flush = (): void => {
      if (run.length === 0) return;
      let d = `M${run[0].x.toFixed(1)} ${run[0].top.toFixed(1)}`;
      for (let k = 1; k < run.length; k += 1)
        d += ` L${run[k].x.toFixed(1)} ${run[k].top.toFixed(1)}`;
      for (let k = run.length - 1; k >= 0; k -= 1)
        d += ` L${run[k].x.toFixed(1)} ${run[k].bottom.toFixed(1)}`;
      parts.push(
        `<path d="${d} Z" style="fill:${seriesColor(id)};fill-opacity:.26;stroke:${seriesColor(id)};stroke-width:1;stroke-opacity:.5"/>`,
      );
      run = [];
    };
    bars.forEach((_, i) => {
      const v = byId[i].get(id);
      if (v === undefined) {
        flush();
        return;
      }
      const x = g.pl + gap * i + gap / 2;
      run.push({ x, top: yOf(bases[i] + v), bottom: yOf(bases[i]) });
      bases[i] += v;
    });
    flush();
  }
  // 交互命中区与柱状同构（整列透明 rect，data-bucket 委托）；空桶同样给虚位（两形态一致）
  bars.forEach((b, i) => {
    const cx = g.pl + gap * i + gap / 2;
    const inner = b.none
      ? `<rect x="${(cx - Math.max(1.5, Math.min(9, gap * 0.31))).toFixed(1)}" y="${(g.pt + g.plotH - 2).toFixed(1)}" width="${Math.max(3, Math.min(18, gap * 0.62)).toFixed(1)}" height="2" rx="1" style="fill:var(--dsw-alias-label-tertiary,#9aa0ab);fill-opacity:.45"/>`
      : "";
    parts.push(bucketGroup(g, i, cx - gap / 2, gap, inner));
  });
  parts.push(...axisLabelParts(g, bars, gran));
  parts.push(...peakAnnotation(g, peakIndex ?? -1, peakKey ?? "", gran, gap));
  return svgShell(g, parts);
}

// ---------------------------------------------------------------- B2-1 用量页聚合（纯函数：donut/热力/分担）

/** 环形扇区输入（value 非负；label 进 <title> 前 escHtml，宿主 provider 名不受信）。 */
export interface DonutInput {
  label: string;
  value: number;
  color: string;
}

/** 环形 SVG（stroke-dasharray 分段圆，-90° 起点；total<=0 只画 track；size=外径 px）。 */
export function donutSvg(segs: DonutInput[], size = 120): string {
  const r = 44;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  const total = segs.reduce((a, s) => a + (s.value > 0 ? s.value : 0), 0);
  const track = `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="var(--dsw-alias-border-l2,#e8eaf0)" stroke-width="16"/>`;
  if (total <= 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" style="width:100%;max-width:${size}px;height:auto;display:block">${track}</svg>`;
  }
  let acc = 0;
  const arcs = segs.map((s) => {
    const v = s.value > 0 ? s.value : 0;
    const frac = v / total;
    const dash = `${(frac * c).toFixed(2)} ${(c - frac * c).toFixed(2)}`;
    const off = (-acc * c).toFixed(2);
    acc += frac;
    const pct = `${(frac * 100).toFixed(1)}%`;
    return `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${s.color}" stroke-width="16" stroke-dasharray="${dash}" stroke-dashoffset="${off}" transform="rotate(-90 ${cx} ${cx})"><title>${escHtml(s.label)} ${escHtml(pct)}</title></circle>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" style="width:100%;max-width:${size}px;height:auto;display:block">${track}${arcs.join("")}</svg>`;
}
/** 日桶最小形状（本模块只读 key/total/parts，不过问宿主其余字段）。 */
export interface DayBucket {
  key: string;
  total: number | null;
  parts: Array<{ provider: string; value: number | null }>;
}

/** 窗口内按 provider 累加（null/非正跳过；降序，top 即首位）。 */
export function sumPartsByProvider(
  series: DayBucket[],
): Array<{ provider: string; value: number }> {
  const acc = new Map<string, number>();
  for (const b of series) {
    for (const p of b.parts) {
      if (typeof p.provider !== "string" || p.provider.length === 0) continue;
      if (typeof p.value !== "number" || !(p.value > 0)) continue;
      acc.set(p.provider, (acc.get(p.provider) ?? 0) + p.value);
    }
  }
  return [...acc.entries()]
    .map(([provider, value]) => ({ provider, value }))
    .sort((a, b) => b.value - a.value);
}

/** 有数据天数（total 非 null 计 1；null 三态不区分，沿 M2.1 约定）。 */
export function activeDayCount(series: DayBucket[]): number {
  let n = 0;
  for (const b of series) if (b.total !== null) n += 1;
  return n;
}

/** 热力 5 档（0=空 … 4=满；相对窗口 max 分档；max<=0 或 null 全 0）。 */
export function heatLevel(value: number | null, max: number): number {
  if (value === null || !(value > 0) || !(max > 0)) return 0;
  const r = value / max;
  if (r >= 0.75) return 4;
  if (r >= 0.5) return 3;
  if (r >= 0.25) return 2;
  return 1;
}

/** 取尾部 N 天 cells（不足 N 全取；level 按窗口 max 归一）。 */
export function heatCells(
  series: DayBucket[],
  days: number,
): Array<{ key: string; total: number | null; level: number }> {
  const tail = series.slice(Math.max(0, series.length - days));
  let max = 0;
  for (const b of tail) if (typeof b.total === "number" && b.total > max) max = b.total;
  return tail.map((b) => ({ key: b.key, total: b.total, level: heatLevel(b.total, max) }));
}
/** provider 面窗口分担 Top3 行（空窗口返回 ""，由调用方条件渲染）。 */
export function composeShares(series: DayBucket[]): string {
  const sums = sumPartsByProvider(series);
  const total = sums.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return "";
  return sums
    .slice(0, 3)
    .map((s) => `${s.provider} ${((s.value / total) * 100).toFixed(0)}%`)
    .join(" · ");
}
/** 目录维度生效判定（请求三态互斥后 provider 面不再携带 byDir/dirs）。 */
export function isDirMode(
  data: { byDir?: boolean; dirs?: Array<{ dir?: string | null }> } | null,
  dirFilter: string,
): boolean {
  return data !== null && (data.byDir === true || dirFilter !== "" || (data.dirs?.length ?? 0) > 0);
}
