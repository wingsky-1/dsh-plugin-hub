/**
 * dsh-provider-usage — 内置 DeepSeek 官方余额适配器（v2 契约；源自 user-file 原型，
 * issue #198；v2.3 起记账口径为区间记账法，与原型分叉——原型后续同步）。
 *
 * #215 mjs 化：本文件为 .mjs 权威实现。图表与日界函数优先消费注入的
 * `input.utils`（PanelInput.utils；宿主管线强制注入 ADAPTER_UTILS，见 pipeline/v2.ts）：
 * - dayKey / lastNDayKeys / h（escHtml）/ ea（escAttr）→ 优先 U.dayKey/U.lastNDayKeys/
 *   U.escHtml/U.escAttr（文件内保留私有副本兜底，注释「与 charts.ts 同源需同步」）；
 * - balanceSvg / dailyBarsSvg 仍留文件内（DS 业务强耦合，柱图化候选记入 issue #215）。
 * 其余逻辑（区间记账 classifyIntervalDs/aggregateDaily/layerDaily/B2 断轴 balanceSvg/
 * toppedUpIn 汇总/峰谷徽标）保持与 v2.3 完全一致，零改动。
 *
 * 对齐纪律：GAP_MS=27h 中断判定、TOL/ANOMALY 分层、六态错误路径（含 AbortError 重抛）、
 * 严格金额解析、官方域名 /v1 前缀剥离等与原型一致；
 * 有意差异仅两处并在下方标注：
 * 1. name 采用 `deepseek-official-builtin`（原型为 `deepseek-official`，与 provider 同名），
 *    对齐 opencode-go-builtin 先例——避免与用户已装 user-file 原型在 registeredNames 冲突被拒收；
 * 2. 新增峰谷倒计时徽标（原型无此功能）：UTC 工作日固定峰窗常量 + 纯本地时间计算。
 *
 * v2.3 记账口径重构（守恒式 → 区间记账法，B2 展示）：
 * - 根因：官方 topped_up_balance 是「充值账户当前剩余」而非累计计数器
 *   （恒等式 total = toppedUp + granted 实测成立），消费时 toppedUp 与 total 同步下降，
 *   旧守恒式 usage = Δbal + Δtop + Δgranted 把每笔消费完美相消 → 恒 0；
 * - 新口径：逐采样区间记账，不做代数相消——
 *   · 区间内 toppedUp 无增加且 granted 不变 → 纯消费区间：消耗 = 余额降幅（可与平台对账）；
 *   · 区间内 toppedUp 上涨 / granted 变动 → 扰动混合区间：消费漏计、提取「充值 +¥X」事件；
 *   · 日消耗 = 当日落账区间降幅之和；充值/赠款合计独立展示，不与消耗混算。
 * - 卡1 徽章同口径（剔除扰动区间求和，title 注明未计入的充值额）；
 * - B2 断轴平移：卡1 余额折线在充值时刻做断轴（后段整体 +充值额下移抹平台阶），
 *   充值位置画虚线标记线并在 title 注明金额，消除「余额暴涨压扁真实波动」的观感失真；
 * - 冷启动自然成立：当日 ≥2 个采样点即可出数，不再依赖跨日基线兜底。
 *
 * 数据模型：
 * - fetchData 只返回展示所需最小数据集（按天落盘 JSONL）；外部字符串拼 HTML 一律 esc()。
 */

/** 内置适配器认领的 provider 名（与会话模型 provider 精确匹配）。 */
export const DEEPSEEK_OFFICIAL_PROVIDER = "deepseek-official";

/** 内置适配器唯一名（有意差异 1：加 -builtin 后缀，见文件头注释）。 */
export const DEEPSEEK_OFFICIAL_ADAPTER_ID = "deepseek-official-builtin";

/** DeepSeek 官方 API 基础地址。 */
export const BASE_URL = "https://api.deepseek.com";

/** 取可用 API Key：优先插件配置链注入，其次兜底自查 DEEPSEEK_API_KEY（与 llm 层共用，
 *  覆盖「llm 能跑、余额接口 401」场景；该兜底属适配器实现细节，不在共享 provider-config 层特判）。 */
function resolveApiKey(apiKey) {
  if (apiKey && apiKey.length > 0) return apiKey;
  try {
    const v = process.env.DEEPSEEK_API_KEY;
    if (v && v.length > 0) return v;
  } catch { /* 环境变量读取失败视为缺失 */ }
  return undefined;
}

/** 严格金额解析：仅接受可转为有限数字的字符串，其余返回 null（杜绝 NaN 静默落盘）。 */
export function parseAmount(v) {
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 构造查询余额接口 URL：官方域名剥掉 OpenAI 兼容的 /v1 前缀，其余显式端点原样拼接；尾斜杠归一。 */
export function resolveEndpoint(apiEndpoint) {
  const base = (apiEndpoint && apiEndpoint.trim()) || BASE_URL;
  const root = /^https?:\/\/api\.deepseek\.com/i.test(base)
    ? base.replace(/\/v1\/?$/i, "")
    : base;
  return root.replace(/\/+$/, "") + "/user/balance";
}

// ---------------------------------------------------------------- 日界/转义（自 charts.ts 同源，需同步；正常路径经注入 utils 消费）

/** HTML 转义兜底（契约入参 esc 助手同语义；含引号转义，元素内容上下文用）。 */
function hFallback(s) {
  const str = s === null || s === undefined ? "" : String(s);
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 本地时区日期 key 兜底（禁用 toISOString——UTC 归组会使东八区每天 00:00–08:00 的采样划入前一天）。 */
function dayKeyFallback(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 近 n 个自然日 key 列表兜底（含今日；逐日 setDate 回退生成，DST/跨月/跨年安全，禁用毫秒减法）。 */
function lastNDayKeysFallback(n, now) {
  const d = new Date(now);
  const keys = [];
  for (let i = 0; i < n; i += 1) {
    keys.unshift(dayKeyFallback(d.getTime()));
    d.setDate(d.getDate() - 1);
  }
  return keys;
}

/**
 * 本地时区日期 key（文件级导出，保持 index re-export 面——unit 测试从
 * lib/index.js 导入；与 charts.ts dayKey 同源需同步，formatPanel 内优先注入 utils）。
 */
export function dayKey(t) {
  return dayKeyFallback(t);
}

/** 近 n 个自然日 key 列表（文件级导出，同 dayKey 说明；与 charts.ts 同源需同步）。 */
export function lastNDayKeys(n, now) {
  return lastNDayKeysFallback(n, now);
}

/** 数值安全化兜底：非有限返回 null；有限则 clamp 到 [min,max] 再返回。 */
function finFallback(v, min = -Number.MAX_VALUE, max = Number.MAX_VALUE) {
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
export const PEAK_WINDOWS_UTC = [
  [60, 240],   // 01:00–04:00 UTC
  [360, 600],  // 06:00–10:00 UTC
];

/** 单时刻峰谷判定（纯函数）：UTC 工作日 + 分钟粒度半开区间（毫秒级边界语义等价：
 *  03:59:59.999 属峰、04:00:00.000 即属谷——分钟数不受秒/毫秒影响）。 */
export function isPeakUtc(t) {
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
export function nextPeakTransition(t) {
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
      for (const [min, toPeak] of [[startMin, true], [endMin, false]]) {
        const at = Date.UTC(y, m, d0 + off, 0, min, 0, 0);
        if (at > t && toPeak !== peakNow) return { toPeak, at };
      }
    }
  }
  // 不可达（7 天内必有转换）；防御性兜底：返回一周后的同一时刻
  return { toPeak: !peakNow, at: t + 7 * DAY_MS };
}

/** 倒计时格式化 mm:ss 之外的 HH:MM 形态（向上取整到分钟，恒 ≥1 分钟，杜绝 "-00:00"/负值形态）。 */
function fmtCountdown(ms) {
  const totalMin = Math.max(1, Math.ceil(ms / 60000));
  const hh = String(Math.floor(totalMin / 60)).padStart(2, "0");
  const mm = String(totalMin % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 当前进程时区名（纯环境元数据读取，无时钟依赖，仅供 tooltip 对照提示）。 */
function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

/** 峰谷倒计时徽标 HTML（纯本地时间计算，不依赖远端数据——stale 帧同样渲染）。 */
export function peakBadgeHtml(nowTs) {
  const peak = isPeakUtc(nowTs);
  const tr = nextPeakTransition(nowTs);
  const countdown = fmtCountdown(tr.at - nowTs);
  const label = peak ? `⚡峰 · 距谷 ${countdown}` : `⚡谷 · 距峰 ${countdown}`;
  const windowsText = PEAK_WINDOWS_UTC
    .map(([s, e]) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}–${String(Math.floor(e / 60)).padStart(2, "0")}:${String(e % 60).padStart(2, "0")}`)
    .join("、");
  const tip = `DeepSeek 错峰计费：峰时段（UTC 工作日）${windowsText}，周末全天谷；时段定义为 UTC，与显示时区无关，倒计时按 UTC 换算（服务器时区 ${localTimeZone()}）`;
  const cls = peak ? "dou-peak dou-peak-on" : "dou-peak dou-peak-off";
  return `<span class="${cls}" title="${eaFallback(tip)}">${hFallback(label)}</span>`;
}

/** 属性上下文转义兜底：不信任宿主 esc 一定转义引号，属性插值一律走本函数。 */
function eaFallback(s) {
  return hFallback(s);
}

// ---------------------------------------------------------------- fetchData（六态错误路径与原型一致）

/**
 * 拉取余额（v2 fetchData，fetch 经 ctx.fetch 或 fetchImpl 注入，便于单测）。
 * 返回 { isAvailable, balance, toppedUp, grantedBalance }（仅保留 CNY 币种）。
 * 字段语义（实测确认，v2.3 区间记账法的前提）：
 * - topped_up_balance = 充值账户当前剩余（非累计充值计数器）；
 * - granted_balance = 赠款账户当前剩余；
 * - 恒等式 total = toppedUp + granted 成立；消费时 toppedUp 与 total 同步下降。
 */
export async function fetchDeepSeekOfficialV2(ctx, fetchImpl) {
  const key = resolveApiKey(ctx.apiKey);
  if (!key) throw new Error("no-api-key");

  const f = ctx.fetch ?? fetchImpl ?? globalThis.fetch;
  const url = resolveEndpoint(ctx.apiEndpoint);

  let res;
  try {
    res = await f(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: ctx.signal,
    });
  } catch (err) {
    // 超时/取消由插件 signal 负责；AbortError 重抛不被吞成 network（原型行为）
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new Error("network");
  }
  if (res.status === 401 || res.status === 403) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`http-${res.status}`);

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("bad-json");
  }

  // 只保留 CNY 币种（官方 balance_infos 数组，金额为字符串）；无 CNY 条目 → 全 null 正常帧（B4 修订版）
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const cny = infos.find((b) => typeof b === "object" && b !== null && b.currency === "CNY");

  return {
    isAvailable: body.is_available === true,
    balance: parseAmount(cny?.total_balance),
    toppedUp: parseAmount(cny?.topped_up_balance),
    grantedBalance: parseAmount(cny?.granted_balance),
  };
}

// ---------------------------------------------------------------- 胶囊 + 峰谷徽标

/** 胶囊文案：CNY 余额 + 可用性/缓存标记 + 峰谷倒计时徽标（追加于余额文本之后）。 */
export function formatCapsuleWithBadge({ data, status }, nowTs) {
  const e = hFallback;
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

// 采样代表点（有效过滤后；available=is_available 标记，缺省视为可用以兼容旧历史分片）。

/** 单日用量记录（聚合输出，v2.3 区间记账法）。 */

/**
 * 相邻采样区间分类（v2.3 区间记账法的判定核，不做代数相消）：
 * - unavailable：任一端点 is_available=false → 整段跳过（不可用期余额变动非消耗）；
 * - gap：跨度超 GAP_MS → 数据中断，跳过（防畸形巨柱）；
 * - disturbed：区间内充值入账（toppedUp 上涨）或赠款变动（granted 变化）→
 *   消费成分漏计、提取充值事件额，绝不与消耗混算；
 * - clean：无扰动纯消费区间 → 消耗 = 余额降幅（可与平台账单对账）。
 */
export function classifyIntervalDs(a, b) {
  if (a.available === false || b.available === false) return { type: "unavailable", drop: 0, topup: 0, grantDelta: 0 };
  const dTop = a.toppedUp !== null && b.toppedUp !== null ? b.toppedUp - a.toppedUp : 0;
  const dGrant = a.granted !== null && b.granted !== null ? b.granted - a.granted : 0;
  const drop = a.balance - b.balance;
  if (b.t - a.t > GAP_MS) return { type: "gap", drop, topup: 0, grantDelta: 0 };
  if (dTop > TOL || Math.abs(dGrant) > TOL) {
    return { type: "disturbed", drop, topup: Math.max(0, dTop), grantDelta: dGrant };
  }
  return { type: "clean", drop, topup: 0, grantDelta: 0 };
}

/** 分层渲染规则（与旧版一致的单日判定）：|u|≤TOL → 0；轻微负值 → neg 绿柱；大额负值 → 异常。 */
function layerDaily(sum) {
  const v = finFallback(sum);
  if (v === null) return { status: "anomaly", u: 0, note: "数值异常" };
  if (Math.abs(v) <= TOL) return { status: "ok", u: 0 };
  if (v < 0 && v >= ANOMALY_NEG) return { status: "ok", u: v, neg: true };
  if (v < ANOMALY_NEG) return { status: "anomaly", u: 0, note: `余额净增 ¥${Math.abs(v).toFixed(2)}（异常）` };
  return { status: "ok", u: v };
}

/**
 * 每日用量聚合（v2.3 区间记账法）：
 * - 归属规则：相邻采样区间 (a,b) 计入 dayKey(b.t)（结束端所在日）——跨午夜区间的
 *   隔夜消费不丢失（旧基线法会整段掉落）；
 * - 冷启动自然成立：当日只要有 ≥1 个完整区间即出数，不再依赖跨日基线兜底；
 * - truncated 参数保留签名兼容；新口径按区间记账，截断不再导致首日整日不计。
 * - 第 4 参 utils 可选（#215 注入面）：dayKey 优先消费注入实现，缺失回退文件内副本。
 */
export function aggregateDaily(pts, keys, _truncated, utils) {
  const dayKey = (utils && typeof utils.dayKey === "function") ? utils.dayKey : dayKeyFallback;
  const keysSet = new Set(keys);
  /** 各目标日的取样帧数（区分 empty 与 insufficient）。 */
  const framesByDay = new Map();
  for (const p of pts) {
    const k = dayKey(p.t);
    if (!keysSet.has(k)) continue;
    framesByDay.set(k, (framesByDay.get(k) ?? 0) + 1);
  }

  /** 各目标日的区间记账累加器。 */
  const acc = new Map();

  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const k = dayKey(b.t);
    if (!keysSet.has(k)) continue;
    const cls = classifyIntervalDs(a, b);
    const slot = acc.get(k) ?? { sum: 0, topIn: 0, grantParts: [], mixed: false, gapSegs: 0, unavail: false };
    if (cls.type === "unavailable") {
      slot.unavail = true;
    } else if (cls.type === "gap") {
      slot.gapSegs += 1;
    } else if (cls.type === "disturbed") {
      slot.mixed = true;
      if (cls.topup > 0) slot.topIn += cls.topup;
      if (Math.abs(cls.grantDelta) > TOL) {
        // grantDelta>0 赠款入账 / <0 过期出账：绝对额入文案
        slot.grantParts.push(`赠款 ${cls.grantDelta > 0 ? "+" : ""}${cls.grantDelta.toFixed(2)}`);
      }
    } else {
      slot.sum += cls.drop;
    }
    acc.set(k, slot);
  }

  return keys.map((k) => {
    const frames = framesByDay.get(k) ?? 0;
    const s = acc.get(k);
    if (!s) {
      if (frames === 0) return { key: k, status: "empty", u: 0 };
      return { key: k, status: "insufficient", u: 0 }; // 有帧但无可计区间（单帧冷启动极早期）
    }
    const layers = layerDaily(s.sum);
    if (layers.status === "anomaly") {
      return { key: k, status: "anomaly", u: 0, note: layers.note };
    }
    const notes = [];
    if (s.topIn > 0) notes.push(`充值 +¥${s.topIn.toFixed(2)} 未计入`);
    if (s.grantParts.length > 0) notes.push(`${s.grantParts.join(" · ")} 变动不计`);
    if (s.gapSegs > 0) notes.push(`${s.gapSegs} 段中断不计`);
    if (s.unavail) notes.push("含不可用区间不计");
    return {
      key: k,
      status: "ok",
      u: layers.u,
      ...(layers.neg ? { neg: true } : {}),
      ...(notes.length > 0 ? { extra: notes.join(" · ") } : {}),
      ...(s.topIn > 0 ? { toppedUpIn: s.topIn } : {}),
    };
  });
}

/** 聚合内部使用的 dayKey 实现（闭包注入，支持外部覆盖——见 aggregateDailyWith）。 */
// （无需模块级状态：dayKey 经 aggregateDaily 第 4 参注入，见上。）

/** 柱形图 y 轴上限取整到 1/2/5×10^k 的好看步长。 */
export function niceCeil(v) {
  if (!(typeof v === "number" && Number.isFinite(v) && v > 0)) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return m * p;
}

/** 卡2：标题行 + 柱形 SVG + 汇总行（v2.3 区间记账法：消耗与充值分列，不混算）。 */
function renderDailyUsageCard(pts, truncated, e, now, utils) {
  const dayKey = (utils && utils.dayKey) || dayKeyFallback;
  const lastNDayKeys = (utils && utils.lastNDayKeys) || lastNDayKeysFallback;
  const ea = (utils && utils.escAttr) || eaFallback;
  const fin = (utils && utils.fin) || finFallback;
  const keys = lastNDayKeys(15, now);
  const records = aggregateDaily(pts, keys, truncated, utils);

  const sumUse = records.reduce((s, r) => s + (r.status === "ok" && !r.neg ? r.u : 0), 0);
  const sumTopUp = records.reduce((s, r) => s + (r.toppedUpIn ?? 0), 0);
  const mixedCaliber = records.some((r) => r.status === "gap" || r.status === "insufficient" || r.status === "unavailable");

  const svgAttrs = [
    `role="img"`,
    `aria-label="${ea(`近15日每日用量柱形图，合计消耗约${sumUse.toFixed(2)}元${sumTopUp > 0 ? `，另有充值 ${sumTopUp.toFixed(2)} 元` : ""}`)}"`,
  ].join(" ");
  const summary = `<p style="margin:4px 0 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0ab);text-align:center">近 15 日消耗约 ¥${sumUse.toFixed(2)}${
    sumTopUp > 0 ? ` · 另有充值 <span style="color:var(--dsw-alias-state-success-primary,#16a34a)">+¥${sumTopUp.toFixed(2)}</span>` : ""
  }${
    mixedCaliber ? `<span style="opacity:.65">（部分区间中断/不可用未计）</span>` : ""
  }</p>`;

  return `<div class="dou-card">
    <div class="dou-cardHead">
      <div class="dou-cardMeta">
        <span class="dou-legendDot" style="background:var(--dsw-alias-state-business-primary,#3b82f6)"></span>
        <h4 class="dou-cardName">近 15 日用量</h4>
      </div>
      <p class="dou-cardLimit">区间记账 · 充值独立列示不计入消耗</p>
    </div>
    <div class="dou-miniChart"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 100" ${svgAttrs}>${dailyBarsSvg(records, e)}</svg></div>
    ${summary}
  </div>`;
}

/** 柱形几何：双向域 [lo, hi]、基线 y=0 实线；消耗蓝柱向上、净增绿柱向下、异常 0 高。 */
function dailyBarsSvg(records, e) {
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

  const yOf = (v) => PT + ((hi - v) / span) * (bottom - PT);
  const y0 = yOf(0);
  const fmtVal = (v) => (Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(Math.abs(v) >= 10 ? 1 : 2));

  const parts = [];
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
  const fmtAmt = (v) => `¥${v.toFixed(2)}`;

  records.forEach((r, i) => {
    const x = PL + slotW * i + (slotW - barW) / 2;
    const cx = x + barW / 2;
    const isToday = i === records.length - 1;
    const dateLabel = isToday ? "今日" : r.key.slice(5);
    const opacity = isToday ? 0.55 : 1; // 今日未结束，半透明示意
    let titleText;
    if (r.status === "empty") titleText = `${dateLabel} 无采样`;
    else if (r.status === "insufficient") titleText = `${dateLabel} 样本不足`;
    else if (r.status === "gap") titleText = `${dateLabel} 数据中断`;
    else if (r.status === "unavailable") titleText = `${dateLabel} 服务不可用区间不计`;
    else if (r.status === "anomaly") titleText = `${dateLabel} ${r.note || "数值异常"}`;
    else if (r.neg) titleText = `${dateLabel} 余额净增 ¥${Math.abs(r.u).toFixed(2)}${r.extra ? `（${r.extra}）` : ""}`;
    else titleText = `${dateLabel} 消耗 ¥${r.u.toFixed(2)}${r.extra ? `（${r.extra}）` : ""}`;

    if (r.u > TOL && r.status === "ok") {
      const yTop = yOf(finFallback(r.u, 0, hi));
      const barH = Math.max(1, y0 - yTop);
      parts.push(`<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${consumptionColor}" fill-opacity="${opacity}" rx="1.5"><title>${e(titleText)}</title></rect>`);
      // 金额：柱顶上方（柱高<16px 时放基线上方避免压基线）
      const labelY = y0 - yTop > 16 ? yTop - 4 : y0 - 14;
      parts.push(`<text x="${cx.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" style="font-size:8px;fill:${consumptionColor}">${fmtAmt(r.u)}</text>`);
    } else if (r.neg && r.u < -TOL) {
      const yBot = yOf(finFallback(r.u, lo, 0));
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

/**
 * 余额走势 SVG（v2.3 B2 断轴平移版）：
 * - 充值时刻（相邻区间 toppedUp 上涨 >TOL）做断轴：充值后各点按累计充值额整体下移，
 *   抹平「充值台阶」，保留真实消费波动形态（除权图语义）；
 * - 断轴处画竖直虚线连接两侧真实水位，title 注明金额——跳变不隐藏、可读可回溯；
 * - y 轴数值 = 剔除充值后的「校准水位」（title 声明），末点高亮与面积填充随段处理。
 */
function balanceSvg(values, e, ea) {
  if (values.length < 2) return "";
  const W = 320, H = 100, PL = 44, PR = 8, PT = 14, PB = 16;
  const xw = W - PL - PR, plotH = H - PT - PB;
  const t0 = values[0].t, t1 = values[values.length - 1].t;
  const spanMs = t1 > t0 ? t1 - t0 : 60000;

  // 充值事件：atIdx 表示发生在 values[atIdx-1] → values[atIdx] 区间
  const events = [];
  for (let i = 1; i < values.length; i += 1) {
    const a = values[i - 1];
    const b = values[i];
    if (a.toppedUp !== null && b.toppedUp !== null && b.toppedUp - a.toppedUp > TOL) {
      events.push({ atIdx: i, amt: b.toppedUp - a.toppedUp, xMid: xOfMid(a.t, b.t) });
    }
  }
  function xOfMid(ta, tb) {
    return PL + ((ta + ((tb - ta) / 2) - t0) / spanMs) * xw;
  }
  // 每点累计下移量 = 该点之前发生的充值合计
  const shifts = new Array(values.length).fill(0);
  let accShift = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (i > 0) {
      for (const ev of events) if (ev.atIdx === i) accShift += ev.amt;
    }
    shifts[i] = accShift;
  }

  // y 域：自适应（基于校准水位 balance − shift）
  let lo = Infinity, hi = -Infinity;
  const calibAt = (i) => values[i].balance - shifts[i];
  for (let i = 0; i < values.length; i += 1) {
    const v = calibAt(i);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Infinity) return "";
  const pad = (hi - lo) * 0.15 || Math.max(hi * 0.1, 0.01);
  lo = Math.max(0, lo - pad);
  hi = hi + pad;
  if (hi - lo < 1e-6) { lo = Math.max(0, lo - 1); hi = hi + 1; }

  const xOf = (t) => PL + ((t - t0) / spanMs) * xw;
  const yOf = (v) => PT + ((hi - v) / (hi - lo)) * plotH;
  const fmtVal = (v) => (Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(2));

  const parts = [];
  // 网格三线 + 数值标签（校准水位）
  for (const gv of [lo, (lo + hi) / 2, hi]) {
    const gy = yOf(gv);
    parts.push(`<line x1="${PL}" y1="${gy.toFixed(1)}" x2="${W - PR}" y2="${gy.toFixed(1)}" style="stroke:var(--dsw-alias-border-l2,#e8eaf0);stroke-width:1;stroke-dasharray:3 3"/>`);
    parts.push(`<text x="${PL - 4}" y="${(gy + 3).toFixed(1)}" text-anchor="end" style="font-size:9.5px">${fmtVal(gv)}</text>`);
  }

  // 折线分段子路径（事件处断开）+ 面积填充
  const color = "var(--dsw-alias-state-business-primary,#3b82f6)";
  const eventAt = new Set(events.map((ev) => ev.atIdx));
  /** 构造一个连续子段的 path d 与面积 d。 */
  const buildSegment = (from, to) => {
    if (to - from < 1) return null;
    // 段内降采样 ≤300 点
    const idxs = [];
    const n = to - from + 1;
    if (n > 300) {
      const step = n / 300;
      for (let k = 0; k < n; k += step) idxs.push(from + Math.floor(k));
      if (idxs[idxs.length - 1] !== to) idxs.push(to);
    } else {
      for (let k = from; k <= to; k += 1) idxs.push(k);
    }
    const xy = idxs.map((i) => ({ x: xOf(values[i].t), y: yOf(calibAt(i)) }));
    let d = `M ${xy[0].x.toFixed(1)} ${xy[0].y.toFixed(1)}`;
    for (let k = 1; k < xy.length; k += 1) d += ` L ${xy[k].x.toFixed(1)} ${xy[k].y.toFixed(1)}`;
    const btm = PT + plotH;
    const areaD = `${d} L ${xy[xy.length - 1].x.toFixed(1)} ${btm} L ${xy[0].x.toFixed(1)} ${btm} Z`;
    return { lineD: d, areaD };
  };

  let segStart = 0;
  for (let i = 0; i <= values.length - 1; i += 1) {
    if (i === values.length - 1 || eventAt.has(i + 1)) {
      const seg = buildSegment(segStart, i);
      if (seg !== null) {
        parts.push(`<path d="${seg.areaD}" style="fill:${color};fill-opacity:.13"/>`);
        parts.push(`<path d="${seg.lineD}" style="fill:none;stroke:${color};stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round"/>`);
      }
      segStart = i + 1;
    }
  }

  // 断轴标记：事件位置竖直虚线连接两侧显示水位（跳变显式可见，不隐藏）
  for (const ev of events) {
    const prevY = yOf(calibAt(ev.atIdx - 1));      // 充值前真实水位（无位移）
    const nextY = yOf(calibAt(ev.atIdx));          // 充值后校准水位（已下移）
    const topY = Math.min(prevY, nextY);
    const botY = Math.max(prevY, nextY);
    parts.push(`<line x1="${ev.xMid.toFixed(1)}" y1="${topY.toFixed(1)}" x2="${ev.xMid.toFixed(1)}" y2="${botY.toFixed(1)}" style="stroke:var(--dsw-alias-label-tertiary,#9aa0ab);stroke-width:1;stroke-dasharray:2 3;stroke-opacity:.7"><title>${ea(`充值 +¥${ev.amt.toFixed(2)}（此处断轴，折线已平移抹平台阶）`)}</title></line>`);
    parts.push(`<path d="M ${ev.xMid.toFixed(1)} ${topY.toFixed(1)} l 3.5 3.5 l -7 0 z" style="fill:var(--dsw-alias-state-success-primary,#16a34a);fill-opacity:.8"><title>${ea(`充值 +¥${ev.amt.toFixed(2)}`)}</title></path>`);
  }

  // 末点高亮（最后一段终点）
  const lastI = values.length - 1;
  parts.push(`<circle cx="${xOf(values[lastI].t).toFixed(1)}" cy="${yOf(calibAt(lastI)).toFixed(1)}" r="2.6" style="fill:${color};stroke:var(--dsw-alias-bg-base,#fdfdfd);stroke-width:1.2"/>`);

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
 * 卡2：近 15 个自然日每日用量柱形图（区间记账口径：余额差 + 充值/赠款变动修正）。
 * 「现在」以 range.end 注入（T3 防 flake：面板判定路径不取墙钟；history 路由 end=查询时刻）。
 */
function formatPanelImpl(input) {
  const e = input.esc || hFallback;
  // #215 注入面：日界/转义优先消费注入 utils，缺失回退文件内兜底副本
  const utils = input.utils || {};
  const dayKey = utils.dayKey || dayKeyFallback;
  const ea = utils.escAttr || eaFallback;
  const fin = utils.fin || finFallback;
  if (!Array.isArray(input.entries) || input.entries.length === 0) return "<p>暂无历史数据</p>";

  const now = input.range.end;
  // 过滤有效点 + 剔除未来时间戳（容差一个采样周期）+ 防御性稳定排序（契约保证升序，宿主升级兜底）
  const pts = input.entries
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
    // v2.3 徽章 = 近 24h 区间记账落账消费之和：逐区间分类，
    // 纯消费区间求降幅；充值/赠款/中断/不可用区间一律不计（金额另行提示）。
    let spent = 0;
    let topIn = 0;
    let skipped = false; // 存在未计区间（扰动/中断/不可用）
    let counted = 0;     // 有效计账区间数
    for (let i = 1; i < values24.length; i += 1) {
      const cls = classifyIntervalDs(values24[i - 1], values24[i]);
      if (cls.type === "clean") {
        if (cls.drop > TOL) spent += cls.drop;
        counted += 1;
      } else {
        skipped = true;
        if (cls.type === "disturbed") topIn += cls.topup;
      }
    }
    spent = fin(spent) ?? 0;
    const tipParts = [];
    if (topIn > 0) tipParts.push(`另有充值 +¥${topIn.toFixed(2)} 未计入`);
    if (skipped) tipParts.push("部分区间未计");
    const tipSuffix = tipParts.length > 0 ? `（${tipParts.join(" · ")}）` : "";
    if (spent > TOL) {
      trendHtml = `<span class="dou-trend-up" title="${ea(`近24小时消费${tipSuffix}`)}">已用 ¥${spent.toFixed(2)}</span>`;
    } else if (counted === 0) {
      // 无任何可计账区间：不声称 ≈0（诚实），但充值等已知信息仍在 title 呈现
      trendHtml = `<span class="dou-trend-flat" title="${ea(`近24小时无可计消费区间${tipSuffix ? `，${tipParts.join(" · ")}` : ""}`)}">— 消费未知</span>`;
    } else {
      trendHtml = `<span class="dou-trend-flat" title="${ea(`近24小时消费${tipSuffix}`)}">— 消费≈0</span>`;
    }
  }

  // 卡1 副标题：有充值事件时注明断轴（B2 折线语义提示）
  const rechargeHint = values24.some((p, i) =>
    i > 0 && values24[i - 1].toppedUp !== null && p.toppedUp !== null && p.toppedUp - values24[i - 1].toppedUp > TOL)
    ? " · 充值已断轴"
    : "";
  const head = `<div class="dou-cardHead">
    <div class="dou-cardMeta">
      <span class="dou-legendDot" style="background:var(--dsw-alias-state-business-primary,#3b82f6)"></span>
      <h4 class="dou-cardName">余额</h4>
      <span class="dou-cardCur">${balance !== null && Number.isFinite(balance) ? `¥${balance.toFixed(2)}` : "--"}</span>
      ${trendHtml}
    </div>
    <p class="dou-cardLimit" title="${ea("DeepSeek 官方（CNY）")}">近 24 小时波动${rechargeHint}</p>
  </div>`;

  let chartHtml = "";
  if (values24.length >= 2) {
    chartHtml = `<div class="dou-miniChart">${balanceSvg(values24, e, ea)}</div>`;
  } else if (input.entries.length < 2) {
    chartHtml = `<p class="dou-chartEmpty">数据采集中：每次刷新记录一个采样点（约每 5 分钟一次），≥2 个点后显示趋势。</p>`;
  } else {
    chartHtml = `<p class="dou-chartEmpty">近 24 小时内采样不足（&lt;2 点），随时间积累后显示。</p>`;
  }

  const card1 = `<div class="dou-card">${head}${chartHtml}</div>`;
  const card2 = renderDailyUsageCard(pts, input.truncated === true, e, now, utils);
  return card1 + card2;
}

/** 内置 DeepSeek 官方适配器（v2 契约，行为与原型一致；name 加 -builtin 后缀）。 */
export const deepSeekOfficialAdapter = {
  version: 2,
  name: DEEPSEEK_OFFICIAL_ADAPTER_ID,
  label: "DeepSeek 官方余额",
  providers: [DEEPSEEK_OFFICIAL_PROVIDER],

  async fetchData(ctx) {
    return fetchDeepSeekOfficialV2(ctx);
  },

  formatCapsule(input) {
    return formatCapsuleWithBadge(input, input.time);
  },

  formatPanel(input) {
    return formatPanelImpl(input);
  },
};
