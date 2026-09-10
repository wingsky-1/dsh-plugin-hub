/**
 * dsh-provider-usage/trend — 事件折叠状态机。
 *
 * 纯逻辑模块：吃官方 SessionEvent 流，产出定稿记录（call/counter），不碰 IO、
 * 不持时钟（now 可注入）。热路径纪律：handler 顶部先按 event.type 廉价过滤，
 * 再做防御性深检查（payload 跨宿主边界不受信）。
 *
 * 记账口径（0.1.5-rc.1 起；证据 = @deepseek-ai/dsh-session 官方类型层）：
 * - 0.1.2 的 `assistant/chunk`（逐 chunk firehose）已被官方移除，usage 改由**结算
 *   事件**承载：`assistant/message` 带顶层 `usage` 且内嵌压缩 `stream`；
 *   `assistant/attempt`（失败/中止且未提交消息的尝试）只带 `stream`。
 * - 一次结算 = 一次尝试入账（call）；retry 取该 (session, turn, step) 内的结算序数，
 *   同键多次结算即重试逐次计——与 0.1.2「每次尝试一条 usage chunk」同构。
 * - token 取值顺序 = 顶层 `usage` ?? stream 内最后一条裸 usage chunk，**二选一**：
 *   真实会话中 message 的两处 usage 恒等（实测 871/871），两处都取会翻倍。
 * - 无 usage 的 `assistant/attempt` 不入账（0.1.2 无 usage chunk 即无调用证据）；
 *   无 usage 的 `assistant/message` 仍入账、token 记 null（沿用零 usage 语义）。
 * - request/header 折叠为 per-session 归属主源（EpochHeader.config.provider/model）；
 *   message.source（kind:"model"）为副源（仅归属缺失时补）；两者皆缺 → 未识别桶。
 * - turn/end 轮次计数独立 +1；tool/call 计数独立 +1。
 * - 会话状态 TTL：默认 60min 无活动整会话丢弃（下次活动必伴随新 request/header，
 *   归属随后自愈）。
 */
import type { SessionEvent } from "@deepseek-ai/dsh-session/types";
import {
  TREND_UNIDENTIFIED,
  safeId,
  safeToken,
  sanitizeDirName,
  type TrendAttribution,
  type TrendTokens,
} from "./types.ts";

/** 会话状态（归属/目录/结算序数记忆）整体 TTL。 */
export const TREND_SESSION_TTL_MS = 60 * 60 * 1000;
/**
 * 结算序数记忆上限（键数）：超过后按 Map 插入序淘汰最旧键。
 * 记忆不按 turn 清（保留跨 turn 的序数连续性），本上限是唯一收缩路径，
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
  /**
   * 目录归属（cwd 经 sanitizeDirName 归一化的 basename；
   * store 无 session / header.cwd 缺失 / 获取抛错时为 TREND_UNIDENTIFIED——
   * 不静默丢弃，沿用 provider 维度未识别桶约定）。
   */
  dir: string;
  /** token 计量（无 usage 的成功结算为 null——调用照计）。 */
  tokens: TrendTokens | null;
  interrupted?: true;
}

/**
 * 校正记录：覆盖同 fold 键已定稿明细的 token 值（不重计调用）。
 * 0.1.5 起结算事件自带完整 token，collector 不再产出 correct；类型保留供
 * 聚合层既有消费面（applyCorrect）与外部消费者使用。
 */
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
  /** 目录归属（同 TrendCallRecord.dir）。 */
  dir: string;
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
  /**
   * 目录归属缓存：值三态——string = 已解析（净化 basename 或
   * TREND_UNIDENTIFIED）；null = 已查询但 store 无该 session / cwd 缺失 / 抛错
   * （缓存未识别结果，防同 session 重复查询）；undefined = 尚未查询。
   * 同 session 生命周期内至多发起一次 store.get（TTL 回收随会话状态）。
   */
  dir: string | null | undefined;
  /**
   * (turn, step) → 该键已结算次数。下一次同键结算即 retry = 记忆值 + 1，
   * 使重试逐次独立入账（结算序数内生于主事件，不依赖可选插件的重试事件）。
   * 上限 TREND_DONE_MAX 按插入序淘汰最旧键（长命会话防无界增长）。
   */
  done: Map<string, number>;
  /** 最近一次事件触达（墙钟，注入时钟）；会话级 TTL 依据。 */
  lastTouch: number;
}

export interface TrendCollectorOptions {
  /** 注入时钟（默认 Date.now；测试可冻结/步进）。 */
  now?: () => number;
  /** 定稿记录出口（aggregator.apply*）。 */
  emit: (e: TrendEmit) => void;
  /** 归属异常告警出口（主源与 message.source 副源不一致等；只告警不纠数）。 */
  onAnomaly?: (msg: string) => void;
  /**
   * 目录归属解析器（可选）：输入 session id，返回 cwd 原始值或 undefined。
   * 接入 ctx.sessions.get(id)?.header.cwd（官方类型层）；抛错由本模块捕获归未识别。
   * 缺省 = 不接 store（纯离线/测试），目录恒归未识别桶。
   */
  resolveCwd?: (session: string) => string | undefined;
}

/**
 * 结算序数记忆写入：超上限按 Map 插入序淘汰最旧键（done.set 对已存键
 * 不重置插入序，淘汰目标恒为最早写入且未被复写的键）。
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

/**
 * 取压缩 stream 里最后一条**裸** usage chunk 的 usage（倒序扫，命中即返回）。
 *
 * 只需认 `{type:'chunk', chunk}` 一种记录形态：usage 属 RawStreamChunkType，
 * 官方 accumulator 从不把非 delta chunk 打包成 text/reasoning/tool-call-chunks
 * run，故 packed 形态结构上不可能承载 usage（无需展开 time0+dt 重建时间戳——
 * 调用时刻统一取事件自身的 `time`）。
 */
function lastUsageFromStream(stream: unknown): unknown {
  if (!Array.isArray(stream)) return undefined;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const rec = stream[i] as { type?: unknown; chunk?: { type?: unknown; usage?: unknown } } | undefined;
    if (rec?.type === "chunk" && rec.chunk?.type === "usage") return rec.chunk.usage;
  }
  return undefined;
}

export class TrendCollector {
  private readonly sessions = new Map<string, SessionFoldState>();
  private readonly now: () => number;
  private readonly emit: (e: TrendEmit) => void;
  private readonly onAnomaly: ((msg: string) => void) | null;
  private readonly resolveCwd: ((session: string) => string | undefined) | null;
  private lastSweep = 0;

  constructor(opts: TrendCollectorOptions) {
    this.now = opts.now ?? Date.now;
    this.emit = opts.emit;
    this.onAnomaly = opts.onAnomaly ?? null;
    this.resolveCwd = opts.resolveCwd ?? null;
  }

  /** 会话状态（惰性建）。 */
  private stateOf(session: string): SessionFoldState {
    let s = this.sessions.get(session);
    if (s === undefined) {
      s = { attribution: null, dir: undefined, done: new Map<string, number>(), lastTouch: this.now() };
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
   * 目录归属解析：per-session 惰性单查——首次需要归属时经 resolveCwd
   * 查一次（结果缓存进会话状态，后续定稿直接命中缓存）；store 无该 session /
   * cwd 缺失 / sanitize 失败 / resolveCwd 抛错 → 缓存 null（未识别），同样只查一次。
   */
  private dirOf(s: SessionFoldState, session: string): string {
    if (s.dir !== undefined) return s.dir ?? TREND_UNIDENTIFIED;
    let dir: string | null = null;
    if (this.resolveCwd !== null) {
      try {
        const raw = this.resolveCwd(session);
        dir = raw === undefined ? null : sanitizeDirName(raw);
      } catch {
        dir = null; // 获取抛错 → 未识别（缓存，不重复查询）
      }
    }
    s.dir = dir;
    return dir ?? TREND_UNIDENTIFIED;
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
          this.onHeader(state, event);
          return;
        case "assistant/message":
          this.onSettled(state, session, event, "message");
          return;
        case "assistant/attempt":
          this.onSettled(state, session, event, "attempt");
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

  /** TTL 兜底扫描（60s 惰性节流）：会话状态整体回收。 */
  private lazySweep(nowMs: number): void {
    if (nowMs - this.lastSweep < 60_000) return;
    this.lastSweep = nowMs;
    for (const [id, s] of this.sessions) {
      if (nowMs - s.lastTouch > TREND_SESSION_TTL_MS) this.sessions.delete(id);
    }
  }

  private onHeader(state: SessionFoldState, event: SessionEvent & { type: "request/header" }): void {
    // 归属主源：逐会话折叠最新 header（含 mid-session 切换的 series 语义——取最新即可）
    const config = (event.data as { header?: { config?: unknown } } | undefined)?.header?.config;
    const next = parseAttribution(config);
    if (next !== null) state.attribution = next;
  }

  /**
   * 一次模型尝试的结算入账（0.1.5 的 usage 承载点）。
   *
   * kind 区分两类结算：`message` = 提交了消息（带顶层 usage，可能被中断），
   * `attempt` = 失败/中止且未提交消息（usage 只可能在内嵌 stream 里）。
   */
  private onSettled(
    state: SessionFoldState,
    session: string,
    event: SessionEvent & { type: "assistant/message" | "assistant/attempt" },
    kind: "message" | "attempt",
  ): void {
    const d = event.data as {
      turn?: unknown;
      step?: unknown;
      usage?: unknown;
      interrupted?: unknown;
      stream?: unknown;
      message?: { source?: unknown };
    };
    const turn = typeof d.turn === "number" && Number.isFinite(d.turn) ? d.turn : null;
    const step = typeof d.step === "number" && Number.isFinite(d.step) ? d.step : null;
    if (turn === null || step === null) return;
    // 副源归属：归属缺失时用 message.source（kind:"model"）补齐；主源在场
    // 但与副源解析结果不一致（provider 或 model 不同）时仅告警不覆盖——主源 header
    // 是记账归属的权威，message.source 仅为缺失时的补齐副源。
    if (kind === "message") {
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
    }
    // token 二选一：顶层 usage 优先，回落 stream 内最后一条裸 usage chunk。
    // message 与 attempt 的 stream 都可能带 usage，但 message 自带顶层 field，
    // 二者恒等（实测），绝不可相加。
    const tokens =
      kind === "message"
        ? (parseTokens(d.usage) ?? parseTokens(lastUsageFromStream(d.stream)))
        : parseTokens(lastUsageFromStream(d.stream));
    // 无 usage 的失败尝试无调用证据（0.1.2 同边界：无 usage chunk 即不入账）；
    // 而提交了消息的结算即便无 usage 也要入账、token 记 null（零 usage 语义）。
    if (kind === "attempt" && tokens === null) return;

    const key = this.foldKey(turn, step);
    const settled = state.done.get(key);
    const retry = settled === undefined ? 1 : settled + 1;
    rememberDone(state.done, key, retry);
    const time = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : this.now();
    const { provider, model } = this.providerOf(state);
    const dir = this.dirOf(state, session);
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
        dir,
        tokens,
        ...(kind === "message" && d.interrupted === true ? { interrupted: true as const } : {}),
      },
    });
  }

  private onTurnEnd(state: SessionFoldState, session: string, event: SessionEvent & { type: "turn/end" }): void {
    void state;
    // counter 记账时间取事件 time（防时钟回拨时 counter 落错日桶），非有限数回落 now
    const time = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : this.now();
    const { provider, model } = this.providerOf(state);
    const dir = this.dirOf(state, session);
    this.emit({ type: "counter", record: { time, session, provider, model, dir, turns: 1, toolCalls: 0 } });
  }

  private onToolCall(state: SessionFoldState, session: string, event: SessionEvent & { type: "tool/call" }): void {
    // 同 onTurnEnd：counter 记账时间取事件 time，非有限数回落 now（口径与 onSettled 一致）
    const time = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : this.now();
    const { provider, model } = this.providerOf(state);
    const dir = this.dirOf(state, session);
    this.emit({ type: "counter", record: { time, session, provider, model, dir, turns: 0, toolCalls: 1 } });
  }

  private foldKey(turn: unknown, step: unknown): string {
    return `${String(turn)}:${String(step)}`;
  }
}
