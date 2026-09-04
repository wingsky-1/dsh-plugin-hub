/**
 * dsh-provider-usage/trend — 事件折叠状态机（#503 M1）。
 *
 * 纯逻辑模块：吃官方 SessionEvent 流，产出定稿记录（call/correct/counter），
 * 不碰 IO、不持时钟（now 可注入）。热路径纪律：handler 顶部先按 event.type /
 * chunk.type 廉价过滤，再做防御性深检查（payload 跨宿主边界不受信）。
 *
 * 记账口径（方案定稿 v1.2，证据 = @deepseek-ai/dsh-session 官方类型层）：
 * - usage chunk 到达即定稿（主信号）：fold 键 (session, turn, step, retry)；
 * - retry 判定：同一 (turn,step) 自上次定稿后出现新的 request/header（重试复用
 *   同一 (turn,step)，retrySeq 递增）→ 下一个 usage 定稿为新的一次调用；
 *   未出现新 header 的后续 usage chunk 视为同一调用的重复/更新块 → 校正不重记；
 * - assistant/message：已定稿 → 校正（token 覆盖，不重计调用）；未定稿/缺失 →
 *   补记（usage 缺失时调用照计、token 记 null——零 usage 语义）；interrupted 同口径；
 * - request/header 折叠为 per-session 归属主源（EpochHeader.config.provider/model）；
 *   message.source（kind:"model"）为副源（仅归属缺失时补）；两者皆缺 → 未识别桶；
 * - turn/end：该 turn 全部 fold 状态强制丢弃（已定稿的已入账，无证据的不入账）；
 *   turn 计数独立 +1（轮次指标）；tool/call 计数独立 +1；
 * - 缓冲 GC 三重保险之一：TTL 扫描（默认 10min 无活动整会话状态丢弃；
 *   下次活动必伴随新 request/header，归属随后自愈）。
 */
import type { SessionEvent } from "@deepseek-ai/dsh-session/types";
import {
  TREND_UNIDENTIFIED,
  safeId,
  safeToken,
  type TrendAttribution,
  type TrendTokens,
} from "./types.ts";

/** fold 缓冲 TTL（方案定稿：约 10min 强制兜底）。 */
export const TREND_FOLD_TTL_MS = 10 * 60 * 1000;
/** 会话状态（定稿记忆/归属）整体 TTL（长于 fold TTL，防乱序迟到 message 双算）。 */
export const TREND_SESSION_TTL_MS = 60 * 60 * 1000;
/**
 * done 定稿记忆上限（键数，P2-3）：超过后按 Map 插入序淘汰最旧键。
 * done 不按 turn 清（保留定稿记忆防乱序迟到 message 双算），本上限是唯一收缩路径，
 * 防长命会话无界增长。
 */
export const TREND_DONE_MAX = 200;

/** 一次定稿 LLM 调用（collector → aggregator 的主记录）。 */
export interface TrendCallRecord {
  time: number;
  session: string;
  turn: number;
  step: number;
  retry: number;
  /** 归属 provider（未识别时为 TREND_UNIDENTIFIED）。 */
  provider: string;
  /** 归属 model（未识别/缺失时 null）。 */
  model: string | null;
  /** token 计量（补记且 usage 缺失时 null——调用照计）。 */
  tokens: TrendTokens | null;
  interrupted?: true;
}

/** 校正记录：覆盖同 fold 键已定稿明细的 token 值（不重计调用）。 */
export interface TrendCorrectRecord {
  session: string;
  turn: number;
  step: number;
  retry: number;
  tokens: TrendTokens;
}

/** 轮次/工具调用计数记录（归属按会话当前折叠结果）。 */
export interface TrendCounterRecord {
  time: number;
  session: string;
  provider: string;
  model: string | null;
  turns: 0 | 1;
  toolCalls: 0 | 1;
}

export type TrendEmit =
  | { type: "call"; record: TrendCallRecord }
  | { type: "correct"; record: TrendCorrectRecord }
  | { type: "counter"; record: TrendCounterRecord };

/** 单会话折叠状态。 */
interface SessionFoldState {
  attribution: TrendAttribution | null;
  /** 进行中 fold 缓冲，key = `${turn}:${step}`。 */
  folds: Map<string, { retry: number; finalized: boolean }>;
  /**
   * 重试边界标记（会话级）：request/header 不携带 turn/step（官方类型只有
   * header/reason/startsSeries），而会话内请求串行——「上次定稿后见过新 header」
   * 即判定下一个 usage 为新一次调用（retry），未见 header 的 usage 为同调用重复块。
   */
  headerSeen: boolean;
  /**
   * 已定稿 fold 记忆（turn/end 丢弃的是未定稿缓冲，不是定稿记忆；防乱序迟到 message 双算）。
   * 值 = 该键最后一次定稿的 retry（fold 被 TTL 清后，迟到校正据此取真实 retry，P2-3）；
   * 上限 TREND_DONE_MAX 按插入序淘汰最旧键（长命会话防无界增长）。
   */
  done: Map<string, number>;
  /** 最近一次事件触达（墙钟，注入时钟）；会话级 TTL 依据。 */
  lastTouch: number;
  /** 最近一次 fold 活动；fold 级 TTL 依据。 */
  lastFoldTouch: number;
}

export interface TrendCollectorOptions {
  /** 注入时钟（默认 Date.now；测试可冻结/步进）。 */
  now?: () => number;
  /** 定稿记录出口（aggregator.apply*）。 */
  emit: (e: TrendEmit) => void;
  /** 归属异常告警出口（P2-6：主源与 message.source 副源不一致等；只告警不纠数）。 */
  onAnomaly?: (msg: string) => void;
}

/**
 * done 定稿记忆写入（P2-3）：超上限按 Map 插入序淘汰最旧键（done.set 对已存键
 * 不重置插入序，淘汰目标恒为最早写入且未被复写的键）。失败路径不写 done——
 * 只有真实定稿才进记忆。
 */
function rememberDone(done: Map<string, number>, key: string, retry: number): void {
  done.set(key, retry);
  if (done.size > TREND_DONE_MAX) {
    const oldest = done.keys().next();
    if (!oldest.done) done.delete(oldest.value);
  }
}

/** 从 EpochHeader.config / AssistantProvenance 形状的 payload 防御提取归属。 */
function parseAttribution(v: unknown): TrendAttribution | null {
  if (typeof v !== "object" || v === null) return null;
  const src = v as Record<string, unknown>;
  const provider = safeId(src.provider, 128);
  const model = safeId(src.model, 256);
  if (provider === null || model === null) return null;
  return { provider, model };
}

/** 从 TokenUsage 形状的 payload 防御提取 token 计量（全缺失返回 null）。 */
function parseTokens(v: unknown): TrendTokens | null {
  if (typeof v !== "object" || v === null) return null;
  const u = v as Record<string, unknown>;
  const input = safeToken(u.inputTokens);
  const output = safeToken(u.outputTokens);
  const cacheRead = safeToken(u.cacheReadTokens);
  const cacheWrite = safeToken(u.cacheWriteTokens);
  if (input === null && output === null && cacheRead === null && cacheWrite === null) return null;
  return { input, output, cacheRead, cacheWrite };
}

export class TrendCollector {
  private readonly sessions = new Map<string, SessionFoldState>();
  private readonly now: () => number;
  private readonly emit: (e: TrendEmit) => void;
  private readonly onAnomaly: ((msg: string) => void) | null;
  private lastSweep = 0;

  constructor(opts: TrendCollectorOptions) {
    this.now = opts.now ?? Date.now;
    this.emit = opts.emit;
    this.onAnomaly = opts.onAnomaly ?? null;
  }

  /** 会话状态（惰性建）。 */
  private stateOf(session: string): SessionFoldState {
    let s = this.sessions.get(session);
    if (s === undefined) {
      s = { attribution: null, folds: new Map(), headerSeen: false, done: new Map<string, number>(), lastTouch: this.now(), lastFoldTouch: this.now() };
      this.sessions.set(session, s);
    }
    return s;
  }

  /** 归属解析：主源（折叠 header）→ 未识别桶（不静默丢弃）。 */
  private providerOf(s: SessionFoldState): { provider: string; model: string | null } {
    const a = s.attribution;
    if (a === null) return { provider: TREND_UNIDENTIFIED, model: null };
    return { provider: a.provider, model: a.model };
  }

  /**
   * 事件入口（单个 session/event）。任何异常都就地吞掉（单事件失败不连坐，
   * dsh-notifier 同款隔离），调用方无须再包 try/catch。
   */
  handleEvent(session: string, event: SessionEvent): void {
    const nowMs = this.now();
    try {
      if (typeof session !== "string" || session.length === 0) return;
      if (typeof event !== "object" || event === null) return;
      const state = this.stateOf(session);
      state.lastTouch = nowMs;
      switch (event.type) {
        case "request/header":
          this.onHeader(state, session, event);
          return;
        case "assistant/chunk":
          // 热路径：先按 chunk.type 廉价过滤（token 级 firehose 的绝大多数 chunk 在此返回）
          if ((event.data as { chunk?: { type?: unknown } } | undefined)?.chunk?.type !== "usage") return;
          this.onUsageChunk(state, session, event, nowMs);
          return;
        case "assistant/message":
          this.onMessage(state, session, event);
          return;
        case "turn/end":
          this.onTurnEnd(state, session, event);
          return;
        case "tool/call":
          this.onToolCall(state, session, event);
          return;
        default:
          return; // 其余事件类型与记账无关
      }
    } catch {
      /* 单事件失败不连坐 */
    } finally {
      this.lazySweep(nowMs);
    }
  }

  /** 会话销毁清理（session/disposed）。 */
  handleDisposed(session: string): void {
    try {
      if (typeof session === "string") this.sessions.delete(session);
    } catch {
      /* 忽略 */
    }
  }

  /** TTL 兜底扫描（60s 惰性节流）：fold 缓冲 10min、会话状态 60min 分级回收。 */
  private lazySweep(nowMs: number): void {
    if (nowMs - this.lastSweep < 60_000) return;
    this.lastSweep = nowMs;
    for (const [id, s] of this.sessions) {
      if (nowMs - s.lastTouch > TREND_SESSION_TTL_MS) {
        this.sessions.delete(id);
        continue;
      }
      if (nowMs - s.lastFoldTouch > TREND_FOLD_TTL_MS && s.folds.size > 0) s.folds.clear();
    }
  }

  private onHeader(state: SessionFoldState, session: string, event: SessionEvent & { type: "request/header" }): void {
    void session;
    // 归属主源：逐会话折叠最新 header（含 mid-session 切换的 series 语义——取最新即可）
    const config = (event.data as { header?: { config?: unknown } } | undefined)?.header?.config;
    const next = parseAttribution(config);
    if (next !== null) state.attribution = next;
    // 重试边界标记（会话级）：已定稿调用之后的新 header → 下一个 usage 是新一次调用
    state.headerSeen = true;
  }

  private onUsageChunk(
    state: SessionFoldState,
    session: string,
    event: SessionEvent & { type: "assistant/chunk" },
    nowMs: number,
  ): void {
    const d = event.data as { turn?: unknown; step?: unknown; chunk?: { usage?: unknown } };
    const turn = typeof d.turn === "number" && Number.isFinite(d.turn) ? d.turn : null;
    const step = typeof d.step === "number" && Number.isFinite(d.step) ? d.step : null;
    if (turn === null || step === null) return;
    const key = this.foldKey(turn, step);
    const time = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : nowMs;
    const tokens = parseTokens(d.chunk?.usage);
    let fold = state.folds.get(key);
    if (fold === undefined) {
      fold = { retry: 1, finalized: false };
      state.folds.set(key, fold);
    } else if (fold.finalized) {
      if (!state.headerSeen) {
        // 同一调用的重复/更新 usage 块 → 校正已定稿记录，不重计调用
        if (tokens !== null) {
          this.emit({ type: "correct", record: { session, turn, step, retry: fold.retry, tokens } });
        }
        return;
      }
      // 新 header 后的 usage → 重试：逐次独立入账
      fold.retry += 1;
      fold.finalized = false;
    }
    fold.finalized = true;
    state.headerSeen = false;
    state.lastFoldTouch = nowMs;
    rememberDone(state.done, key, fold.retry);
    const { provider, model } = this.providerOf(state);
    this.emit({
      type: "call",
      record: { time, session, turn, step, retry: fold.retry, provider, model, tokens },
    });
  }

  private onMessage(state: SessionFoldState, session: string, event: SessionEvent & { type: "assistant/message" }): void {
    const d = event.data as {
      turn?: unknown;
      step?: unknown;
      usage?: unknown;
      interrupted?: unknown;
      message?: { source?: unknown };
    };
    const turn = typeof d.turn === "number" && Number.isFinite(d.turn) ? d.turn : null;
    const step = typeof d.step === "number" && Number.isFinite(d.step) ? d.step : null;
    if (turn === null || step === null) return;
    // 副源归属（P2-6）：归属缺失时用 message.source（kind:"model"）补齐；主源在场
    // 但与副源解析结果不一致（provider 或 model 不同）时仅告警不覆盖——主源 header
    // 是记账归属的权威，message.source 仅为缺失时的补齐副源。
    const src = d.message?.source as Record<string, unknown> | undefined;
    if (src !== undefined && src.kind === "model") {
      const alt = parseAttribution(src);
      if (alt !== null) {
        if (state.attribution === null) {
          state.attribution = alt;
        } else if (state.attribution.provider !== alt.provider || state.attribution.model !== alt.model) {
          this.onAnomaly?.(
            `归属不一致（session=${session} turn=${turn} step=${step}）：主源 ${state.attribution.provider}/${state.attribution.model ?? "null"} 与 message.source ${alt.provider}/${alt.model} 不同，保留主源`,
          );
        }
      }
    }
    const key = this.foldKey(turn, step);
    const fold = state.folds.get(key);
    const tokens = parseTokens(d.usage);
    if ((fold !== undefined && fold.finalized) || state.done.has(key)) {
      // 已定稿（fold 在场或已成记忆）→ 仅校正不重记。
      // retry 取值（P2-3）：fold 在场取 fold.retry；fold 被 TTL 清后从 done 记忆取
      // 真实 retry（防迟到校正错改 retry=1 行）；两者皆缺兜底 1。
      if (tokens !== null) {
        const retry = fold?.retry ?? state.done.get(key) ?? 1;
        this.emit({ type: "correct", record: { session, turn, step, retry, tokens } });
      }
      return;
    }
    // 未定稿/缺失 → 补记（usage 缺失：调用照计、token 记 null）；时间取事件 time（非单调容忍）
    // headerSeen 对称重置（P2-2）：与 usage 定稿路径对称——header 后 message 补记定稿
    // 若仍留 headerSeen=true，同 fold 键迟到 usage chunk 会被误判为新调用（retry+1 重记）双算。
    const retry = fold !== undefined ? fold.retry : 1;
    if (fold !== undefined) {
      fold.finalized = true;
    } else {
      state.folds.set(key, { retry: 1, finalized: true });
    }
    state.lastFoldTouch = this.now();
    state.headerSeen = false;
    rememberDone(state.done, key, retry);
    const time = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : this.now();
    const { provider, model } = this.providerOf(state);
    this.emit({
      type: "call",
      record: {
        time,
        session,
        turn,
        step,
        retry,
        provider,
        model,
        tokens,
        ...(d.interrupted === true ? { interrupted: true as const } : {}),
      },
    });
  }

  private onTurnEnd(state: SessionFoldState, session: string, event: SessionEvent & { type: "turn/end" }): void {
    const turn = (event.data as { turn?: unknown }).turn;
    if (typeof turn === "number" && Number.isFinite(turn)) {
      // 强制收尾：该 turn 全部 fold 状态丢弃（已定稿已入账；无证据的不入账）
      const prefix = `${turn}:`;
      for (const key of state.folds.keys()) {
        if (key.startsWith(prefix)) state.folds.delete(key);
      }
    }
    // counter 记账时间取事件 time（P2-1：防时钟回拨时 counter 落错日桶），非有限数回落 now
    const time = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : this.now();
    const { provider, model } = this.providerOf(state);
    this.emit({ type: "counter", record: { time, session, provider, model, turns: 1, toolCalls: 0 } });
  }

  private onToolCall(state: SessionFoldState, session: string, event: SessionEvent & { type: "tool/call" }): void {
    // 同 onTurnEnd：counter 记账时间取事件 time，非有限数回落 now（口径与 onMessage 一致）
    const time = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : this.now();
    const { provider, model } = this.providerOf(state);
    this.emit({ type: "counter", record: { time, session, provider, model, turns: 0, toolCalls: 1 } });
  }

  private foldKey(turn: unknown, step: unknown): string {
    return `${String(turn)}:${String(step)}`;
  }
}
