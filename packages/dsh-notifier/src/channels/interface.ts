/**
 * dsh-notifier — channels/interface.ts：渠道域唯一对外引用面。
 *
 * 目录外代码只能从这里引用：内置频道工厂（browser/system，注入面装配）、
 * 配置驱动频道工厂（bark/webhook，含渲染纯函数与可靠性常量）与出站解析器。
 * 频道能力声明（capabilities）与错误协议（retryable 标注）的消费方在
 * pipeline/sdk 域（verify-dir-imports 静态强制）。
 */
export {
  BARK_MAX_INFLIGHT,
  BARK_RETRIES,
  BARK_TIMEOUT_MS,
  SEVERITY_LEVEL,
  createBarkChannel,
  createBarkGate,
} from "./bark.ts";
export {
  SEVERITY_GOTIFY_PRIORITY,
  SEVERITY_NTFY_PRIORITY,
  WEBHOOK_DEFAULT_TIMEOUT_SEC,
  WEBHOOK_MAX_TIMEOUT_SEC,
  WEBHOOK_MIN_TIMEOUT_SEC,
  createWebhookChannel,
  priorityFor,
  renderWebhookBody,
} from "./webhook.ts";
export { createBrowserChannel } from "./browser.ts";
export { createSystemChannel } from "./system.ts";
export { createOutboundChannelResolver } from "./outbound.ts";