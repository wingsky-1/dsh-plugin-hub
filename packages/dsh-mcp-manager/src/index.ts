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
import type { McpManagerService } from "./integration/interface.ts";
import { installCatalog } from "./catalog/interface.ts";
import { installPipeline } from "./pipeline/interface.ts";
import * as connectionApi from "./connection/interface.ts";
import * as storeApi from "./config/store/interface.ts";
import * as workspaceApi from "./workspace/interface.ts";

// 目录域的静态端口装配。三组 Port 全是静态模块引用（不需要宿主 ctx 或配置），故写在入口
// 顶层、模块求值期写定。实参必须是可解析的对象字面量、键集与 catalog/deps.ts 的 CatalogDeps
// 严格相等——由 verify-dir-imports 的注入面对账强制；调用点必须落在入口，写在别处该对账会
// 静默空转（附录 G·G20）。
installCatalog({ store: storeApi, connection: connectionApi, workspace: workspaceApi });

// 执行管道域的静态端口装配。同上：实参必须是可解析的对象字面量、键集与 pipeline/deps.ts 的
// PipelineDeps 严格相等，且调用点必须落在入口（written elsewhere → 该对账静默空转，附录 G·G20）。
installPipeline({ workspace: workspaceApi });

/** 稳定的 cordis 插件名。 */
export const name = "mcp-manager";

/** 需要已初始化的工具注册表、web 服务器与提示词组装器。 */
export const inject = ["tools", "webServer", "systemPrompt"];

// 浮窗定位/层级/断点纯函数：实现在 shared/placement-math.ts（零依赖单一事实源，
// 客户端 bundle 与宿主端共用同一份），此处经 shared 门面 re-export 保持导出面不变。
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
  composerDockedAtBottom,
  bottomAnchorEdge,
} from "./shared/interface.ts";
export type { FloatBreakpoint, ViewportPoint, RectLike } from "./shared/interface.ts";
// 面板锚点判定同为纯函数，随定位数学一起从单一事实源 re-export。
export { panelAnchorForPosition } from "./shared/interface.ts";

// ------------------------------------------------------------ re-export
// 导出面与拆分前 lib/index.js 完全一致（smoke 验收契约）。

// 插件契约转发（apply 主流程 + 宣告文本实现于 apply.ts）
export { apply, MCP_GUIDANCE, MCP_SECTION_ORDER } from "./bootstrap/interface.ts";
export { resolveDebugConfig, resolveMiddlewareMode } from "./bootstrap/interface.ts";
// 运行期装配工厂（组合根）：热切换为 B20/C-EVT 契约测试面
export { makeMiddlewareHotSwitch } from "./bootstrap/interface.ts";

// 插件 Config schema 与配置归一化（类型自 types.ts 取）
export {
  DEFAULT_UI_CONFIG,
  DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS,
  normalizeUiConfig,
  buildConfigUiPatch,
  panelTopForAnchor,
  Config,
} from "./config/model/interface.ts";
export type { UiPlacementConfig, ClientUiConfig } from "./types/interface.ts";

// 管理器 / 连接域（orchestrator+runtime：#664 阶段 6 集中搬移完成）
export { McpManager } from "./connection/orchestrator/interface.ts";
export {
  ConnectionSupervisor,
  McpMiddleware,
  expandEnv,
  HttpTransport,
  parseSsePayload,
  StdioTransport,
  createTransport,
  MCPClient,
} from "./connection/interface.ts";
export {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DEFAULT_RESULT_TRUNCATE_BYTES,
  publicToolName,
  truncateText,
  assertSupportedOutputSchema,
  buildToolDefinition,
  RECONNECT_DEFAULTS,
  resolveReconnect,
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
} from "./connection/interface.ts";
export type { ReconnectPolicy } from "./connection/interface.ts";
// 工作空间路由域（项目根发现 / 全名解析 / scope / 模式归一化；阶段 4 成形）
export { findProjectRoot, normalizedProjectRoot, makeResolveRoot } from "./workspace/interface.ts";
export {
  fullServerName,
  parseFullServerName,
  normalizeToolName,
  normalizeMiddlewareMode,
} from "./workspace/interface.ts";
// 执行管道域（两路径同构纯函数族；#664 阶段 2）
export {
  normalizeArguments,
  msgOf,
  createRedactor,
  globMatch,
  policyAllows,
  policyDenialReason,
  isToolDenied,
  toolDisabledReason,
  withTimeout,
  defaultCallResultFallbackText,
  projectCallToolResult,
} from "./pipeline/interface.ts";
export type { CallResultTextHandlers, ProjectedCallResult } from "./pipeline/interface.ts";
// 核心化 service（官方 storageDomain 模式）：ctx.mcpManager 类型面 + 声明合并。
// 仅类型导出（无副作用导入）：消费方 import 类型时 tsc 会解析 integration 门面，
// 入口的 declare module 合并自动生效；副作用导入会让 stryker sandbox 解析
// src/service.js 失败（sandbox 只有 .ts），也避免 .d.ts 里残留 .ts 引用。
export type { McpManagerServerInput, McpManagerService } from "./integration/interface.ts";

/**
 * 服务名：本插件对兄弟插件开放的 ABI。声明合并的键引用它，而不是就地再写一遍字面量——两处字面量
 * 在改名时只会有一处被改到，而症状（消费方 `ctx.get` 拿到空）出现在别的插件里。名字的所有权在
 * 提供方（bootstrap/apply-services.ts），B2 落 sdk 域时并成一处定义。
 *
 * 它不进包导出面：入口对外只有声明合并本身，常量不外放。
 */
const MCP_MANAGER_SERVICE = "mcpManager" as const;

/**
 * 对外名字的声明合并。**必须写在包入口**：declare module 是全局增强，入口声明面不可达时
 * `lib/index.d.ts` 里就没有它（`pack:check` 的「声明合并可达性」判据盯这条）。
 */
declare module "@deepseek-ai/cordis" {
  interface Context {
    /** mcp-manager 核心服务：其他插件运行时注入/控制/查询 MCP 服务器（官方 storageDomain 模式）。 */
    [MCP_MANAGER_SERVICE]: McpManagerService;
  }
}

// 存储与状态持久化（config/store：#664 阶段 6 落位）
export { defaultStorePath, McpStore } from "./config/store/interface.ts";
export {
  userStateFile,
  loadUserState,
  saveUserState,
  loadDisabledTools,
  saveDisabledTools,
  parseDisabledTools,
  catalogCacheFileFor,
  readCatalogServerFromDisk,
} from "./config/store/interface.ts";
// 能力目录 / 目录缓存（#664 阶段 5：catalog 域成形）
export {
  DEFAULT_ANNOUNCE_CATALOG,
  DEFAULT_CATALOG_MAX_ENTRIES,
  catalogCacheFile,
  CATALOG_SUMMARY_MAX_CHARS,
  CATALOG_SUMMARY_PER_TOOL_CHARS,
  CATALOG_ENTRY_MAX_CHARS,
  summarizeToolDescriptions,
  composeCatalogEntries,
  digestCatalogEntries,
  renderMcpCatalogMessage,
  escapeCatalogText,
  findCatalogMessage,
  readCatalogEntries,
  isCatalogSource,
  resolveCatalogEntries,
  CATALOG_SOURCE_PLUGIN,
  CATALOG_SECTION_NAME,
  catalogHistory,
  renderMcpCatalogUpdate,
  resolveCatalogInjection,
  scoreTool,
  searchCatalog,
  isCatalogFresh,
  boundCatalogTools,
  searchCatalogMulti,
  listCatalog,
  findToolDetail,
} from "./catalog/interface.ts";
// mcpServers JSON 导入 / 归一化（config/model）
export {
  fromClaudeEntry,
  parseClaudeJson,
  SERVER_NAME_PATTERN,
  normalizeServer,
} from "./config/model/interface.ts";
// 统计与 Debug
export { McpStatsCollector, defaultStatsPath } from "./stats/interface.ts";
export type {
  McpStatsSnapshot,
  ServerStats,
  ToolCallMetric,
  ProgressiveDisclosureStats,
  DebugConfig,
} from "./stats/interface.ts";
// 工具注册面（inject：#664 阶段 6 落位）
export { registerMiddlewareTools, registerDirectMcpGuard } from "./inject/interface.ts";
// 共享类型面（types 域）
export type {
  MiddlewareMode,
  MiddlewarePolicy,
  ProjectUnit,
  SearchHit,
  ListToolEntry,
  ListServerEntry,
  ListCatalogResult,
  ToolDetail,
  DisabledToolsMap,
  ServerConfig,
  ServerStatus,
} from "./types/interface.ts";

// 路由
export {
  ROUTES,
  makeRoutes,
  makeEventsRoute,
  makeHealthRoute,
  uiConfigChangedFrame,
  broadcastFrame,
  SSE_HEARTBEAT_MS,
  SSE_PING_FRAME,
} from "./api/interface.ts";
export { normalizeScope } from "./workspace/interface.ts";
// 跨端契约常量（物理定义在 shared/constants.ts）：入口经共享层门面取，与两端消费者同一份；
// workspace 域门面仍为域内消费者转出同一份。客户端目前仍以字面量重复实现 scope 与全局 root
// 前缀，改引属 #769。
export { MIDDLEWARE_GLOBAL_ROOT, SCOPE_GLOBAL, SCOPE_PROJECT } from "./shared/interface.ts";
// 仓库共享层（loopback 围栏 / writeJson / readJsonBody / sseData）
export { isLoopbackRequest } from "../../../shared/loopback.js";
export { writeJson, readJsonBody, sseData } from "../../../shared/host-utils.js";
