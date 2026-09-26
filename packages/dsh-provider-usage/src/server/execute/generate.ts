/**
 * dsh-provider-usage — server/execute 域：报告生成（ctx.llm.stream 路线）
 * （#768 D3，由 domain2/execute/generate.ts 搬入，零行为变更）。
 *
 * - 零凭据、零独立网络出口：模型调用经宿主 llm 服务（ctx.llm.stream），
 *   凭据由 dsh 既有 provider 配置持有，本插件不接触（README 安全模型同步口径）；
 * - 生成消耗不入统计：llm.stream 不派发 session/event → 不进用量记账
 *   （单测显式断言该前提），token 消耗单独记录在报告元数据（报告页可见）；
 * - 无会话副作用：一击式流式调用，不创建 agent/会话、无工具面（tools 不传）；
 * - provider/model 空串 = 跟随默认：dsh-llm 服务面无「默认 provider」API
 *   （仅 listProviders/listModels/stream），按注册序首个 provider/model 解析
 *   （单 provider 部署即默认；多 provider 建议在报告配置显式选择），解析结果写入元数据；
 * - 失败语义：流式异常 → ok:false 元数据（错误短句可读），不抛——
 *   幂等重试由调度层决定（onDue 抛错才不推进 lastRun，见接线层约定）；
 * - 官方类型层仅 import type（仓库契约门禁「@deepseek-ai/* 仅类型导入」）：
 *   prompt 消息自拼 UserMessage 字面量（与官方 createUserMessage 产物同形——
 *   id = crypto.randomUUID()，官方 createMessage 同源 randomUUID 生成稳定 id；
 *   仅作只读传参，无需 freeze）。
 */
import type {
  ContentBlockType,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmReasoningEffortInfo,
  LlmResolvedModelInfo,
  MessageId,
  StreamChunk,
  UserMessage,
} from "@deepseek-ai/dsh-llm";
import { metricValue } from "../shared/interface.ts";
import {
  sumToken,
  TREND_UNIDENTIFIED,
  type TrendCell,
  type TrendDirRow,
  type TrendHourRow,
} from "../shared/interface.ts";
import type { ReportPeriod } from "../config/interface.ts";
import type { RetryFailure, RetryRouteSnapshot } from "./runner.ts";

/** 报告生成所用 llm 服务面（LlmRuntime 最小结构面——只依赖实际用到的三个方法）。 */
export interface ReportLlmService {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  listProviders(): LlmProviderInfo[];
  listModels(provider: string): Promise<LlmModelInfo[]>;
}

/** 报告 token 元数据（防御解析后；缺失维度 null）。 */
export interface ReportTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/** 报告 hero 摘要（meta.json 落盘 + 详情页年报 hero 数据源；纯数值投影）。 */
export interface ReportMetaSummary {
  total: number | null;
  calls: number;
  activeDays: number;
  windowDays: number;
  longestStreak: number;
  wowRatio: number | null;
  peakDay: { day: string; total: number | null } | null;
  /** 最活跃钟点（快照 peakHour 透传；覆盖不足/全 null 时 null，旧报告缺字段照读） */
  peakHour: { hour: number; calls: number; total: number | null } | null;
}

/** 报告元数据（落盘与索引 JSONL 由接线层负责，本模块只产出数据）。 */
export interface ReportMeta {
  period: ReportPeriod;
  /** 窗口键（与 DueReport.key 一致，幂等标记单位）。 */
  key: string;
  startDay: string;
  endDay: string;
  /** 实际使用的 provider/model（空串「跟随默认」已解析为具体路由）。 */
  provider: string;
  model: string;
  /** 生成发起时间（epoch ms）。 */
  generatedAt: number;
  durationMs: number | null;
  ok: boolean;
  /** 失败原因（ok=false 时的可读短句）。 */
  error?: string;
  /** 生成消耗 token（流携带 usage chunk 时记录；不入用量统计）。 */
  tokens?: ReportTokenUsage;
  /** 当期无任何用量（calls=0）→ 未调模型、未落盘（调度侧正常推进 lastRun 防重试死循环）。 */
  noData?: boolean;
  /** 当期 hero 摘要（成功生成时随 meta 落盘；旧报告无此字段，详情页不渲染 hero）。 */
  summary?: ReportMetaSummary;
}

/** 报告生成结果（正文 + 元数据）。 */
export interface ReportResult {
  /** 报告正文（LLM 产出的叙事文本；失败时为空串）。 */
  body: string;
  meta: ReportMeta;
}

/** 包内单次生成观测：只含安全数字，不携带 provider 原文。 */
export interface GenerateReportAttempt {
  durationMs: number | null;
  tokens: ReportTokenUsage | null;
}

/** 包内结构化生成结果：失败标签只含稳定 code/kind，不携带 provider 原文。 */
export type GenerateReportOutcome =
  | { status: "success"; result: ReportResult; attempt: GenerateReportAttempt }
  | {
      status: "failure";
      failure: RetryFailure;
      result: ReportResult;
      attempt: GenerateReportAttempt;
    };

/** executor claim 使用的路由解析结果；unresolved 不得进入 stream。 */
export interface UnresolvedRouteOutcome {
  status: "failure";
  route: RetryRouteSnapshot;
  failure: RetryFailure;
  /** true 仅表示路由暂不可解析；失败类别仍由 failure.kind 决定。 */
  unresolved: true;
}

export type GenerateRouteOutcome =
  | { status: "success"; route: RetryRouteSnapshot }
  | UnresolvedRouteOutcome
  | { status: "failure"; route: RetryRouteSnapshot; failure: RetryFailure; unresolved?: false };

const UNRESOLVED_ROUTE_ID = "__dsh_provider_usage_unresolved__";

/** 仅为 ledger 保留的非空占位路由；它绝不是可 stream 的已解析路由。 */
export function unresolvedRouteSnapshot(): RetryRouteSnapshot {
  return { provider: UNRESOLVED_ROUTE_ID, model: UNRESOLVED_ROUTE_ID };
}

export function isUnresolvedRoute(route: RetryRouteSnapshot): boolean {
  return (
    route.provider === UNRESOLVED_ROUTE_ID ||
    route.model === UNRESOLVED_ROUTE_ID ||
    route.provider.length === 0 ||
    route.model.length === 0
  );
}

export function isResolvedRouteSnapshot(route: RetryRouteSnapshot): boolean {
  return !isUnresolvedRoute(route);
}

export interface GenerateReportOptions {
  /** 宿主 llm 服务面（apply 层传 ctx.llm）。 */
  llm: ReportLlmService;
  period: ReportPeriod;
  key: string;
  startDay: string;
  endDay: string;
  /** 当期聚合统计 JSON 字符串（buildStatsSnapshot 产出；注入 {stats} 占位）。 */
  statsJson: string;
  /** 窗口范围文本（注入 {range} 占位；缺省 = startDay ~ endDay）。 */
  rangeText?: string;
  /** 提示词模板（{stats}/{range} 双占位；normalizeReportConfig 已保证非空）。 */
  promptTemplate: string;
  /** 配置的 provider/model；空串 = 跟随默认（解析为注册序首个）。 */
  provider: string;
  model: string;
  /** 配置的 opaque reasoning effort ID；仅在 exact-model capability 精确命中后传入。 */
  reasoningEffort?: string;
  /** 取消信号（透传 GenerateOptions.signal）。 */
  signal?: AbortSignal;
  /** 注入时钟（测试；默认 Date.now）。 */
  now?: () => number;
}

/** 包内 outcome 调用面：允许 executor 复用 claim 中的同一路由快照。 */
export interface GenerateReportOutcomeOptions extends GenerateReportOptions {
  route?: GenerateRouteOutcome;
}

/**
 * 报告统计快照（注入 {stats} 的 JSON 形状；方案 §2.3「当期聚合统计」）。
 * 注入面 = 聚合数值 + 目录 basename（剥控制字符 + 截断），不含
 * 会话明细与完整路径。
 */
export interface ReportStatsSnapshot {
  period: ReportPeriod;
  startDay: string;
  endDay: string;
  /** 窗口聚合总量。 */
  totals: {
    calls: number;
    turns: number;
    toolCalls: number;
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    /** 四项 token 之和（null-aware）。 */
    total: number | null;
  };
  /** 逐日总量序列（窗口内出现数据的日，升序）。 */
  byDay: Array<{ day: string; total: number | null }>;
  /** 按适配器聚合（calls 降序；叙事化「最活跃适配器/模型」数据源）。 */
  byProvider: Array<{
    provider: string;
    model: string | null;
    calls: number;
    total: number | null;
  }>;
  /** 上一同等长度窗口的指标总量（环比基准；接线层经 windowSummary 取得）。 */
  prevTotal: number | null;
  /** 按目录聚合（calls 降序，口径与 byProvider 一致；未识别桶
   * dir=TREND_UNIDENTIFIED；dir 键为脱敏出口形态的 basename 或未识别桶键（basename
   * 化 + 剥控制字符 + 截断 80，无路径分隔符）；旧数据
   * 无 dir 事实 → 空数组，不补造）。 */
  byDirectory: Array<{ dir: string; calls: number; total: number | null }>;
  // ---------------------------------------------------------------- 时段维度
  // 数据面 = day×hour 聚合行（hourRows，落盘即定型）；覆盖度守卫：coveredDays 为
  // 窗口内有 hour 事实（calls>0）的天数，**coveredDays < windowDays 时三个时段字段
  // 整体置 null**（升级期部分天缺小时事实时提示词整段降级，杜绝「1/7 天代表整周」）。
  /** 窗口内按钟点聚合（24 项 hour 0..23 全量；无数据钟点 calls=0/total=null，
   * 零 usage 语义——调用独立计数、token 记 null；覆盖不足时整体 null）。 */
  byHour: Array<{ hour: number; calls: number; total: number | null }> | null;
  /** 预分四时段（凌晨 0-5 / 上午 6-11 / 下午 12-17 / 晚间 18-23；口径由代码
   * 锁定，防弱模型自行归纳编造；无数据档 total=null；覆盖不足时整体 null）。 */
  byPeriod: Array<{ period: string; calls: number; total: number | null }> | null;
  /** 最活跃钟点（byHour 内 total 判峰、并列取最早；全 null → null；覆盖不足时 null）。 */
  peakHour: { hour: number; calls: number; total: number | null } | null;
  /** 窗口内有 hour 事实的天数（覆盖度守卫：< windowDays 时上三个字段整体 null）。 */
  coveredDays: number;
  // ---------------------------------------------------------------- 年报派生维度
  // 全部为快照内单遍派生的聚合数值，注入面收敛承诺不变（仍无路径/会话明细）。
  /** 峰值日（byDay 内 total 最大的一天；空窗口 null）。 */
  peakDay: { day: string; total: number | null } | null;
  /** 活跃天数（byDay 中有数据的天数）。 */
  activeDays: number;
  /** 窗口总天数（含无数据日）。 */
  windowDays: number;
  /** 活跃日均用量（avg = totals.total / activeDays；activeDays=0 → null）。 */
  avgPerActiveDay: number | null;
  /** 最长连续活跃天数（按日历日差=1 判定，跨月/跨年安全；activeDays=0 → 0）。 */
  longestStreak: number;
  /**
   * 环比比值（当期 total / prevTotal）。prevTotal 缺失或 <= 0 → null（不做对比；
   * 防 Infinity——JSON.stringify(Infinity) 会静默变 null 造成语义错误）。
   */
  wowRatio: number | null;
  /** 按星期分布的总量（周一..周日 7 项，index 0=周一；无数据日计 0）。 */
  byWeekday: [number, number, number, number, number, number, number];
}

/** 防御性有限数（usage chunk 字段跨宿主边界不受信）。 */
function safeNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** 从 TokenUsage 防御提取报告 token 元数据。 */
function parseTokenUsage(u: unknown): ReportTokenUsage {
  const src = (typeof u === "object" && u !== null ? u : {}) as Record<string, unknown>;
  return {
    inputTokens: safeNum(src.inputTokens),
    outputTokens: safeNum(src.outputTokens),
    reasoningTokens: safeNum(src.reasoningTokens),
    totalTokens: safeNum(src.totalTokens),
    cacheReadTokens: safeNum(src.cacheReadTokens),
    cacheWriteTokens: safeNum(src.cacheWriteTokens),
  };
}

/**
 * {stats}/{range} 双占位替换（模板其余文本原样保留；占位多次出现全部替换）。
 * split+join 而非 replace 正则：避免模板内容被按正则语义误解析。
 * 旧模板无 {range} 时原样保留（向后兼容）；rangeText 缺省时 {range} 原样保留。
 */
export function applyPromptTemplate(
  template: string,
  statsJson: string,
  rangeText?: string,
): string {
  const withStats = template.split("{stats}").join(statsJson);
  if (rangeText === undefined) return withStats;
  return withStats.split("{range}").join(rangeText);
}

const ROUTE_DISCOVERY_TIMEOUT_MS = 5_000;

const ROUTE_DISCOVERY_TIMEOUT = Symbol("route-discovery-timeout");

/**
 * 默认路由发现（listModels）与 report-models 端点同口径：5s 有界。
 * 官方 listModels 不接受 signal，底层 promise 可能在超时后继续挂起；此处已挂接
 * rejection 处理器吸收晚到错误，调用方在 deadline 处稳定收敛，绝不无限等待。
 */
async function discoverModels(llm: ReportLlmService, provider: string): Promise<LlmModelInfo[]> {
  const pending = llm.listModels(provider);
  void pending.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(ROUTE_DISCOVERY_TIMEOUT);
    }, ROUTE_DISCOVERY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** 空串跟随默认：注册序首个 provider/model（无可选项返回 null）。 */
async function resolveRoute(
  llm: ReportLlmService,
  provider: string,
  model: string,
): Promise<{ provider: string; model: string } | null> {
  let p = provider;
  if (p.length === 0) {
    p = llm.listProviders()[0]?.id ?? "";
    if (p.length === 0) return null;
  }
  let m = model;
  if (m.length === 0) {
    const models = await discoverModels(llm, p);
    m = models[0]?.id ?? "";
    if (m.length === 0) return null;
  }
  return { provider: p, model: m };
}

const CAPABILITY_RESOLVE_TIMEOUT_MS = 5_000;

const CAPABILITY_ERROR = {
  unavailable: "模型能力信息不可用",
  cancelled: "模型能力解析已取消",
  timeout: "模型能力解析超时",
  unsupported: "配置指定的思考等级不受当前模型支持",
  failed: "模型能力解析失败",
} as const;

const GENERATE_FAILURE = {
  routeResolution: { kind: "transient", code: "route-resolution-failed" },
  routeUnavailable: { kind: "permanent", code: "route-unavailable" },
  capabilityUnavailable: { kind: "permanent", code: "capability-unavailable" },
  capabilityCancelled: { kind: "aborted", code: "capability-aborted" },
  capabilityTimeout: { kind: "transient", code: "capability-timeout" },
  capabilityUnsupported: { kind: "permanent", code: "capability-unsupported" },
  capabilityFailed: { kind: "permanent", code: "capability-failed" },
  providerFinishFailed: { kind: "permanent", code: "provider-finish-failed" },
  requestAborted: { kind: "aborted", code: "request-aborted" },
  unsupportedTool: { kind: "permanent", code: "unsupported-tool" },
  unsupportedContent: { kind: "permanent", code: "unsupported-content" },
  unknownStreamEvent: { kind: "unknown", code: "unknown-stream-event" },
  protocolAfterTerminal: { kind: "unknown", code: "protocol-after-terminal" },
  unknownFinish: { kind: "unknown", code: "unknown-finish" },
  missingFinish: { kind: "unknown", code: "missing-finish" },
  reasoningOnly: { kind: "empty-output", code: "reasoning-only" },
  emptyOutput: { kind: "empty-output", code: "empty-output" },
} as const satisfies Record<string, RetryFailure>;

type OptionalModelCapabilityResolver = {
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo>;
};

/** 能力探测是内部可选能力；公开 ReportLlmService 三方法形状保持不变。 */
function hasModelCapabilityResolver(
  llm: ReportLlmService,
): llm is ReportLlmService & OptionalModelCapabilityResolver {
  return "resolveModelInfo" in llm && typeof llm.resolveModelInfo === "function";
}

/** 能力探测结论（成功携带 exact-model 命中的 opaque effort ID；失败带固定安全文案）。 */
type CapabilityOutcome =
  | { ok: true; id: LlmReasoningEffortInfo["id"] }
  | { ok: false; error: string; failure: RetryFailure };

const CAPABILITY_UNSUPPORTED: CapabilityOutcome = {
  ok: false,
  error: CAPABILITY_ERROR.unsupported,
  failure: GENERATE_FAILURE.capabilityUnsupported,
};

/**
 * effort 精确命中判定（唯一放行口）：必须落在该 exact model 的 efforts 白名单内，
 * 缺 reasoning 段、efforts 非数组、找不到 configured 三者同归 unsupported。
 */
function matchConfiguredEffort(info: LlmResolvedModelInfo, configured: string): CapabilityOutcome {
  const efforts = info.reasoning?.efforts;
  if (!Array.isArray(efforts)) return CAPABILITY_UNSUPPORTED;
  const exact = efforts.find((effort) => effort.id === configured);
  return exact === undefined ? CAPABILITY_UNSUPPORTED : { ok: true, id: exact.id };
}

/** 探测失败的归因（顺序即优先级：超时 → 外部取消 → 其它解析失败）。 */
function classifyCapabilityFailure(timedOut: boolean, cancelled: boolean): CapabilityOutcome {
  if (timedOut) {
    return {
      ok: false,
      error: CAPABILITY_ERROR.timeout,
      failure: GENERATE_FAILURE.capabilityTimeout,
    };
  }
  if (cancelled) {
    return {
      ok: false,
      error: CAPABILITY_ERROR.cancelled,
      failure: GENERATE_FAILURE.capabilityCancelled,
    };
  }
  return { ok: false, error: CAPABILITY_ERROR.failed, failure: GENERATE_FAILURE.capabilityFailed };
}

/**
 * 能力探测的取消/超时作用域：内部 controller 承担 5s 超时兜底，caller signal
 * 手动级联合流（不用 AbortSignal.any——engines node>=20 全系兼容）。
 * finish() 幂等收口：停表、摘 caller 监听（防长生命周期 signal 累积监听器泄漏）。
 */
function beginCapabilityScope(signal: AbortSignal | undefined) {
  const controller = new AbortController();
  let timedOut = false;
  let callerCancelled = false;
  let rejectDeadline: (() => void) | undefined;
  let rejectCancellation: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = () => reject();
  });
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = () => reject();
  });
  const onCallerAbort = (): void => {
    callerCancelled = true;
    rejectCancellation?.();
    controller.abort();
  };
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    controller,
    races: [deadline, cancellation],
    /** 超时闸门起跑（resolveModelInfo 发起后才计时，保证时长覆盖真实调用）。 */
    startTimer: (): void => {
      timer = setTimeout(() => {
        timedOut = true;
        rejectDeadline?.();
        controller.abort();
      }, CAPABILITY_RESOLVE_TIMEOUT_MS);
    },
    state: (): { timedOut: boolean; cancelled: boolean } => ({
      timedOut,
      cancelled: callerCancelled || signal?.aborted === true,
    }),
    finish: (): void => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

async function resolveConfiguredReasoningEffort(
  llm: ReportLlmService,
  provider: string,
  model: string,
  configured: string,
  signal?: AbortSignal,
): Promise<CapabilityOutcome> {
  if (signal?.aborted) {
    return {
      ok: false,
      error: CAPABILITY_ERROR.cancelled,
      failure: GENERATE_FAILURE.capabilityCancelled,
    };
  }
  if (!hasModelCapabilityResolver(llm)) {
    return {
      ok: false,
      error: CAPABILITY_ERROR.unavailable,
      failure: GENERATE_FAILURE.capabilityUnavailable,
    };
  }

  const scope = beginCapabilityScope(signal);
  try {
    const pending = llm.resolveModelInfo(provider, model, scope.controller.signal);
    void pending.catch(() => {});
    scope.startTimer();
    const info = await Promise.race([pending, ...scope.races]);
    return matchConfiguredEffort(info, configured);
  } catch {
    const { timedOut, cancelled } = scope.state();
    return classifyCapabilityFailure(timedOut, cancelled);
  } finally {
    scope.finish();
  }
}

type StreamTerminal =
  | { kind: "none" }
  | { kind: "normal" }
  | { kind: "unknown" }
  | { kind: "error"; error: string; failure: RetryFailure };

interface StreamState {
  body: string;
  textDeltaIndexes: ReadonlySet<number>;
  hasNonWhitespaceReasoning: boolean;
  hasUnsupportedTool: boolean;
  hasUnsupportedContent: boolean;
  hasUnknownChunk: boolean;
  /** 已见 finish（流已封闭）；此后的 chunk 不再改变任何已收集事实。 */
  closed: boolean;
  /** 封闭后仍收到 chunk（协议违规）；正文/token 一律不落盘。 */
  afterTerminal: boolean;
  tokens: ReportTokenUsage | null;
  terminal: StreamTerminal;
}

function classifyFinishReason(reason: FinishReason): StreamTerminal {
  switch (reason.kind) {
    case "stop":
    case "tool-calls":
    case "max-tokens":
      return { kind: "normal" };
    case "error":
      return {
        kind: "error",
        error: "模型请求失败",
        failure: GENERATE_FAILURE.providerFinishFailed,
      };
    case "aborted":
      return {
        kind: "error",
        error: "模型请求已取消",
        failure: GENERATE_FAILURE.requestAborted,
      };
    default:
      return { kind: "unknown" };
  }
}

function mergeTerminal(current: StreamTerminal, next: StreamTerminal): StreamTerminal {
  if (current.kind === "error" || next.kind === "none") return current;
  if (next.kind === "error" || current.kind === "none") return next;
  if (current.kind === "unknown" || next.kind === "unknown") return { kind: "unknown" };
  return next;
}

const STREAM_ERROR_POLICY = {
  // 保留既有 thrown EMPTY_RESPONSE 的 transient 兼容语义；finish 终态错误不自动重试。
  transient: new Set(["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"]),
  permanent: new Set([
    "AUTH",
    "INVALID_CREDENTIAL",
    "MISSING_CREDENTIAL",
    "QUOTA",
    "ACCOUNT_QUOTA",
    "INVALID_REQUEST",
    "CONTEXT_WINDOW",
    "CONTEXT_WINDOW_EXCEEDED",
    "CONTENT_FILTER",
    "NO_ADAPTER",
  ]),
} as const satisfies {
  transient: ReadonlySet<string>;
  permanent: ReadonlySet<string>;
};

type StreamErrorEnvelope = {
  message?: unknown;
  name?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  failure?: unknown;
  cause?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStreamError(error: unknown, depth = 0): StreamErrorEnvelope | null {
  if (!isRecord(error) || depth > 2) return null;
  return {
    message: error.message,
    name: error.name,
    code: error.code,
    status: error.status,
    statusCode: error.statusCode,
    failure: error.failure,
    cause: error.cause,
  };
}

/** 错误码归一（去空白 + 大写；非字符串/空串 → ""，即「无可用 code」）。 */
function normalizedErrorCode(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/** code → 重试类别（两级策略表；表外一律 unknown —— fail closed 不自动重试）。 */
function policyKindOf(code: string): RetryFailure["kind"] {
  if (STREAM_ERROR_POLICY.transient.has(code)) return "transient";
  if (STREAM_ERROR_POLICY.permanent.has(code)) return "permanent";
  return "unknown";
}

/** 流失败的稳定标签（对外只见固定 code，kind 由分类决定）。 */
function streamFailureOf(kind: RetryFailure["kind"]): RetryFailure {
  return { kind, code: "provider-stream-failed" };
}

/**
 * HTTP status 兜底分类：**只有 401 可安全判定**（凭据无效 = 永久失败）；
 * 429 也可能是额度耗尽，没有结构化 code 时无法安全自动重试 → 一律 fail closed。
 */
function statusKindOf(rawStatus: unknown): RetryFailure["kind"] {
  const statusCode = typeof rawStatus === "string" ? Number(rawStatus) : rawStatus;
  return statusCode === 401 ? "permanent" : "unknown";
}

/** 嵌套信封（failure / cause）里的首个可用 code（都无则空串）。 */
function nestedCodeOf(current: StreamErrorEnvelope | null): string {
  for (const candidate of [current?.failure, current?.cause]) {
    const code = normalizedErrorCode(readStreamError(candidate, 1)?.code);
    if (code !== "") return code;
  }
  return "";
}

/** DSH 结构化错误信封优先，宿主未携带 LlmError.code 时才用精确 HTTP status 兜底。 */
function classifyStreamFailure(error: unknown): RetryFailure {
  const current = readStreamError(error);
  const nested = nestedCodeOf(current);
  if (nested !== "") return streamFailureOf(policyKindOf(nested));
  const own = normalizedErrorCode(current?.code);
  if (own !== "") return streamFailureOf(policyKindOf(own));
  return streamFailureOf(statusKindOf(current?.status ?? current?.statusCode));
}

const REPORT_STREAM_ERROR = {
  requestAborted: "模型请求已取消",
  unsupportedTool: "模型返回了报告不支持的工具调用",
  unsupportedContent: "模型返回了报告不支持的内容块",
  afterTerminal: "模型在结束后仍返回内容",
} as const;

type ReportBlockSupport = "supported" | "unsupported";

const REPORT_BLOCK_SUPPORT = {
  text: "supported",
  reasoning: "supported",
  image: "unsupported",
  file: "unsupported",
  "tool-call": "unsupported",
  "tool-addition": "unsupported",
  "tool-removal": "unsupported",
} as const satisfies Record<ContentBlockType, ReportBlockSupport>;

function reportBlockSupport(type: string): ReportBlockSupport | "unknown" {
  if (!Object.hasOwn(REPORT_BLOCK_SUPPORT, type)) return "unknown";
  return REPORT_BLOCK_SUPPORT[type as ContentBlockType];
}

/**
 * 生成报告：流式收集正文、reasoning 可见性、token 与终态。
 * reasoning 原文不保留；工具语义、未知内容块与未知/缺失终态均 fail closed。
 */
/** finish chunk 的终态事实（tool-calls 标记 + 终态合并；block-start/finish 两处共用）。 */
function finishFacts(state: StreamState, reason: FinishReason): Partial<StreamState> {
  return {
    hasUnsupportedTool: state.hasUnsupportedTool || reason.kind === "tool-calls",
    terminal: mergeTerminal(state.terminal, classifyFinishReason(reason)),
  };
}

/**
 * 内容块支持度 → 状态标记（unsupported/unknown 两个 fail-closed 标记位）。
 * supported 与 tool-call 之外的已知类型一律原样返回。
 */
function withBlockSupport(state: StreamState, type: string): StreamState {
  const support = reportBlockSupport(type);
  if (support === "unsupported") return { ...state, hasUnsupportedContent: true };
  if (support === "unknown") return { ...state, hasUnknownChunk: true };
  return state;
}

/** reasoning 可见性（reasoning-delta 与 block-end(reasoning) 共用同一判据）。 */
function withReasoningText(state: StreamState, text: string): StreamState {
  return text.trim().length > 0 ? { ...state, hasNonWhitespaceReasoning: true } : state;
}

/**
 * text-delta 正文累加：只有见到非空白正文才算「该 index 已由 delta 提供」，
 * 否则空/纯空白 delta 会屏蔽随后的合法 block-end.text，导致整段正文被丢弃并误报空输出。
 */
function withTextDelta(
  state: StreamState,
  chunk: Extract<StreamChunk, { type: "text-delta" }>,
): StreamState {
  if (chunk.text.trim().length === 0) return { ...state, body: state.body + chunk.text };
  const textDeltaIndexes = new Set(state.textDeltaIndexes);
  textDeltaIndexes.add(chunk.index);
  return { ...state, body: state.body + chunk.text, textDeltaIndexes };
}

/** block-end(text) 正文累加：index 已由 delta 提供过则丢弃（防同一段重复计入）。 */
function withBlockEndText(
  state: StreamState,
  chunk: Extract<StreamChunk, { type: "block-end" }>,
): StreamState {
  const block = chunk.block;
  if (block.type !== "text") return state;
  return state.textDeltaIndexes.has(chunk.index)
    ? state
    : { ...state, body: state.body + block.text };
}

/** block-end 的内容块分派（text/reasoning/tool-call 三类自有判据，其余走支持度表）。 */
function accumulateBlockEnd(
  chunk: Extract<StreamChunk, { type: "block-end" }>,
  state: StreamState,
): StreamState {
  const block = chunk.block;
  if (block.type === "text") return withBlockEndText(state, chunk);
  if (block.type === "reasoning") return withReasoningText(state, block.text);
  if (block.type === "tool-call") return { ...state, hasUnsupportedTool: true };
  return withBlockSupport(state, block.type);
}

/** 终态之后仍有 chunk：协议违规，fail closed。正文/token/内容块事实一律不再累加，
 *  只保留终态自身的合并（error/unknown 优先级不因该违规而降级）。 */
function accumulateAfterTerminal(chunk: StreamChunk, state: StreamState): StreamState {
  if (chunk.type !== "finish") return { ...state, afterTerminal: true };
  return { ...state, afterTerminal: true, ...finishFacts(state, chunk.reason) };
}

/** 开流期 delta 家族（block-start / text-delta / reasoning-delta / tool-call-delta）。 */
function accumulateDelta(chunk: StreamChunk, state: StreamState): StreamState {
  switch (chunk.type) {
    case "block-start":
      return chunk.blockType === "tool-call"
        ? { ...state, hasUnsupportedTool: true }
        : withBlockSupport(state, chunk.blockType);
    case "text-delta":
      return withTextDelta(state, chunk);
    case "reasoning-delta":
      return withReasoningText(state, chunk.text);
    case "tool-call-delta":
      return { ...state, hasUnsupportedTool: true };
    default:
      return { ...state, hasUnknownChunk: true };
  }
}

function accumulateChunk(chunk: StreamChunk, state: StreamState): StreamState {
  if (state.closed) return accumulateAfterTerminal(chunk, state);
  if (chunk.type === "finish") {
    return { ...state, closed: true, ...finishFacts(state, chunk.reason) };
  }
  if (chunk.type === "usage") {
    return state.tokens === null ? { ...state, tokens: parseTokenUsage(chunk.usage) } : state;
  }
  if (chunk.type === "block-end") return accumulateBlockEnd(chunk, state);
  return accumulateDelta(chunk, state);
}

type StreamCollection = { kind: "completed"; state: StreamState } | { kind: "aborted" };

const STREAM_ABORTED = Symbol("stream-aborted");

/**
 * 手动推进 provider 流，使插件边界能观察 caller abort，而不依赖 provider 是否
 * 响应 GenerateOptions.signal。取消时只发起 best-effort return，不等待一个同样
 * 可能忽略取消的 provider；后台 next/return 的 rejection 由已挂接的处理器收口。
 */
/**
 * 流取消闸门：caller abort 与 `next()` 竞速（不依赖 provider 是否响应 GenerateOptions.signal）。
 * dispose() 摘除监听，防止长生命周期 signal 累积监听器泄漏。
 */
function beginStreamAbort(signal: AbortSignal | undefined) {
  let resolveAbort: (() => void) | undefined;
  const gate = new Promise<typeof STREAM_ABORTED>((resolve) => {
    resolveAbort = () => resolve(STREAM_ABORTED);
  });
  const onAbort = (): void => resolveAbort?.();
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    gate,
    /** caller 是否已取消（闸门命中或 signal 已置位都算）。 */
    cancelled: (): boolean => signal?.aborted === true,
    dispose: (): void => {
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * 中断/异常时的状态回写：把已收集事实同步回 initialState（调用方在取消路径也读它取 token），
 * 再按「已见终态 → 收尾完成 / caller 取消 → 取消 / 其余 → 上抛」三态收敛。
 */
function streamInterruption(
  state: StreamState,
  initialState: StreamState,
  cancelled: boolean,
): StreamCollection | null {
  Object.assign(initialState, state);
  if (state.closed) return { kind: "completed", state: { ...state, afterTerminal: true } };
  if (cancelled) return { kind: "aborted" };
  return null;
}

/** 提前收口迭代器（已完成则不调；收口失败不得覆盖调用方已观察到的取消/provider 失败）。 */
function closeStreamIterator(iterator: AsyncIterator<StreamChunk>, completed: boolean): void {
  if (completed) return;
  try {
    const closing = iterator.return?.();
    if (closing !== undefined) void closing.catch(() => {});
  } catch {
    // 忽略
  }
}

async function collectStream(
  stream: AsyncIterable<StreamChunk>,
  initialState: StreamState,
  signal?: AbortSignal,
): Promise<StreamCollection> {
  if (signal?.aborted) return { kind: "aborted" };
  const iterator = stream[Symbol.asyncIterator]();
  const abort = beginStreamAbort(signal);
  let completed = false;
  let state = initialState;

  try {
    while (true) {
      const next = await Promise.race([iterator.next(), abort.gate]);
      if (next === STREAM_ABORTED || abort.cancelled()) {
        // 取消恒产出 aborted（即使已见终态）：本路径只回写状态，不改判终态优先级
        // ——终态优先级由 streamInterruption 的异常路径单独裁决。
        Object.assign(initialState, state);
        return { kind: "aborted" };
      }
      if (next.done) {
        completed = true;
        return { kind: "completed", state };
      }
      state = accumulateChunk(next.value, state);
    }
  } catch (error) {
    const interrupted = streamInterruption(state, initialState, abort.cancelled());
    if (interrupted !== null) return interrupted;
    throw error;
  } finally {
    abort.dispose();
    closeStreamIterator(iterator, completed);
  }
}

function routeSnapshot(
  provider: string,
  model: string,
  reasoningEffort?: string,
): RetryRouteSnapshot {
  return reasoningEffort === undefined ? { provider, model } : { provider, model, reasoningEffort };
}

/** claim 前解析 provider/model；transient 解析失败明确标为 unresolved。 */
export async function resolveGenerateRoute(
  opts: Pick<GenerateReportOptions, "llm" | "provider" | "model" | "reasoningEffort">,
): Promise<GenerateRouteOutcome> {
  try {
    const route = await resolveRoute(opts.llm, opts.provider, opts.model);
    if (route === null) {
      return {
        status: "failure",
        route: unresolvedRouteSnapshot(),
        failure: GENERATE_FAILURE.routeUnavailable,
      };
    }
    return {
      status: "success",
      route: routeSnapshot(route.provider, route.model, opts.reasoningEffort),
    };
  } catch (error) {
    const failureKind: RetryFailure["kind"] =
      error === ROUTE_DISCOVERY_TIMEOUT ? "transient" : classifyStreamFailure(error).kind;
    return {
      status: "failure",
      route: unresolvedRouteSnapshot(),
      failure: { kind: failureKind, code: GENERATE_FAILURE.routeResolution.code },
      unresolved: failureKind === "transient",
    };
  }
}

function routeFailureMessage(failure: RetryFailure): string {
  return failure.code === "route-resolution-failed"
    ? "模型路由解析失败"
    : "无可用的已注册 provider/model（须先在 dsh 注册适配器路由）";
}

/** 失败归因（固定安全文案 + 稳定 code/kind；母体各处只传这四元组）。 */
interface StreamVerdict {
  error: string;
  failure: RetryFailure;
}

/** 阻断性事实优先：终态错误 → 工具 → 不支持内容块 → 未知流事件。 */
function classifyBlockingFacts(state: StreamState): StreamVerdict | null {
  if (state.terminal.kind === "error") {
    return { error: state.terminal.error, failure: state.terminal.failure };
  }
  if (state.hasUnsupportedTool) {
    return {
      error: REPORT_STREAM_ERROR.unsupportedTool,
      failure: GENERATE_FAILURE.unsupportedTool,
    };
  }
  if (state.hasUnsupportedContent) {
    return {
      error: REPORT_STREAM_ERROR.unsupportedContent,
      failure: GENERATE_FAILURE.unsupportedContent,
    };
  }
  if (state.hasUnknownChunk) {
    return {
      error: "模型返回了未知流事件",
      failure: GENERATE_FAILURE.unknownStreamEvent,
    };
  }
  return null;
}

/**
 * 终态归因：未知终态 → 封闭后仍有内容 → 终态缺失。
 * after-terminal 排在终态缺失之前：封闭流不可能同时「未返回终态」。
 */
function classifyFinishFacts(state: StreamState): StreamVerdict | null {
  if (state.terminal.kind === "unknown") {
    return { error: "模型流返回未知终态", failure: GENERATE_FAILURE.unknownFinish };
  }
  if (state.afterTerminal) {
    return {
      error: REPORT_STREAM_ERROR.afterTerminal,
      failure: GENERATE_FAILURE.protocolAfterTerminal,
    };
  }
  if (state.terminal.kind === "none") {
    return { error: "模型流未返回可识别终态", failure: GENERATE_FAILURE.missingFinish };
  }
  return null;
}

/** 正文归因：仅推理无正文 → 完全无正文（两者都按调用/正文证据缺失处理）。 */
function classifyBodyFacts(state: StreamState): StreamVerdict | null {
  if (state.body.trim().length > 0) return null;
  if (state.hasNonWhitespaceReasoning) {
    return {
      error: "模型仅返回推理过程未产出正文",
      failure: GENERATE_FAILURE.reasoningOnly,
    };
  }
  return { error: "模型未产出任何正文", failure: GENERATE_FAILURE.emptyOutput };
}

/**
 * 流终态归因阶梯（顺序即分类优先级，不可重排）：
 * 阻断事实 → 终态事实 → 正文事实；全通过即成功。
 */
function classifyStreamState(state: StreamState): StreamVerdict | null {
  return classifyBlockingFacts(state) ?? classifyFinishFacts(state) ?? classifyBodyFacts(state);
}

/** 空流状态（累计起点）。 */
function emptyStreamState(): StreamState {
  return {
    body: "",
    textDeltaIndexes: new Set(),
    hasNonWhitespaceReasoning: false,
    hasUnsupportedTool: false,
    hasUnsupportedContent: false,
    hasUnknownChunk: false,
    closed: false,
    afterTerminal: false,
    tokens: null,
    terminal: { kind: "none" },
  };
}

/** 流执行结果（state 原对象在取消/异常路径被回写，token 由此透出给失败帧）。 */
type StreamRun =
  | { kind: "state"; state: StreamState }
  | { kind: "aborted"; tokens: ReportTokenUsage | null }
  | { kind: "failure"; failure: RetryFailure; tokens: ReportTokenUsage | null };

async function runReportStream(
  opts: GenerateReportOutcomeOptions,
  genOpts: GenerateOptions,
): Promise<StreamRun> {
  const state = emptyStreamState();
  try {
    const collection = await collectStream(opts.llm.stream(genOpts), state, opts.signal);
    if (collection.kind === "aborted" || opts.signal?.aborted) {
      return { kind: "aborted", tokens: state.tokens };
    }
    return { kind: "state", state: collection.state };
  } catch (error) {
    // provider 异常可能携带 prompt、路径或凭据；只返回稳定安全文案。
    if (opts.signal?.aborted) return { kind: "aborted", tokens: null };
    return { kind: "failure", failure: classifyStreamFailure(error), tokens: state.tokens };
  }
}

/** 生成调用的入参装配（prompt 模板注入 + 自拼 UserMessage + 可选 effort/signal）。 */
function buildGenerateOptions(
  opts: GenerateReportOutcomeOptions,
  route: RetryRouteSnapshot,
  effortId: LlmReasoningEffortInfo["id"] | undefined,
): GenerateOptions {
  const rangeText = opts.rangeText ?? `${opts.startDay} ~ ${opts.endDay}`;
  const prompt = applyPromptTemplate(opts.promptTemplate, opts.statsJson, rangeText);
  // 自拼 UserMessage（与官方 createUserMessage 产物同形：randomUUID 稳定 id +
  // 单 text 块 content + user source；role 由 UserMessage 类型钉死为 user；
  // 仅作只读传参，无需 freeze）
  const message: UserMessage = {
    id: crypto.randomUUID() as MessageId,
    role: "user",
    content: [{ type: "text", text: prompt }],
    source: { kind: "user" },
  };
  const genOpts: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages: [message],
    // tools 不传 = 无工具面（方案 §八5，类型层保证）
  };
  if (effortId !== undefined) genOpts.reasoningEffort = effortId;
  if (opts.signal !== undefined) genOpts.signal = opts.signal;
  return genOpts;
}

/** 路由门禁：非成功或未解析的路由不进 stream（携带既有固定文案）。 */
function routeGate(routeOutcome: GenerateRouteOutcome): StreamVerdict | null {
  if (routeOutcome.status === "success" && isResolvedRouteSnapshot(routeOutcome.route)) {
    return null;
  }
  const failure =
    routeOutcome.status === "success" ? GENERATE_FAILURE.routeUnavailable : routeOutcome.failure;
  return { error: routeFailureMessage(failure), failure };
}

/** outcome 构造器（母体只经它产出终态，durationMs 与 metaBase 口径单点）。 */
function makeOutcomeBuilder(opts: GenerateReportOutcomeOptions, started: number) {
  const now = opts.now ?? Date.now;
  const metaBase = {
    period: opts.period,
    key: opts.key,
    startDay: opts.startDay,
    endDay: opts.endDay,
    generatedAt: started,
  };
  const fail = (
    error: string,
    failure: RetryFailure,
    route: { provider: string; model: string },
    tokens: ReportTokenUsage | null = null,
  ): GenerateReportOutcome => {
    const durationMs = now() - started;
    return {
      status: "failure",
      failure,
      result: {
        body: "",
        meta: {
          ...metaBase,
          provider: route.provider,
          model: route.model,
          durationMs,
          ok: false,
          error,
          ...(tokens === null ? {} : { tokens }),
        },
      },
      attempt: { durationMs, tokens },
    };
  };
  const failAborted = (
    route: { provider: string; model: string } = opts.route?.route ?? {
      provider: opts.provider,
      model: opts.model,
    },
    tokens: ReportTokenUsage | null = null,
  ): GenerateReportOutcome =>
    fail(REPORT_STREAM_ERROR.requestAborted, GENERATE_FAILURE.requestAborted, route, tokens);
  const succeed = (route: RetryRouteSnapshot, state: StreamState): GenerateReportOutcome => {
    const durationMs = now() - started;
    return {
      status: "success",
      result: {
        body: state.body,
        meta: {
          ...metaBase,
          provider: route.provider,
          model: route.model,
          durationMs,
          ok: true,
          ...(state.tokens !== null ? { tokens: state.tokens } : {}),
        },
      },
      attempt: { durationMs, tokens: state.tokens },
    };
  };
  return { fail, failAborted, succeed };
}

/** 路由解析 + effort 能力探测（顺序即语义：任一环失败即产出终态，绝不进 stream）。 */
async function openRoute(
  opts: GenerateReportOutcomeOptions,
  outcome: ReturnType<typeof makeOutcomeBuilder>,
): Promise<
  | { route: RetryRouteSnapshot; effortId: LlmReasoningEffortInfo["id"] | undefined }
  | GenerateReportOutcome
> {
  if (opts.signal?.aborted) return outcome.failAborted();
  const routeOutcome = opts.route ?? (await resolveGenerateRoute(opts));
  if (opts.signal?.aborted) return outcome.failAborted(routeOutcome.route);
  const gate = routeGate(routeOutcome);
  if (gate !== null) {
    return outcome.fail(gate.error, gate.failure, {
      provider: opts.provider,
      model: opts.model,
    });
  }
  const route = routeOutcome.route;
  if (opts.reasoningEffort === undefined) return { route, effortId: undefined };
  const effort = await resolveConfiguredReasoningEffort(
    opts.llm,
    route.provider,
    route.model,
    opts.reasoningEffort,
    opts.signal,
  );
  if (!effort.ok) return outcome.fail(effort.error, effort.failure, route);
  return { route, effortId: effort.id };
}

/** 包内结构化生成边界；所有失败只输出稳定 code/kind 与固定安全文案。 */
export async function generateReportOutcome(
  opts: GenerateReportOutcomeOptions,
): Promise<GenerateReportOutcome> {
  const outcome = makeOutcomeBuilder(opts, (opts.now ?? Date.now)());
  const opened = await openRoute(opts, outcome);
  if ("status" in opened) return opened;

  const genOpts = buildGenerateOptions(opts, opened.route, opened.effortId);
  if (opts.signal?.aborted) return outcome.failAborted(opened.route);

  const run = await runReportStream(opts, genOpts);
  if (run.kind === "aborted") return outcome.failAborted(opened.route, run.tokens);
  if (run.kind === "failure") {
    return outcome.fail("模型请求失败", run.failure, opened.route, run.tokens);
  }
  const verdict = classifyStreamState(run.state);
  if (verdict !== null) {
    return outcome.fail(verdict.error, verdict.failure, opened.route, run.state.tokens);
  }
  return outcome.succeed(opened.route, run.state);
}

/** 公开兼容 wrapper：保留既有 ReportResult 形状，不暴露结构化失败标签。 */
export async function generateReport(opts: GenerateReportOptions): Promise<ReportResult> {
  return (await generateReportOutcome(opts)).result;
}

/**
 * 报告统计快照（纯计算）：从 tracker.buckets() 快照聚合窗口内数据。
 * 注入面收敛：只含聚合数值与目录 basename
 * （剥控制字符 + 截断 80——byDirectory 出口 basename 化，无路径分隔符），
 * 不含会话明细与完整路径——sanitizePaths 配置约束未来注入面扩展。
 */
function cleanName(name: string): string {
  const stripped = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return stripped.length > 80 ? stripped.slice(0, 80) : stripped;
}
function cleanDir(dir: string): string {
  const stripped = dir.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  const cut = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  const base = cut >= 0 ? stripped.slice(cut + 1) : stripped;
  return base.length === 0 ? TREND_UNIDENTIFIED : cleanName(base);
}
function sanitizeSnapshotNames(
  byProvider: Array<{
    provider: string;
    model: string | null;
    calls: number;
    total: number | null;
  }>,
  byDirectory: Array<{ dir: string; calls: number; total: number | null }>,
): {
  providers: Array<{ provider: string; model: string | null; calls: number; total: number | null }>;
  directories: Array<{ dir: string; calls: number; total: number | null }>;
} {
  const providers = byProvider.map((row) => ({
    provider: cleanName(row.provider),
    model: row.model !== null ? cleanName(row.model) : null,
    calls: row.calls,
    total: row.total,
  }));
  const directories = byDirectory.map((row) => ({
    dir: cleanDir(row.dir),
    calls: row.calls,
    total: row.total,
  }));
  return { providers: providers, directories: directories };
}
function inWindow(day: string, startDay: string, endDay: string): boolean {
  return day >= startDay && day <= endDay;
}
function aggregateBucketWindow(
  buckets: Array<{
    day: string;
    providers: Array<{ provider: string; model: string | null; cell: TrendCell }>;
  }>,
  startDay: string,
  endDay: string,
): {
  totals: {
    calls: number;
    turns: number;
    toolCalls: number;
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    total: number | null;
  };
  byDay: Array<{ day: string; total: number | null }>;
  byProvider: Array<{
    provider: string;
    model: string | null;
    calls: number;
    total: number | null;
  }>;
} {
  const totals = {
    calls: 0,
    turns: 0,
    toolCalls: 0,
    input: null as number | null,
    output: null as number | null,
    cacheRead: null as number | null,
    cacheWrite: null as number | null,
    total: null as number | null,
  };
  const byDay: Array<{ day: string; total: number | null }> = [];
  const byKey = new Map<
    string,
    { provider: string; model: string | null; calls: number; total: number | null }
  >();
  for (const item of buckets) {
    if (!inWindow(item.day, startDay, endDay)) {
      continue;
    }
    let dayTotal: number | null = null;
    for (const cell of item.providers) {
      const total = metricValue(cell.cell, "total");
      totals.calls += cell.cell.calls;
      totals.turns += cell.cell.turns;
      totals.toolCalls += cell.cell.toolCalls;
      totals.input = sumToken(totals.input, cell.cell.input);
      totals.output = sumToken(totals.output, cell.cell.output);
      totals.cacheRead = sumToken(totals.cacheRead, cell.cell.cacheRead);
      totals.cacheWrite = sumToken(totals.cacheWrite, cell.cell.cacheWrite);
      dayTotal = sumToken(dayTotal, total);
      totals.total = sumToken(totals.total, total);
      const key = cell.provider + "\u0000" + (cell.model ?? "");
      const cur = byKey.get(key);
      if (cur === undefined) {
        byKey.set(key, {
          provider: cell.provider,
          model: cell.model,
          calls: cell.cell.calls,
          total: total,
        });
      } else {
        cur.calls += cell.cell.calls;
        cur.total = sumToken(cur.total, total);
      }
    }
    if (dayTotal !== null) {
      byDay.push({ day: item.day, total: dayTotal });
    }
  }
  const byProvider = Array.from(byKey.values()).sort(function (a, b) {
    return b.calls - a.calls;
  });
  return { totals: totals, byDay: byDay, byProvider: byProvider };
}
function aggregateDirWindow(
  rows: TrendDirRow[] | undefined,
  startDay: string,
  endDay: string,
): Map<string, { dir: string; calls: number; total: number | null }> {
  const byDir = new Map<string, { dir: string; calls: number; total: number | null }>();
  for (const row of rows ?? []) {
    if (!inWindow(row.day, startDay, endDay)) {
      continue;
    }
    const total = metricValue(row, "total");
    const cur = byDir.get(row.dir);
    if (cur === undefined) {
      byDir.set(row.dir, { dir: row.dir, calls: row.calls, total: total });
    } else {
      cur.calls += row.calls;
      cur.total = sumToken(cur.total, total);
    }
  }
  return byDir;
}
function aggregateHourWindow(
  rows: TrendHourRow[] | undefined,
  startDay: string,
  endDay: string,
): { cells: Map<number, { calls: number; total: number | null }>; covered: Set<string> } {
  const cells = new Map<number, { calls: number; total: number | null }>();
  const covered = new Set<string>();
  for (const row of rows ?? []) {
    if (!inWindow(row.day, startDay, endDay)) {
      continue;
    }
    if (row.calls > 0 || row.turns > 0 || row.toolCalls > 0) {
      covered.add(row.day);
    }
    const cur = cells.get(row.hour);
    const total = metricValue(row, "total");
    if (cur === undefined) {
      cells.set(row.hour, { calls: row.calls, total: total });
    } else {
      cur.calls += row.calls;
      cur.total = sumToken(cur.total, total);
    }
  }
  return { cells: cells, covered: covered };
}
function avgForActive(total: number | null, activeDays: number): number | null {
  if (activeDays <= 0 || total === null) return null;
  return total / activeDays;
}
function statsPeak(
  byDay: Array<{ day: string; total: number | null }>,
  totals: { total: number | null },
  startDay: string,
  endDay: string,
) {
  let peakDay: { day: string; total: number | null } | null = null;
  for (const d of byDay) {
    if (peakDay === null || (d.total ?? 0) > (peakDay.total ?? 0)) peakDay = d;
  }
  // 活跃天数 / 窗口天数 / 活跃日均
  const activeDays = byDay.length;
  const windowDays = windowDayCount(startDay, endDay);
  const avgPerActiveDay = avgForActive(totals.total, activeDays);
  // 最长连续活跃天数：day 排序后以日历日差 = 1 判定连续（bucket day 为 UTC day key，
  // 经 Date UTC 解析求差，跨月/跨年安全——与窗口天数计算同源口径）
  let longestStreak = 0;
  let streak = 0;
  let prevDay: number | null = null;
  for (const d of byDay) {
    const ts = Date.parse(d.day);
    const isNextCalendarDay = prevDay !== null && Math.round((ts - prevDay) / 86400000) === 1;
    streak = isNextCalendarDay ? streak + 1 : 1;
    if (streak > longestStreak) longestStreak = streak;
    prevDay = ts;
  }
  // 环比：prevTotal 缺失或 <= 0 → null（不做对比；防 Infinity）
  return {
    peakDay: peakDay,
    activeDays: activeDays,
    windowDays: windowDays,
    avgPerActiveDay: avgPerActiveDay,
    longestStreak: longestStreak,
  };
}
function statsRatio(
  byDay: Array<{ day: string; total: number | null }>,
  totals: { total: number | null },
  prevTotal: number | null,
) {
  const wowRatio =
    prevTotal !== null && prevTotal > 0 && totals.total !== null ? totals.total / prevTotal : null;
  // 星期分布：周一..周日（bucket day 为 UTC key，星期口径与 day 生成处一致用 UTC 星期，
  // 避免「按本地构造 day key 却按本地星期统计」的口径漂移——快照内自洽即可）
  const byWeekday: [number, number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0, 0];
  for (const d of byDay) {
    const dow = new Date(`${d.day}T00:00:00Z`).getUTCDay(); // 0=周日
    byWeekday[dow === 0 ? 6 : dow - 1] += d.total ?? 0;
  }

  // ---- 时段维度（hourRows → byHour[24]/byPeriod[4]/peakHour + coveredDays 守卫）----
  // 窗口过滤与 buckets 同口径（day 字典序闭区间）；同钟点跨日 null-aware 累加（计数
  // 独立，token 记 null——零 usage 语义）。覆盖度守卫：coveredDays = 窗口内有 hour
  // 事实（calls/turns/toolCalls 任一 > 0）的天数；coveredDays < windowDays（升级期
  // 部分天缺 hour 行）→ 三个时段字段整体置 null（提示词整段降级，杜绝「局部天代表
  // 全窗口」的误导叙事）。
  return { wowRatio: wowRatio, byWeekday: byWeekday };
}
function deriveHourStats(
  hourCells: Map<number, { calls: number; total: number | null }>,
  covered: Set<string>,
  windowDays: number,
  hourRows: TrendHourRow[] | undefined,
) {
  const coveredDays = covered.size;
  const hourCovered = (hourRows ?? []).length > 0 && coveredDays >= windowDays;
  let byHour: ReportStatsSnapshot["byHour"] = null;
  let byPeriod: ReportStatsSnapshot["byPeriod"] = null;
  let peakHour: ReportStatsSnapshot["peakHour"] = null;
  if (hourCovered) {
    // 分支内 list 明确非 null（byHour 24 项全量：无数据钟点 calls=0/total=null）
    const list: Array<{ hour: number; calls: number; total: number | null }> = Array.from(
      { length: 24 },
      (_, hour) => {
        const c = hourCells.get(hour);
        return { hour, calls: c?.calls ?? 0, total: c?.total ?? null };
      },
    );
    byHour = list;
    byPeriod = PERIOD_BUCKETS.map((p) => {
      let calls = 0;
      let total: number | null = null;
      for (let h = p.from; h <= p.to; h += 1) {
        const c = hourCells.get(h);
        if (c === undefined) continue;
        calls += c.calls;
        total = sumToken(total, c.total);
      }
      return { period: p.name, calls, total };
    });
    // peakHour：total 判峰、并列取最早（保持 byHour 升序遍历序）；全 null → null
    let peak: { hour: number; calls: number; total: number | null } | null = null;
    for (const item of list) {
      if (item.total === null) continue;
      if (peak === null || peak.total === null || item.total > peak.total) peak = item;
    }
    peakHour = peak;
  }

  return { byHour: byHour, byPeriod: byPeriod, peakHour: peakHour, coveredDays: coveredDays };
}
export function buildStatsSnapshot(input: {
  period: ReportPeriod;
  startDay: string;
  endDay: string;
  /** tracker.buckets() 快照（day 升序；day×provider×model×cell）。 */
  buckets: Array<{
    day: string;
    providers: Array<{ provider: string; model: string | null; cell: TrendCell }>;
  }>;
  /**
   * 目录维度日汇总行快照（store.readAggDayShard 产物 filter kind:"dir"，
   * 可选；缺省 = 旧数据无目录事实，不补造桶（旧格式零变化口径）。
   */
  dirRows?: TrendDirRow[];
  /**
   * 小时维度日汇总行快照（trend.hourRows() 产物，可选；缺省/旧数据无 hour
   * 事实 → byHour/byPeriod/peakHour 依覆盖度守卫整体置 null（coveredDays=0）。
   */
  hourRows?: TrendHourRow[];
  /** 上一同等长度窗口的指标总量（环比基准；接线层经 windowSummary 取得）。 */
  prevTotal: number | null;
}): ReportStatsSnapshot {
  const { totals, byDay, byProvider } = aggregateBucketWindow(
    input.buckets,
    input.startDay,
    input.endDay,
  );

  // ---- 目录维度聚合（dir 行 → byDirectory，口径与 byProvider 一致）----
  // 同 dir 键跨日 null-aware 累加；窗口过滤与 buckets 同口径（day 字典序闭区间）。
  const byDir = aggregateDirWindow(input.dirRows, input.startDay, input.endDay);
  const byDirectory = [...byDir.values()].sort((a, b) => b.calls - a.calls);

  // ---- 年报派生维度（快照内单遍 O(n)，全部聚合数值，注入面收敛不变） ----
  // 注入文本防御：provider/model 名为 adapter/上游可影响文本，进快照前截断 80 字符
  // 并剥离控制字符（prompt 注入面收紧；快照数值维度不受影响）。
  const clean = sanitizeSnapshotNames(byProvider, byDirectory);
  const { peakDay, activeDays, windowDays, avgPerActiveDay, longestStreak } = statsPeak(
    byDay,
    totals,
    input.startDay,
    input.endDay,
  );
  const { wowRatio, byWeekday } = statsRatio(byDay, totals, input.prevTotal);
  const hourAgg = aggregateHourWindow(input.hourRows, input.startDay, input.endDay);
  const { byHour, byPeriod, peakHour, coveredDays } = deriveHourStats(
    hourAgg.cells,
    hourAgg.covered,
    windowDays,
    input.hourRows,
  );
  return {
    period: input.period,
    startDay: input.startDay,
    endDay: input.endDay,
    totals,
    byDay,
    byProvider: clean.providers,
    byDirectory: clean.directories,
    prevTotal: input.prevTotal,
    peakDay,
    activeDays,
    windowDays,
    avgPerActiveDay,
    longestStreak,
    wowRatio,
    byWeekday,
    byHour,
    byPeriod,
    peakHour,
    coveredDays,
  };
}

/** 窗口天数（day key 按 UTC 解析差值 = 天数差，不受 DST 影响；单日窗口=1）。 */
function windowDayCount(startDay: string, endDay: string): number {
  return Math.round((Date.parse(endDay) - Date.parse(startDay)) / 86400000) + 1;
}

/**
 * 预分四时段档位（报告时段叙事口径由代码锁定，防弱模型自行归纳 24 档编造）。
 * 边界闭区间（from..to 均含）：凌晨 0-5 / 上午 6-11 / 下午 12-17 / 晚间 18-23。
 * 档名即为提示词可原样引用的 byPeriod.period 字段值（口径变更须同步提示词红线注释）。
 */
export const PERIOD_BUCKETS: ReadonlyArray<{ name: string; from: number; to: number }> = [
  { name: "凌晨", from: 0, to: 5 },
  { name: "上午", from: 6, to: 11 },
  { name: "下午", from: 12, to: 17 },
  { name: "晚间", from: 18, to: 23 },
];
