/**
 * dsh-mcp-manager — workspace/full-name.ts：server 全名与工具名归一化。
 *
 * 阶段 4 自 src/middleware-utils.ts 迁入工作空间路由域（命名/全名解析类，
 * v3 §二 workspace/full-name.ts）；策略裁决与目录检索函数留在
 * middleware-utils.ts（阶段 5 catalog 域迁出）。引用面经 workspace/interface.ts。
 */

import { MIDDLEWARE_GLOBAL_ROOT } from "./constants.ts";

/** server 全局唯一名：@<root>/<server>。 */
export function fullServerName(root: string, server: string): string {
  return `@${root}/${server}`;
}

/** 解析 @<root>/<server> 全名 → { root, server }；非法返回 undefined。
 * root 是绝对路径（以 / 开头），故从最后一个 `/` 分割（server 名不含 `/`）。
 * 特殊形态兼容：`@global/<server>`（单 @，人类/文档/A2 指引形态）归一化为
 * root=`@global`（MIDDLEWARE_GLOBAL_ROOT）；`@@global/<server>`（双 @，内部
 * fullServerName 产物）同样归一化为 `@global`——两种输入等价，杜绝「单 @ 被
 * 路由拒绝、双 @ 放行」的语义分裂（隔离验证 P0 发现，smoke 双 @ 掩盖单 @ 被拒）。 */
export function parseFullServerName(name: string): { root: string; server: string } | undefined {
  if (!name.startsWith("@")) return undefined;
  const slash = name.lastIndexOf("/");
  if (slash <= 1 || slash === name.length - 1) return undefined;
  const rawRoot = name.slice(1, slash);
  // @global/<s> → rawRoot="global"；@@global/<s> → rawRoot="@global"。
  const root = rawRoot === "global" || rawRoot === "@global" ? MIDDLEWARE_GLOBAL_ROOT : rawRoot;
  return { root, server: name.slice(slash + 1) };
}

/** 提取裸名（@root/server → server；无前缀原样返回）。 */
export function bareServerName(name: string): string {
  const parsed = parseFullServerName(name);
  return parsed?.server ?? name;
}

/** 归一化中间层工具的 tool 参数（模型可能传 mcp__<server>__<tool> 全名）。
 * @param caller 调用方工具名（错误文案前缀；ws_mcp_call / ws_mcp_detail 复用）。 */
export function normalizeToolName(serverName: string, toolName: string, caller = "ws_mcp_call"): string {
  const prefix = `mcp__${serverName}__`;
  let name = toolName;
  if (name.startsWith("mcp__")) {
    while (name.startsWith(prefix)) name = name.slice(prefix.length);
    if (name.startsWith("mcp__")) {
      throw new Error(
        `${caller}: tool 参数疑似其他 MCP server 的注册全名（${JSON.stringify(toolName)}，server="${serverName}"）；请传该 server 上的裸名`,
      );
    }
  }
  return name;
}