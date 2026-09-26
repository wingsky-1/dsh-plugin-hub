/**
 * dsh-provider-usage — 内置智谱 Coding Plan (CN) 适配器（v2 契约；provider zai-coding-cn）。
 *
 * 接口实测结论（2026-08-27 真 key 实测，含响应示例；社区 opencode-glm-quota 同款三域名）：
 * - 端点：`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`（**平台级固定路径，
 *   不拼接 baseURL 的 /api/coding/paas/v4 段**——那是模型调用入口；OpenTokenUsage 文档
 *   的 `/api/biz/monitor/...` 是错的）。
 * - 响应：`{ code: 200, data: { limits: [...], level: "lite" } }`：
 *   · `CREDIT_LIMIT unit=3,number=5` → 5h 窗口（usage/currentValue/remaining/percentage/nextResetTime）；
 *   · `CREDIT_LIMIT unit=6,number=1` → 周窗口（**按 unit 而非 number 判定窗口**）；
 *   · `percentage` = **服务端权威口径**：5h 刚重置时 `usage=2000,currentValue=0,remaining=2000,
 *     percentage=0`（用量 0%）；周用满时 `percentage=100`——勿用 remaining/total 自行推断
 *     （remaining 是剩余量，混用会算反）；
 *   · `TIME_LIMIT` 本用户套餐无（工具配额类，见 opencode-glm-quota 处理）；
 *   · `data.level` = 套餐等级（lite/pro/max），替代国际站的 subscription/list。
 * - 网关对未知路径也回 HTTP 200 + `{code:404,...}`，**必须校验业务码**：`raw.code !== 200 → bad-data`。
 *
 * 展示：
 * - 胶囊：`5h 0% · 周 100% · Lite`（窗口短名百分比 + 套餐等级；百分比 = percentage 权威口径）；
 * - 面板：两卡 miniAreaSvg（5h / 周 各一，period 取 nextResetTime 相对窗口，dateOnly=false）
 *   + 工具（TIME_LIMIT）卡条件渲染（currentValue/usage 条形示意）；
 * - capsule stale 带值降级分支：有数据正常渲染 + 缓存尾注（见 formatCapsule）。
 *
 * 本文件为 .mjs 权威实现；图表走注入的 `input.utils`（宿主管线强制注入
 * ADAPTER_UTILS），无注入回退文件内兜底副本；toNumber/clampPct/toEpochMs/pctOfLimit/
 * getJson（含业务码校验）留在文件内。
 */

/** 内置适配器认领的 provider 名（DSH 内置预设：智谱 Coding Plan (CN)）。 */
export const ZAI_CODING_CN_PROVIDER = "zai-coding-cn";

/** 内置适配器唯一名。 */
export const ZAI_CODING_CN_ADAPTER_ID = "zai-coding-cn-builtin";

/**
 * 智谱 Coding Plan (CN) 用量接口路径（平台级固定端点，**不**从 baseURL 拼接——
 * baseURL `https://open.bigmodel.cn/api/coding/paas/v4` 是模型调用入口，quota 接口
 * 为 `https://open.bigmodel.cn/api/monitor/usage/quota/limit`（无 /biz 段；社区
 * opencode-glm-quota 同款三域名枚举）。仅当 ctx.apiEndpoint 配置了自定义主机时
 * 取其 origin + 本固定路径（支持中转/代理）。
 */
export const QUOTA_PATH = "/api/monitor/usage/quota/limit";

/** 默认 quota 端点主机（智谱开放平台）。 */
const DEFAULT_QUOTA_HOST = "https://open.bigmodel.cn";

/** 业务码：网关对未知路径回 HTTP 200 + 业务错误码，须显式校验（见 getJson）。 */
const OK_CODE = 200;

// ------------------------------------------------------------------ 数值/解析辅助（本文件私有）

/** 数值安全化：有限 number 返回原值，字符串数字转换，其余 null。 */
function toNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 百分比钳制到 [0,100]（非有限返回 null）。 */
function clampPct(v) {
  const n = toNumber(v);
  if (n === null) return null;
  return Math.min(Math.max(n, 0), 100);
}

/** 时间戳归一化：epoch 毫秒 / ISO 字符串 → epochMs 或 undefined。 */
function toEpochMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/**
 * 窗口剩余百分比（**percentage 字段优先**——服务端权威口径，实测 2026-08-27：
 * 5h 窗口刚重置 `usage=2000,currentValue=0,remaining=2000,percentage=0`（remaining=满额
 * 但 percentage=0 表示用量 0%）；周窗口 `usage=2000,currentValue=2026,remaining=0,
 * percentage=100`。故 percentage 才是正确语义，remaining/usage 推断仅作兜底——
 * 且 remaining 语义是「剩余量」时 (remaining/total) 是剩余百分比而非用量百分比，
 * 混用会算反（如 5h 窗口 remaining=2000 被误判为 100%）。
 */
function pctOfLimit(limit) {
  const percentage = toNumber(limit.percentage);
  if (percentage !== null) return clampPct(percentage);
  // 兜底：percentage 缺失时用 usage/currentValue 相对 total 推断（用量百分比）
  const total = toNumber(limit.total);
  const used = toNumber(limit.currentValue) ?? toNumber(limit.usage);
  if (total !== null && total > 0 && used !== null) return clampPct((used / total) * 100);
  return null;
}

// ------------------------------------------------------------------ fetchData

/**
 * 拉取配额（v2 fetchData）。返回归一化数据：
 * { level, windows: [{ key:"5h"|"week", percent, usage, currentValue, remaining, total,
 *   nextResetTime, unit }], tools?: { percent, currentValue, total, usageDetails? } }。
 */
/**
 * 主机判定（纯函数）：优先取 ctx.apiEndpoint 的 origin（支持中转/代理），
 * 缺省用默认主机。quota 端点是平台级固定路径——**绝不**把
 * /api/coding/paas/v4 段拼进 quota 路径。非法端点回落默认主机。
 */
export function quotaHostOf(apiEndpoint) {
  const ep = apiEndpoint && apiEndpoint.trim();
  if (!ep) return DEFAULT_QUOTA_HOST;
  try {
    const u = new URL(ep);
    if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
  } catch {
    /* 非法端点回落默认主机 */
  }
  return DEFAULT_QUOTA_HOST;
}

/** 拉取期超时/上游取消接线：返回 abort signal 与幂等收尾函数。 */
function withTimeout(ctx) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 2000);
  const onAbort = () => controller.abort();
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    finish: () => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** 窗口键判定（纯函数）：按 unit 而非 number 判定窗口
 * （实测 2026-08-27：5h=unit3/number5，周=unit6/number1）。 */
function creditWindowKey(unit) {
  if (unit === 3) return "5h";
  if (unit === 6) return "week";
  return undefined;
}

/** CREDIT_LIMIT → 窗口记录（纯函数）：未知 unit 视作不认领。 */
function creditWindowOf(lim, unit) {
  const key = creditWindowKey(unit);
  if (key === undefined) return null;
  return {
    key,
    percent: pctOfLimit(lim),
    usage: toNumber(lim.usage),
    currentValue: toNumber(lim.currentValue),
    remaining: toNumber(lim.remaining),
    total: toNumber(lim.total),
    nextResetTime: toEpochMs(lim.nextResetTime),
    unit,
  };
}

/** TIME_LIMIT → 工具配额记录（纯函数）：仅当存在时展示（本用户套餐无）。 */
function toolsQuotaOf(lim) {
  return {
    percent: clampPct(lim.percentage ?? pctOfLimit(lim)),
    currentValue: toNumber(lim.currentValue),
    total: toNumber(lim.usage) ?? toNumber(lim.total),
    usageDetails: lim.usageDetails,
  };
}

/** limits 数组归一（纯函数）：分 CREDIT_LIMIT / TIME_LIMIT 两类收集，忽略非对象项。 */
export function normalizeLimits(limits) {
  const out = { level: undefined, windows: [], tools: undefined };
  for (const lim of limits) {
    if (typeof lim !== "object" || lim === null) continue;
    if (lim.type === "CREDIT_LIMIT") {
      const win = creditWindowOf(lim, toNumber(lim.unit));
      if (win !== null) out.windows.push(win);
    } else if (lim.type === "TIME_LIMIT") {
      out.tools = toolsQuotaOf(lim);
    }
  }
  return out;
}

/**
 * 业务层取数（纯函数）：网关对未知路径也回 HTTP 200 + {code:404,...}，故业务码校验
 * 在此执行（不并入 getJson 的 HTTP/JSON 层错误映射）。limits 非数组或窗口为空皆 bad-data。
 */
export function normalizeQuotaBody(body) {
  if (!body || body.code !== OK_CODE) return null;
  const data = body.data && typeof body.data === "object" ? body.data : null;
  if (data === null || !Array.isArray(data.limits)) return null;
  const limits = normalizeLimits(data.limits);
  if (limits.windows.length === 0) return null;
  const level = typeof data.level === "string" ? data.level : undefined;
  const out = { level, windows: limits.windows };
  if (limits.tools !== undefined) out.tools = limits.tools;
  return out;
}

export async function fetchData(ctx) {
  const apiKey = ctx.apiKey;
  if (typeof apiKey !== "string" || apiKey === "") throw new Error("no-api-key");
  const url = quotaHostOf(ctx.apiEndpoint).replace(/\/+$/, "") + QUOTA_PATH;
  const guard = withTimeout(ctx);

  const out = normalizeQuotaBody(await getJson(url, apiKey, guard.signal, guard.finish));
  if (out === null) throw new Error("bad-data");
  return out;
}

/**
 * GET JSON（含业务码校验前的基础错误映射）。fetch 可注入（便于单测）。
 * 注意：业务码 `code !== 200` 的判定在调用方（本文件 fetchData）执行——这里只做
 * HTTP/JSON 层错误映射，保证「网关 200 + 业务 404」能进入业务码分支而非吞成 bad-json。
 */
async function getJson(url, apiKey, signal, finish) {
  const fetcher = globalThis.fetch;
  let res;
  try {
    res = await fetcher(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    });
  } catch (err) {
    finish();
    if (err && err.name === "AbortError") throw err;
    throw new Error("network");
  }
  finish();
  if (res.status === 401 || res.status === 403) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`http-${res.status}`);
  let parsed;
  try {
    parsed = await res.json();
  } catch {
    throw new Error("bad-json");
  }
  return parsed;
}

// ------------------------------------------------------------------ 图表兜底副本（自 charts.ts 同源，需同步；正常路径经注入 utils 消费）

/** 迷你面积图几何与字号常量。 */
const MINI_GEOM = {
  W: 320,
  H: 100,
  PL: 34,
  PR: 6,
  PT: 14,
  PB: 16,
  xw: 280,
  plotH: 70,
  fs: 9.5,
  fs100: 9,
};

/**
 * 重置时刻外推（纯函数）：resetsAt 归一化后落窗口，按周期向前外推（上限 40 步），
 * 不落到窗口起点之前。周期非正或时间戳无法归一化时返回空表。
 */
export function resetMarksOf(resetsAt, resetPeriodMs, t0, t1) {
  if (!(resetPeriodMs > 0)) return [];
  const r = toEpochMs(resetsAt);
  if (r === undefined) return [];
  const marks = [];
  if (r >= t0 && r <= t1) marks.push(r);
  let ts = r - resetPeriodMs;
  for (let guard = 0; guard < 40 && ts >= t0; guard += 1) {
    marks.push(ts);
    ts -= resetPeriodMs;
  }
  return marks;
}

/** 重置标记（纯函数渲染）：竖直虚线 + 顶部三角。 */
function resetMarkerParts(marks, xOf) {
  const parts = [];
  for (const rr of marks) {
    const rx = xOf(rr);
    parts.push(
      `<line x1="${rx.toFixed(1)}" y1="${MINI_GEOM.PT}" x2="${rx.toFixed(1)}" y2="${(MINI_GEOM.PT + MINI_GEOM.plotH).toFixed(1)}" style="stroke:var(--dsw-alias-label-tertiary,#9aa0ab);stroke-width:1;stroke-dasharray:2 3;stroke-opacity:.55"><title>窗口重置点</title></line>`,
    );
    parts.push(
      `<path d="M ${rx.toFixed(1)} ${MINI_GEOM.PT} l 3.5 3.5 l -7 0 z" style="fill:var(--dsw-alias-label-tertiary,#9aa0ab);fill-opacity:.55"/>`,
    );
  }
  return parts;
}

/** 网格三线 + 百分比标签（纯函数渲染）。 */
function gridTickParts(yOf, lo, hi) {
  const parts = [];
  for (const gv of [lo, (lo + hi) / 2, hi]) {
    const gy = yOf(gv);
    parts.push(
      `<line x1="${MINI_GEOM.PL}" y1="${gy.toFixed(1)}" x2="${MINI_GEOM.W - MINI_GEOM.PR}" y2="${gy.toFixed(1)}" style="stroke:var(--dsw-alias-border-l2,#e8eaf0);stroke-width:1;stroke-dasharray:3 3"/>`,
    );
    parts.push(
      `<text x="${MINI_GEOM.PL - 4}" y="${(gy + 3).toFixed(1)}" text-anchor="end" style="font-size:${MINI_GEOM.fs}px">${(Number.isInteger(gv) ? String(gv) : gv.toFixed(1)) + "%"}</text>`,
    );
  }
  return parts;
}

/** 100% 预警线（纯函数渲染）：仅当 100 落在域内且域宽于 0.01 时出现。 */
function limit100Parts(yOf, lo, hi) {
  if (!(lo <= 100 && 100 <= hi && hi - lo > 0.01)) return [];
  const ly = yOf(100);
  return [
    `<line x1="${MINI_GEOM.PL}" y1="${ly.toFixed(1)}" x2="${MINI_GEOM.W - MINI_GEOM.PR}" y2="${ly.toFixed(1)}" style="stroke:var(--dsw-alias-state-error-primary,#d64545);stroke-width:1;stroke-dasharray:4 3;stroke-opacity:.65"/>`,
    `<text x="${MINI_GEOM.W - MINI_GEOM.PR - 2}" y="${(ly - 3).toFixed(1)}" text-anchor="end" style="fill:var(--dsw-alias-state-error-primary,#d64545);font-size:${MINI_GEOM.fs100}px">100%</text>`,
  ];
}

/** 采样点钳到域内并投影到画布坐标（纯函数）。 */
function clampLineOf(samples, lo, hi, xOf, yOf) {
  const line = [];
  for (const s of samples) {
    line.push({ x: xOf(s.x), y: yOf(Math.min(Math.max(s.y, lo), hi)) });
  }
  return line;
}

/** 面积 + 折线 + 末点（纯函数渲染）。 */
function areaSeriesParts(line, color) {
  if (line.length < 2) return [];
  const lpts = downsampleFallback(line, 300);
  const d = smoothPathFallback(lpts);
  const first = lpts[0];
  const lastPt = lpts[lpts.length - 1];
  const bottom = MINI_GEOM.PT + MINI_GEOM.plotH;
  return [
    `<path d="${d} L ${lastPt.x.toFixed(1)} ${bottom} L ${first.x.toFixed(1)} ${bottom} Z" style="fill:${color};fill-opacity:.13"/>`,
    `<path d="${d}" style="fill:none;stroke:${color};stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round"/>`,
    `<circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="2.6" style="fill:${color};stroke:var(--dsw-alias-bg-base,#fdfdfd);stroke-width:1.2"/>`,
  ];
}

/** x 轴时间刻度（纯函数渲染）：固定 5 等分；跨日用月-日，否则时:分。 */
function axisTickParts(t0, t1, spanMs, dateOnly, xOf) {
  const parts = [];
  const stepMs = spanMs / 5;
  for (let k = 0; k <= 5; k += 1) {
    const tt = t0 + stepMs * k;
    const tx = xOf(Math.min(tt, t1));
    const d = new Date(tt);
    const label = dateOnly
      ? `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")}`
      : spanMs >= 86400000
        ? `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")}`
        : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const anchor = k === 0 ? "start" : k === 5 ? "end" : "middle";
    parts.push(
      `<text x="${tx.toFixed(1)}" y="${MINI_GEOM.H - 4}" text-anchor="${anchor}" style="font-size:${MINI_GEOM.fs}px">${label}</text>`,
    );
  }
  return parts;
}

function miniAreaSvgFallback(opts) {
  const { samples, color, lo, hi, resetsAt, resetPeriodMs, dateOnly } = opts;
  if (samples.length < 2) return "";
  const t0 = samples[0].x;
  const t1 = samples[samples.length - 1].x;
  const spanMs = t1 > t0 ? t1 - t0 : 60000;
  const xOf = (ts) => MINI_GEOM.PL + ((ts - t0) / spanMs) * MINI_GEOM.xw;
  const yOf = (pct) => MINI_GEOM.PT + ((hi - pct) / (hi - lo)) * MINI_GEOM.plotH;
  const parts = [
    ...resetMarkerParts(resetMarksOf(resetsAt, resetPeriodMs, t0, t1), xOf),
    ...gridTickParts(yOf, lo, hi),
    ...limit100Parts(yOf, lo, hi),
    ...areaSeriesParts(clampLineOf(samples, lo, hi, xOf, yOf), color),
    ...axisTickParts(t0, t1, spanMs, dateOnly, xOf),
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MINI_GEOM.W} ${MINI_GEOM.H}">${parts.join("")}</svg>`;
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

// ------------------------------------------------------------------ 适配器

/** 内置智谱 Coding Plan (CN) 适配器（v2 契约）。 */
/** 窗口键 → 胶囊标签（纯函数）。 */
export function windowLabelOf(key) {
  if (key === "5h") return "5h";
  if (key === "week") return "周";
  return key;
}

/** 窗口百分比胶囊片段（纯函数）：非 number 的窗口不出片段。 */
export function windowCapsuleParts(windows) {
  const parts = [];
  for (const w of windows) {
    if (typeof w.percent === "number") {
      parts.push(`${windowLabelOf(w.key)} ${Math.round(w.percent)}%`);
    }
  }
  return parts;
}

/** 套餐等级首字母大写（纯函数）：非串或空串不出片段。 */
export function levelCapsulePart(level) {
  if (typeof level !== "string" || level === "") return null;
  return level.charAt(0).toUpperCase() + level.slice(1).toLowerCase();
}

/** 胶囊文案（纯函数渲染）：窗口百分比 + 等级，stale 时附缓存标记。 */
export function capsuleHtml(input) {
  const e = input.esc || escFallback;
  const data = input.data || {};
  const windows = Array.isArray(data.windows) ? data.windows : [];
  const parts = windowCapsuleParts(windows);
  if (parts.length === 0) return "<span>无数据</span>";
  const level = levelCapsulePart(data.level);
  if (level !== null) parts.push(level);
  const staleMark =
    input.status === "stale" ? `<span style="opacity:.6;margin-left:6px">(缓存)</span>` : "";
  return `<span>${e(parts.join(" · "))}</span>${staleMark}`;
}

export const zaiCodingCnAdapter = {
  version: 2,
  name: ZAI_CODING_CN_ADAPTER_ID,
  label: "智谱 Coding Plan (CN)",
  providers: [ZAI_CODING_CN_PROVIDER],

  async fetchData(ctx) {
    return fetchData(ctx);
  },

  formatCapsule(input) {
    return capsuleHtml(input);
  },

  formatPanel(input) {
    const e = input.esc || escFallback;
    // 图表函数优先消费注入 utils，缺失回退文件内兜底副本
    const U = input.utils || {};
    const miniArea = U.miniAreaSvg || miniAreaSvgFallback;
    if (!Array.isArray(input.entries) || input.entries.length === 0) return "<p>暂无历史数据</p>";

    const now = input.range.end;
    const latest = input.entries[input.entries.length - 1].data;
    const windows = Array.isArray(latest.windows) ? latest.windows : [];
    if (windows.length === 0) return "<p>暂无历史数据</p>";

    const cards = [];
    // 窗口迷你图卡（5h / 周 各一）
    function collectWindowPoints(entries, key) {
      const points = [];
      for (const en of entries) {
        const pv = windowPercentOf(en.data, key);
        if (pv !== null) {
          points.push({ x: en.time, y: pv });
        }
      }
      return points;
    }
    function renderWindowCard(w) {
      const key = w.key;
      const name = windowName(key);
      const color = windowColor(key);
      const pct = typeof w.percent === "number" ? w.percent : null;
      const resetText =
        w.nextResetTime !== undefined && w.nextResetTime !== null
          ? `重置 ${fmtReset(w.nextResetTime)}`
          : "";
      // 采样序列（v2 数据形态：entries[].data.windows[].percent）
      const pcts = input.entries.map(function (en) {
        return windowPercentOf(en.data, key);
      });
      const hasPoint = pcts.some((v) => typeof v === "number");
      const head = `<div class="dou-cardHead">
        <div class="dou-cardMeta">
          <span class="dou-legendDot" style="background:${color}"></span>
          <h4 class="dou-cardName">${e(name)}</h4>
          <span class="dou-cardCur">${pct === null ? "--" : `${Math.round(pct)}%`}</span>
        </div>
        <p class="dou-cardLimit">${e(String(w.unit ?? ""))}${resetText !== "" ? ` · ${e(resetText)}` : ""}</p>
      </div>`;
      const points = collectWindowPoints(input.entries, key);
      let bodyHtml;
      if (points.length >= 2 && hasPoint) {
        const lo = Math.max(0, Math.min(...points.map((p) => p.y)) - 10);
        const hi = Math.min(100, Math.max(...points.map((p) => p.y)) + 10);
        bodyHtml = `<div class="dou-miniChart">${miniArea({
          samples: points,
          color,
          lo,
          hi,
          resetsAt: w.nextResetTime,
          resetPeriodMs: windowPeriodMs(key, w.nextResetTime, now),
          dateOnly: false,
        })}</div>`;
      } else if (input.entries.length >= 2) {
        bodyHtml = `<p class="dou-chartEmpty">该时间范围内采样不足（<2 点），随时间积累后显示。</p>`;
      } else {
        bodyHtml = `<p class="dou-chartEmpty">数据采集中：每次刷新记录一个采样点（约每 5 分钟一次），≥2 个点后显示趋势。</p>`;
      }
      return `<div class="dou-card">${head}${bodyHtml}</div>`;
    }
    for (const w of windows) {
      cards.push(renderWindowCard(w));
    }

    // 工具（TIME_LIMIT）卡条件渲染
    function renderToolsCard(latest) {
      if (latest.tools && typeof latest.tools.percent === "number") {
        const t = latest.tools;
        const used = t.currentValue;
        const total = t.total;
        const pct = Math.round(t.percent);
        let bar = "";
        if (used !== null && total !== null && total > 0) {
          const bw = Math.min(100, Math.max(0, (used / total) * 100));
          bar = `<div style="margin-top:6px;height:8px;background:var(--dsw-alias-border-l2,#e8eaf0);border-radius:4px;overflow:hidden"><div style="width:${bw.toFixed(1)}%;height:100%;background:var(--dsw-alias-state-warn-primary,#c9820b)"></div></div>`;
        }
        const toolsCard = `<div class="dou-card">
        <div class="dou-cardHead">
          <div class="dou-cardMeta">
            <span class="dou-legendDot" style="background:var(--dsw-alias-state-warn-primary,#c9820b)"></span>
            <h4 class="dou-cardName">工具额度</h4>
            <span class="dou-cardCur">${pct}%</span>
          </div>
        </div>
        <p class="dou-cardLimit">${used !== null && total !== null ? `已用 ${used} / ${total}` : ""}</p>
        ${bar}
      </div>`;
        return toolsCard;
      }
      return "";
    }

    cards.push(renderToolsCard(latest));
    return cards.join("");
  },
};

const WINDOW_NAME = { "5h": "5h 滚动", week: "每周" };
function windowName(key) {
  return WINDOW_NAME[key] ?? key;
}
const WINDOW_COLOR = { "5h": "var(--dsw-alias-state-business-primary,#3b82f6)" };
const WINDOW_COLOR_FALLBACK = "var(--dsw-alias-state-warn-primary,#c9820b)";
function windowColor(key) {
  return WINDOW_COLOR[key] ?? WINDOW_COLOR_FALLBACK;
}
function windowPercentOf(data, key) {
  const arr = Array.isArray(data.windows) ? data.windows : [];
  const v = arr.find(function (x) {
    return x && x.key === key;
  });
  return v && typeof v.percent === "number" && Number.isFinite(v.percent) ? v.percent : null;
}
/** 重置时间格式化（epochMs → 本地中文短格式）。 */
function fmtReset(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "未知";
  return d.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 窗口周期估计（ms）：优先 nextResetTime − now；缺失按 key 语义兜底。 */
function windowPeriodMs(key, nextResetTime, now) {
  if (nextResetTime !== undefined && nextResetTime !== null && Number.isFinite(nextResetTime)) {
    const diff = nextResetTime - now;
    if (diff > 0 && diff < 45 * 86400000) return diff;
  }
  return key === "5h" ? 5 * 3600000 : 7 * 86400000;
}
