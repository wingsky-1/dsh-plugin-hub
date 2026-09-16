/**
 * dsh-notifier —— 一次失败请求的「可操作结论」（客户端唯一的失败分类判定点）。
 *
 * 为什么判定要收在这里：围栏拒答的识别原本是 `String(error.message).indexOf("403")`，那等于把
 * 「服务端必须永远把 `error` 写成裸字符串」当成隐式契约——宿主端一旦把它包成对象，状态码消失、
 * 局域网直连引导静默失效——那条失败走的是静默降级，不会有人报错，也就没人会发现引导没了。判定
 * 顺序因此是契约本身，必须能被直连单测打红：
 *
 *   1. 结构化 `code`（src/shared/refusal.ts 的闭集，两端同一份取值）——新宿主；
 *   2. 结构化 `status`——新宿主（也兼容只带状态码的中间形态）；
 *   3. 文案兜底——旧宿主只有 `HTTP 403` 这种 message。这条不是历史包袱：老服务端配新客户端时
 *      它是唯一信号，宿主端至今保持 `error` 为裸字符串正是为了让这条继续成立。
 *
 * 结构化命中时以结构化字段为准：`METHOD_NOT_ALLOWED` 即使状态码/文案里出现 403 也不给局域网引导
 * （那条引导只对回环围栏有意义）。
 *
 * 纯函数：零 DOM、零 fetch，翻译函数由调用方注入（沿用 reason-text.ts 的范式）。
 */
import { REFUSAL_CODES } from "../shared/interface.ts";
import type { NotifierLocaleKey } from "./locales.ts";

/** 翻译函数：宿主 locale 服务产物，或未装配时回落 key 本体的那个。 */
export type FailureTranslator = (key: NotifierLocaleKey) => string;

/** 失败的可操作结论：界面只消费这三个字段，业务判断不再散落在各 catch 里。 */
export interface ApiFailure {
  /** 是否属围栏拒答（回环围栏或方法围栏）。 */
  refused: boolean;
  /** 可操作引导；只有回环围栏拒答非空（非 403 一律空串，不给普通失败粘贴无关提示）。 */
  hint: string;
  /** 展示正文。 */
  message: string;
}

/** 已构造的失败错误上被判读的结构化字段（挂载点见 markHttpFailure）。 */
export interface HttpFailure {
  code?: string;
  status?: number;
}

/** 围栏闭集的值域：从共享表派生，不抄第二份字面量。 */
const REFUSAL_VALUES: readonly string[] = Object.values(REFUSAL_CODES);

/**
 * 判定一次失败的结论。
 *
 * 输入可以是 catch 到的东西（新宿主挂过 `code`/`status` 的 Error、旧宿主的裸字符串、`null`），
 * 也可以是裸响应体（围栏体把 `code`/`status` 与 `error` 平铺）。形状再怪也只是判不出来，
 * 一律不抛——判定函数的职责是给结论，不是替调用方处理畸形输入。
 */
export function apiFailureOf(error: unknown, t: FailureTranslator): ApiFailure {
  const source = objectOf(error);
  const message = failureMessageOf(error, source);
  const code = stringOf(source?.code);
  if (code !== undefined && REFUSAL_VALUES.includes(code)) {
    return {
      refused: true,
      hint: code === REFUSAL_CODES.FORBIDDEN_LOOPBACK ? t("lanAccessHint") : "",
      message,
    };
  }
  const status = numberOf(source?.status);
  // 状态码是契约里最稳的一条：本服务端的 403 只有回环围栏一个来源。文案兜底只认「403」这个
  // 状态码本身（旧宿主的 message 就是 `HTTP 403`），不是中文文案匹配。
  if (status === 403 || (status === undefined && message.includes("403"))) {
    return { refused: true, hint: t("lanAccessHint"), message };
  }
  return { refused: false, hint: "", message };
}

/**
 * 把失败响应的结构化字段挂到已构造的 Error 上：就地挂、原样返回，throw 点的写法不变。
 *
 * 为什么这一步最要紧：字段没挂上，判定侧就只能退回文案兜底，结构化判定等于没做。两种形状都取
 * 是因为围栏拒答体把它们平铺（`{error, code, status}`），而端点失败体把 `code` 嵌在 `error` 里
 * （`{ok:false, error:{error, code}}`）；形状认不出时只挂得到状态码，判定侧照旧走兜底。
 *
 * `body` 可选：有的调用点只有响应码——例如 DELETE /history 的失败体未必是 JSON，为了挂
 * `code` 去解析它会让一条失败请求变成两条（读体再抛）。让调用点少传一个参数，比逼它造一个
 * 假 body 诚实。
 */
export function markHttpFailure<T extends Error>(
  error: T,
  status: number,
  body?: unknown,
): T & HttpFailure {
  const source = objectOf(body);
  const code = stringOf(source?.code) ?? stringOf(objectOf(source?.error)?.code);
  const failure = error as T & HttpFailure;
  if (code !== undefined) failure.code = code;
  failure.status = numberOf(source?.status) ?? status;
  return failure;
}

/**
 * 展示正文。四种输入各按自己的形状取：Error / 裸字符串 / 失败响应体（围栏体的 `error` 是裸字符串，
 * 端点失败体的是对象）/ 认不出的形状。
 *
 * 认不出的形状沿旧 catch 表达式 `(e && e.message) || e` 的语义交回对象本身，而不是编一句话：
 * 编出来的文案会把「读不出来」伪装成读出来了。
 */
function failureMessageOf(error: unknown, source: Record<string, unknown> | undefined): string {
  if (typeof error === "string") return error;
  if (source === undefined) return error === null || error === undefined ? "" : String(error);
  const direct = stringOf(source.message) ?? stringOf(source.details);
  if (direct !== undefined) return direct;
  if (typeof source.error === "string" && source.error !== "") return source.error;
  const nested = objectOf(source.error);
  const nestedText = stringOf(nested?.details) ?? stringOf(nested?.error);
  return nestedText ?? String(error);
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 非空字符串才算读到了值：空串与缺失在展示上是同一件事。 */
function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
