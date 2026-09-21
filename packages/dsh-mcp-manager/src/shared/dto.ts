/**
 * dsh-mcp-manager — 跨端 DTO 形状单点（D5，#767 B1.5b）。
 *
 * 宿主与客户端经 HTTP / SSE 交换的数据形状只在本文件定义一次，两端一律经
 * shared/interface.ts 引用同一份。等值副本出现在 src/shared 之外即判红：
 * 运行期判据在 test/e2e/cross-end-lock.test.ts 的「单点定义」面，编译期判据在
 * test/integration/service-contract.test.ts 的两端互赋面（任一侧漂移即 tsc 红）。
 *
 * 这里只有形状没有行为：宿主投影按它构造载荷，客户端按它消费与编辑。
 */

import type { McpScope, McpServerStatus } from "./service.ts";

/**
 * 某服务器的实时摘要（服务查询面）：ctx.mcpManager.getStatus / list 的返回形态。
 * 它是服务 ABI 的一部分——字段增减即跨插件契约变更，消费方编译期可见。
 */
export interface McpServerSummary {
  name: string;
  transport: "stdio" | "streamable-http";
  scope: McpScope;
  status: McpServerStatus;
  error?: string;
  tools: string[];
  enabled: boolean;
}

/**
 * 面板列表条目：GET /servers 载荷的元素形态，也是客户端编辑表单的数据源。
 * #770-A3 只读投影：env/headers 敏感值整体省略（字段缺省，不用 "[REDACTED]"
 * 占位符），有无秘密只经 hasSecrets 布尔告知 GUI；url 按 B8 仅脱敏
 * userinfo/searchParams（host/path/查询键保留）。写路径（POST/PATCH）永不消费
 * 投影值：缺键即沿用既有、占位符 URL 由宿主 update 丢弃（回写链单测锁定）。
 */
export interface McpServerListEntry {
  name: string;
  transport: string;
  status: string;
  scope: string;
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** 有凭据被投影省略/脱敏（env/headers 非空或 url 含 userinfo/查询值）时为 true。 */
  hasSecrets?: boolean;
  error?: string;
  tools?: string[];
  /** 工具级被用户禁用的工具名列表（独立于服务器级 enabled）。 */
  disabledTools?: string[];
  toolCallTimeoutMs?: number;
  description?: string;
}

/** 浮窗 UI 配置：GET /config 与 POST /config 的扁平形态（宿主 normalizeUiConfig 的产出）。 */
export interface ClientUiConfig {
  position: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  offsetX: number;
  offsetY: number;
  blankY: number;
  zIndexBase: number;
}
