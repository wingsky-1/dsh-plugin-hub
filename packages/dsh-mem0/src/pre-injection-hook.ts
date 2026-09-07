/**
 * dsh-mem0 — #581 会话首轮智能预检索注入钩子（agent/pre-step 装配）。
 *
 * 语义：
 * - 静默预检索：插件内部直接调 executor.search，不依赖模型工具调用往返，
 *   模型侧首轮不因预检索多出任何推理轮次；
 * - 每会话恰一次尝试：无论注入成功、结果为空还是失败降级，本会话后续步骤
 *   不再发起重复检索（attemptOrder 哨兵 + 注入事件判重双保险）；
 * - 首轮判定：事件流（snapshotEvents）中不存在本插件来源的预检索注入消息
 *   （form=recall）；与既有纪律判重（isMemoryDisciplineInjected）互不误伤；
 * - 三类降级（未就绪 / 抛错 / 超时）静默放行：不注入任何文本、不补注、不重试，
 *   异常不向会话步骤冒泡，绝不阻塞首轮回复；
 * - 零命中不追加任何文本（零 Token 浪费）；配套纪律独立成消息，互不合并。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import {
  buildPreInjectionText,
  filterCandidatesByThreshold,
  parseSearchCandidates,
  redactCandidates,
  PRE_INJECTION_DISCIPLINE_TEXT,
  type PreInjectOptions,
} from "./pre-injection.ts";
import { isMemoryDisciplineInjected } from "./prompt.ts";
import type { MemoryExecutor } from "./tool-definitions.ts";

/** 预检索有界超时（毫秒）：超时走静默降级，绝不阻塞首轮回复。 */
export const PRE_INJECTION_TIMEOUT_MS = 3000;

/** 围栏注入消息的 form 标记（dsh-llm ContextForm 枚举：recall = 从历史会话提取的材料）。 */
const PRE_INJECTION_SOURCE_FORM = "recall" as const;
/** 配套纪律消息的 form 标记（instructions = 期望模型遵循的指令）。 */
const PRE_INJECTION_DISCIPLINE_FORM = "instructions" as const;

/** 插件注入消息允许的 form（ContextForm 枚举子集：recall = 历史材料，instructions = 指令）。 */
type PluginSourceForm = "recall" | "instructions";

/** 构造插件来源注入消息。 */
function pluginInjectedMessage(text: string, form: PluginSourceForm): UserMessage {
  return {
    id: randomUUID() as UserMessage["id"],
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "mem0", form },
  };
}

/** 从 config 切片读取预检索配置（缺省回退默认值，容错 schema 演进）。 */
function readPreInjectOptions(config: unknown): PreInjectOptions {
  const c = (config ?? {}) as Partial<PreInjectOptions>;
  return {
    preInjectionThreshold: typeof c.preInjectionThreshold === "number" ? c.preInjectionThreshold : 0.6,
    preInjectionLimit: typeof c.preInjectionLimit === "number" ? c.preInjectionLimit : 3,
  };
}

/**
 * 首轮判定：事件流中不存在本插件来源的预检索注入消息（form=recall）。
 * 判定只认 recall 形态，与既有纪律注入判重（isMemoryDisciplineInjected）
 * 互不误伤；两种注入各自独立成消息。
 */
export function isPreInjectionTriggered(agent: {
  session?: { snapshotEvents?: () => ReadonlyArray<unknown> };
}): boolean {
  const events = agent.session?.snapshotEvents?.();
  if (!Array.isArray(events)) return true;
  return !events.some((event) => {
    const e = event as { type?: string; data?: { source?: { kind?: string; plugin?: string; form?: string } } };
    return (
      e.type === "user/message" &&
      e.data?.source?.kind === "plugin" &&
      e.data.source.plugin === "mem0" &&
      e.data.source.form === PRE_INJECTION_SOURCE_FORM
    );
  });
}

/** 提取 decision.messages 中最新的真实用户消息文本（跳过插件注入消息）。 */
function extractLatestUserText(messages: ReadonlyArray<unknown>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown; source?: { kind?: string } };
    if (m?.role !== "user") continue;
    if (m.source && typeof m.source === "object" && m.source.kind === "plugin") continue;
    return extractTextContent(m);
  }
  return "";
}

/** 从消息载荷提取文本内容（兼容 content 数组与纯字符串两种形态）。 */
function extractTextContent(message: unknown): string {
  if (typeof message === "string") return message;
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string"
          ? (c as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/** 带有界超时的检索：超时抛错归约到调用方降级路径。 */
function searchWithTimeout(
  executor: MemoryExecutor,
  query: string,
  limit: number,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("pre-injection search timeout")), timeoutMs);
    executor
      .search(query, undefined, limit)
      .then(
        (res) => {
          clearTimeout(timer);
          resolve(res);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
  });
}

/**
 * #581：注册会话首轮智能预检索注入钩子。
 *
 * 语义：
 * - 静默预检索：插件内部直接调 executor.search，不依赖模型工具调用往返；
 * - 每会话恰一次尝试：无论成功、空集还是失败降级，本会话不再重试（attemptOrder 哨兵
 *   + 注入事件判重双保险，覆盖同会话多 agent 实例形态）；
 * - 三类降级（未就绪 / 抛错 / 超时）静默放行，异常不向会话步骤冒泡；
 * - 零命中不追加任何文本；纪律提示词独立成消息、不与本注入合并。
 */
export function registerSmartPreInjectionHook(
  ctx: Context,
  executor: MemoryExecutor,
  getConfig: () => unknown,
  options?: { timeoutMs?: number },
): () => void {
  const timeoutMs = options?.timeoutMs ?? PRE_INJECTION_TIMEOUT_MS;
  // 检索尝试唯一性哨兵：以 agent 对象为键（WeakSet），会话结束随 agent 释放
  const attemptOrder = new WeakSet<object>();

  return ctx.on("agent/pre-step", async ({ agent }, next) => {
    const decision = await next();
    if (decision.kind === "reject") return decision;

    const agentObj = agent as unknown as object;
    // 检索尝试唯一性：本会话已发起过一次尝试（无论结果）→ 不再检索
    if (attemptOrder.has(agentObj)) return decision;
    attemptOrder.add(agentObj);

    // 注入唯一性：事件流已有预检索注入记录 → 不再注入
    if (!isPreInjectionTriggered(agent as unknown as { session?: { snapshotEvents?: () => ReadonlyArray<unknown> } })) {
      return decision;
    }

    // 开关关闭：全程不检索不注入
    const cfg = (getConfig() ?? {}) as { enableSmartPreInjection?: boolean };
    if (cfg.enableSmartPreInjection === false) return decision;

    // 降级 1：服务未就绪 → 静默放行
    if (!executor.isReady()) return decision;

    const query = extractLatestUserText(decision.messages ?? []);
    if (!query.trim()) return decision;

    const { preInjectionThreshold, preInjectionLimit } = readPreInjectOptions(getConfig());

    try {
      // 静默预检索（先于注入组装完成；有界超时约束）
      const raw = await searchWithTimeout(executor, query, preInjectionLimit, timeoutMs);
      const candidates = parseSearchCandidates(raw);
      const selected = redactCandidates(filterCandidatesByThreshold(candidates, { preInjectionThreshold, preInjectionLimit }));

      // 零命中：零 Token 浪费，不追加任何文本
      if (selected.length === 0) return decision;

      const baseMessages = Array.isArray(decision.messages) ? decision.messages : [];
      const nextMessages = [
        ...baseMessages,
        pluginInjectedMessage(buildPreInjectionText(selected), PRE_INJECTION_SOURCE_FORM),
      ];
      // 配套纪律独立成消息（仅当既有纪律提示词尚未注入时，互不合并、判重互不误伤）
      if (!isMemoryDisciplineInjected(agent as unknown as { session?: { snapshotEvents?: () => ReadonlyArray<unknown> } })) {
        nextMessages.push(pluginInjectedMessage(PRE_INJECTION_DISCIPLINE_TEXT, PRE_INJECTION_DISCIPLINE_FORM));
      }
      return { kind: "enter", messages: nextMessages };
    } catch {
      // 降级 2/3：检索抛错或超时 → 不补注、不重试，静默放行
      return decision;
    }
  });
}
