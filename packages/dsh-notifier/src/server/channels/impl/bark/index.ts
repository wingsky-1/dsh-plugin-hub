/**
 * dsh-notifier channels 域 —— bark 出口。
 * device_key 走 JSON body 不进 URL（反代访问日志默认只记 URL 与 header）；成功判定双查
 * 2xx 且响应体 code===200；失败只分类不重试，重试与节奏归管线。
 */
import type { ReasonCode, ReasonParams } from "../../../shared/interface.ts";
import { clampReasonDetail, reason } from "../../../shared/interface.ts";
import {
  FAILURE_REASON_MAX,
  RESPONSE_DETAIL_MAX,
  displayCaps,
  truncateCodePoints,
} from "../deliver/caps.ts";
import type {
  DeliverResult,
  HttpFetch,
  HttpFetchResult,
  NotifyMessage,
  NotifySeverity,
} from "../deliver/type.ts";
import { admitDeliveryUrl } from "../deliver/url-gate.ts";
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

/**
 * 默认出站实现：全局 fetch。已保存路径的语义锚点——调用方不传第三个参数时走这里，
 * 与重写前逐字一致（跟随重定向、宿主 DNS 直连）；dry-run 传自己的 SSRF 安全实现。
 */
const defaultFetch: HttpFetch = (url, init) => globalThis.fetch(url, init);

/**
 * Bark 推送：**先判地址，再发请求**（#1016 P0）。
 *
 * 出口自身只做准入与委派，请求构造与失败分类在 pushOnce。拆开有两个理由：
 *  - 复杂度：把准入这一支并进来会让本函数越过 ESLint 的上限（与 isBarkRejected 同源的问题）；
 *  - 读侧：准入是「这个目标能不能发」，投递是「发出去之后算什么」，两件事混在一个函数里
 *    时，改判据的人得先读完整个失败分类表。
 */
export async function sendBark(
  target: BarkTarget,
  message: NotifyMessage,
  fetchImpl: HttpFetch = defaultFetch,
): Promise<DeliverResult> {
  const pushUrl = pushUrlOf(target.baseUrl);
  // 判的是**拼好之后**真正发出去的那个地址（见 pushUrlOf 与 url-gate.ts 模块头）
  const admitted = admitDeliveryUrl(pushUrl);
  if (!admitted.ok) {
    // retryable 为假：URL 是配置事实，重投只是把同一个错地址打三遍（与 4xx 同一判据）
    return failed("reasonBarkRequestFailed", { detail: admitted.cause }, false);
  }
  return pushOnce(target, message, pushUrl, fetchImpl);
}

/**
 * 推送地址：把 `/push` 拼到 baseUrl 的**路径**上，query 原样留在后面（#1016 P0）。
 *
 * 此前是字符串拼接 `baseUrl + "/push"`，两处会打歪：
 * - base 带 query 时 `/push` 掉进 query 串里——`https://host/x?t=1` 拼出
 *   `https://host/x?t=1/push`，实际打到的是被截断的 `/x`；
 * - base 带尾斜杠时拼出 `//push`，多出一个空路径段（`https://api.day.app/` → `//push`）。
 * 走 URL API 则 `/push` 一定落在 pathname 上，两种 base 都拼对。
 *
 * hash 无需特判：fragment 不随请求发出，fetch 会忽略它——拼出来的
 * `https://host/x/push?t=1#frag` 与 `https://host/x/push?t=1` 发到同一个地方。
 * URL API 顺带做的规范化（默认端口省略、主机名小写、路径按需百分号编码）都是同址的等价写法，
 * 不改请求落点。
 *
 * 解析不了就原样返回：硬闸拿到的仍是同一个非法串，于是「URL 解析失败」这句只由
 * admitDeliveryUrl 一处产出，不在出口另抄一份文案。
 */
function pushUrlOf(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  // 去尾斜杠：否则 base 的末段与 /push 之间会多出一个空段
  url.pathname = url.pathname.replace(/\/+$/, "") + "/push";
  return url.toString();
}

/** 已准入的推送：拼请求体、发出去、按响应分类。判据一字未动，只是搬出准入那一支。 */
async function pushOnce(
  target: BarkTarget,
  message: NotifyMessage,
  pushUrl: string,
  fetchImpl: HttpFetch,
): Promise<DeliverResult> {
  const body = barkBodyOf(target, message);

  let response: HttpFetchResult;
  try {
    response = await fetchImpl(pushUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMsOf(target)),
    });
  } catch (cause) {
    // fetch 层失败（网络 / DNS / 超时）：POST 幂等，可重试
    const detail = cause instanceof Error ? cause.message : String(cause);
    return failed("reasonBarkRequestFailed", { detail }, true);
  }

  if (!response.ok) {
    // 4xx 确定失败；5xx 与网络同属可重试面。响应体只取摘要——本域不做脱敏
    const detail = await errorDetailOf(response);
    return failed(
      "reasonBarkHttp",
      { params: { status: response.status }, detail },
      response.status >= 500,
    );
  }

  try {
    const parsed = (await response.json()) as BarkPushResponse;
    if (isBarkRejected(parsed)) {
      // 业务码非 200：服务端拒绝，POST 幂等故按可重试面处理
      return failed(
        "reasonBarkRejected",
        { params: { code: String(parsed.code) }, detail: String(parsed.message ?? "") },
        true,
      );
    }
  } catch (cause) {
    // 非 JSON 响应体：2xx 已足够；读取中断（超时等）按可重试处理
    if (!(cause instanceof SyntaxError)) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return failed("reasonBarkBodyUnreadable", { detail }, true);
    }
  }
  return { status: "ok", stage: "delivered" };
}

/**
 * 业务码判定：2xx 不足以算送达——bark 服务端带 `code`，非 200 即拒收。
 *
 * 单立一函数是因为这是本出口唯一的「2xx 但仍失败」分支，判据却藏在四个条件的合取里：
 * 少一个条件（`code` 缺失、非对象）都会把拒收读成送达，而症状是用户看到「已送达」却没收到。
 */
function isBarkRejected(parsed: BarkPushResponse): boolean {
  return parsed !== null && typeof parsed === "object" && "code" in parsed && parsed.code !== 200;
}

/** 推送体：可选键「取不到就不写」，与服务端的缺省语义对齐。 */
function barkBodyOf(target: BarkTarget, message: NotifyMessage): BarkPushBody {
  // 推送体只由投递参数拼出：配置域不再透传频道条目里的陌生键（#1016 S2 删掉了 extras 概念），
  // 于是「配置里写一个 `title` 就能顶掉通知标题」这条透传面也不再存在。
  const body: BarkPushBody = {
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
async function errorDetailOf(response: HttpFetchResult): Promise<string> {
  try {
    return truncateCodePoints(await response.text(), RESPONSE_DETAIL_MAX);
  } catch {
    return "";
  }
}

/** 失败结果：code 出文案、detail 存宿主原文；截断是展示语义，不是脱敏。 */
function failed(
  code: ReasonCode,
  options: { readonly params?: ReasonParams; readonly detail?: string },
  retryable: boolean,
): DeliverResult {
  return {
    status: "failed",
    stage: "delivered",
    reason: clampReasonDetail(reason(code, options), FAILURE_REASON_MAX),
    retryable,
  };
}

/** 调用方给了可用的超时就照用，否则用出口的硬超时。
 *
 * 导出给草稿测试（dry-run）复用同一 clamp 口径：它在出口硬超时之外再压一条 15s 上限
 * （提案 B4），基数必须与这里同源，否则「已保存 10s、草稿 30s」这种分叉迟早出现。 */
export function timeoutMsOf(target: BarkTarget): number {
  const value = target.timeoutMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : BARK_TIMEOUT_MS;
}
