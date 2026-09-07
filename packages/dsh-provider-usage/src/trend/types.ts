/**
 * dsh-provider-usage/trend — 会话用量趋势数据类型（#503 M1）。
 *
 * 数据源与记账口径（方案定稿 v1.2，唯一事实源 = ctx.on("session/event") 官方契约）：
 * - 主信号：assistant/chunk 中 chunk.type==="usage" 到达即定稿（一次 LLM 调用）；
 * - 副源：assistant/message（含 interrupted）未定稿时补记、已定稿时仅校正不重记；
 * - fold 键 (session, turn, step, retrySeq)：retry 复用同一 (turn,step)，重试消耗逐次入账；
 * - 归属主源 = 逐会话折叠 request/header（EpochHeader.config 的 provider/model），
 *   assistant/message.source（kind:"model"）为副源；归属缺失显式入「未识别」桶；
 * - 零 usage 语义：调用次数独立计数，token 记 null 而非 0；
 * - 时间与日界：event.time 非单调（seq 才单调）——按事件本地日 dayKey 落桶，
 *   时钟回拨时旧日事件追加进对应日分片（append-only，查询容忍）；禁缓存时区偏移（DST 安全）。
 *
 * 存储（两级聚合）：当日保留 per-step 明细行；日切压实为 day×provider(×model) 聚合行
 * 并丢弃明细。分片行一律自带 schema 版本 v 与 kind 判别字段（重启重建遇日切瞬间无歧义）。
 */

/** 分片行 schema 版本：字段语义破坏性变更时递增（载入只认当前版本，其余跳过）。 */
export const TREND_ROW_VERSION = 1;
/**
 * #633 A1/A2：目录维度（cwd basename 净化值）为**加性可选键**，不递增版本——
 * 旧格式行（无 dir 键）必须原样读回（round-trip 不丢行、不因缺键拒绝），
 * 重建时目录维度归「未识别」桶（TREND_UNIDENTIFIED，不静默丢弃）。
 */

/** 未识别归属桶键（provider/model 缺失显式入此桶，不静默丢弃）。 */
export const TREND_UNIDENTIFIED = "(unidentified)";

/** 归属（provider 路由 + 模型 id）。 */
export interface TrendAttribution {
  provider: string;
  model: string;
}

/** 一次定稿调用的 token 计量（缺失维度记 null——零 usage 不强造 0）。 */
export interface TrendTokens {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

/** 目录键防御校验上限（复核 L4：POSIX NAME_MAX=255 以字节计，JS 字符串按 UTF-16
 * 码元计长——255 字节至多 255 个字符（多字节字符只会更短），255 < 256，取 256 与
 * safeId 上限同口径留 1 字符安全余量；超长伪造行按坏行跳过）。 */
const TREND_DIR_MAX = 256;

/** 分片行 dir 键防御校验：非空字符串且不超上限（旧格式行无该键，天然通过）。 */
function isValidDirKey(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && v.length <= TREND_DIR_MAX;
}

/**
 * cwd → 目录键归一化（#633 A1/C2 数据层约定：dir 字段落盘即存 basename 净化值）：
 * 剥控制字符（C0/C1）→ POSIX basename（取最后一个 '/' 后段，尾斜杠取前段）。
 * 无效输入（非字符串/空白/根路径/剥后为空）返回 null → 归「未识别」桶。
 * 注意：不在数据层截断长度——截断属展示出口（C2），数据层截断会把不同目录
 * 暗中合并为同桶（违反 B1 可区分性）。
 */
export function sanitizeDirName(cwd: unknown): string | null {
  if (typeof cwd !== "string") return null;
  let cleaned = "";
  for (const ch of cwd) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue; // C0 + DEL + C1 控制字符剥除
    cleaned += ch;
  }
  if (cleaned.endsWith("/")) cleaned = cleaned.slice(0, -1);
  const base = cleaned.slice(cleaned.lastIndexOf("/") + 1);
  if (base.length === 0 || base.trim().length === 0) return null; // 根路径/空段/纯空白 → 未识别
  return base;
}

/** 当日 per-step 明细行（分片 kind:"detail"；每次定稿调用一行）。 */
export interface TrendDetailRow {
  v: number;
  kind: "detail";
  /** 定稿时间（event.time，epoch ms；非单调，日界按本地日判定）。 */
  time: number;
  /** 本地日 key（YYYY-MM-DD，自 time 计算）。 */
  day: string;
  session: string;
  turn: number;
  step: number;
  /** 同 (session,turn,step) 内第几次调用（retry 序号，自 1 起）。 */
  retry: number;
  /** 归属 provider（未识别时为 TREND_UNIDENTIFIED）。 */
  provider: string;
  /** 归属 model（缺失时 null；未识别桶 model 记 null）。 */
  model: string | null;
  /** 目录归属（cwd basename 净化值；#633 新行必有，旧格式行无此键 → 重建归未识别）。 */
  dir?: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  calls: 1;
  interrupted?: true;
}

/** 轮次/工具调用计数行（分片 kind:"counter"；turn/end 与 tool/call 的落盘载体）。 */
export interface TrendCounterRow {
  v: number;
  kind: "counter";
  time: number;
  day: string;
  session: string;
  provider: string;
  model: string | null;
  /** turn/end 计 1，否则 0。 */
  turns: 0 | 1;
  /** tool/call 计 1，否则 0。 */
  toolCalls: 0 | 1;
  /** 目录归属（同 detail 行约定；#633 新行必有，旧格式行无此键）。 */
  dir?: string;
}

/** 日切压实后的 day×provider(×model) 聚合行（分片 kind:"agg"；append 后整日原子重写）。 */
export interface TrendAggRow {
  v: number;
  kind: "agg";
  day: string;
  provider: string;
  model: string | null;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  calls: number;
  turns: number;
  toolCalls: number;
}

/**
 * 日级目录汇总行（分片 kind:"dir"；#633 A4 落盘形态：会话归属为 session 级
 * 内存映射（per-session 缓存），日切时由明细/计数行折算为 day×dir 汇总行，
 * 与 kind:"agg" 同生命周期、整日原子重写）。
 * dir 为 TREND_UNIDENTIFIED 时即「未识别目录」桶（不静默丢弃约定）。
 */
export interface TrendDirRow {
  v: number;
  kind: "dir";
  day: string;
  /** 目录键（sanitizeDirName 净化 basename 或 TREND_UNIDENTIFIED）。 */
  dir: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  calls: number;
  turns: number;
  toolCalls: number;
}

export type TrendRow = TrendDetailRow | TrendCounterRow | TrendAggRow | TrendDirRow;

/** 内存聚合桶（day×provider×model 单元）。null token 语义：桶内无任何有效数字则保持 null。 */
export interface TrendCell {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  calls: number;
  turns: number;
  toolCalls: number;
}

/** 两个 token 值求和（null 视为缺失；两者皆 null 返回 null）。 */
export function sumToken(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/** 防御性有限整数（负数/非有限记 null——事件 payload 跨宿主边界不受信）。 */
export function safeToken(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v);
}

/** 防御性非空字符串（归属/会话 id 等标识字段）。 */
export function safeId(v: unknown, maxLen = 256): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > maxLen) return null;
  return v;
}

// 分片行校验局部 helper（P2-4）：防 "x" 等垃圾值进 sumToken 拼接、垃圾日键进内存桶。
/** day key 格式（YYYY-MM-DD；字典序即时间序的根基，垃圾日键会污染内存桶与 prune 判定）。 */
const TREND_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** token 计量字段：有限数或 null（负数/NaN/字符串一律拒绝）。 */
function isNumOrNull(v: unknown): boolean {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}
/** 标识字段：字符串或 null。 */
function isStrOrNull(v: unknown): boolean {
  return v === null || typeof v === "string";
}

/** 判定明细/计数/聚合/目录汇总行是否完整可收（载入重建的防御校验；坏行跳过）。
 *  #633 A2：detail/counter 的 dir 为加性可选键——旧格式行（无 dir）不因缺键拒绝。 */
export function isValidShardRow(
  row: unknown,
): row is TrendDetailRow | TrendCounterRow | TrendAggRow | TrendDirRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  if (r.v !== TREND_ROW_VERSION) return false;
  if (r.kind === "detail") {
    return (
      typeof r.time === "number" &&
      typeof r.day === "string" &&
      TREND_DAY_RE.test(r.day) &&
      typeof r.session === "string" &&
      typeof r.turn === "number" &&
      typeof r.step === "number" &&
      typeof r.retry === "number" &&
      typeof r.provider === "string" &&
      r.calls === 1 &&
      isNumOrNull(r.input) &&
      isNumOrNull(r.output) &&
      isNumOrNull(r.cacheRead) &&
      isNumOrNull(r.cacheWrite) &&
      isStrOrNull(r.model) &&
      (r.dir === undefined || isValidDirKey(r.dir))
    );
  }
  if (r.kind === "counter") {
    return (
      typeof r.time === "number" &&
      typeof r.day === "string" &&
      TREND_DAY_RE.test(r.day) &&
      typeof r.session === "string" &&
      typeof r.provider === "string" &&
      isStrOrNull(r.model) &&
      (r.turns === 0 || r.turns === 1) &&
      (r.toolCalls === 0 || r.toolCalls === 1) &&
      (r.dir === undefined || isValidDirKey(r.dir))
    );
  }
  if (r.kind === "agg") {
    return (
      typeof r.day === "string" &&
      TREND_DAY_RE.test(r.day) &&
      typeof r.provider === "string" &&
      isStrOrNull(r.model) &&
      isNumOrNull(r.input) &&
      isNumOrNull(r.output) &&
      isNumOrNull(r.cacheRead) &&
      isNumOrNull(r.cacheWrite) &&
      typeof r.calls === "number" &&
      typeof r.turns === "number" &&
      typeof r.toolCalls === "number"
    );
  }
  if (r.kind === "dir") {
    return (
      typeof r.day === "string" &&
      TREND_DAY_RE.test(r.day) &&
      isValidDirKey(r.dir) &&
      isNumOrNull(r.input) &&
      isNumOrNull(r.output) &&
      isNumOrNull(r.cacheRead) &&
      isNumOrNull(r.cacheWrite) &&
      typeof r.calls === "number" &&
      typeof r.turns === "number" &&
      typeof r.toolCalls === "number"
    );
  }
  return false;
}
