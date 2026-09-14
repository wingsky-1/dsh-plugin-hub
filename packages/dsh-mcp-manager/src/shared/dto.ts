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
 * 比服务查询面的摘要宽——配置面字段（含 env / headers / url）**保留键**、值由宿主
 * 按凭据清单掩码（§6.1），客户端原样回传、由宿主按源身份还原；删键会打穿编辑面。
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
