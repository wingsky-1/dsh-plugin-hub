/**
 * dsh-mcp-manager — types/interface.ts：共享 DTO/类型域唯一对外引用面（D10，#664 阶段 6）。
 *
 * types 域 = 服务器配置/状态（server/status）+ 浮窗 UI 配置（ui）+ 中间层共享
 * 类型（middleware-types）+ 宿主最小面（host-faces，阶段 6 收敛）。目录外模块
 * **只能**从这里引用（verify-dir-imports 静态强制）；DTO 集中本域是 v3 C-DIR
 * 既有规划。
 */
export type { ServerConfig } from "./server.ts";
export type { ServerStatus } from "./status.ts";
export type { UiPlacementConfig, ClientUiConfig } from "./ui.ts";
export type {
  MiddlewareMode,
  DisabledToolsMap,
  MiddlewarePolicy,
  ProjectUnit,
  ConnectionEntry,
  CatalogServer,
  CatalogTool,
  SearchHit,
  ListToolEntry,
  ListServerEntry,
  ToolDetail,
  ListCatalogResult,
} from "./middleware-types.ts";
export type { ManagerLite, RoutesManager, MiddlewareHost, SupervisorLite } from "./host-faces.ts";