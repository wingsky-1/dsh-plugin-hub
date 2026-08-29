/**
 * mcp-manager 核心化 service 类型（官方 storageDomain 模式）。
 *
 * 类型面单一事实源在 shared/mcp-manager-service.d.ts（跨包共享，构建期内联、
 * 随包复制）。本文件只做类型 re-export + cordis Context 声明合并——消费方
 * （如 dsh-codegraph）从 shared 引用类型，不依赖本包构建时序（CI 并行 build）。
 *
 * 提供方：apply.ts 中 ctx.provide("mcpManager", service)。
 * 消费方：其他插件经 `ctx.mcpManager` 调用（inject 声明 "mcpManager"，
 * 或运行时 ctx.get("mcpManager") 探测降级）。
 */

// 类型 re-export（公共类型面，供消费方 import）。
export type {
  McpManagerServerInput,
  McpManagerService,
  McpScope,
  McpServerStatus,
  McpServerSummary,
  McpToolInfo,
} from "../../../shared/mcp-manager-service.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** mcp-manager 核心服务：其他插件运行时注入/控制/查询 MCP 服务器（官方 storageDomain 模式）。 */
    mcpManager: import("../../../shared/mcp-manager-service.js").McpManagerService;
  }
}