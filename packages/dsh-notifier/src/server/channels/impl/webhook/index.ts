/**
 * dsh-notifier channels 域 —— webhook 出口。
 * 模板走两步法防注入：先替换裸值 {{ts}}、JSON.parse 整份模板，再对字符串值做占位符替换
 * 后重新序列化，替换内容因此逃不出字符串。任何失败都不重试。
 */
// 默认模板与 {{priority}} 映射表的事实源在 src/shared/webhooks.ts（两端共享面）：客户端「恢复
// 默认模板」与本出口渲染读同一份字面量——两处各写一份时的漂移症状是「设置页看到的模板与实际发
// 出去的 body 不是同一份」。命名差异（配置层 custom = 投递层 raw）也在那里单点化。
import { WEBHOOK_DEFAULT_TEMPLATES, WEBHOOK_PRIORITY } from "../../../../shared/interface.ts";
import type { ReasonCode, ReasonParams } from "../../../shared/interface.ts";
import { clampReasonDetail, reason } from "../../../shared/interface.ts";
import {
  FAILURE_REASON_MAX,
  RESPONSE_DETAIL_MAX,
  displayCaps,
  truncateCodePoints,
} from "../deliver/caps.ts";
import type { DeliverResult, NotifyMessage, NotifySeverity } from "../deliver/type.ts";
import type {
  WebhookPreset,
  WebhookRenderVars,
  WebhookTarget,
  WebhookTemplateNode,
} from "./type.ts";

/** 投递超时边界与缺省（秒），与配置层同一口径。 */
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 60;
const DEFAULT_TIMEOUT_SEC = 10;

/** 占位符（`{{ts}}` 不在其中：它只在文本层替换，见 renderWebhookBody）。 */
const TOKEN_RE = /\{\{\s*(title|message|kind|severity|priority|source)\s*\}\}/g;

/** `{{priority}}` 渲染值；severity 非法（跨边界值不受编译期约束）视同未提供。 */
export function priorityFor(preset: WebhookPreset, severity?: NotifySeverity): string {
  const mapped =
    severity !== undefined && Object.hasOwn(WEBHOOK_PRIORITY[preset], severity)
      ? WEBHOOK_PRIORITY[preset][severity]
      : undefined;
  if (mapped !== undefined) return mapped;
  return preset === "raw" ? "" : WEBHOOK_PRIORITY[preset].info;
}

/** 渲染 body；模板非法 JSON 即抛错（调用方转成这次投递失败，绝不降级成文本发送）。 */
export function renderWebhookBody(
  template: string,
  preset: WebhookPreset,
  vars: WebhookRenderVars,
): string {
  const source = template.length > 0 ? template : WEBHOOK_DEFAULT_TEMPLATES[preset];
  // 第一步：只有 {{ts}} 允许裸值形态（数字直出），否则模板不可能通过 JSON.parse
  const step1 = source.split("{{ts}}").join(String(Math.round(vars.ts)));
  let tree: WebhookTemplateNode;
  try {
    tree = JSON.parse(step1) as WebhookTemplateNode;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`webhook 模板不是合法 JSON: ${reason}`);
  }
  // 第二、三步：只替换字符串值；重新序列化时统一转义，注入内容逃不出这个字符串
  return JSON.stringify(
    renderTree(tree, {
      title: vars.title,
      message: vars.message,
      kind: vars.kind,
      severity: vars.severity ?? "",
      priority: priorityFor(preset, vars.severity),
      source: "",
    }),
  );
}

/** 遍历模板树，单趟替换字符串值里的占位符（替换内容不会被再次扫描）。 */
function renderTree(
  node: WebhookTemplateNode,
  values: Readonly<Record<string, string>>,
): WebhookTemplateNode {
  if (typeof node === "string") {
    return node.replace(TOKEN_RE, (match, name: string) =>
      Object.hasOwn(values, name) ? values[name] : match,
    );
  }
  if (Array.isArray(node)) return node.map((item) => renderTree(item, values));
  if (typeof node === "object" && node !== null) {
    const rebuilt: Record<string, WebhookTemplateNode> = {};
    for (const [key, value] of Object.entries(node)) rebuilt[key] = renderTree(value, values);
    return rebuilt;
  }
  return node;
}

/** 请求体由模板渲染；任何失败都不重试（模板或凭据写错，重投三次还是同样的结论）。 */
export async function sendWebhook(
  target: WebhookTarget,
  message: NotifyMessage,
): Promise<DeliverResult> {
  let body: string;
  try {
    // 空模板由 renderWebhookBody 回落到 preset 默认模板
    body = renderWebhookBody(target.template ?? "", target.preset, {
      title: truncateCodePoints(message.title, displayCaps.webhook.titleMax),
      message: truncateCodePoints(message.body, displayCaps.webhook.bodyMax),
      kind: message.kind,
      severity: message.severity,
      ts: message.ts,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return failed("reasonWebhookTemplateInvalid", { detail });
  }

  const headers: Record<string, string> = { ...target.headers };
  setHeader(headers, "content-type", "application/json; charset=utf-8");
  const auth = target.auth;
  // 枚举之外的认证方式（跨边界值）一律不套用：凭据只走请求头，拼进 URL 会留在对端访问日志里。
  if (auth !== undefined) {
    if (auth.kind === "bearer") {
      setHeader(headers, "authorization", `Bearer ${auth.token}`);
    } else if (auth.kind === "basic") {
      const pair = Buffer.from(`${auth.user}:${auth.password}`).toString("base64");
      setHeader(headers, "authorization", `Basic ${pair}`);
    }
  }

  let response: Response;
  try {
    response = await fetch(target.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(clampTimeoutSec(target.timeoutSec) * 1000),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return failed("reasonWebhookRequestFailed", { detail });
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = truncateCodePoints(await response.text(), RESPONSE_DETAIL_MAX);
    } catch {
      // 读不到响应体：状态码本身已是完整原因
    }
    return failed("reasonWebhookHttp", { params: { status: response.status }, detail });
  }
  return { status: "ok", stage: "delivered" };
}

/**
 * 写固定头：先摘掉同名（大小写不敏感）的自定义头——fetch 的 Headers 会把同名两键合并
 * 成一个值，凭据与 content-type 都会被发成两份。
 */
function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) delete headers[key];
  }
  headers[name] = value;
}

/**
 * 投递超时 clamp 到 1..60 秒（缺省 10）：配置层已归一，这里兜跨边界值。
 *
 * 导出是为了让这条口径可表驱动：clamp 的产物只落在 `AbortSignal` 的 deadline 上，从外面读不出来
 * ——「上界被改宽」与「下界被改成 0」在行为用例里都是绿的。
 */
export function clampTimeoutSec(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_SEC;
  return Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, Math.round(value)));
}

/** 失败结果：code 出文案、detail 存宿主原文；截断是展示语义，不是脱敏。 */
function failed(
  code: ReasonCode,
  options: { readonly params?: ReasonParams; readonly detail?: string } = {},
): DeliverResult {
  return {
    status: "failed",
    stage: "delivered",
    reason: clampReasonDetail(reason(code, options), FAILURE_REASON_MAX),
    // 零重试是硬约束：失败即终态，交回管线也没有第二次
    retryable: false,
  };
}
