/**
 * dsh-provider-usage — 内置 OpenCode Go 适配器（v2 新契约格式，展示逻辑与旧版一致）。
 *
 * 行为保持（对齐 v1 客户端渲染器 renderers/opencode-go.ts）：
 * - 胶囊：三窗口短名百分比文案 "5h 3% · 周 1% · 月 0%"
 * - 面板：三窗口迷你图卡片（图例点/名称/当前百分比/趋势/限额/重置时间），
 *   每窗口独立自适应 y 轴、100% 配额参考线、重置标记线、平滑面积图、
 *   降采样（≤300 点）、x 轴时间刻度（含手机字号补偿语义）
 * - 色板与观察周期沿用旧 CHART_SERIES（主题变量 + 浅色回退，明暗自适应）
 *
 * #215 mjs 化：本文件为 .mjs 权威实现（供 adapter-guide 引导 agent 参照编写）。
 * 图表与日界函数一律经注入的 `input.utils`（PanelInput.utils / FetchContext.utils）
 * 消费（宿主管线强制注入 ADAPTER_UTILS，见 pipeline/v2.ts）；无注入时回退文件内
 * 私有兜底副本。以下为自 charts.ts 收编的同源函数（mjs 无法 import 编译后 charts）：
 * fmtAxisTime / axisLabelWidthPx / niceStep / niceDomain / fmtPctTick / timeTickStep /
 * timeTicks / trendOf / resetTicks / downsample / smoothPath / miniAreaSvg。
 * 其余业务逻辑（窗口模型/解析/fetchData/formatCapsule）保持本文件私有。
 *
 * 宿主端渲染：formatPanel 直接返回 SVG/HTML 字符串，客户端 innerHTML 注入，
 * 样式复用 style.css 中保留的 dou-card / dou-miniChart / dou-legendDot 等类。
 */

/** 内置适配器的 provider 名（如 "opencode-go"）。 */
export const OPENCODE_GO_PROVIDER = "opencode-go";

/** 内置适配器 id（设置面板候选名，历史割接目标桶）。 */
export const OPENCODE_GO_ADAPTER_ID = "opencode-go-builtin";

/** 官方用量接口默认地址（OpenCode Go，Anthropic 兼容 key）。 */
export const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1/usage";

/** [key, 中文名, 短名, 颜色, 展示限额, x 轴观察周期(ms), 重置周期(ms)]。 */
const CHART_SERIES = [
  ["rolling", "5h 滚动", "5h", "var(--dsw-alias-state-business-primary,#3b82f6)", 12, 12 * 3600000, 5 * 3600000],
  ["weekly", "每周", "周", "var(--dsw-alias-state-warn-primary,#c9820b)", 30, 7 * 86400000, 7 * 86400000],
  ["monthly", "每月", "月", "var(--dsw-alias-state-success-primary,#0f9d6e)", 60, 30 * 86400000, 30 * 86400000],
];

const CHART_MAX_POINTS = 300; // 降采样上限（约每像素一点）

/** 三窗口配置（供 fetchData 解析与 format 对齐）。 */
export const OPENCODE_GO_WINDOWS = CHART_SERIES.map(([key, name, short, , limit, , resetPeriodMs]) => ({
  key,
  name,
  short,
  limit: Number(limit),
  resetPeriodMs,
}));

// ------------------------------------------------------------------ 图表兜底副本（自 charts.ts 同源，需同步；正常路径经注入 utils 消费）

function fmtReset(iso) {
  if (typeof iso !== "string" || iso === "") return "未知";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function miniAreaSvgFallback(opts) {
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
  const xOf = (ts) => PL + ((ts - t0) / spanMs) * xw;
  const yOf = (pct) => PT + ((hi - pct) / (hi - lo)) * plotH;

  const parts = [];
  const resets = resetTicksFallback(resetsAt, resetPeriodMs, t0, t1);
  for (const rr of resets) {
    const rx = xOf(rr);
    parts.push(`<line x1="${rx.toFixed(1)}" y1="${PT}" x2="${rx.toFixed(1)}" y2="${(PT + plotH).toFixed(1)}" style="stroke:var(--dsw-alias-label-tertiary,#9aa0ab);stroke-width:1;stroke-dasharray:2 3;stroke-opacity:.55"><title>窗口重置点</title></line>`);
    parts.push(`<path d="M ${rx.toFixed(1)} ${PT} l 3.5 3.5 l -7 0 z" style="fill:var(--dsw-alias-label-tertiary,#9aa0ab);fill-opacity:.55"/>`);
  }
  const gridVals = [lo, (lo + hi) / 2, hi];
  for (const gv of gridVals) {
    const gy = yOf(gv);
    parts.push(`<line x1="${PL}" y1="${gy.toFixed(1)}" x2="${(W - PR)}" y2="${gy.toFixed(1)}" style="stroke:var(--dsw-alias-border-l2,#e8eaf0);stroke-width:1;stroke-dasharray:3 3"/>`);
    parts.push(`<text x="${(PL - 4)}" y="${(gy + 3).toFixed(1)}" text-anchor="end" style="font-size:${fs}px">${fmtPctTickFallback(gv)}</text>`);
  }
  if (lo <= 100 && 100 <= hi && hi - lo > 0.01) {
    const ly = yOf(100);
    parts.push(`<line x1="${PL}" y1="${ly.toFixed(1)}" x2="${(W - PR)}" y2="${ly.toFixed(1)}" style="stroke:var(--dsw-alias-state-error-primary,#d64545);stroke-width:1;stroke-dasharray:4 3;stroke-opacity:.65"/>`);
    parts.push(`<text x="${(W - PR - 2)}" y="${(ly - 3).toFixed(1)}" text-anchor="end" style="fill:var(--dsw-alias-state-error-primary,#d64545);font-size:${fs100}px">100%</text>`);
  }
  const line = [];
  for (const s of samples) {
    const clamped = Math.min(Math.max(s.y, lo), hi);
    line.push({ x: xOf(s.x), y: yOf(clamped) });
  }
  if (line.length >= 2) {
    const lpts = downsampleFallback(line, CHART_MAX_POINTS);
    const d = smoothPathFallback(lpts);
    const first = lpts[0];
    const lastPt = lpts[lpts.length - 1];
    const bottom = PT + plotH;
    const areaD = `${d} L ${lastPt.x.toFixed(1)} ${bottom} L ${first.x.toFixed(1)} ${bottom} Z`;
    parts.push(`<path d="${areaD}" style="fill:${color};fill-opacity:.13"/>`);
    parts.push(`<path d="${d}" style="fill:none;stroke:${color};stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round"/>`);
    parts.push(`<circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="2.6" style="fill:${color};stroke:var(--dsw-alias-bg-base,#fdfdfd);stroke-width:1.2"/>`);
  }
  const labelPx = axisLabelWidthPxFallback(spanMs, fs, dateOnly);
  const minGapMs = (labelPx * spanMs) / xw;
  const ticks = timeTicksFallback(t0, t1, minGapMs);
  for (let k = 0; k < ticks.length; k += 1) {
    const tx = xOf(ticks[k]);
    const anchor = k === 0 ? "start" : k === ticks.length - 1 ? "end" : "middle";
    parts.push(`<text x="${tx.toFixed(1)}" y="${(H - 4)}" text-anchor="${anchor}" style="font-size:${fs}px">${fmtAxisTimeFallback(ticks[k], spanMs, dateOnly)}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

function fmtAxisTimeFallback(ts, spanMs, dateOnly) {
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

function axisLabelWidthPxFallback(spanMs, fontSizePx, dateOnly) {
  let chars;
  if (dateOnly) chars = "MM-dd".length;
  else if (spanMs >= 7 * 86400000) chars = "MM-dd".length;
  else if (spanMs >= 86400000) chars = "MM-dd HH:mm".length;
  else chars = "HH:mm".length;
  return Math.ceil(chars * fontSizePx * 0.62) + 4;
}

function niceStepFallback(raw) {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm < 1.5) return mag;
  if (norm < 3.5) return 2 * mag;
  if (norm < 7.5) return 5 * mag;
  return 10 * mag;
}

function niceDomainFallback(pcts) {
  const vals = [];
  for (const v of pcts) if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
  if (vals.length === 0) return [0, 100];
  let dmin = vals[0];
  let dmax = vals[0];
  for (const v of vals) {
    if (v < dmin) dmin = v;
    if (v > dmax) dmax = v;
  }
  const step = niceStepFallback((dmax - dmin) / 3);
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

function fmtPctTickFallback(v) {
  return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + "%";
}

function timeTickStepFallback(spanMs) {
  if (spanMs <= 10 * 60000) return 2 * 60000;
  if (spanMs <= 45 * 60000) return 5 * 60000;
  if (spanMs <= 3 * 3600000) return 15 * 60000;
  if (spanMs <= 12 * 3600000) return 3600000;
  if (spanMs <= 3 * 86400000) return 3 * 3600000;
  if (spanMs <= 7 * 86400000) return 6 * 3600000;
  if (spanMs <= 30 * 86400000) return 86400000;
  return 7 * 86400000;
}

function timeTicksFallback(t0, t1, minGapMs) {
  let step = timeTickStepFallback(t1 - t0);
  const gapOk = (s) => !(minGapMs > 0) || s >= minGapMs;
  for (let guard = 0; guard < 8; guard += 1) {
    const first = Math.ceil(t0 / step) * step;
    let count = 0;
    for (let t = first; t <= t1 + 1; t += step) count += 1;
    if (count <= 6 && gapOk(step)) break;
    step *= 2;
  }
  const out = [];
  const start = Math.ceil(t0 / step) * step;
  for (let tt = start; tt <= t1 + 1; tt += step) out.push(tt);
  if (out.length < 2) return [t0, t1];
  return out;
}

function trendOfFallback(pcts) {
  let first = null;
  let last = null;
  for (const v of pcts) if (typeof v === "number") { first = v; break; }
  for (let j = pcts.length - 1; j >= 0; j -= 1) if (typeof pcts[j] === "number") { last = pcts[j]; break; }
  if (first === null || last === null) return null;
  const d = last - first;
  return { delta: Math.round(d * 10) / 10, up: d > 0.05, down: d < -0.05 };
}

function resetTicksFallback(resetsAt, periodMs, t0, t1) {
  if (typeof resetsAt !== "string" || resetsAt === "" || !(periodMs > 0)) return [];
  const r = new Date(resetsAt).getTime();
  if (Number.isNaN(r)) return [];
  const out = [];
  if (r >= t0 && r <= t1) out.push(r);
  let ts = r - periodMs;
  for (let guard = 0; guard < 40 && ts >= t0; guard += 1) {
    out.push(ts);
    ts -= periodMs;
  }
  out.sort((a, b) => a - b);
  return out;
}

function downsampleFallback(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out = [];
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

function smoothPathFallback(pts) {
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

/** HTML 转义兜底（契约入参 esc 助手同语义；含引号转义）。 */
function escFallback(s) {
  if (s === null || s === undefined) return "";
  const str = typeof s === "string" ? s : String(s);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * miniChartSvgMarkup 兼容导出（#150 测试导入面保留）：等同于图表工具集注入版的
 * miniAreaSvg（resetsAt 支持 ISO 字符串 / epochMs）。新代码请使用注入的
 * `input.utils.miniAreaSvg`（#215）；本导出仅维持 index re-export 面不破。
 */
export function miniChartSvgMarkup(opts) {
  const { samples, color, lo, hi, resetsAt, resetPeriodMs, dateOnly } = opts;
  return miniAreaSvgFallback({
    samples,
    color,
    lo,
    hi,
    resetsAt: resetsAt !== undefined && typeof resetsAt !== "number" ? resetsAt : resetsAt,
    resetPeriodMs,
    dateOnly,
  });
}

// ------------------------------------------------------------------ 窗口数据模型

/** 防御式窗口解析：任意输入 → 归一化窗口数据（percent 可为 null）。 */
export function pickWindow(w, key, name, limit) {
  if (typeof w !== "object" || w === null) return null;
  const rec = w;
  const percent = typeof rec.percent === "number" ? rec.percent : Number(rec.percent);
  return {
    key,
    name,
    percent: Number.isFinite(percent) ? percent : null,
    raw: typeof rec.raw === "string" ? rec.raw : undefined,
    limit,
    resetsAt: typeof rec.resetsAt === "string" ? rec.resetsAt : undefined,
  };
}

/** 解析用量响应体（兼容 {usage:{...}} 与直接三键两种形状）。 */
export function parseUsageResponse(body) {
  if (typeof body !== "object" || body === null) return null;
  const rec = body;
  const usage = rec.usage && typeof rec.usage === "object" ? rec.usage : rec;
  const out = {};
  for (const w of OPENCODE_GO_WINDOWS) {
    const picked = pickWindow(usage[w.key], w.key, w.name, w.limit);
    if (picked !== null) out[w.key] = picked;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 调用官方用量接口（fetch 可注入，便于单测）。
 * 新契约 fetchData：入参由插件注入 apiEndpoint/staticPath/apiKey。
 * 返回 { rolling: {percent, raw?, limit, resetsAt?}, weekly: {...}, monthly: {...} }。
 */
export async function fetchOpenCodeGoV2(ctx, fetchImpl) {
  if (typeof ctx.apiKey !== "string" || ctx.apiKey === "") {
    throw new Error("no-api-key");
  }
  const url = (ctx.apiEndpoint || DEFAULT_BASE_URL) + ctx.staticPath;
  const fetcher = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 2000);
  const onAbort = () => controller.abort();
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  const finish = () => {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onAbort);
  };
  let res;
  try {
    res = await fetcher(url, {
      headers: { Authorization: `Bearer ${ctx.apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch {
    finish();
    throw new Error("network");
  }
  if (res.status === 401 || res.status === 403) {
    finish();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    finish();
    throw new Error(`http-${res.status}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    finish();
    throw new Error("bad-json");
  } finally {
    finish();
  }
  const parsed = parseUsageResponse(body);
  if (parsed === null) throw new Error("bad-data");
  // 归一化数据：窗口数组（供历史落盘与 format 使用）
  const data = {};
  for (const w of OPENCODE_GO_WINDOWS) {
    data[w.key] = parsed[w.key] ?? { key: w.key, name: w.name, percent: null, limit: w.limit };
  }
  return data;
}

// ------------------------------------------------------------------ 适配器

/** 内置 OpenCode Go 适配器（v2 新契约，展示逻辑与 v1 一致）。 */
export const openCodeGoAdapter = {
  version: 2,
  name: OPENCODE_GO_ADAPTER_ID,
  label: "OpenCode Go 官方",
  providers: [OPENCODE_GO_PROVIDER],

  async fetchData(ctx) {
    return fetchOpenCodeGoV2(ctx);
  },

  formatCapsule(input) {
    const e = input.esc || escFallback;
    const text =
      OPENCODE_GO_WINDOWS
        .map((w) => {
          const v = (input.data[w.key] ?? { percent: null });
          return { w, v };
        })
        .filter(({ v }) => typeof v.percent === "number")
        .map(({ w, v }) => `${w.short} ${v.percent}%`)
        .join(" · ") || "无数据";
    // 纯文本胶囊（v1 语义：无内联加粗，样式由 .dou-label 控制）
    return `<span>${e(text)}</span>`;
  },

  formatPanel(input) {
    const e = input.esc || escFallback;
    // #215 注入面：图表函数优先消费注入 utils，缺失回退文件内兜底副本
    const U = input.utils || {};
    const miniArea = U.miniAreaSvg || miniAreaSvgFallback;
    const niceDomain = U.niceDomain || niceDomainFallback;
    const trendOf = U.trendOf || trendOfFallback;
    if (input.entries.length === 0) return "<p>暂无历史数据</p>";

    const cards = [];
    // 最新一条的窗口数据（卡片头当前百分比/重置时间用）
    const latest = input.entries[input.entries.length - 1].data;

    for (let ci = 0; ci < CHART_SERIES.length; ci += 1) {
      const s = CHART_SERIES[ci];
      const key = s[0];
      const color = s[3];
      const limit = s[4];
      const obsMs = s[5];
      const period = s[6];
      const win = latest[key];
      const pct = win && typeof win.percent === "number" ? win.percent : null;
      const resetsAt = win?.resetsAt;

      // 采样序列（v2 数据形态：entries[].data[key].percent）
      const pcts = input.entries
        .filter((en) => {
          if (obsMs > 0) {
            const tail = input.entries[input.entries.length - 1].time;
            return en.time >= tail - obsMs;
          }
          return true;
        })
        .map((en) => {
          const v = (en.data[key] ?? { percent: null });
          return typeof v.percent === "number" && Number.isFinite(v.percent) ? v.percent : null;
        });
      const hasPoint = pcts.some((v) => typeof v === "number");

      // 卡片头
      const resetText = resetsAt !== undefined && resetsAt !== "" ? `重置 ${fmtReset(resetsAt)}` : "";
      const trend = trendOf(pcts);
      const trendHtml =
        trend === null
          ? ""
          : trend.up
            ? `<span class="dou-trend-up" title="较区间首个采样点">▲ +${trend.delta}%</span>`
            : trend.down
              ? `<span class="dou-trend-down" title="较区间首个采样点">▼ ${trend.delta}%</span>`
              : `<span class="dou-trend-flat" title="较区间首个采样点">— ${trend.delta}%</span>`;
      const head = `<div class="dou-cardHead">
        <div class="dou-cardMeta">
          <span class="dou-legendDot" style="background:${color}"></span>
          <h4 class="dou-cardName">${e(s[1])}</h4>
          <span class="dou-cardCur">${pct === null ? "--" : `${pct}%`}</span>
          ${trendHtml}
        </div>
        <p class="dou-cardLimit">限额 ${e(String(limit))}${resetText !== "" ? ` · ${e(resetText)}` : ""}</p>
      </div>`;

      // 迷你图：构造 {x:time, y:pct} 序列
      const points = [];
      const tail = input.entries[input.entries.length - 1].time;
      for (const en of input.entries) {
        if (obsMs > 0 && en.time < tail - obsMs) continue;
        const v = (en.data[key] ?? { percent: null });
        if (typeof v.percent === "number" && Number.isFinite(v.percent)) {
          points.push({ x: en.time, y: v.percent });
        }
      }

      let bodyHtml;
      if (points.length >= 2 && hasPoint) {
        const domain = niceDomain(points.map((p) => p.y));
        bodyHtml = `<div class="dou-miniChart">${miniArea({
          samples: points,
          color,
          lo: domain[0],
          hi: domain[1],
          resetsAt,
          resetPeriodMs: period,
          dateOnly: key === "weekly" || key === "monthly",
        })}</div>`;
      } else if (input.entries.length >= 2) {
        bodyHtml = `<p class="dou-chartEmpty">该时间范围内采样不足（<2 点），随时间积累后显示。</p>`;
      } else {
        bodyHtml = `<p class="dou-chartEmpty">数据采集中：每次刷新记录一个采样点（约每 5 分钟一次），≥2 个点后显示趋势。</p>`;
      }

      cards.push(`<div class="dou-card">${head}${bodyHtml}</div>`);
    }

    // 与 v1 结构一致：卡片直接进 .dou-charts 容器（无额外 wrapper）
    return cards.join("");
  },
};
