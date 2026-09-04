/**
 * dsh-notifier — Webhook 推送频道（#508 M2，issue #505 方向一）。
 *
 * 职责：WebhookChannelConfig → NotifyChannel 适配。安卓侧经 ntfy / Gotify /
 * 自建推送网关补齐 Bark（iOS）未覆盖的推送通道。POST JSON 到 cfg.url，
 * 凭据一律走请求头（bearer→Authorization: Bearer、basic→Authorization: Basic、
 * header→自定义头），不拼 URL（不落访问日志，与 bark 的 device_key 走 body 同姿态）。
 *
 * 模板渲染（JSON-aware 两步法，评审 P0 防注入）：
 * 1. 文本层：仅替换 raw 型占位符 {{ts}}（数字直出，允许以裸值形态出现在模板中，
 *    使 JSON.parse 可行）；其余占位符不动；
 * 2. JSON.parse 模板（失败 = 该频道投递失败落记录，不影响其他频道）；
 * 3. 树遍历：对字符串值做占位符替换（值级替换——替换内容处于已解析字符串内部，
 *    JSON.stringify 重新序列化时统一转义，{{title}} 内容含引号/`"}}` 无法逃逸
 *    出字符串注入额外字段）；
 * 4. JSON.stringify 输出。
 *
 * {{priority}} 频道感知映射（拍板 ④）：按 cfg.preset 选择映射表——
 * ntfy：info→default / success→low / warning→high / failure→urgent（字符串）；
 * gotify：info/success→3 / warning→7 / failure→9（1-10 整数，字符串形态直出）；
 * custom：severity 原文直出（网关自定义处理）。{{severity}} 恒为原文直出。
 *
 * 可靠性（拍板 ②）：投递超时可配 1-60s（默认 10，normalize 权威 clamp）；
 * 失败不自动重试（终态落 status/历史，可重发测试验证）；4xx/5xx/网络错误统一
 * 失败终态。错误出口统一脱敏：凭据字面替换 → sanitizeErrorText（同 bark P0-4）。
 */
import { SECRET_MASK, isWebhookHeaderName } from "./config.ts";
import type { WebhookChannelConfig, WebhookPreset } from "./config.ts";
import type { NotifyChannel, NotifySeverity } from "./service.ts";
import { sanitizeErrorText } from "./message.ts";

/** severity → ntfy priority 静态映射（拍板 ④；契约测试锁定）。 */
export const SEVERITY_NTFY_PRIORITY: Readonly<Record<NotifySeverity, string>> = {
  failure: "urgent",
  warning: "high",
  success: "low",
  info: "default",
};

/** severity → Gotify priority（1-10 整数；拍板 r3：info/success→3、warning→7、failure→9）。 */
export const SEVERITY_GOTIFY_PRIORITY: Readonly<Record<NotifySeverity, number>> = {
  failure: 9,
  warning: 7,
  success: 3,
  info: 3,
};

/** 超时边界（秒）与缺省（拍板 ②：1-60，默认 10；normalize 权威 clamp，此处兜底）。 */
export const WEBHOOK_DEFAULT_TIMEOUT_SEC = 10;
export const WEBHOOK_MIN_TIMEOUT_SEC = 1;
export const WEBHOOK_MAX_TIMEOUT_SEC = 60;

/** 预设默认模板（cfg.template 为空时的兜底；与客户端 WEBHOOK_PRESETS 同源语义）。 */
const DEFAULT_TEMPLATES: Readonly<Record<WebhookPreset, string>> = {
  ntfy: '{\n  "topic": "<topic>",\n  "title": "{{title}}",\n  "message": "{{message}}",\n  "tags": ["{{kind}}"],\n  "priority": "{{priority}}"\n}',
  gotify: '{\n  "title": "{{title}}",\n  "message": "{{message}}",\n  "priority": "{{priority}}"\n}',
  custom: '{\n  "event": "{{kind}}",\n  "title": "{{title}}",\n  "body": "{{message}}",\n  "severity": "{{severity}}",\n  "ts": {{ts}}\n}',
};

/** {{priority}} 频道感知映射（preset → severity → 渲染值）。 */
export function priorityFor(preset: WebhookPreset, severity: NotifySeverity | undefined): string {
  if (preset === "gotify") return String(SEVERITY_GOTIFY_PRIORITY[severity ?? "info"]);
  if (preset === "custom") return severity ?? "";
  return SEVERITY_NTFY_PRIORITY[severity ?? "info"];
}

/** 渲染变量（渠道 SPI 契约字段 + 派生值）。 */
export interface WebhookRenderVars {
  title: string;
  message: string;
  kind: string;
  severity?: NotifySeverity;
  ts: number;
}

/**
 * JSON-aware 模板渲染（见文件头两步法说明）。模板非法 JSON 时抛错——调用方
 * （send）把渲染失败转为该频道的投递失败终态（落记录，不阻断其他频道）。
 * 导出供 smoke 直测（渲染/注入防护/映射表断言）。
 */
export function renderWebhookBody(template: string, preset: WebhookPreset, vars: WebhookRenderVars): string {
  const tpl = template.length > 0 ? template : DEFAULT_TEMPLATES[preset];
  // 步骤 1：raw 型 {{ts}} 数字直出（仅此占位符允许裸值形态）
  const step1 = tpl.split("{{ts}}").join(String(Math.round(vars.ts)));
  // 步骤 2：模板必须是合法 JSON（用户写错即投递失败，绝不静默降级成文本）
  let tree: unknown;
  try {
    tree = JSON.parse(step1);
  } catch (error) {
    throw new Error(`webhook 模板不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  // 步骤 3：树遍历做字符串值的占位符替换（单趟正则替换，防插入内容再被二次替换）
  const textVars: Record<string, string> = {
    title: vars.title,
    message: vars.message,
    kind: vars.kind,
    severity: vars.severity ?? "",
    priority: priorityFor(preset, vars.severity),
    source: "",
  };
  const TOKEN_RE = /\{\{\s*(title|message|kind|severity|priority|source)\s*\}\}/g;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return node.replace(TOKEN_RE, (m, name: string) => (name in textVars ? textVars[name] : m));
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  // 步骤 4：重新序列化——字符串值统一转义（注入面收口）
  return JSON.stringify(walk(tree));
}

/**
 * Webhook 频道实例工厂（#508 M2）。
 * @param cfg 实例配置（normalizeConfig 已归一化；url 已去 query/hash、timeoutSec 已 clamp）。
 * @returns NotifyChannel——send() 返回在途 promise（resolve=终态成功 / reject=终态
 *   失败，错误已脱敏）；渲染失败在 send 内捕获转为 reject（同步抛错面不外泄）。
 */
export function createWebhookChannel(cfg: WebhookChannelConfig): NotifyChannel {
  // 错误出口脱敏：凭据字面替换 → sanitizeErrorText 有序表 + 截断（同 bark 评审 P0-4）
  const secrets = [cfg.token, cfg.password, cfg.headerValue].filter((s): s is string => typeof s === "string" && s.length > 0);
  const scrub = (text: string): string => {
    let out = String(text);
    for (const s of secrets) out = out.split(s).join(SECRET_MASK);
    return sanitizeErrorText(out, 300);
  };
  const timeoutSec = typeof cfg.timeoutSec === "number" && Number.isFinite(cfg.timeoutSec)
    ? Math.min(WEBHOOK_MAX_TIMEOUT_SEC, Math.max(WEBHOOK_MIN_TIMEOUT_SEC, Math.round(cfg.timeoutSec)))
    : WEBHOOK_DEFAULT_TIMEOUT_SEC;
  const preset: WebhookPreset = cfg.preset ?? "ntfy";

  /** 组装认证头（normalize 已校验头名形状与 denylist；此处仅摘出）。 */
  function authHeaders(): Record<string, string> {
    if (cfg.auth === "bearer" && cfg.token) return { authorization: `Bearer ${cfg.token}` };
    if (cfg.auth === "basic" && cfg.username && cfg.password !== undefined) {
      // Node 宿主端：Buffer 可用（本文件不进客户端 bundle）
      return { authorization: `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")}` };
    }
    if (cfg.auth === "header" && cfg.headerName && isWebhookHeaderName(cfg.headerName) && cfg.headerValue) {
      return { [cfg.headerName]: cfg.headerValue };
    }
    return {};
  }

  /** 单次 POST（拍板：失败不重试）。非 2xx 抛错（响应体先截断再脱敏）。 */
  async function postOnce(bodyStr: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", ...authHeaders() },
        body: bodyStr,
        signal: AbortSignal.timeout(timeoutSec * 1000),
      });
    } catch (error) {
      throw new Error(`webhook 请求失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200); // 4xx 响应体可能回显凭据 → scrub
      } catch {
        // 响应体读不到：仅状态码
      }
      throw new Error(`webhook HTTP ${res.status}${detail ? `: ${scrub(detail)}` : ""}`);
    }
  }

  return {
    name: `webhook:${cfg.id}`,
    // capabilities：与 bark 同取合理客户端体验值（框架层 truncateCodePoints 统一执行）
    capabilities: { titleMaxLen: 64, maxBodyLen: 4096 },
    send(payload) {
      // fire-and-forget 语义由调用方（service dispatch）决定是否等待——渲染/投递
      // 全部在 promise 内（渲染失败也是 reject 终态，不抛同步错）。
      return (async () => {
        const bodyStr = renderWebhookBody(cfg.template ?? "", preset, {
          title: payload.title,
          message: payload.body,
          kind: payload.kind,
          severity: payload.severity,
          ts: payload.ts,
        });
        await postOnce(bodyStr);
      })();
    },
  };
}
