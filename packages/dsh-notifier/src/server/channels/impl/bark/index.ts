/**
 * dsh-notifier channels 域 —— bark 出口。
 * device_key 走 JSON body 不进 URL（反代访问日志默认只记 URL 与 header）；成功判定双查
 * 2xx 且响应体 code===200；失败只分类不重试，重试与节奏归管线。
 */
import {
  FAILURE_REASON_MAX,
  RESPONSE_DETAIL_MAX,
  displayCaps,
  truncateCodePoints,
} from "../deliver/caps.ts";
import type { DeliverResult, NotifyMessage, NotifySeverity } from "../deliver/type.ts";
import type { BarkPushBody, BarkPushResponse, BarkTarget } from "./type.ts";

/** 单次推送硬超时（毫秒）：超时归属出口，不在管线可配范围内。 */
const BARK_TIMEOUT_MS = 10_000;

/** severity → bark level（critical 需苹果特批故不映射；查不到即非法值，视同未提供）。 */
const SEVERITY_LEVEL: Readonly<Record<NotifySeverity, string>> = {
  failure: "timeSensitive",
  warning: "active",
  success: "active",
  info: "passive",
};

export async function sendBark(target: BarkTarget, message: NotifyMessage): Promise<DeliverResult> {
  const body = barkBodyOf(target, message);

  let response: Response;
  try {
    response = await fetch(`${target.baseUrl}/push`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMsOf(target)),
    });
  } catch (cause) {
    // fetch 层失败（网络 / DNS / 超时）：POST 幂等，可重试
    const reason = cause instanceof Error ? cause.message : String(cause);
    return failed(`bark 请求失败: ${reason}`, true);
  }

  if (!response.ok) {
    // 4xx 确定失败；5xx 与网络同属可重试面。响应体只取摘要——本域不做脱敏
    const detail = await errorDetailOf(response);
    const reason = `bark HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
    return failed(reason, response.status >= 500);
  }

  try {
    const parsed = (await response.json()) as BarkPushResponse;
    if (parsed !== null && typeof parsed === "object" && "code" in parsed && parsed.code !== 200) {
      // 业务码非 200：服务端拒绝，POST 幂等故按可重试面处理
      return failed(`bark code ${String(parsed.code)}: ${String(parsed.message ?? "")}`, true);
    }
  } catch (cause) {
    // 非 JSON 响应体：2xx 已足够；读取中断（超时等）按可重试处理
    if (!(cause instanceof SyntaxError)) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return failed(`bark 响应体读取失败: ${reason}`, true);
    }
  }
  return { status: "ok", stage: "delivered" };
}

/** 推送体：可选键「取不到就不写」，与服务端的缺省语义对齐。 */
function barkBodyOf(target: BarkTarget, message: NotifyMessage): BarkPushBody {
  // 未知键先铺底、已知键随后覆盖：透传是「带上用户写的额外参数」，不是「允许它们改写通知本身」
  // （配置里写一个 `title` 就能顶掉通知标题，那是透传面不该有的能力）。
  const body: BarkPushBody = {
    ...target.extras,
    device_key: target.deviceKey,
    title: truncateCodePoints(message.title, displayCaps.bark.titleMax),
    body: truncateCodePoints(message.body, displayCaps.bark.bodyMax),
  };
  // 显式 level 由调用方按 kind 算好，其次才是强度映射；两者都取不到就不写这个键
  const mapped =
    message.severity === undefined || !Object.hasOwn(SEVERITY_LEVEL, message.severity)
      ? undefined
      : SEVERITY_LEVEL[message.severity];
  const level = target.level ?? mapped;
  if (level !== undefined) body.level = level;
  if (target.sound !== undefined) body.sound = target.sound;
  if (target.group !== undefined) body.group = target.group;
  if (target.icon !== undefined) body.icon = target.icon;
  if (target.url !== undefined) body.url = target.url;
  if (target.badge !== undefined) body.badge = target.badge;
  return body;
}

/** 非 2xx 的响应体摘要；读不到就是空串——状态码本身已是完整原因。 */
async function errorDetailOf(response: Response): Promise<string> {
  try {
    return truncateCodePoints(await response.text(), RESPONSE_DETAIL_MAX);
  } catch {
    return "";
  }
}

/** 失败结果：原因按展示上限截断（截断是展示语义，不是脱敏）。 */
function failed(reason: string, retryable: boolean): DeliverResult {
  return {
    status: "failed",
    stage: "delivered",
    reason: truncateCodePoints(reason, FAILURE_REASON_MAX),
    retryable,
  };
}

/** 调用方给了可用的超时就照用，否则用出口的硬超时。 */
function timeoutMsOf(target: BarkTarget): number {
  const value = target.timeoutMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : BARK_TIMEOUT_MS;
}
