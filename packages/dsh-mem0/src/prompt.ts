/**
 * dsh-mem0 — 记忆系统提示词纪律注入。
 *
 * 核心设计（ADR-3）：
 * 1. 会话级单次注入（幂等防重）：通过 agent.session.snapshotEvents() 检查是否已注入，
 *    避免长会话每 step 累加 token 浪费；
 * 2. 文本全英文，严格控制在 ≤50 tokens；
 * 3. 强化 Active Recall 与 Conscious Retention。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";

export const MEMORY_DISCIPLINE_TEXT = [
  "[Memory System Guidelines]:",
  "- Active Recall: Consult 'memory_search' before making major architectural decisions or investigating unfamiliar patterns.",
  "- Conscious Retention: Call 'memory_add' immediately when the user clarifies a preference, confirms a design direction, or resolves a tricky bug.",
  "- Scoping: Project context is automatically bound to current repository; use scope=\"global\" only for universal preferences.",
].join("\n");

/** 构造记忆纪律注入消息。 */
function memoryDisciplineMessage(): UserMessage {
  return {
    id: randomUUID() as UserMessage["id"],
    role: "user",
    content: [{ type: "text", text: MEMORY_DISCIPLINE_TEXT }],
    source: { kind: "plugin", plugin: "mem0", form: "instructions" },
  };
}

/** 检查会话历史中是否已注入过 mem0 纪律。 */
export function isMemoryDisciplineInjected(agent: { session?: { snapshotEvents?: () => ReadonlyArray<unknown> } }): boolean {
  const events = agent.session?.snapshotEvents?.();
  if (!Array.isArray(events)) return false;
  return events.some((event) => {
    const e = event as { type?: string; data?: { source?: { kind?: string; plugin?: string } } };
    return (
      e.type === "user/message" &&
      e.data?.source?.kind === "plugin" &&
      e.data.source.plugin === "mem0"
    );
  });
}

/** 注册纪律钩子到 Cordis 上下文。 */
export function registerMemoryPromptHook(ctx: Context): () => void {
  return ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    signal.throwIfAborted();
    if (decision.kind === "reject") return decision;

    if (isMemoryDisciplineInjected(agent as unknown as { session?: { snapshotEvents?: () => ReadonlyArray<unknown> } })) {
      return decision;
    }

    const nextMessages = Array.isArray(decision.messages)
      ? [...decision.messages, memoryDisciplineMessage()]
      : decision.messages;
    return { kind: "enter", messages: nextMessages };
  });
}
