/**
 * dsh-notifier channels 域 —— webhook 出口。
 * 模板走两步法防注入：先替换裸值 {{ts}}、JSON.parse 整份模板，再对字符串值做占位符替换
 * 后重新序列化，替换内容因此逃不出字符串。任何失败都不重试。
 */
// 默认模板与 {{priority}} 映射表的事实源在 src/shared/webhooks.ts（两端共享面）：客户端「恢复
// 默认模板」与本出口渲染读同一份字面量——两处各写一份时的漂移症状是「设置页看到的模板与实际发
// 出去的 body 不是同一份」。命名差异（配置层 custom = 投递层 raw）也在那里单点化。
import {
  WEBHOOK_DEFAULT_TEMPLATES,
  WEBHOOK_PRIORITY,
  WEBHOOK_TIMEOUT,
} from "../../../../shared/interface.ts";
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
import type {
  WebhookPreset,
  WebhookRenderVars,
  WebhookTarget,
  WebhookTemplateNode,
} from "./type.ts";

// 投递超时边界与缺省（秒）在 src/shared/config-schema.ts 的 `WEBHOOK_TIMEOUT`（两端共享面）。
// 配置层归一化按 0..600 收口（见 input/index.ts 的 asCount），比本出口的 clamp 宽——
// 故这里是**兜跨边界值**的那一道，不声称与配置层同一口径。

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
  const rendered = renderTree(tree, {
    title: vars.title,
    message: vars.message,
    kind: vars.kind,
    severity: vars.severity ?? "",
    priority: priorityFor(preset, vars.severity),
    source: "",
  });
  // ntfy 官方 JSON 协议要求 `priority` 为 1..5 数字（字符串会被 400）：模板里仍写
  // `"{{priority}}"` 占位，这里归一成数字。旧字面量（`urgent` 等名称）兼容映射，
  // 非法值抛错进这次投递失败，不静默发出。gotify / raw 原样不动。
  return JSON.stringify(preset === "ntfy" ? normalizeNtfyTree(rendered) : rendered);
}

/** ntfy 旧名称 → 数字（兼容用户手写过旧名称字面量的模板；大小写不敏感）。 */
const NTFY_PRIORITY_NAMES: Readonly<Record<string, number>> = {
  min: 1,
  low: 2,
  default: 3,
  high: 4,
  urgent: 5,
  max: 5,
};

/** 单个 priority 值归一成数字（抛错进这次投递失败）。 */
function ntfyPriorityValue(value: WebhookTemplateNode): number {
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 1 && value <= 5) return value;
    throw new Error(`ntfy priority 非法：${String(value)}（需 1..5 数字）`);
  }
  if (typeof value !== "string") throw new Error("ntfy priority 非法：需 1..5 数字");
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const numeric = Number.parseInt(text, 10);
    if (numeric >= 1 && numeric <= 5) return numeric;
    throw new Error(`ntfy priority 非法：${value}（需 1..5 数字）`);
  }
  const named = text.toLowerCase();
  // 原型链守卫（与 priorityFor 的 hasOwn 同因）：直接索引时 `"__proto__"` 会拿到
  // `Object.prototype`（truthy 非数字），归一后发出的 priority 就不是数字了。
  if (!Object.hasOwn(NTFY_PRIORITY_NAMES, named))
    throw new Error(`ntfy priority 非法：${value}（需 1..5 数字）`);
  return NTFY_PRIORITY_NAMES[named];
}

/**
 * ntfy body 顶层 `priority` 归一成 1..5 数字。缺席与 null 视同缺席（交服务端默认 3，
 * 不替用户补——补了就分不清「用户没写」与「用户写了 3」）；其余非法一律抛错。
 */
function normalizeNtfyTree(node: WebhookTemplateNode): WebhookTemplateNode {
  if (typeof node !== "object") return node;
  if (node === null) return node;
  if (Array.isArray(node)) return node;
  const record = node as Record<string, WebhookTemplateNode>;
  if (!Object.hasOwn(record, "priority")) return node;
  if (record.priority === null) {
    delete record.priority;
    return node;
  }
  record.priority = ntfyPriorityValue(record.priority);
  return node;
}

/** ntfy topic 字符集（官方：字母/数字/`_`/`-`，1..64 字符）。 */
const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** topic 占位残留：空串、默认模板的 `<topic>` 字面量、未渲染的 `{{…}}` 视同缺席。 */
function isPlaceholderTopic(value: string): boolean {
  return value === "" || value === "<topic>" || value.includes("{{") || value.includes("}}");
}

/** path 单段安全解码：解码失败即用原文（随后走字符集校验，不抛穿）。 */
function decodeTopicSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** ntfy 发布地址解析结论：成功带最终地址与 body，失败带一句进 reason.detail 的原因。 */
type NtfyPublish =
  | { readonly ok: true; readonly url: string; readonly body: string }
  | { readonly ok: false; readonly cause: string };

/** 读 body.topic：占位残留视同缺席（undefined）；非法抛错进投递失败。 */
function readNtfyTopic(record: Record<string, unknown>): string | undefined {
  if (record.topic === undefined) return undefined;
  if (typeof record.topic !== "string") throw new Error("ntfy 配置错误：body.topic 需为字符串");
  if (isPlaceholderTopic(record.topic)) return undefined;
  if (!NTFY_TOPIC_RE.test(record.topic)) {
    throw new Error(
      `ntfy 配置错误：topic 非法：${record.topic}（仅允许字母/数字/_/-，1..64 字符）`,
    );
  }
  return record.topic;
}

/**
 * ntfy URL 拆解：只取原始 pathname（不解码——自托管前缀的大小写/编码/双斜杠原样保留，
 * 截段只动已明确的末段）；解析失败给 undefined（调用方报配置错误，不抛穿）。
 */
interface NtfyUrlParts {
  readonly origin: string;
  readonly pathname: string;
  readonly query: string;
}

function splitNtfyUrl(rawUrl: string): NtfyUrlParts | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  return { origin: url.origin, pathname: url.pathname, query: url.search };
}

/** 原始路径非空段（不解码）：只用于定位末段，比较时才解码候选末段。 */
function rawSegments(pathname: string): readonly string[] {
  return pathname.split("/").filter((part) => part.length > 0);
}

/**
 * 显式 topic 的地址判定：根路径原样保留；尾斜杠路径视同自托管前缀根地址，原样保留
 * 绝不截断；末段解码后与 topic 一致（无尾斜杠）则从原始 pathname 截掉该末段（其余
 * 字节/双斜杠/query 原样保留）；末段不一致（无尾斜杠）即 topic URL 与自定义模板
 * topic 冲突，报配置错误、不发错地址。
 */
function publishWithTopic(
  parts: NtfyUrlParts,
  topic: string,
  rawUrl: string,
  bodyText: string,
): NtfyPublish {
  const raws = rawSegments(parts.pathname);
  if (raws.length === 0) return { ok: true, url: rawUrl, body: bodyText };
  const lastRaw = raws[raws.length - 1] as string;
  if (decodeTopicSegment(lastRaw) !== topic) {
    if (parts.pathname.endsWith("/")) return { ok: true, url: rawUrl, body: bodyText };
    return {
      ok: false,
      cause: `ntfy 配置错误：URL 末段 "${decodeTopicSegment(lastRaw)}" 与模板 topic "${topic}" 不一致（JSON 须发往服务根地址）；请改用根地址或统一 topic`,
    };
  }
  if (parts.pathname.endsWith("/")) return { ok: true, url: rawUrl, body: bodyText };
  // 只移除末段 topic 本身：分隔斜杠是前缀的一部分（如 /base//demo → /base//，
  // /base/demo → /base/），连同分隔符一起截会改写前缀字节。
  const cut = parts.pathname.slice(0, parts.pathname.length - lastRaw.length) || "/";
  return { ok: true, url: parts.origin + cut + parts.query, body: bodyText };
}

/**
 * 无可用 topic 的地址判定：根路径报缺 topic；尾斜杠路径（非根）不明确是前缀根还是
 * topic 地址，不猜、报不明确；多段路径同样不猜自托管前缀；仅无尾斜杠单段路径提取
 * 末段（解码后校验）并改写为根地址。三者都不发错地址。
 */
function publishWithoutTopic(parts: NtfyUrlParts, record: Record<string, unknown>): NtfyPublish {
  const raws = rawSegments(parts.pathname);
  if (raws.length === 0) {
    return {
      ok: false,
      cause:
        "ntfy 配置错误：缺少可用 topic（模板 topic 为空或仍为 <topic> 占位，且 URL 为服务根地址无法提取）；请在模板填写真实 topic",
    };
  }
  if (parts.pathname.endsWith("/")) {
    return {
      ok: false,
      cause:
        "ntfy 配置错误：模板无可用 topic 且 URL 以 / 结尾，无法明确判断这是前缀根地址还是 topic 地址；请在模板填写真实 topic",
    };
  }
  if (raws.length > 1) {
    return {
      ok: false,
      cause:
        "ntfy 配置错误：模板 topic 为空/占位且 URL 路径含多段，无法明确提取 topic（不猜测自托管前缀）；请改用服务根地址并在模板填写真实 topic",
    };
  }
  const extracted = decodeTopicSegment(raws[0] as string);
  if (!NTFY_TOPIC_RE.test(extracted)) {
    return {
      ok: false,
      cause: `ntfy 配置错误：URL 末段 topic 非法：${extracted}（仅允许字母/数字/_/-，1..64 字符）`,
    };
  }
  record.topic = extracted;
  return { ok: true, url: parts.origin + "/" + parts.query, body: JSON.stringify(record) };
}

/**
 * ntfy JSON 发布地址解析（#1102）：官方要求 JSON 发往服务根地址、body.topic 必填。
 * 根 JSON 模式与旧 topic URL 模式都明确判定、互相兼容，细则见 publishWithTopic /
 * publishWithoutTopic（判定分散后本函数只做装配：解析 → 读 topic → 分派）。
 */
function resolveNtfyPublish(rawUrl: string, bodyText: string): NtfyPublish {
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText) as unknown;
  } catch {
    return { ok: false, cause: "ntfy 配置错误：body 不是合法 JSON 对象" };
  }
  if (typeof payload !== "object")
    return { ok: false, cause: "ntfy 配置错误：body 顶层需为 JSON 对象" };
  if (payload === null) return { ok: false, cause: "ntfy 配置错误：body 顶层需为 JSON 对象" };
  if (Array.isArray(payload)) return { ok: false, cause: "ntfy 配置错误：body 顶层需为 JSON 对象" };
  const record = payload as Record<string, unknown>;
  let topic: string | undefined;
  try {
    topic = readNtfyTopic(record);
  } catch (cause) {
    return { ok: false, cause: errorDetail(cause) };
  }
  const parts = splitNtfyUrl(rawUrl);
  if (parts === undefined) return { ok: false, cause: "ntfy 配置错误：URL 解析失败" };
  if (topic !== undefined) return publishWithTopic(parts, topic, rawUrl, bodyText);
  return publishWithoutTopic(parts, record);
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

/**
 * 默认出站实现：全局 fetch。已保存路径的语义锚点——调用方不传第三个参数时走这里，
 * 与重写前逐字一致；dry-run 传自己的 SSRF 安全实现（见 bark 出口同款注释）。
 */
const defaultFetch: HttpFetch = (url, init) => globalThis.fetch(url, init);

/** 请求体由模板渲染；任何失败都不重试（模板或凭据写错，重投三次还是同样的结论）。 */
export async function sendWebhook(
  target: WebhookTarget,
  message: NotifyMessage,
  fetchImpl: HttpFetch = defaultFetch,
): Promise<DeliverResult> {
  // 准入先于模板渲染（#1016 P0）：地址不合规时没有可发的地方，渲染 body 只是白做一遍解析。
  // 顺序反过来会让「地址错 + 模板错」的频道只报模板问题，用户改完模板再撞一次地址。
  const admitted = admitDeliveryUrl(target.url);
  if (!admitted.ok) return failed("reasonWebhookRequestFailed", { detail: admitted.cause });

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
    return failed("reasonWebhookTemplateInvalid", { detail: errorDetail(cause) });
  }

  // ntfy JSON 须发往服务根地址（#1102）：旧 topic URL + 默认模板自动兼容改写，
  // 根地址 + 显式 topic 原样保留，冲突/缺 topic/不明确模式在出站前报配置错误。
  // gotify / raw 由 publishTargetOf 原样直通，不进 ntfy 分支。
  const published = publishTargetOf(target, body);
  if (published.failure !== undefined) return published.failure;
  body = published.body;
  const publishUrl = published.url;

  const headers: Record<string, string> = { ...target.headers };
  setHeader(headers, "content-type", "application/json; charset=utf-8");
  applyAuthHeader(headers, target.auth);

  let response: HttpFetchResult;
  try {
    response = await fetchImpl(publishUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(clampTimeoutSec(target.timeoutSec) * 1000),
    });
  } catch (cause) {
    return failed("reasonWebhookRequestFailed", { detail: errorDetail(cause) });
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
 * 套用认证头。枚举之外的认证方式（跨边界值）一律不套用：凭据只走请求头，
 * 拼进 URL 会留在对端访问日志里。两种方式各自决定 header 值，故与 setHeader 分开成一处。
 */
function applyAuthHeader(headers: Record<string, string>, auth: WebhookTarget["auth"]): void {
  if (auth === undefined) return;
  if (auth.kind === "bearer") {
    setHeader(headers, "authorization", `Bearer ${auth.token}`);
    return;
  }
  if (auth.kind === "basic") {
    const pair = Buffer.from(`${auth.user}:${auth.password}`).toString("base64");
    setHeader(headers, "authorization", `Basic ${pair}`);
  }
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
  if (typeof value !== "number" || !Number.isFinite(value)) return WEBHOOK_TIMEOUT.default;
  return Math.min(WEBHOOK_TIMEOUT.max, Math.max(WEBHOOK_TIMEOUT.min, Math.round(value)));
}

/** 失败原因的宿主原文：Error 取 message，其余 String 化（调用方截断进 detail）。 */
function errorDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 本次投递的发布地址与 body。非 ntfy 原样直通；ntfy 解析失败直接带回这次投递的
 * 失败结果（调用方单分支返回，sendWebhook 不再为 ntfy 增复杂度）。
 * 改写后的地址在这里重新过出站硬闸，不绕过现有安全桩。
 */
function publishTargetOf(
  target: WebhookTarget,
  body: string,
): { readonly url: string; readonly body: string; readonly failure?: DeliverResult } {
  if (target.preset !== "ntfy") return { url: target.url, body };
  const resolved = resolveNtfyPublish(target.url, body);
  if (!resolved.ok) {
    return {
      url: target.url,
      body,
      failure: failed("reasonWebhookTemplateInvalid", { detail: resolved.cause }),
    };
  }
  const readmitted = admitDeliveryUrl(resolved.url);
  if (!readmitted.ok) {
    return {
      url: target.url,
      body,
      failure: failed("reasonWebhookRequestFailed", { detail: readmitted.cause }),
    };
  }
  return { url: resolved.url, body: resolved.body };
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
