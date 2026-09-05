/**
 * dsh-mem0 — 封装工具定义（4 个核心工具：search/add/list/delete）。
 *
 * 规范要点（ADR-2, ADR-3, ADR-5）：
 * 1. 面向 LLM 的参数 schema 与 docstring 全英文；
 * 2. execute 先从会话上下文读取 cwd，自动映射 Git Canonical Namespace 注入；
 * 3. 统一输出 schema（canonical text output block）；
 * 4. 离线/故障优雅降级：执行失败或未就绪时返回结构化降级提示，绝不抛出异常。
 */

import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { GLOBAL_NAMESPACE, resolveGitCanonicalNamespace } from "./namespace.ts";

/** 底层记忆执行器接口。 */
export interface MemoryExecutor {
  search(query: string, userId?: string, limit?: number): Promise<string>;
  add(text: string, userId: string): Promise<string>;
  list(userId: string): Promise<string>;
  delete(memoryId: string): Promise<string>;
  isReady(): boolean;
}

/** 统一文本输出结构。 */
const TEXT_OUTPUT: ToolDefinition["output"] = {
  schema: {
    type: "object",
    properties: {
      text: { type: "string" },
    },
    required: ["text"],
    additionalProperties: false,
  },
  render(_args: unknown, value?: unknown) {
    const text = value && typeof value === "object" && "text" in value
      ? String((value as { text?: unknown }).text ?? "")
      : "";
    return [{ type: "text", text }];
  },
};

/** 离线降级提示文本。 */
export const UNAVAILABLE_MSG =
  "[Memory System Notice]: The persistent memory service is currently offline or unreachable. " +
  "Proceeding with current conversation context without long-term memory.";

/** 从上下文取会话 cwd。 */
export function extractSessionCwd(exec: { agent?: unknown }): string | undefined {
  if (typeof exec?.agent !== "object" || exec.agent === null) return undefined;
  const agent = exec.agent as { session?: { header?: { cwd?: unknown } } };
  const cwd = agent.session?.header?.cwd;
  return typeof cwd === "string" ? cwd : undefined;
}

/**
 * 构建 memory_search 工具定义。
 */
export function buildMemorySearchTool(executor: MemoryExecutor): ToolDefinition {
  return {
    name: "memory_search",
    description:
      "Search the persistent associative memory store for relevant past decisions, user preferences, " +
      "architectural conventions, and bug workarounds.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query describing the concepts, decisions, or facts to recall.",
        },
        scope: {
          type: "string",
          enum: ["project", "global", "all"],
          description: "Search scope: 'project' (current workspace, default), 'global' (cross-project), or 'all'.",
        },
        limit: {
          type: "number",
          description: "Maximum number of memories to return (default: 5).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args: unknown, exec: { agent?: unknown }) {
      if (!executor.isReady()) {
        return { text: UNAVAILABLE_MSG };
      }
      try {
        const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
        const query = String(params.query ?? "").trim();
        if (!query) return { text: "No query provided." };

        const scope = String(params.scope ?? "project");
        const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 5;

        const cwd = extractSessionCwd(exec);
        const projectNs = resolveGitCanonicalNamespace(cwd);

        let targetUser: string | undefined;
        if (scope === "project") {
          targetUser = projectNs;
        } else if (scope === "global") {
          targetUser = GLOBAL_NAMESPACE;
        } else {
          // 'all': 留空触发底层跨命名空间检索
          targetUser = undefined;
        }

        const res = await executor.search(query, targetUser, limit);
        return { text: res };
      } catch (err) {
        return { text: `[memory_search error: ${err instanceof Error ? err.message : String(err)}]` };
      }
    },
  };
}

/**
 * 构建 memory_add 工具定义。
 */
export function buildMemoryAddTool(executor: MemoryExecutor): ToolDefinition {
  return {
    name: "memory_add",
    description:
      "Record a new durable fact, user preference, architectural decision, or convention to the persistent store.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The concrete fact, decision, or preference to record into memory.",
        },
        scope: {
          type: "string",
          enum: ["project", "global"],
          description: "Target scope: 'project' (current repository, default) or 'global' (cross-project preferences).",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args: unknown, exec: { agent?: unknown }) {
      if (!executor.isReady()) {
        return { text: UNAVAILABLE_MSG };
      }
      try {
        const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
        const text = String(params.text ?? "").trim();
        if (!text) return { text: "Empty text cannot be recorded into memory." };

        const scope = String(params.scope ?? "project");
        const cwd = extractSessionCwd(exec);
        const targetUser = scope === "global" ? GLOBAL_NAMESPACE : resolveGitCanonicalNamespace(cwd);

        const res = await executor.add(text, targetUser);
        return { text: `Memory recorded successfully:\n${res}` };
      } catch (err) {
        return { text: `[memory_add error: ${err instanceof Error ? err.message : String(err)}]` };
      }
    },
  };
}

/**
 * 构建 memory_list 工具定义。
 */
export function buildMemoryListTool(executor: MemoryExecutor): ToolDefinition {
  return {
    name: "memory_list",
    description: "List stored memories in the persistent store for browsing and context inspection.",
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["project", "global"],
          description: "Target scope: 'project' (current workspace, default) or 'global'.",
        },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args: unknown, exec: { agent?: unknown }) {
      if (!executor.isReady()) {
        return { text: UNAVAILABLE_MSG };
      }
      try {
        const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
        const scope = String(params.scope ?? "project");
        const cwd = extractSessionCwd(exec);
        const targetUser = scope === "global" ? GLOBAL_NAMESPACE : resolveGitCanonicalNamespace(cwd);

        const res = await executor.list(targetUser);
        return { text: res };
      } catch (err) {
        return { text: `[memory_list error: ${err instanceof Error ? err.message : String(err)}]` };
      }
    },
  };
}

/**
 * 构建 memory_delete 工具定义。
 */
export function buildMemoryDeleteTool(executor: MemoryExecutor): ToolDefinition {
  return {
    name: "memory_delete",
    description: "Delete a specific memory entry by its unique ID. Bulk deletion is not supported.",
    parameters: {
      type: "object",
      properties: {
        memory_id: {
          type: "string",
          description: "Unique ID of the memory entry to delete.",
        },
      },
      required: ["memory_id"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args: unknown) {
      if (!executor.isReady()) {
        return { text: UNAVAILABLE_MSG };
      }
      try {
        const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
        const memoryId = String(params.memory_id ?? "").trim();
        if (!memoryId) return { text: "No memory_id specified." };

        const res = await executor.delete(memoryId);
        return { text: res };
      } catch (err) {
        return { text: `[memory_delete error: ${err instanceof Error ? err.message : String(err)}]` };
      }
    },
  };
}

/**
 * 获取全部 4 个封装工具定义集合。
 */
export function buildAllMemoryTools(executor: MemoryExecutor): ToolDefinition[] {
  return [
    buildMemorySearchTool(executor),
    buildMemoryAddTool(executor),
    buildMemoryListTool(executor),
    buildMemoryDeleteTool(executor),
  ];
}
