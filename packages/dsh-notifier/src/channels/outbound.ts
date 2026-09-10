import type { NotifyChannel } from "../sdk/interface.ts";
import type { ChannelConfig } from "../config/interface.ts";
import { createBarkChannel } from "./bark.ts";
import { createWebhookChannel } from "./webhook.ts";

/**
 * 创建配置驱动的出站频道解析器（bark + webhook）。
 * 重试/并发门已上移框架 pipeline/deliver（B-3），装配层不再持有限流门状态。
 */
export function createOutboundChannelResolver(
  getChannels: () => ChannelConfig[] | undefined,
): () => Array<{ id: string; channel: NotifyChannel }> {
  return function outboundChannels(): Array<{ id: string; channel: NotifyChannel }> {
    const out: Array<{ id: string; channel: NotifyChannel }> = [];
    for (const c of getChannels() ?? []) {
      if (!c.enabled) continue;
      if (c.type === "bark") out.push({ id: `bark:${c.id}`, channel: createBarkChannel(c) });
      else if (c.type === "webhook") out.push({ id: `webhook:${c.id}`, channel: createWebhookChannel(c) });
    }
    return out;
  };
}