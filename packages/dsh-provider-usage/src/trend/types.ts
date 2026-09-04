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

export type TrendRow = TrendDetailRow | TrendCounterRow | TrendAggRow;

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

/** 判定明细/计数行是否完整可收（载入重建的防御校验；坏行跳过）。 */
export function isValidShardRow(row: unknown): row is TrendDetailRow | TrendCounterRow | TrendAggRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  if (r.v !== TREND_ROW_VERSION) return false;
  if (r.kind === "detail") {
    return (
      typeof r.time === "number" &&
      typeof r.day === "string" &&
      typeof r.session === "string" &&
      typeof r.turn === "number" &&
      typeof r.step === "number" &&
      typeof r.retry === "number" &&
      typeof r.provider === "string" &&
      r.calls === 1
    );
  }
  if (r.kind === "counter") {
    return (
      typeof r.time === "number" &&
      typeof r.day === "string" &&
      typeof r.session === "string" &&
      typeof r.provider === "string" &&
      (r.turns === 0 || r.turns === 1) &&
      (r.toolCalls === 0 || r.toolCalls === 1)
    );
  }
  if (r.kind === "agg") {
    return (
      typeof r.day === "string" &&
      typeof r.provider === "string" &&
      typeof r.calls === "number" &&
      typeof r.turns === "number" &&
      typeof r.toolCalls === "number"
    );
  }
  return false;
}
