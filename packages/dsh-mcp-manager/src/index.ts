/**
 * dsh-mcp-manager — 主机端（组合根）。
 *
 * 管理本机的 MCP（Model Context Protocol）服务器并桥接到 DSH：
 *  - 服务器配置持久化在 `~/.dsh/dsh-mcp.json`（版本化，原子写入）；
 *  - 每个服务器一个连接监督器（supervisor）：stdio / streamable-http 两种
 *    传输，指数退避重连，断开后按预算放弃；
 *  - 已连接服务器的工具以 `mcp__<serverName>__<rawName>` 注册进
 *    `ctx.tools`，模型可直接调用（与官方 dsh-mcp-client 同名契约）；
 *  - `/api/dsh-mcp/*` 路由（loopback-only）供 web GUI 分级展示、快速
 *    接入、粘贴 mcpServers JSON 导入；
 *  - 零运行时依赖：MCP 协议客户端（JSON-RPC over stdio / streamable-http）
 *    直接基于 node:child_process 与全局 fetch 实现。
 *
 * 激活：安装进 profile（见 cordis.patch.yml 注释），重启一次 dsh web 后，
 * 侧边栏出现「MCP」入口。
 *
 * 结构：职责按模块拆分（store / transport / protocol / supervisor /
 * routes / catalog / import / normalize / config-schema / manager / apply），
 * 本文件保留插件契约转发（apply）与全部公共符号 re-export（导出面不变）。
 */

// 类型面加载（declare module 合并）：dsh-agent 注入 agent/* 事件（含 pre-step
// waterfall）、dsh-tools 注入 ctx.tools、dsh-system-prompt 注入 ctx.systemPrompt。
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-tools";

/** 稳定的 cordis 插件名。 */
export const name = "mcp-manager";

/** 需要已初始化的工具注册表、web 服务器与提示词组装器。 */
export const inject = ["tools", "webServer", "systemPrompt"];

// 浮窗定位/层级/断点纯函数：实现在 placement-math.ts（零依赖单一事实源，
// 客户端 bundle 与宿主端共用同一份），此处 re-export 保持导出面不变。
export {
  DEFAULT_Z_INDEX_BASE,
  Z_INDEX_BASE_MIN,
  Z_INDEX_BASE_MAX,
  Z_INDEX_PANEL_DELTA,
  BREAKPOINT_NARROW_MAX,
  BREAKPOINT_TABLET_MAX,
  clampZIndexBase,
  panelZIndexFor,
  breakpointForWidth,
  clampPointToViewport,
} from "./placement-math.ts";
export type { FloatBreakpoint, ViewportPoint } from "./placement-math.ts";
// 面板锚点判定同为纯函数，随定位数学一起从单一事实源 re-export。
export { panelAnchorForPosition } from "./placement-math.ts";

// ------------------------------------------------------------ re-export
// 导出面与拆分前 lib/index.js 完全一致（smoke 验收契约）。

// 插件契约转发（apply 主流程 + 宣告文本实现于 apply.ts）
export { apply, MCP_GUIDANCE } from "./apply.ts";

// 服务器配置归一化（纯函数单一事实源）
export { SERVER_NAME_PATTERN, normalizeServer } from "./normalize.ts";

// 插件 Config schema 与配置归一化（类型自 types.ts 取）
export {
  DEFAULT_UI_CONFIG,
  DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS,
  normalizeUiConfig,
  buildConfigUiPatch,
  panelTopForAnchor,
  Config,
} from "./config-schema.ts";
export type { UiPlacementConfig, ClientUiConfig } from "./types.ts";

// 管理器 / 中间层全局虚拟 root
export { McpManager, MIDDLEWARE_GLOBAL_ROOT } from "./manager.ts";

// 核心化 service（官方 storageDomain 模式）：ctx.mcpManager 类型面 + 声明合并。
// 仅类型导出（无副作用导入）：消费方 import 类型时 tsc 会解析 service.d.ts，
// 其内的 declare module 合并自动生效；副作用导入会让 stryker sandbox 解析
// src/service.js 失败（sandbox 只有 .ts），也避免 .d.ts 里残留 .ts 引用。
export type { McpManagerServerInput, McpManagerService } from "./service.ts";

// 存储
export { defaultStorePath, McpStore } from "./store.ts";
// 传输
export { expandEnv, HttpTransport, parseSsePayload, StdioTransport, createTransport } from "./transport.ts";
// 协议
export { MCPClient } from "./protocol.ts";
// 连接监督器 / 工具定义（含命名、截断、schema 校验）
export {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  RECONNECT_DEFAULTS,
  DEFAULT_RESULT_TRUNCATE_BYTES,
  publicToolName,
  truncateText,
  assertSupportedOutputSchema,
  buildToolDefinition,
  ConnectionSupervisor,
  resolveReconnect,
} from "./supervisor.ts";
// 能力目录 / 目录缓存
export {
  DEFAULT_ANNOUNCE_CATALOG,
  DEFAULT_CATALOG_MAX_ENTRIES,
  catalogCacheFile,
  summarizeToolDescriptions,
  composeCatalogEntries,
  digestCatalogEntries,
  renderMcpCatalogMessage,
  escapeCatalogText,
  findCatalogMessage,
  readCatalogEntries,
  catalogHistory,
  renderMcpCatalogUpdate,
  resolveCatalogInjection,
} from "./catalog.ts";
// mcpServers JSON 导入
export { fromClaudeEntry, parseClaudeJson } from "./import.ts";
// 中间层（工作空间 MCP 路由：连接池 / 目录 / ws_mcp_search / ws_mcp_call /
// ws_mcp_list / ws_mcp_detail）
export {
  McpMiddleware,
  normalizeMiddlewareMode,
  registerMiddlewareTools,
  fullServerName,
  parseFullServerName,
  normalizeToolName,
  normalizeArguments,
  msgOf,
  createRedactor,
  globMatch,
  policyAllows,
  policyDenialReason,
  scoreTool,
  searchCatalog,
  searchCatalogMulti,
  listCatalog,
  findToolDetail,
  withTimeout,
  userStateFile,
  loadUserState,
  saveUserState,
  catalogCacheFileFor,
  CONNECT_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  CATALOG_TTL_MS,
  CATALOG_LRU_MAX,
  MAX_TOOLS_PER_SERVER,
  MAX_BYTES_PER_TOOL,
  MAX_TOTAL_CATALOG_BYTES,
  LIST_DEFAULT_TOOLS_PER_SERVER,
  LIST_MAX_TOOLS_PER_SERVER,
} from "./middleware.ts";
export type {
  MiddlewareMode,
  MiddlewarePolicy,
  ProjectUnit,
  SearchHit,
  ListToolEntry,
  ListServerEntry,
  ListCatalogResult,
  ToolDetail,
} from "./middleware.ts";
// 路由
export { ROUTES, makeRoutes, makeEventsRoute, makeHealthRoute, sseData, uiConfigChangedFrame, broadcastFrame, SSE_HEARTBEAT_MS, SSE_PING_FRAME } from "./routes.ts";
export { SCOPE_GLOBAL, SCOPE_PROJECT, normalizeScope } from "./scope.ts";
// 仓库共享层（loopback 围栏 / writeJson / readJsonBody）
export { isLoopbackRequest } from "../../../shared/loopback.js";
export { writeJson, readJsonBody } from "../../../shared/host-utils.js";
