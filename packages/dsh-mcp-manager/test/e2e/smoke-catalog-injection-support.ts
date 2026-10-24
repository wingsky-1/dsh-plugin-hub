// dsh-mcp-manager — e2e 目录注入测试桩（#1174 shape 拆分产物）。
//
// 原 e2e/smoke.test.ts 的 makeAgent / runStep 逐字提取：两者是 resolveCatalogInjection it 族与
// 双缺省 it 族共用的装配桩，独立成 support 供两个测试文件导入（避免从 .test.ts 导入导致重复求值）。
import { isCatalogSource, resolveCatalogInjection } from "../../lib/index.js";

// 0.1.2-rc.1 起 events getter 移除，fake 暴露方法形态）
export function makeAgent(): NonNullable<Parameters<typeof resolveCatalogInjection>[5]> {
  const events: { type: string; data: unknown; seq: number }[] = [];
  const session = {
    header: { cwd: "/tmp" },
    surface: { nodes: new Set<number>() },
    snapshotEvents: () => events,
    append(type: string, data: unknown) {
      const seq = events.length;
      const event = { type, data, seq };
      events.push(event);
      if (type === "user/message") session.surface.nodes.add(seq);
      return event;
    },
  };
  return { session } as unknown as NonNullable<Parameters<typeof resolveCatalogInjection>[5]>;
}

// 模拟一轮 pre-step：调用决策并把新增目录消息持久化进 events（agent-loop 行为）
export function runStep(
  decision: Parameters<typeof resolveCatalogInjection>[0],
  messages: Parameters<typeof resolveCatalogInjection>[1],
  supervisors: Parameters<typeof resolveCatalogInjection>[2],
  cache: Parameters<typeof resolveCatalogInjection>[4],
  agent: Parameters<typeof resolveCatalogInjection>[5],
) {
  const result = resolveCatalogInjection(decision, messages, supervisors, 6, cache, agent);
  const known = new Set<unknown>();
  for (const evt of agent!.session!.snapshotEvents!()) {
    if (evt.type === "user/message" && isCatalogSource(evt.data?.source))
      known.add((evt.data as unknown as { id: unknown }).id);
  }
  for (const msg of result.messages) {
    if (isCatalogSource(msg.source) && !known.has(msg.id))
      (agent!.session as unknown as { append: (type: string, data: unknown) => unknown }).append(
        "user/message",
        msg,
      );
  }
  return result;
}
