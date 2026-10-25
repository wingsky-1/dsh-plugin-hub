/**
 * dsh-notifier channels 域 webhook 测试的共享 fixture。
 *
 * target/message 是通用投递与 ntfy 两个测试文件共同消费的输入形状；产品裁决仍留在测试用例。
 */
import type { WebhookTarget } from "../../../src/server/channels/impl/webhook/type.ts";
import type { NotifyMessage } from "../../../src/server/channels/impl/deliver/type.ts";

export function targetOf(over: Partial<WebhookTarget> = {}): WebhookTarget {
  return { type: "webhook", url: "http://127.0.0.1:40281/hook", preset: "raw", ...over };
}

export function messageOf(over: Partial<NotifyMessage> = {}): NotifyMessage {
  return { title: "标题", body: "正文", kind: "done", ts: 1_700_000_000_000, ...over };
}
