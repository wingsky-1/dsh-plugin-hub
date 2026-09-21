/**
 * tools 域实现：SystemOne 调用（并发信号量 + Abort 超时 + 有限重试，自研内联，零运行时依赖）。
 *
 * - 基址写死 JEV_BASE_URL（加载断言在共享契约；本模块不再接受基址参数）；
 * - fetch 经 FetchImpl 注入（默认全局 fetch 适配；单测注入 mock，全程离线）；
 * - 重试：网络抛错/超时/429/5xx 最多 2 次重试（共 3 尝试），4xx 不重试；
 * - 信号量：同进程并发上限 maxConcurrency，排队公平先进先出；
 * - 状态全部收进闭包/实例，无模块级可变状态。
 */
import { JEV_BASE_URL } from "../../../shared/interface.ts";
import type { FetchImpl } from "../deps.ts";
import type { ValidQuestion } from "../deps.ts";
import type { JevLang } from "../../../shared/interface.ts";

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

/** 请求体（线协议最小面；裸漏形状即耦合源，故字段固定）。 */
export interface JevRequestBody {
  readonly preset: string;
  readonly templateVersion: 1;
  readonly state: { readonly text: string; readonly lang: JevLang };
  readonly questions: readonly {
    readonly id: string;
    readonly text: string;
    readonly kind: string;
    readonly options?: readonly string[];
  }[];
}

/** 解析远端响应（score 1-5 整形非法即失败；tier/automation 越界即回落 0）。 */
export function parseVerdict(
  status: number,
  text: string,
):
  | { readonly ok: true; readonly verdict: RemoteVerdict }
  | { readonly ok: false; readonly failure: JevFailure } {
  if (status === 401 || status === 403) {
    return {
      ok: false,
      failure: {
        code: "UNAUTHORIZED",
        category: "unauthorized",
        message: "upstream rejected credentials",
        retryable: false,
        status,
      },
    };
  }
  if (status === 429) {
    return {
      ok: false,
      failure: {
        code: "RATE_LIMITED",
        category: "rate-limited",
        message: "upstream rate limited",
        retryable: true,
        status,
      },
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      ok: false,
      failure: {
        code: "UPSTREAM",
        category: "upstream",
        message: "upstream status " + String(status),
        retryable: true,
        status,
      },
    };
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      failure: {
        code: "UPSTREAM",
        category: "upstream",
        message: "upstream status " + String(status),
        retryable: false,
        status,
      },
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      failure: {
        code: "UPSTREAM",
        category: "bad-payload",
        message: "upstream body not JSON",
        retryable: false,
        status,
      },
    };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      failure: {
        code: "UPSTREAM",
        category: "bad-payload",
        message: "upstream body shape",
        retryable: false,
        status,
      },
    };
  }
  const rec = body as Record<string, unknown>;
  const kind = rec["resultKind"];
  if (kind !== "choice" && kind !== "score") {
    return {
      ok: false,
      failure: {
        code: "UPSTREAM",
        category: "bad-payload",
        message: "resultKind must be choice|score",
        retryable: false,
        status,
      },
    };
  }
  const confidence =
    typeof rec["confidence"] === "number" && Number.isFinite(rec["confidence"] as number)
      ? Math.min(1, Math.max(0, rec["confidence"] as number))
      : 0;
  const tierRaw = rec["tier"];
  const tier = tierRaw === 1 || tierRaw === 2 ? (tierRaw as number) : 0;
  const autoRaw = rec["automation"];
  const automation = autoRaw === 1 || autoRaw === 2 ? (autoRaw as number) : 0;
  const billed = rec["codepoints"];
  const codepoints =
    typeof billed === "number" && Number.isFinite(billed) && billed >= 0
      ? Math.floor(billed as number)
      : 0;
  if (kind === "choice") {
    const choice = rec["choice"];
    if (typeof choice !== "string" || choice.length === 0) {
      return {
        ok: false,
        failure: {
          code: "UPSTREAM",
          category: "bad-payload",
          message: "choice must be non-empty",
          retryable: false,
          status,
        },
      };
    }
    return {
      ok: true,
      verdict: { resultKind: "choice", choice, confidence, tier, automation, codepoints },
    };
  }
  const score = rec["score"];
  if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) {
    return {
      ok: false,
      failure: {
        code: "UPSTREAM",
        category: "bad-payload",
        message: "score must be int 1..5",
        retryable: false,
        status,
      },
    };
  }
  return {
    ok: true,
    verdict: { resultKind: "score", score, confidence, tier, automation, codepoints },
  };
}

/** 调用远端（1 次尝试：超时 Abort；抛错/超时归为可重试）。 */
async function attemptOnce(
  body: JevRequestBody,
  key: string,
  timeoutMs: number,
  fetchImpl: FetchImpl,
): Promise<
  | { readonly ok: true; readonly verdict: RemoteVerdict }
  | { readonly ok: false; readonly failure: JevFailure }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(JEV_BASE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return parseVerdict(res.status, res.text);
  } catch (cause) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      failure: aborted
        ? { code: "TIMEOUT", category: "timeout", message: "request timed out", retryable: true }
        : {
            code: "NETWORK",
            category: "network",
            message: "fetch failed: " + (cause instanceof Error ? cause.message : String(cause)),
            retryable: true,
          },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 有限重试调用（最多 2 次重试；返回重试次数供输出计费面）。
 *
 * timeoutMs 是整次调用的总预算（非逐次）：每次尝试的 Abort 定时按剩余预算设置，
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

/** 远端问题投影（内部 ValidQuestion 转线协议面）。 */
export function toWireQuestions(questions: readonly ValidQuestion[]): JevRequestBody["questions"] {
  return questions.map((q) => ({
    id: q.id,
    text: q.text,
    kind: q.kind,
    ...(q.options !== undefined ? { options: [...q.options] } : {}),
  }));
}
