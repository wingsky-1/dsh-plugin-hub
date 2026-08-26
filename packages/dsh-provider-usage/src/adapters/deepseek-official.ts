/**
 * dsh-provider-usage — 内置 DeepSeek 官方余额适配器（v2 契约，逐函数移植自本地已验证的
 * user-file 原型 ~/.dsh/provider-usage/deepseek-official.mjs，issue #198）。
 *
 * 对齐纪律：守恒式推算、GAP_MS=27h 中断判定、TOL/ANOMALY 分层、六态错误路径
 * （含 AbortError 重抛）、严格金额解析、官方域名 /v1 前缀剥离等全部与原型一致；
 * 有意差异仅两处并在下方标注：
 * 1. name 采用 `deepseek-official-builtin`（原型为 `deepseek-official`，与 provider 同名），
 *    对齐 opencode-go-builtin 先例——避免与用户已装 user-file 原型在 registeredNames 冲突被拒收；
 * 2. 新增峰谷倒计时徽标（原型无此功能）：UTC 工作日固定峰窗常量 + 纯本地时间计算。
 *
 * 数据模型（与原型一致）：
 * - 官方 API 无用量接口，每日用量由余额差守恒式推算：
 *     usage = (totalPrev − totalCur) + ΔtoppedUp + Δgranted
 *   分量缺失逐项独立退化（缺 granted 只跳该项继续 toppedUp 修正，反之亦然）。
 * - fetchData 只返回展示所需最小数据集（按天落盘 JSONL）；外部字符串拼 HTML 一律 esc()。
 */
import type {
  UsageStatsAdapter,
  FetchContext,
  CapsuleInput,
  PanelInput,
} from "../contracts.ts";
import { esc } from "../contracts.ts";

/** 内置适配器认领的 provider 名（与会话模型 provider 精确匹配）。 */
export const DEEPSEEK_OFFICIAL_PROVIDER = "deepseek-official";

/** 内置适配器唯一名（有意差异 1：加 -builtin 后缀，见文件头注释）。 */
export const DEEPSEEK_OFFICIAL_ADAPTER_ID = "deepseek-official-builtin";

/** DeepSeek 官方 API 基础地址。 */
export const BASE_URL = "https://api.deepseek.com";

/** 取可用 API Key：优先插件配置链注入，其次兜底自查 DEEPSEEK_API_KEY（与 llm 层共用，
 *  覆盖「llm 能跑、余额接口 401」场景；该兜底属适配器实现细节，不在共享 provider-config 层特判）。 */
function resolveApiKey(apiKey: string | undefined): string | undefined {
  if (apiKey && apiKey.length > 0) return apiKey;
  try {
    const v = process.env.DEEPSEEK_API_KEY;
    if (v && v.length > 0) return v;
  } catch { /* 环境变量读取失败视为缺失 */ }
  return undefined;
}

/** 严格金额解析：仅接受可转为有限数字的字符串，其余返回 null（杜绝 NaN 静默落盘）。 */
export function parseAmount(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 构造查询余额接口 URL：官方域名剥掉 OpenAI 兼容的 /v1 前缀，其余显式端点原样拼接；尾斜杠归一。 */
export function resolveEndpoint(apiEndpoint: string | undefined): string {
  const base = (apiEndpoint && apiEndpoint.trim()) || BASE_URL;
  const root = /^https?:\/\/api\.deepseek\.com/i.test(base)
    ? base.replace(/\/v1\/?$/i, "")
    : base;
  return root.replace(/\/+$/, "") + "/user/balance";
}

/** HTML 转义（契约入参的 esc 助手同语义，宿主端兜底；含引号转义，元素内容上下文用）。 */
function h(s: unknown): string {
  const str = s === null || s === undefined ? "" : String(s);
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 属性上下文转义：不信任宿主 esc 一定转义引号，属性插值一律走本函数。 */
function ea(s: unknown): string {
  return h(s);
}

/** 数值安全化：非有限返回 null；有限则 clamp 到 [min,max] 再返回。 */
function fin(v: number, min = -Number.MAX_VALUE, max = Number.MAX_VALUE): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(Math.max(v, min), max);
}

// ---------------------------------------------------------------- 共用常量（与原型一致）

const DAY_MS = 86400000;
/** 相邻代表点跨度超过该值视为采样中断（略大于一个采样周期 5min 的多倍冗余）。 */
export const GAP_MS = 27 * 3600000;
/** 金额容差（浮点噪声 + 「无消耗」判定）。 */
export const TOL = 0.005;
/** 大额负向净变动的异常阈值（低于它不画柱只标注）。 */
export const ANOMALY_NEG = -1;

// ================================================================ 峰谷时段（内置版新增，有意差异 2）
//
// DeepSeek 官方错峰定价时段（UTC 工作日固定窗口，硬编码常量、无配置项）。
// 来源：https://api-docs.deepseek.com/quick_start/pricing （错峰折扣时段说明）
// 核实日期：2026-08-26。官方如调整时段须改码发布，不做运行时可配。

/**
 * 峰值窗口表（UTC 分钟数，[start,end) 半开区间；仅周一至周五生效，周末全天谷）。
 * [[01:00,04:00], [06:00,10:00]]（UTC）。
 */
export const PEAK_WINDOWS_UTC: Array<readonly [number, number]> = [
  [60, 240],   // 01:00–04:00 UTC
  [360, 600],  // 06:00–10:00 UTC
];

/** 单时刻峰谷判定（纯函数）：UTC 工作日 + 分钟粒度半开区间（毫秒级边界语义等价：
 *  03:59:59.999 属峰、04:00:00.000 即属谷——分钟数不受秒/毫秒影响）。 */
export function isPeakUtc(t: number): boolean {
  const d = new Date(t);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false; // 周末全天低谷
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  for (const [startMin, endMin] of PEAK_WINDOWS_UTC) {
    if (min >= startMin && min < endMin) return true;
  }
  return false;
}

/**
 * 下一次峰谷转换点（纯函数）：返回严格晚于 t 的最近转换边界与目标状态。
 * 谷态找下一个开峰（跨周末跳到下周一），峰态找本窗口切谷时刻。
 */
export function nextPeakTransition(t: number): { toPeak: boolean; at: number } {
  const peakNow = isPeakUtc(t);
  const cur = new Date(t);
  const y = cur.getUTCFullYear();
  const m = cur.getUTCMonth();
  const d0 = cur.getUTCDate();
  for (let off = 0; off <= 7; off += 1) {
    // 周末全天谷：不存在任何峰窗边界，直接跳过（否则会把周末 01:00 误当开峰点）
    const dow = new Date(Date.UTC(y, m, d0 + off)).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (const [startMin, endMin] of PEAK_WINDOWS_UTC) {
      // 同日内 start<end 且窗口按序排列，[start,end] 对遍历天然时间有序；
      // 第一个严格大于 t 且引起状态翻转的边界即答案
      for (const [min, toPeak] of [[startMin, true], [endMin, false]] as Array<readonly [number, boolean]>) {
        const at = Date.UTC(y, m, d0 + off, 0, min, 0, 0);
        if (at > t && toPeak !== peakNow) return { toPeak, at };
      }
    }
  }
  // 不可达（7 天内必有转换）；防御性兜底：返回一周后的同一时刻
  return { toPeak: !peakNow, at: t + 7 * DAY_MS };
}

/** 倒计时格式化 mm:ss 之外的 HH:MM 形态（向上取整到分钟，恒 ≥1 分钟，杜绝 "-00:00"/负值形态）。 */
function fmtCountdown(ms: number): string {
  const totalMin = Math.max(1, Math.ceil(ms / 60000));
  const hh = String(Math.floor(totalMin / 60)).padStart(2, "0");
  const mm = String(totalMin % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 当前进程时区名（纯环境元数据读取，无时钟依赖，仅供 tooltip 对照提示）。 */
function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

/** 峰谷倒计时徽标 HTML（纯本地时间计算，不依赖远端数据——stale 帧同样渲染）。 */
export function peakBadgeHtml(nowTs: number): string {
  const peak = isPeakUtc(nowTs);
  const tr = nextPeakTransition(nowTs);
  const countdown = fmtCountdown(tr.at - nowTs);
  const label = peak ? `⚡峰 · 距谷 ${countdown}` : `⚡谷 · 距峰 ${countdown}`;
  const windowsText = PEAK_WINDOWS_UTC
    .map(([s, e]) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}–${String(Math.floor(e / 60)).padStart(2, "0")}:${String(e % 60).padStart(2, "0")}`)
    .join("、");
  const tip = `DeepSeek 错峰计费：峰时段（UTC 工作日）${windowsText}，周末全天谷；时段定义为 UTC，与显示时区无关，倒计时按 UTC 换算（服务器时区 ${localTimeZone()}）`;
  const cls = peak ? "dou-peak dou-peak-on" : "dou-peak dou-peak-off";
  return `<span class="${cls}" title="${ea(tip)}">${h(label)}</span>`;
}

// ---------------------------------------------------------------- fetchData（六态错误路径与原型一致）

/**
 * 拉取余额（v2 fetchData，fetch 经 ctx.fetch 或 fetchImpl 注入，便于单测）。
 * 返回 { isAvailable, balance, toppedUp, grantedBalance }（仅保留 CNY 币种；
 * 后两者用于每日用量守恒式）。
 */
export async function fetchDeepSeekOfficialV2(
  ctx: FetchContext & { fetch?: typeof fetch },
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown>> {
  const key = resolveApiKey(ctx.apiKey);
  if (!key) throw new Error("no-api-key");

  const f: typeof fetch = ctx.fetch ?? fetchImpl ?? globalThis.fetch;
  const url = resolveEndpoint(ctx.apiEndpoint);

  let res: Response;
  try {
    res = await f(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: ctx.signal,
    });
  } catch (err: unknown) {
    // 超时/取消由插件 signal 负责；AbortError 重抛不被吞成 network（原型行为）
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new Error("network");
  }
  if (res.status === 401 || res.status === 403) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`http-${res.status}`);

  let body: { is_available?: unknown; balance_infos?: unknown };
  try {
    body = await res.json();
  } catch {
    throw new Error("bad-json");
  }

  // 只保留 CNY 币种（官方 balance_infos 数组，金额为字符串）；无 CNY 条目 → 全 null 正常帧（B4 修订版）
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const cny = infos.find((b: unknown): b is Record<string, unknown> => {
    return typeof b === "object" && b !== null && (b as Record<string, unknown>).currency === "CNY";
  });

  return {
    isAvailable: body.is_available === true,
    balance: parseAmount(cny?.total_balance),
    toppedUp: parseAmount(cny?.topped_up_balance),
    grantedBalance: parseAmount(cny?.granted_balance),
  };
}

// ---------------------------------------------------------------- 胶囊 + 峰谷徽标

/** 胶囊文案：CNY 余额 + 可用性/缓存标记 + 峰谷倒计时徽标（追加于余额文本之后）。 */
export function formatCapsuleWithBadge(
  { data, status }: { data: Record<string, unknown>; status: string },
  nowTs: number,
): string {
  const e = h;
  const badge = peakBadgeHtml(nowTs);
  const balance = data && typeof data.balance === "number" ? data.balance : null;
  const text = balance !== null ? `余额 ¥${balance.toFixed(2)}` : "DeepSeek 余额 --";
  const unavail = data && data.isAvailable === false
    ? `<span style="opacity:.7;margin-left:6px">(不可用)</span>`
    : "";
  const staleMark = status === "stale" ? `<span style="opacity:.6;margin-left:6px">(缓存)</span>` : "";
  return `<span>${e(text)}</span>${badge}${unavail}${staleMark}`;
}

// ================================================================ 近 15 日用量柱形图（与原型同构移植）
// 说明：日期口径 = 宿主进程本地时区（DSH web 多端访问时以宿主为准，注释声明避免误当 bug）。

/** 本地时区日期 key（禁用 toISOString —— UTC 归组会使东八区每天 00:00–08:00 的采样划入前一天）。 */
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

/** 采样代表点（有效过滤后；available=is_available 标记，缺省视为可用以兼容旧历史分片）。 */
interface SamplePoint {
  t: number;
  balance: number;
  toppedUp: number | null;
  granted: number | null;
  available: boolean;
}

/** 单日用量记录（聚合输出）。 */
interface DayRecord {
  key: string;
  status: "empty" | "insufficient" | "gap" | "anomaly" | "unavailable" | "ok";
  u: number;
  kind?: string;
  extra?: string;
  neg?: boolean;
  note?: string;
}

/**
 * 单日用量计算（守恒式口径）：
 *   usage = (totalPrev − totalCur) + ΔtoppedUp + Δgranted
 * 充值 +X：total −X、topped +X → 相消；赠款过期 −G：total −G、granted −G → 相消。
 * 分量缺失逐项独立退化（kind 标记供 tooltip 注明）。
 */
export function calcUsageDs(base: SamplePoint, cur: SamplePoint): { v: number; kind: string; extra: string } {
  let v = base.balance - cur.balance;
  let kind = "net";
  const notes: string[] = [];
  if (base.toppedUp !== null && cur.toppedUp !== null) {
    const dTop = cur.toppedUp - base.toppedUp;
    v += dTop;
    kind = "adjusted";
    if (Math.abs(dTop) > TOL) notes.push(`含充值 ¥${dTop.toFixed(2)}`);
  }
  if (base.granted !== null && cur.granted !== null) {
    const dGrant = cur.granted - base.granted;
    v += dGrant;
    if (kind !== "adjusted") kind = "adjusted";
    if (Math.abs(dGrant) > TOL) notes.push(`含赠款变动 ¥${(-dGrant).toFixed(2)}`);
  }
  return { v, kind, extra: notes.join(" · ") };
}

/**
 * 每日用量聚合。
 * 口径：闭环（基线 = 向前最近一个有采样日的末点，消除跨日缝隙）；
 * 基线缺失 → 样本不足；跨度超 GAP_MS → 数据中断（不计柱不计入汇总，防畸形巨柱）。
 */
export function aggregateDaily(pts: SamplePoint[], keys: string[], truncated: boolean): DayRecord[] {
  /** 每日末点（升序遍历后写覆盖 → 当日最后一点；重复时间戳取排序后靠后者）。 */
  const byDay = new Map<string, SamplePoint>();
  for (const p of pts) byDay.set(dayKey(p.t), p);

  // 窗口开始前的最后一个采样点作为首日基线
  let base: SamplePoint | null = null;
  for (const p of pts) {
    if (dayKey(p.t) < keys[0]) base = p; else break;
  }

  let skipFirst = truncated === true; // 数据被截断时首个可能残缺的自然日不计
  return keys.map((k): DayRecord => {
    const cur = byDay.get(k) || null;
    if (!cur) return { key: k, status: "empty", u: 0 };
    if (skipFirst) {
      skipFirst = false;
      base = cur;
      return { key: k, status: "insufficient", u: 0 };
    }
    let rec: DayRecord;
    if (!base) rec = { key: k, status: "insufficient", u: 0 };
    else if (cur.t - base.t > GAP_MS) rec = { key: k, status: "gap", u: 0 };
    // is_available=false 的帧不作为守恒端点：跳过其相邻区间的用量推算（C8；
    // 内置化新增策略，原型无此逻辑——不可用期余额变动不代表真实消耗）
    else if (base.available === false || cur.available === false) rec = { key: k, status: "unavailable", u: 0 };
    else {
      const c = calcUsageDs(base, cur);
      const v = fin(c.v);
      // 分层渲染规则：|u|≤容差 → 0；轻微负值 → 可显示的绿柱（余额净增）；大额负值 → 异常标注
      if (v === null) rec = { key: k, status: "anomaly", u: 0, note: "数值异常" };
      else if (Math.abs(v) <= TOL) rec = { key: k, status: "ok", u: 0, ...c };
      else if (v < 0 && v >= ANOMALY_NEG) rec = { key: k, status: "ok", u: v, neg: true, ...c };
      else if (v < ANOMALY_NEG) rec = { key: k, status: "anomaly", u: 0, note: `余额净增 ¥${Math.abs(v).toFixed(2)}（异常）`, ...c };
      else rec = { key: k, status: "ok", u: v, ...c };
    }
    base = cur; // 基线传递：空槽日不改写基线（向前最近非空日）
    return rec;
  });
}

/** 柱形图 y 轴上限取整到 1/2/5×10^k 的好看步长。 */
export function niceCeil(v: number): number {
  if (!(typeof v === "number" && Number.isFinite(v) && v > 0)) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return m * p;
}

/** 卡2：标题行 + 柱形 SVG + 汇总行。 */
function renderDailyUsageCard(pts: SamplePoint[], truncated: boolean, e: (s: unknown) => string, now: number): string {
  const keys = lastNDayKeys(15, now);
  const records = aggregateDaily(pts, keys, truncated);

  const sumUse = records.reduce((s, r) => s + (r.status === "ok" && !r.neg ? r.u : 0), 0);
  const mixedCaliber = records.some((r) => r.kind === "net" || r.status === "gap" || r.status === "insufficient" || r.status === "unavailable");

  const svgAttrs = [
    `role="img"`,
    `aria-label="${ea(`近15日每日用量柱形图，合计消耗约${sumUse.toFixed(2)}元`)}"`,
  ].join(" ");
  const summary = `<p style="margin:4px 0 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0ab);text-align:center">近 15 日消耗约 ¥${sumUse.toFixed(2)}${
    mixedCaliber ? `<span style="opacity:.65">（部分日期按净变动口径估算）</span>` : ""
  }</p>`;

  return `<div class="dou-card">
    <div class="dou-cardHead">
      <div class="dou-cardMeta">
        <span class="dou-legendDot" style="background:var(--dsw-alias-state-business-primary,#3b82f6)"></span>
        <h4 class="dou-cardName">近 15 日用量</h4>
      </div>
      <p class="dou-cardLimit">余额差 + 充值/赠款变动修正</p>
    </div>
    <div class="dou-miniChart"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 100" ${svgAttrs}>${dailyBarsSvg(records, e)}</svg></div>
    ${summary}
  </div>`;
}

/** 柱形几何：双向域 [lo, hi]、基线 y=0 实线；消耗蓝柱向上、净增绿柱向下、异常 0 高。 */
function dailyBarsSvg(records: DayRecord[], e: (s: unknown) => string): string {
  const W = 320, H = 100, PL = 36, PR = 6, PT = 8, PB = 14;
  const plotW = W - PL - PR;
  const bottom = PT + (H - PT - PB);

  const posMax = Math.max(0, ...records.map((r) => r.u));
  const negMin = Math.min(0, ...records.filter((r) => r.neg).map((r) => r.u));
  // 全零窗口落固定默认域，防除零产生 NaN/Infinity 进 SVG 属性
  const hi = posMax > 0 ? niceCeil(posMax) : negMin < 0 ? 0 : 10;
  const lo = negMin < 0 ? -niceCeil(-negMin) : 0;
  const span = hi - lo;
  if (!(span > 0)) return "";

  const yOf = (v: number): number => PT + ((hi - v) / span) * (bottom - PT);
  const y0 = yOf(0);
  const fmtVal = (v: number): string => (Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(Math.abs(v) >= 10 ? 1 : 2));

  const parts: string[] = [];
  // 网格：顶/底两条 + 基线实线
  for (const gv of [...new Set([lo, hi])]) {
    const gy = yOf(gv);
    parts.push(`<line x1="${PL}" y1="${gy.toFixed(1)}" x2="${W - PR}" y2="${gy.toFixed(1)}" style="stroke:var(--dsw-alias-border-l2,#e8eaf0);stroke-width:1;stroke-dasharray:3 3"/>`);
    parts.push(`<text x="${PL - 4}" y="${(gy + 3).toFixed(1)}" text-anchor="end" style="font-size:9px">${fmtVal(gv)}</text>`);
  }
  parts.push(`<line x1="${PL}" y1="${y0.toFixed(1)}" x2="${W - PR}" y2="${y0.toFixed(1)}" style="stroke:var(--dsw-alias-border-l2,#e8eaf0);stroke-width:1"/>`);

  const consumptionColor = "var(--dsw-alias-state-business-primary,#3b82f6)";
  const netIncreaseColor = "var(--dsw-alias-state-success-primary,#16a34a)";
  const slotW = plotW / records.length;
  const barW = Math.min(slotW * 0.62, 18);

  // 金额简短格式化
  const fmtAmt = (v: number): string => `¥${v.toFixed(2)}`;

  records.forEach((r, i) => {
    const x = PL + slotW * i + (slotW - barW) / 2;
    const cx = x + barW / 2;
    const isToday = i === records.length - 1;
    const dateLabel = isToday ? "今日" : r.key.slice(5);
    const opacity = isToday ? 0.55 : 1; // 今日未结束，半透明示意
    let titleText: string;
    if (r.status === "empty") titleText = `${dateLabel} 无采样`;
    else if (r.status === "insufficient") titleText = `${dateLabel} 样本不足`;
    else if (r.status === "gap") titleText = `${dateLabel} 数据中断`;
    else if (r.status === "unavailable") titleText = `${dateLabel} 服务不可用区间不计`;
    else if (r.status === "anomaly") titleText = `${dateLabel} ${r.note || "数值异常"}`;
    else if (r.neg) titleText = `${dateLabel} 余额净增 ¥${Math.abs(r.u).toFixed(2)}${r.extra ? `（${r.extra}）` : ""}`;
    else titleText = `${dateLabel} 消耗 ¥${r.u.toFixed(2)}${r.extra ? `（${r.extra}）` : ""}`;

    if (r.u > TOL && r.status === "ok") {
      const yTop = yOf(fin(r.u, 0, hi)!);
      const barH = Math.max(1, y0 - yTop);
      parts.push(`<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${consumptionColor}" fill-opacity="${opacity}" rx="1.5"><title>${e(titleText)}</title></rect>`);
      // 金额：柱顶上方（柱高<16px 时放基线上方避免压基线）
      const labelY = y0 - yTop > 16 ? yTop - 4 : y0 - 14;
      parts.push(`<text x="${cx.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" style="font-size:8px;fill:${consumptionColor}">${fmtAmt(r.u)}</text>`);
    } else if (r.neg && r.u < -TOL) {
      const yBot = yOf(fin(r.u, lo, 0)!);
      const barH = Math.max(1, yBot - y0);
      parts.push(`<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${netIncreaseColor}" fill-opacity="${opacity}" rx="1.5"><title>${e(titleText)}</title></rect>`);
      // 金额：柱底下方（降到日期上方为止，避免压日期标签）
      const negLabelY = Math.min(yBot + 12, H - 9);
      parts.push(`<text x="${cx.toFixed(1)}" y="${negLabelY.toFixed(1)}" text-anchor="middle" style="font-size:8px;fill:${netIncreaseColor}">${fmtAmt(Math.abs(r.u))}</text>`);
    } else {
      // 占位极矮条：保证空槽/异常日在轴上可感知位置
      parts.push(`<rect x="${x.toFixed(1)}" y="${(y0 - 0.75).toFixed(1)}" width="${barW.toFixed(1)}" height="0.75" fill="${consumptionColor}" fill-opacity=".18"><title>${e(titleText)}</title></rect>`);
    }

    // x 轴日期标签：隔一显示，强制保留首位与今日
    if (i % 2 === 0 || isToday) {
      parts.push(`<text x="${cx.toFixed(1)}" y="${(H - 6).toFixed(1)}" text-anchor="middle" style="font-size:8.5px">${e(dateLabel)}</text>`);
    }
  });

  return parts.join("");
}

/** 余额走势 SVG（自适应值域 + 网格 + 折线 + 末点高亮 + x 轴时间刻度）。 */
function balanceSvg(values: SamplePoint[], e: (s: unknown) => string): string {
  if (values.length < 2) return "";
  const W = 320, H = 100, PL = 44, PR = 8, PT = 14, PB = 16;
  const xw = W - PL - PR, plotH = H - PT - PB;
  const t0 = values[0].t, t1 = values[values.length - 1].t;
  const spanMs = t1 > t0 ? t1 - t0 : 60000;

  // y 域：自适应（余额型，不设百分比参考线）
  let lo = Infinity, hi = -Infinity;
  for (const p of values) {
    if (p.balance < lo) lo = p.balance;
    if (p.balance > hi) hi = p.balance;
  }
  if (lo === Infinity) return "";
  const pad = (hi - lo) * 0.15 || Math.max(hi * 0.1, 0.01);
  lo = Math.max(0, lo - pad);
  hi = hi + pad;
  if (hi - lo < 1e-6) { lo = Math.max(0, lo - 1); hi = hi + 1; }

  const xOf = (t: number): number => PL + ((t - t0) / spanMs) * xw;
  const yOf = (v: number): number => PT + ((hi - v) / (hi - lo)) * plotH;
  const fmtVal = (v: number): string => (Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(2));

  const parts: string[] = [];
  // 网格三线 + 数值标签
  for (const gv of [lo, (lo + hi) / 2, hi]) {
    const gy = yOf(gv);
    parts.push(`<line x1="${PL}" y1="${gy.toFixed(1)}" x2="${W - PR}" y2="${gy.toFixed(1)}" style="stroke:var(--dsw-alias-border-l2,#e8eaf0);stroke-width:1;stroke-dasharray:3 3"/>`);
    parts.push(`<text x="${PL - 4}" y="${(gy + 3).toFixed(1)}" text-anchor="end" style="font-size:9.5px">${fmtVal(gv)}</text>`);
  }
  // 折线 + 面积（降采样 ≤300 点）
  const pts = values.map((p) => ({ x: xOf(p.t), y: yOf(p.balance) }));
  let line = pts;
  if (pts.length > 300) {
    const step = pts.length / 300;
    const out: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < pts.length; i += step) out.push(pts[Math.floor(i)]);
    out.push(pts[pts.length - 1]);
    line = out;
  }
  let d = `M ${line[0].x.toFixed(1)} ${line[0].y.toFixed(1)}`;
  for (let i = 1; i < line.length; i += 1) d += ` L ${line[i].x.toFixed(1)} ${line[i].y.toFixed(1)}`;
  const last = line[line.length - 1];
  const btm = PT + plotH;
  const color = "var(--dsw-alias-state-business-primary,#3b82f6)";
  parts.push(`<path d="${d} L ${last.x.toFixed(1)} ${btm} L ${line[0].x.toFixed(1)} ${btm} Z" style="fill:${color};fill-opacity:.13"/>`);
  parts.push(`<path d="${d}" style="fill:none;stroke:${color};stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round"/>`);
  parts.push(`<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.6" style="fill:${color};stroke:var(--dsw-alias-bg-base,#fdfdfd);stroke-width:1.2"/>`);

  // x 轴时间刻度（≤7 个）
  const stepMs = spanMs / 6;
  for (let k = 0; k <= 6; k += 1) {
    const tt = t0 + stepMs * k;
    const tx = xOf(Math.min(tt, t1));
    const dDate = new Date(tt);
    const label = spanMs >= DAY_MS
      ? `${dDate.getMonth() + 1}-${String(dDate.getDate()).padStart(2, "0")}`
      : `${String(dDate.getHours()).padStart(2, "0")}:${String(dDate.getMinutes()).padStart(2, "0")}`;
    const anchorAttr = k === 0 ? "start" : k === 6 ? "end" : "middle";
    parts.push(`<text x="${tx.toFixed(1)}" y="${H - 4}" text-anchor="${anchorAttr}" style="font-size:9.5px">${e(label)}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

// ---------------------------------------------------------------- 适配器对象

/**
 * 面板内容（两张卡片）：
 * 卡1：余额大头 + 近 24h 余额波动折线（锚点 = min(末采样点, 现在)，宿主时区口径）。
 * 卡2：近 15 个自然日每日用量柱形图（守恒式口径：余额差 + 充值/赠款变动修正）。
 * 「现在」以 range.end 注入（T3 防 flake：面板判定路径不取墙钟；history 路由 end=查询时刻）。
 */
function formatPanelImpl(input: PanelInput): string {
  const e: (s: unknown) => string = input.esc || h;
  if (!Array.isArray(input.entries) || input.entries.length === 0) return "<p>暂无历史数据</p>";

  const now = input.range.end;
  // 过滤有效点 + 剔除未来时间戳（容差一个采样周期）+ 防御性稳定排序（契约保证升序，宿主升级兜底）
  const pts: SamplePoint[] = input.entries
    .map((en) => ({
      t: en && typeof en.time === "number" ? en.time : NaN,
      balance: en && en.data && typeof en.data.balance === "number" ? en.data.balance : NaN,
      toppedUp: en && en.data && typeof en.data.toppedUp === "number" ? en.data.toppedUp : null,
      granted: en && en.data && typeof en.data.grantedBalance === "number" ? en.data.grantedBalance : null,
      available: !(en && en.data && en.data.isAvailable === false),
    }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.balance))
    .filter((p) => p.t <= now + GAP_MS)
    .sort((a, b) => a.t - b.t);
  if (pts.length === 0) return "<p>暂无历史数据</p>";

  // 统一时间锚：折线「近 24h」与柱形窗口共用，避免停滞数据下两图基准割裂
  const anchor = Math.min(pts[pts.length - 1].t, now);

  // ---- 卡1：余额 + 近 24h 折线 ----
  const values24 = pts.filter((p) => p.t >= anchor - DAY_MS);
  const latest = values24[values24.length - 1] || pts[pts.length - 1];
  const first24 = values24[0];
  const balance = latest.balance;

  let trendHtml = "";
  if (first24 && first24.t !== latest.t) {
    const d = latest.balance - first24.balance;
    if (d > TOL) trendHtml = `<span class="dou-trend-up" title="${ea("较24小时前")}">▲ +${d.toFixed(2)}</span>`;
    else if (d < -TOL) trendHtml = `<span class="dou-trend-down" title="${ea("较24小时前")}">▼ ${d.toFixed(2)}</span>`;
    else trendHtml = `<span class="dou-trend-flat" title="${ea("较24小时前")}">— 0.00</span>`;
  }

  const head = `<div class="dou-cardHead">
    <div class="dou-cardMeta">
      <span class="dou-legendDot" style="background:var(--dsw-alias-state-business-primary,#3b82f6)"></span>
      <h4 class="dou-cardName">余额</h4>
      <span class="dou-cardCur">${balance !== null && Number.isFinite(balance) ? `¥${balance.toFixed(2)}` : "--"}</span>
      ${trendHtml}
    </div>
    <p class="dou-cardLimit">DeepSeek 官方（CNY） · 近 24 小时波动</p>
  </div>`;

  let chartHtml = "";
  if (values24.length >= 2) {
    chartHtml = `<div class="dou-miniChart">${balanceSvg(values24, e)}</div>`;
  } else if (input.entries.length < 2) {
    chartHtml = `<p class="dou-chartEmpty">数据采集中：每次刷新记录一个采样点（约每 5 分钟一次），≥2 个点后显示趋势。</p>`;
  } else {
    chartHtml = `<p class="dou-chartEmpty">近 24 小时内采样不足（&lt;2 点），随时间积累后显示。</p>`;
  }

  const card1 = `<div class="dou-card">${head}${chartHtml}</div>`;
  const card2 = renderDailyUsageCard(pts, input.truncated === true, e, now);
  return card1 + card2;
}

/** 内置 DeepSeek 官方适配器（v2 契约，行为与原型一致；name 加 -builtin 后缀）。 */
export const deepSeekOfficialAdapter: UsageStatsAdapter = {
  version: 2,
  name: DEEPSEEK_OFFICIAL_ADAPTER_ID,
  label: "DeepSeek 官方余额",
  providers: [DEEPSEEK_OFFICIAL_PROVIDER],

  async fetchData(ctx: FetchContext): Promise<Record<string, unknown>> {
    return fetchDeepSeekOfficialV2(ctx as FetchContext & { fetch?: typeof fetch });
  },

  formatCapsule(input: CapsuleInput): string {
    return formatCapsuleWithBadge(input, input.time);
  },

  formatPanel(input: PanelInput): string {
    return formatPanelImpl(input);
  },
};
