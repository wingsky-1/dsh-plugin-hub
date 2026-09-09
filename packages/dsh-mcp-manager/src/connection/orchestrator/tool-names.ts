/**
 * dsh-mcp-manager — connection/orchestrator/tool-names.ts：工具名展示投影纯函数。
 *
 * 从 manager.ts 迁入（#664 阶段 3 连接域逻辑收敛）：orchestrator（管理器仲裁/
 * 双轨/summary）的裸名展示口径单一事实源——剥 mcp__<server>__ 前缀后与中间层
 * 投影分支、工具级禁用表键、guard 层反解口径一致（#382 F4）。
 */

/**
 * 剥 mcp__<server>__ 前缀还原裸名（#382 F4 展示口径统一）。前缀不匹配（不可
 * 剥）原样返回；剥后为空或仍以 mcp__ 开头（跨 server 注册名）原样返回。超长
 * 哈希名剥出截断键——与 guard 层（tools/pre-execute 路径二按注册名反解）结果
 * 相同，禁用表键口径统一生效。
 */
export function stripMcpPrefix(registeredName: string, serverName: string): string {
  const prefix = `mcp__${serverName}__`;
  if (!registeredName.startsWith(prefix)) return registeredName;
  let name = registeredName;
  while (name.startsWith(prefix)) name = name.slice(prefix.length);
  if (name === "" || name.startsWith("mcp__")) return registeredName;
  return name;
}