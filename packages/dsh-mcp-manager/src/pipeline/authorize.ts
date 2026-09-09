/**
 * dsh-mcp-manager — pipeline/authorize：执行授权纯函数（#664 阶段 2 迁入）。
 *
 * 本阶段仅迁入自包含的 globMatch（无 workspace 域依赖）；策略裁决族
 * （policyAllows / policyDenialReason / isToolDenied / toolDisabledReason）
 * 依赖 parseFullServerName / MIDDLEWARE_GLOBAL_ROOT（workspace 域，阶段 4 迁入），
 * 待阶段 4 workspace/interface.ts 就绪后并入本文件。
 */

/** 工具名匹配 glob（* 通配）。 */
export function globMatch(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === name;
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(name);
}