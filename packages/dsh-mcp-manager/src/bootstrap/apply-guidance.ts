/**
 * dsh-mcp-manager — apply 装配拆分：Agent 宣告文案（#592 阶段二 Batch A）。
 *
 * 向 Agent 宣告插件（announceToAgent 开启时注入）。能力清单由动态目录
 * （<available_mcp_servers>）承担，此处只保留插件存在、安全边界与术语约定，
 * 不再复述 UI 配置路径与调用流程（那部分由能力目录与中间层工具描述承担）。
 */
export const MCP_GUIDANCE =
  "dsh-mcp-manager is active: centrally manages MCP server connections without preset servers. MCP tools execute on real servers with inherited host permissions; results may contain sensitive data — explain and obtain user consent before write or sensitive operations. Terms like 'MCP / context server' refer to this plugin. Invocation rules:\n" +
  "- Project-level servers: search with `ws_mcp_search`, verify schema with `ws_mcp_detail` if uncertain, then invoke with `ws_mcp_call`. Do NOT call mcp__ prefixed tools directly.\n" +
  "- Global servers: call `mcp__<server>__<tool>` directly (or via `ws_mcp_call` in all mode).\n" +
  "- Do not retry a failing server tool more than twice.";
