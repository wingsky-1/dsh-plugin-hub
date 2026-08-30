/**
 * 纪律工具注册定义（codegraph_explore）——独立纯函数，便于测试与复用。
 *
 * 契约要点（#356 回归）：
 * - 参数 schema 字段名必须是 `parameters`（@deepseek-ai/dsh-llm 的 ToolSchema
 *   契约），**不是** MCP 风格的 `inputSchema`——字段名错误会导致 dsh-tools
 *   投影时 `snapshotJsonValue(undefined)` 抛
 *   "tool \"<name>\" parameters must be lossless JSON before schema projection"；
 * - output 必含 schema + render（ToolOutputDefinition 契约），execute 返回
 *   canonical JSON 值，render 投影为模型可读的 ContentBlock[]。
 */
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { guardedExplore } from "./guard.ts";

/** 构建 codegraph_explore 工具注册定义（纯函数，无副作用）。 */
export function buildGuardToolDefinition(): ToolDefinition {
  return {
    name: "codegraph_explore",
    description:
      "查询 codegraph 代码图谱（本地索引，返回相关符号源码 + 调用路径）。" +
      "自动先 sync 目标 worktree 索引再查（新鲜度硬保证）；projectPath 缺省补全为当前" +
      "会话 worktree；无索引/无法确定 projectPath 时拒绝并提示。结构类代码问题优先用它。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "代码问题/符号名（如：X 被谁调用）" },
        projectPath: { type: "string", description: "目标 worktree 路径（缺省补全为当前会话 worktree）" },
      },
      required: ["query"],
    },
    // 官方 ToolOutputDefinition 契约（dsh-tools）：output 必含 schema + render。
    // execute 返回 canonical JSON 值，render 投影为模型可读的 ContentBlock[]。
    output: {
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
    },
    // canonical 值：{ text }；guardedExplore 返回纯文本（含拒绝引导），不抛错。
    execute: async (
      args: { query: string; projectPath?: string },
      exec: { agent?: { session?: { header?: { cwd?: string } } } },
    ) => {
      const cwd = exec?.agent?.session?.header?.cwd;
      return { text: await guardedExplore(args, cwd) };
    },
  };
}
