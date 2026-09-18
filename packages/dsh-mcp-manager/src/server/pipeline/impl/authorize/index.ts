/**
 * dsh-mcp-manager — pipeline/impl/authorize/index.ts：执行授权纯函数（#664 阶段 2 迁入 + 阶段 6 收敛）。
 *
 * globMatch 阶段 2 迁入；工具级禁用裁决（isToolDenied / toolDisabledReason）经
 * `pipelinePorts` 取 parseFullServerName（workspace 端口，见 ../../deps.ts）与
 * MIDDLEWARE_GLOBAL_ROOT（跨端层 shared/constants.ts），阶段 6 自 middleware-utils.ts
 * 并入本文件（该文件随后删除）。parseDisabledTools（禁用表三层解析）并入
 * server/store/impl/middleware-state.ts（状态域）。
 *
 * #767 笔 2：`middlewarePolicy` 配置键与其策略裁决族（policyAllows / policyDenialReason /
 * MiddlewarePolicy）整体删除——工具级禁用是唯一裁决。globMatch 保留为公开纯函数，
 * 本笔之后仓内已无消费者（有意保留，见裁定 D3）。
 */

import { MIDDLEWARE_GLOBAL_ROOT } from "../../../../shared/interface.ts";
import type { DisabledToolsMap } from "../../../store/interface.ts";
import { pipelinePorts } from "../service/index.ts";

/** 工具名匹配 glob（* 通配）。 */
export function globMatch(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === name;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(name);
}

/**
 * 单一裁决：工具是否被用户禁用（工具级禁用，独立于服务器级 enabled）。
 *
 * 三入口统一调用（P0-1）：ws_mcp_call（callTool）、pre-execute guard（mcp__ 前缀工具）、
 * 插件侧自行声明的纪律裸名。
 *
 * 语义（P0-2 方案 A，零耦合）：禁用**只作用于 mcp-manager 管辖的 mcp__ 前缀
 * 工具**；插件侧声明的纪律裸名工具不受影响，由插件自行声明。
 * 禁用原因文案与浮窗 UI 均需同步声明该语义。
 *
 * 判定（P1 三层结构 + P2 超长名）：
 * 1. 目标 root 直接命中 → 查该 root 记录；
 * 2. 未命中且目标 root 非 @global → 回落 @global 共享记录（全局工具跨工作空间
 *    key=@global；对项目 root 的查询是「该 root 无记录」的探测，永不误禁）；
 * 3. 哈希后缀名（>64 字符或含非法字符）不可逆 → 按「未知 server」处理：
 *    不禁用、不误禁（publicToolName 无法反解出 (server, tool)）。
 *
 * @param disabledTools 禁用映射（root → server → Set<tool>）。
 * @param serverKey @<root>/<server> 全名或裸名。
 * @param tool 远端工具裸名。
 * @returns true = 拒绝执行（被禁用）。
 */
export function isToolDenied(
  disabledTools: DisabledToolsMap | undefined,
  serverKey: string,
  tool: string,
): boolean {
  const {
    workspace: { parseFullServerName },
  } = pipelinePorts.get();
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
  return false;
}

/** 工具级禁用的拒绝原因文案（三入口统一；P0-2 语义声明）。 */
export function toolDisabledReason(serverKey: string, tool: string): string {
  return `ws_mcp_call: 工具 ${JSON.stringify(`${serverKey}/${tool}`)} 已被用户在「MCP」浮窗禁用；工具级禁用作用于 mcp-manager 管辖的全部 MCP 工具（mcp__ 前缀直呼与中间层 ws_mcp_* 一致生效），纪律裸名不受影响（如需恢复请到浮窗重新勾选）`;
}
