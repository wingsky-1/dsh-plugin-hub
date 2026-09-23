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
  TypeSafeClient,
  TypeSafeError,
} from "@typesafe-ai/sdk";
import type { Questions, ScoreCriteria, SystemOneResult } from "@typesafe-ai/sdk";
import { JEV_BASE_URL } from "../../../shared/interface.ts";
import type { FetchImpl } from "../deps.ts";
import type { ValidQuestion } from "../deps.ts";

/** 上游失败（可重试性由本模块判定，调用方只读 code/category）。 */
export interface JevFailure {
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
    if (typeof impl !== "function") throw new Error("jev[500]: global fetch unavailable");
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
  throw new Error("dsh-jev-decide: JEV_BASE_URL 须以 /v1/systemone 结尾");
}
const JEV_API_ROOT = JEV_BASE_URL.slice(0, -SDK_PATH.length);

/** score legend 五档（SDK 0-based，加 1 回旧 1..5 口径）。 */
const SCORE_LEVELS = ["1", "2", "3", "4", "5"] as const;

/** 请求体（官方 SystemOne 形状：model + 字符串 state + 字典 questions）。 */
export interface JevRequestBody {
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

/** FetchImpl 窄面转 SDK 可用的真实 Response（init 取方法/头/体/信号，其余丢弃）。 */
function toSdkFetch(
  fetchImpl: FetchImpl,
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    const res = await fetchImpl(input, {
      method: init?.method ?? "POST",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
      signal: init?.signal ?? new AbortController().signal,
    });
    return new Response(res.text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  };
}

/** 首题答案转 verdict（多题时首题驱动输出；noul/未知形状即 bad-payload 不重试）。 */
export function mapFirstAnswer(
  body: JevRequestBody,
  result: SystemOneResult<Questions>,
):
  | { readonly ok: true; readonly verdict: RemoteVerdict }
  | { readonly ok: false; readonly failure: JevFailure } {
  const bad = (message: string): { readonly ok: false; readonly failure: JevFailure } => ({
    ok: false,
    failure: { code: "UPSTREAM", category: "bad-payload", message, retryable: false },
  });
  const ids = Object.keys(body.questions);
  const first = ids[0];
  const answers: unknown = (result as { readonly answers?: unknown }).answers;
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    return bad("answers shape");
  }
  const ans: unknown =
    first === undefined ? undefined : (answers as Record<string, unknown>)[first];
  if (ans === null || typeof ans !== "object" || Array.isArray(ans)) {
    return bad("answer shape");
  }
  const rec = ans as Record<string, unknown>;
  if (rec["type"] === "choice") {
    const choice = rec["choice"];
    if (typeof choice !== "string" || choice.length === 0) {
      return bad("choice must be non-empty");
    }
    const confidence = clamp01(rec["confidence"]);
    const level = confidenceTier(confidence);
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
  if (rec["type"] === "score") {
    const raw = rec["score"];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return bad("score must be a number");
    }
    const sent = body.questions[first] as { readonly criteria?: readonly unknown[] } | undefined;
    const levels =
      Array.isArray(sent?.criteria) && sent.criteria.length >= 2
        ? sent.criteria.length
        : SCORE_LEVELS.length;
    const score = Math.min(5, Math.max(1, Math.round((raw / (levels - 1)) * 4) + 1));
    const confidence = clamp01(rec["confidence"]);
    const level = confidenceTier(confidence);
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
  return bad("answer type must be choice|score");
}

/** SDK 错误转失败面（状态码沿旧映射；客户端校验错不重试；裸抛错归网络可重试）。 */
export function sdkErrorToFailure(cause: unknown): JevFailure {
  if (cause instanceof APITimeoutError) {
    return { code: "TIMEOUT", category: "timeout", message: "request timed out", retryable: true };
  }
  if (cause instanceof APIConnectionError) {
    return {
      code: "NETWORK",
      category: "network",
      message: "fetch failed: " + (cause instanceof Error ? cause.message : String(cause)),
      retryable: true,
    };
  }
  if (cause instanceof APIError) {
    const status = cause.status;
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
    if (status >= 500 && status <= 599) {
      return {
        code: "UPSTREAM",
        category: "upstream",
        message: "upstream status " + String(status),
        retryable: true,
        status,
      };
    }
    return {
      code: "UPSTREAM",
      category: "upstream",
      message: "upstream status " + String(status),
      retryable: false,
      status,
    };
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

/** 调用远端（1 次尝试：SDK 单次直试；抛错经 sdkErrorToFailure 归类）。 */
async function attemptOnce(
  body: JevRequestBody,
  key: string,
  timeoutMs: number,
  fetchImpl: FetchImpl,
): Promise<
  | { readonly ok: true; readonly verdict: RemoteVerdict }
  | { readonly ok: false; readonly failure: JevFailure }
> {
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
    fetch: toSdkFetch(fetchImpl),
    logLevel: "warn",
    retry: { maxRetries: 0 },
  });
  try {
    const result = await client.systemOne(
      { model: body.model, state: body.state, questions: body.questions },
      { timeout: timeoutMs },
    );
    return mapFirstAnswer(body, result);
  } catch (cause) {
    return { ok: false, failure: sdkErrorToFailure(cause) };
  }
}

/**
 * 有限重试调用（最多 2 次重试；返回重试次数供输出计费面）。
 *
 * timeoutMs 是整次调用的总预算（非逐次）：每次尝试按剩余预算设置 SDK 超时，
 * 预算耗尽后的重试即时失败——慢上游不会把单次决议拖成 3 倍超时（锁定的超时探针
 * 用 timeoutMs=1000 + 2s 轮询钉死该语义：逐次预算下 3 次尝试必超窗）。
 */
export async function callWithRetry(
  body: JevRequestBody,
  key: string,
  timeoutMs: number,
  fetchImpl: FetchImpl,
): Promise<{
  readonly verdict?: RemoteVerdict;
  readonly failure?: JevFailure;
  readonly retries: number;
}> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const budgetLeft = (): number => Math.max(0, deadline - Date.now());
  const first = await attemptOnce(body, key, budgetLeft(), fetchImpl);
  if (first.ok) return { verdict: first.verdict, retries: 0 };
  if (!first.failure.retryable) return { failure: first.failure, retries: 0 };
  const second = await attemptOnce(body, key, budgetLeft(), fetchImpl);
  if (second.ok) return { verdict: second.verdict, retries: 1 };
  if (!second.failure.retryable) return { failure: second.failure, retries: 1 };
  const third = await attemptOnce(body, key, budgetLeft(), fetchImpl);
  if (third.ok) return { verdict: third.verdict, retries: 2 };
  return { failure: third.failure, retries: 2 };
}
