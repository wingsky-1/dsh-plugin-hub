/**
 * dsh-mcp-manager — pipeline/authorize：执行授权纯函数（#664 阶段 2 迁入 + 阶段 6 收敛）。
 *
 * globMatch 阶段 2 迁入；策略裁决族（policyAllows / policyDenialReason /
 * isToolDenied / toolDisabledReason）依赖 parseFullServerName /
 * MIDDLEWARE_GLOBAL_ROOT（workspace 域）与 globMatch，阶段 6 自
 * middleware-utils.ts 并入本文件（该文件随后删除）。parseDisabledTools
 * （禁用表三层解析）并入 config/store/middleware-state.ts（状态域）。
 */

import { fullServerName, parseFullServerName, bareServerName, MIDDLEWARE_GLOBAL_ROOT } from "../workspace/interface.ts";
import type { MiddlewarePolicy, DisabledToolsMap } from "../types/interface.ts";

/** 工具名匹配 glob（* 通配）。 */
export function globMatch(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === name;
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(name);
}

// ------------------------------------------------------------ 策略裁决

/** 策略裁决：deny 优先。serverKey 支持全名（@root/server）或裸名——全名优先匹配（工作空间隔离），未命中回落裸名。返回 true = 允许。 */
export function policyAllows(policy: MiddlewarePolicy | undefined, serverKey: string, tool: string): boolean {
  if (policy === undefined) return true;
  const fullDeny = policy.denyTools?.[serverKey];
  if (fullDeny !== undefined && fullDeny.some((pattern) => globMatch(pattern, tool))) return false;
  const deny = policy.denyTools?.[bareServerName(serverKey)];
  if (deny !== undefined && deny.some((pattern) => globMatch(pattern, tool))) return false;
  const fullAllow = policy.allowTools?.[serverKey];
  if (fullAllow !== undefined && fullAllow.length > 0) {
    return fullAllow.some((pattern) => globMatch(pattern, tool));
  }
  const allow = policy.allowTools?.[bareServerName(serverKey)];
  if (allow === undefined || allow.length === 0) return true;
  return allow.some((pattern) => globMatch(pattern, tool));
}

/**
 * 单一裁决：工具是否被用户禁用（工具级禁用，独立于服务器级 enabled）。
 *
 * 三入口统一调用（P0-1）：ws_mcp_call（callTool，先查禁用再查策略）、
 * pre-execute guard（mcp__ 前缀工具）、插件侧自行声明的纪律裸名。
 *
 * 语义（P0-2 方案 A，零耦合）：禁用**只作用于 mcp-manager 管辖的 mcp__ 前缀
 * 工具**；插件侧声明的纪律裸名工具不受影响，由插件自行声明。
 * 禁用原因文案与浮窗 UI 均需同步声明该语义。
 *
 * 判定（P1 三层结构 + P2 超长名）：
 * 1. 目标 root 直接命中 → 查该 root 记录（project 模式按会话 root 隔离）；
 * 2. 未命中且目标 root 非 @global → 回落 @global 共享记录（全局工具跨工作空间
 *    key=@global；对项目 root 的查询是「该 root 无记录」的探测，永不误禁）；
 * 3. 哈希后缀名（>64 字符或含非法字符）不可逆 → 按「未知 server」处理：
 *    不禁用、不误禁（publicToolName 无法反解出 (server, tool)）。
 *
 * @param disabledTools 禁用映射（root → server → Set<tool>）。
 * @param policy 中间层策略（allowTools/denyTools；工具级禁用之外的第二道闸，
 *    仅 ws_mcp_call 路径检查，与既有语义一致）。
 * @param serverKey @<root>/<server> 全名或裸名（策略键；与 policyAllows 同形态）。
 * @param tool 远端工具裸名。
 * @returns true = 拒绝执行（被禁用或策略 deny）。
 */
export function isToolDenied(
  disabledTools: DisabledToolsMap | undefined,
  policy: MiddlewarePolicy | undefined,
  serverKey: string,
  tool: string,
): boolean {
  const parsed = parseFullServerName(serverKey);
  if (parsed !== undefined) {
    const server = parsed.server;
    const set = disabledTools?.get(parsed.root)?.get(server);
    if (set !== undefined && set.size > 0 && set.has(tool)) return true;
    if (parsed.root !== MIDDLEWARE_GLOBAL_ROOT) {
      const globalSet = disabledTools?.get(MIDDLEWARE_GLOBAL_ROOT)?.get(server);
      if (globalSet !== undefined && globalSet.size > 0 && globalSet.has(tool)) return true;
    }
  }
  return !policyAllows(policy, serverKey, tool);
}

/** 策略拒绝原因（供 denialReason 提示）。 */
export function policyDenialReason(policy: MiddlewarePolicy | undefined, serverKey: string, tool: string): string | undefined {
  if (policyAllows(policy, serverKey, tool)) return undefined;
  const deny = policy?.denyTools?.[serverKey] ?? policy?.denyTools?.[bareServerName(serverKey)];
  if (deny !== undefined && deny.some((pattern) => globMatch(pattern, tool))) {
    return `ws_mcp_call: 工具 ${JSON.stringify(`${serverKey}/${tool}`)} 被 denyTools 策略拒绝`;
  }
  return `ws_mcp_call: 工具 ${JSON.stringify(`${serverKey}/${tool}`)} 不在 allowTools 白名单内，被策略拒绝`;
}

/** 工具级禁用的拒绝原因文案（三入口统一；P0-2 语义声明，#413 覆盖中间层工具）。 */
export function toolDisabledReason(serverKey: string, tool: string): string {
  return `ws_mcp_call: 工具 ${JSON.stringify(`${serverKey}/${tool}`)} 已被用户在「MCP」浮窗禁用；工具级禁用作用于 mcp-manager 管辖的全部 MCP 工具（mcp__ 前缀直呼与中间层 ws_mcp_* 一致生效），纪律裸名不受影响（如需恢复请到浮窗重新勾选）`;
}
