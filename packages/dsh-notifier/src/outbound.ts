import type { NotifyChannel } from "./service.ts";
import type { ChannelConfig } from "./config.ts";
import { createBarkChannel, createBarkGate } from "./channel-bark.ts";
import { createWebhookChannel } from "./channel-webhook.ts";

/**
 * 创建配置驱动的出站频道解析器（bark + webhook）。
 * 限流门状态按 id 在实例生命周期内延续。
 */
export function createOutboundChannelResolver(
  getChannels: () => ChannelConfig[] | undefined,
): () => Array<{ id: string; channel: NotifyChannel }> {
  const barkGates = new Map<string, ReturnType<typeof createBarkGate>>();

  function gateFor(id: string) {
    let gate = barkGates.get(id);
    if (!gate) {
      gate = createBarkGate();
      barkGates.set(id, gate);
    }
    return gate;
  }

  return function outboundChannels(): Array<{ id: string; channel: NotifyChannel }> {
    const out: Array<{ id: string; channel: NotifyChannel }> = [];
    for (const c of getChannels() ?? []) {
      if (!c.enabled) continue;
      if (c.type === "bark") out.push({ id: `bark:${c.id}`, channel: createBarkChannel(c, gateFor(c.id)) });
      else if (c.type === "webhook") out.push({ id: `webhook:${c.id}`, channel: createWebhookChannel(c) });
    }
    return out;
  };
}
