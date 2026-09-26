/**
 * tools 域实现：SystemOne 调用（官方 SDK 传输 + 总预算超时 + 有限重试 + 并发信号量）。
 *
 * - 基址/模型双写死：JEV_BASE_URL 全地址 pin，SDK 拼 /v1/systemone 故传 root 派生
 *   （漂移即拒绝加载）；JEV_MODEL 别名 jev-latest；加载断言在共享契约，均不接受配置覆盖；
 * - 传输走官方 @typesafe-ai/sdk（构建期 esbuild 内联进 lib，零运行时依赖）：
 *   请求/响应形状与 401/422/429/529 错误分类由 SDK 承载；
 * - FetchImpl 窄面经 toSdkFetch 适配为真实 Response（单测 mock 只改 body，不改形状，全程离线）；
 * - 重试保持旧语义：SDK 单次直试（maxRetries 0），外层按总预算最多 2 次重试（共 3 尝试），
 *   可重试性仍按状态码判定（超时/网络/429/5xx 可重试，其余不重试），重试次数如实回传；
 * - score：SDK 回浮点（legend 0-based），按发送档数线性重缩放到 1..5（round(s/(n-1)*4)+1 再钳制；默认五档即 round+1，旧口径保持）；
 * - tier/automation：上游不再直给，由 confidence 派生（0.8/0.5 双阈，与 UI high 线对齐），
 *   再受预设 automationCap 封顶（封顶逻辑在 service 侧，保持）；
 * - 多题 answers 取首题驱动输出（DecideOutput 单 verdict 形状保持；多题输出后续再议）；
 * - codepoints：usage 是 tokens 非 codepoints，置 0 由 service 回落原文长度；
 * - 状态全部收进闭包/实例，无模块级可变状态。
 */
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  TypeSafeError,
} from "@typesafe-ai/sdk";
import type { Questions, ScoreCriteria, SystemOneResult } from "@typesafe-ai/sdk";
import { JEV_BASE_URL } from "../../../shared/interface.ts";
import type { FetchImpl } from "../deps.ts";
import type { ValidQuestion } from "../deps.ts";

/** 上游失败（可重试性由本模块判定，调用方只读 code/category）。 */
export interface DecisionFailure {
  readonly code: string;
  readonly category: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly status?: number;
}

/** 远端原始决议（已做形状校验的最小面）。 */
export interface RemoteVerdict {
  readonly resultKind: "choice" | "score";
  readonly choice?: string;
  readonly score?: number;
  readonly confidence: number;
  readonly tier: number;
  readonly automation: number;
  readonly codepoints: number;
}

/** 默认 fetch 适配（全局 fetch 转窄面；无全局 fetch 即抛未实现）。 */
export function defaultFetchImpl(): FetchImpl {
  return async (url, init) => {
    const impl = (globalThis as unknown as { fetch?: unknown }).fetch;
    if (typeof impl !== "function")
      throw new Error("decision-gateway[500]: global fetch unavailable");
    const res = await (impl as typeof fetch)(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
    return { status: res.status, text: await res.text() };
  };
}

/** SDK 拼路径用 root：全地址 pin 派生，后缀漂移即拒绝加载。 */
const SDK_PATH = "/v1/systemone";
if (!JEV_BASE_URL.endsWith(SDK_PATH)) {
  throw new Error("dsh-decision-gateway: JEV_BASE_URL 须以 /v1/systemone 结尾");
}
const JEV_API_ROOT = JEV_BASE_URL.slice(0, -SDK_PATH.length);

/** score legend 五档（SDK 0-based，加 1 回旧 1..5 口径）。 */
const SCORE_LEVELS = ["1", "2", "3", "4", "5"] as const;

/** 请求体（官方 SystemOne 形状：model + 字符串 state + 字典 questions）。 */
export interface DecisionRequestBody {
  readonly model: string;
  readonly state: string;
  readonly questions: Questions;
}

/** confidence 派生分层（0.8 对齐 UI high 线；0.5 低分界）。 */
export function confidenceTier(confidence: number): number {
  if (confidence >= 0.8) return 2;
  if (confidence >= 0.5) return 1;
  return 0;
}

/** 0..1 钳制（非法回落 0）。 */
function clamp01(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** 远端问题投影（内部 ValidQuestion 转 SDK 字典；choice criteria 置空描述，score 用自带 levels 或默认数字 legend）。 */
export function toWireQuestions(questions: readonly ValidQuestion[]): Questions {
  const out: Record<string, Questions[string]> = {};
  for (const q of questions) {
    out[q.id] =
      q.kind === "choice"
        ? {
            type: "choice",
            instructions: q.text,
            criteria: Object.fromEntries((q.options ?? []).map((o) => [o, null])),
          }
        : {
            type: "score",
            instructions: q.text,
            // 校验已保证 2-10 档；tuple 形状经 unknown 中转（string[] 无法直接断言为定长元组）。
            criteria: [...(q.levels ?? SCORE_LEVELS)] as unknown as ScoreCriteria,
          };
  }
  return out;
}

/** 调用方取消失败（不可重试：socket 关闭/caller abort 即停，不进重试链）。 */
function callerAbortedFailure(): DecisionFailure {
  return {
    code: "ABORTED",
    category: "aborted",
    message: "caller aborted",
    retryable: false,
  };
}

/** 调用方信号是否已取消（缺席即否）。 */
function isCallerAborted(callerSignal?: AbortSignal): boolean {
  return callerSignal?.aborted === true;
}

/**
 * 融合调用方信号与内部信号（SDK 超时信号）：任一 abort 即取消外调。
 *
 * AbortSignal.any 优先（原子融合），缺席回落手动级联（已 abort 即取已取消侧，
 * 否则建中继控制器双向转发，移除监听防泄漏）。调用方缺席即回内部信号原样。
 */
export function combineSignals(
  callerSignal: AbortSignal | undefined,
  innerSignal: AbortSignal,
): AbortSignal {
  if (callerSignal === undefined) return innerSignal;
  if (callerSignal.aborted) return callerSignal;
  if (innerSignal.aborted) return innerSignal;
  const anyFn = (
    AbortSignal as unknown as { readonly any?: (signals: readonly AbortSignal[]) => AbortSignal }
  ).any;
  if (typeof anyFn === "function") return anyFn([callerSignal, innerSignal]);
  const relay = new AbortController();
  const onAbort = (): void => {
    callerSignal.removeEventListener("abort", onAbort);
    innerSignal.removeEventListener("abort", onAbort);
    relay.abort();
  };
  callerSignal.addEventListener("abort", onAbort, { once: true });
  innerSignal.addEventListener("abort", onAbort, { once: true });
  return relay.signal;
}

/** FetchImpl 窄面转 SDK 可用的真实 Response（init 取方法/头/体/信号，其余丢弃；调用方信号与 SDK 超时信号融合）。 */
function toSdkFetch(
  fetchImpl: FetchImpl,
  callerSignal?: AbortSignal,
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    const inner = init?.signal ?? new AbortController().signal;
    const res = await fetchImpl(input, {
      method: init?.method ?? "POST",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
      signal: combineSignals(callerSignal, inner),
    });
    return new Response(res.text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  };
}

type MapAnswerResult =
  | { readonly ok: true; readonly verdict: RemoteVerdict }
  | { readonly ok: false; readonly failure: DecisionFailure };

/** bad-payload 失败面（noul/未知形状一律不重试：重试同一份坏载荷没有意义）。 */
function badAnswer(message: string): { readonly ok: false; readonly failure: DecisionFailure } {
  return {
    ok: false,
    failure: { code: "UPSTREAM", category: "bad-payload", message, retryable: false },
  };
}

/** 错误文本（Error 取 message，其余取 String()）。 */
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 首题答案定位：answers 容器形状 → 首题答案形状 → 记录面。
 *
 * 两级守卫各有各的文案（answers shape / answer shape），所以失败面带 message 而非
 * 只回一个 null——调用点据此原样回传，不在此处合并两种形状错。
 */
function firstAnswerRecord(
  body: DecisionRequestBody,
  result: SystemOneResult<Questions>,
):
  | { readonly ok: true; readonly rec: Record<string, unknown> }
  | { readonly ok: false; readonly message: string } {
  const ids = Object.keys(body.questions);
  const first = ids[0];
  const answers: unknown = (result as { readonly answers?: unknown }).answers;
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    return { ok: false, message: "answers shape" };
  }
  const ans: unknown =
    first === undefined ? undefined : (answers as Record<string, unknown>)[first];
  if (ans === null || typeof ans !== "object" || Array.isArray(ans)) {
    return { ok: false, message: "answer shape" };
  }
  return { ok: true, rec: ans as Record<string, unknown> };
}

/** confidence → tier/automation（两值同源：tier 与 automation 共用同一分档结果）。 */
function confidenceLevel(rec: Record<string, unknown>): { confidence: number; level: number } {
  const confidence = clamp01(rec["confidence"]);
  return { confidence, level: confidenceTier(confidence) };
}

/** score 档位数：题面自带 criteria ≥2 即按其条数，否则回落默认 1-5。 */
function rubricLevels(sent: { readonly criteria?: readonly unknown[] } | undefined): number {
  return Array.isArray(sent?.criteria) && sent.criteria.length >= 2
    ? sent.criteria.length
    : SCORE_LEVELS.length;
}

/** choice 答案转 verdict（choice 必须非空串）。 */
function mapChoiceAnswer(rec: Record<string, unknown>): MapAnswerResult {
  const choice = rec["choice"];
  if (typeof choice !== "string" || choice.length === 0) {
    return badAnswer("choice must be non-empty");
  }
  const { confidence, level } = confidenceLevel(rec);
  return {
    ok: true,
    verdict: {
      resultKind: "choice",
      choice,
      confidence,
      tier: level,
      automation: level,
      codepoints: 0,
    },
  };
}

/** score 答案转 verdict（上游分值按 rubric 条数线性折到 1..5）。 */
function mapScoreAnswer(body: DecisionRequestBody, rec: Record<string, unknown>): MapAnswerResult {
  const raw = rec["score"];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return badAnswer("score must be a number");
  }
  const sent = body.questions[Object.keys(body.questions)[0]] as
    { readonly criteria?: readonly unknown[] } | undefined;
  const levels = rubricLevels(sent);
  const score = Math.min(5, Math.max(1, Math.round((raw / (levels - 1)) * 4) + 1));
  const { confidence, level } = confidenceLevel(rec);
  return {
    ok: true,
    verdict: {
      resultKind: "score",
      score,
      confidence,
      tier: level,
      automation: level,
      codepoints: 0,
    },
  };
}

/** 首题答案转 verdict（多题时首题驱动输出；noul/未知形状即 bad-payload 不重试）。 */
export function mapFirstAnswer(
  body: DecisionRequestBody,
  result: SystemOneResult<Questions>,
): MapAnswerResult {
  const found = firstAnswerRecord(body, result);
  if (!found.ok) return badAnswer(found.message);
  if (found.rec["type"] === "choice") return mapChoiceAnswer(found.rec);
  if (found.rec["type"] === "score") return mapScoreAnswer(body, found.rec);
  return badAnswer("answer type must be choice|score");
}

/**
 * 上游状态码 → 失败面。
 *
 * 401/403 凭据拒收不重试；429 与 5xx 可重试；其余按不可重试的上游错回传
 * （原实现对 5xx 与非 5xx 各写一份同形返回，这里合成一份由 retryable 表达差别）。
 */
function statusToFailure(status: number): DecisionFailure {
  if (status === 401 || status === 403) {
    return {
      code: "UNAUTHORIZED",
      category: "unauthorized",
      message: "upstream rejected credentials",
      retryable: false,
      status,
    };
  }
  if (status === 429) {
    return {
      code: "RATE_LIMITED",
      category: "rate-limited",
      message: "upstream rate limited",
      retryable: true,
      status,
    };
  }
  return {
    code: "UPSTREAM",
    category: "upstream",
    message: "upstream status " + String(status),
    retryable: status >= 500 && status <= 599,
    status,
  };
}

/** SDK 错误转失败面（状态码沿旧映射；客户端校验错不重试；裸抛错归网络可重试；调用方取消单列 ABORTED 不重试）。 */
export function sdkErrorToFailure(cause: unknown): DecisionFailure {
  if (cause instanceof APIUserAbortError) {
    return callerAbortedFailure();
  }
  if (cause instanceof APITimeoutError) {
    return { code: "TIMEOUT", category: "timeout", message: "request timed out", retryable: true };
  }
  if (cause instanceof APIConnectionError) {
    return {
      code: "NETWORK",
      category: "network",
      message: "fetch failed: " + errorText(cause),
      retryable: true,
    };
  }
  if (cause instanceof APIError) {
    return statusToFailure(cause.status);
  }
  if (cause instanceof Error && cause.name === "AbortError") {
    return { code: "TIMEOUT", category: "timeout", message: "request timed out", retryable: true };
  }
  if (cause instanceof TypeSafeError) {
    return {
      code: "UPSTREAM",
      category: "bad-payload",
      message: "client-side SDK error",
      retryable: false,
    };
  }
  if (cause instanceof Error) {
    return {
      code: "NETWORK",
      category: "network",
      message: "fetch failed: " + cause.message,
      retryable: true,
    };
  }
  return { code: "UPSTREAM", category: "upstream", message: "unknown", retryable: false };
}

/** 调用远端（1 次尝试：SDK 单次直试；抛错经 sdkErrorToFailure 归类；调用方已取消即短路 ABORTED）。 */
async function attemptOnce(
  body: DecisionRequestBody,
  key: string,
  timeoutMs: number,
  fetchImpl: FetchImpl,
  callerSignal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly verdict: RemoteVerdict }
  | { readonly ok: false; readonly failure: DecisionFailure }
> {
  if (isCallerAborted(callerSignal)) {
    return { ok: false, failure: callerAbortedFailure() };
  }
  if (!(timeoutMs > 0)) {
    return {
      ok: false,
      failure: {
        code: "TIMEOUT",
        category: "timeout",
        message: "request timed out",
        retryable: true,
      },
    };
  }
  const client = new TypeSafeClient({
    apiKey: key,
    baseURL: JEV_API_ROOT,
    fetch: toSdkFetch(fetchImpl, callerSignal),
    logLevel: "warn",
    retry: { maxRetries: 0 },
  });
  try {
    const result = await client.systemOne(
      { model: body.model, state: body.state, questions: body.questions },
      callerSignal === undefined
        ? { timeout: timeoutMs }
        : { timeout: timeoutMs, signal: callerSignal },
    );
    return mapFirstAnswer(body, result);
  } catch (cause) {
    if (isCallerAborted(callerSignal)) {
      return { ok: false, failure: callerAbortedFailure() };
    }
    return { ok: false, failure: sdkErrorToFailure(cause) };
  }
}

/** 重试次数上限（2 次重试 = 至多 3 次尝试；硬上限，不随预算或故障类型放大）。 */
const MAX_RETRIES = 2;

/**
 * 有限重试调用（最多 2 次重试；返回重试次数供输出计费面）。
 *
 * timeoutMs 是整次调用的总预算（非逐次）：每次尝试按剩余预算设置 SDK 超时，
 * 预算耗尽后的重试即时失败——慢上游不会把单次决议拖成 3 倍超时（锁定的超时探针
 * 用 timeoutMs=1000 + 2s 轮询钉死该语义：逐次预算下 3 次尝试必超窗）。
 */
export async function callWithRetry(
  body: DecisionRequestBody,
  key: string,
  timeoutMs: number,
  fetchImpl: FetchImpl,
  callerSignal?: AbortSignal,
): Promise<{
  readonly verdict?: RemoteVerdict;
  readonly failure?: DecisionFailure;
  readonly retries: number;
}> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const budgetLeft = (): number => Math.max(0, deadline - Date.now());
  // 闸序即重试序：不可重试 / 超时 / 调用方取消 / 预算耗尽，任一命中即如实回传，
  // 都不再发起下一次尝试。末次尝试不判闸——闸只决定「还值不值得再试」。
  let retries = 0;
  for (;;) {
    const attempt = await attemptOnce(body, key, budgetLeft(), fetchImpl, callerSignal);
    if (attempt.ok) return { verdict: attempt.verdict, retries };
    if (retries >= MAX_RETRIES) return { failure: attempt.failure, retries };
    if (!attempt.failure.retryable) return { failure: attempt.failure, retries };
    if (attempt.failure.code === "TIMEOUT") return { failure: attempt.failure, retries };
    if (isCallerAborted(callerSignal)) return { failure: callerAbortedFailure(), retries };
    if (budgetLeft() <= 0) return { failure: attempt.failure, retries };
    retries += 1;
  }
}
