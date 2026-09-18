/**
 * dsh-mcp-manager — connection/interface.ts：连接域唯一对外引用面（D10，#664 阶段 3/6）。
 *
 * 连接域 = orchestrator（仲裁/双轨/summary/事件出口，manager）+ runtime（中间层池 /
 * limits），阶段 6 集中搬移完成（v3 §二）。自研连接栈 protocol/transport/supervisor/
 * reconnect 已在 #767 S1-5c 整体退役。
 * 目录外模块**只能**从这里引用本域自有符号（verify-dir-imports 静态强制）。
 *
 * runtime 子层的值面不再经本门面转出（#767 B2a-wire W10）：本门面只留类型出口，那 26 个值
 * 符号的消费者直接引 `connection/runtime/interface.ts`。「门面 → 子层门面」的值复导本身就是
 * 一条模块级值边（I2① `connection|connection/runtime`），而它只转发、不承载语义。
 *
 * 类型出口（#767 W11b2a）：ProjectUnit / ConnectionEntry 的物理定义在 runtime 的
 * impl/middleware/type.ts，经 runtime/interface.ts 转出后本门面只做门面→门面的再转出；
 * RoutesManager / SupervisorLite 原住 types/host-faces.ts，随 types 域解体落位本块。
 */
import type { SseHub } from "../../../../../shared/sse-hub.js";
import type { ClientUiConfig } from "../../shared/interface.ts";
import type { ServerConfig } from "../config/interface.ts";
import type { McpStore } from "../store/interface.ts";

export type { McpManager } from "./orchestrator/interface.ts";
export type { ProjectUnit, ConnectionEntry } from "./runtime/interface.ts";

/** supervisor 最小面（manager.supervisors 的条目）。 */
export interface SupervisorLite {
  server: ServerConfig;
  /** 服务器归属（global/project）；目录条目携带用于调用引导（#228）。 */
  scope?: string;
}

/** routes 使用的 McpManager 最小面（避免 index↔routes 循环 import）。 */
export interface RoutesManager {
  setSession(cwd: string | undefined): Promise<void>;
  refreshFromDisk(): Promise<void>;
  uiConfig(): ClientUiConfig;
  updateUiConfig(raw: unknown): Promise<ClientUiConfig>;
  summary(): Record<string, unknown>;
  add(server: Record<string, unknown>, scope?: string): Promise<ServerConfig>;
  update(name: string, patch: Record<string, unknown>, scope?: string): Promise<ServerConfig>;
  remove(name: string, scope?: string): Promise<void>;
  connect(name: string, scope?: string): Promise<void>;
  disconnect(name: string, scope?: string): Promise<void>;
  reconnect(name: string, scope?: string): Promise<void>;
  /** 设置/解除单个工具禁用（工具级，独立于服务器级 enabled）。 */
  setToolDisabled?(root: string, server: string, tool: string, disabled: boolean): Promise<void>;
  /** 切回前台受控重建当前工作空间连接（apply 注入；缺省不可用）。 */
  resumeReconnect?(): Promise<void>;
  projectStoreOrThrow(): Promise<McpStore>;
  store: McpStore;
  /** 当前会话项目根（tool-disable 路由一致性校验用）。 */
  projectRoot?: string;
  /** 设置命名空间写入 sink（apply 注入；config 写路由落盘用）。 */
  uiUpdate?: (patch: Record<string, unknown>) => Promise<unknown>;
  /**
   * SSE 连接枢纽（共享 shared/sse-hub，#515）：makeEventsRoute 惰性创建，
   * apply/广播/卸载 disposer 收口到 hub（连接表 + 心跳 + stalled/maxAge 主动回收）。
   * 取代旧 sseConnections Set + per-connection
   * 心跳（#268），消除与 dsh-notifier 的不对称。
   */
  sseHub?: SseHub;
  catalogCache: Map<string, unknown>;
  /** 中间层连接池（health 三计数按它聚合；结构面与 McpMiddleware 兼容）。 */
  middleware?:
    | {
        units: Map<string, { root: string; connections: Map<string, { status: string }> }>;
        /**
         * 读时刷新的六态投影。health 计数必须经它取状态：`entry.status` 只在装载等待窗口
         * 结算时写入，官方的后台重连与预算耗尽没有第二处写入点，直读会停在那一刻而失真。
         */
        statusOf(root: string, serverName: string): string | undefined;
        /** 该 (root, server) 的目录工具数（health 顶层 tools 计数的 units 聚合口径）。 */
        toolCountOf(root: string, serverName: string): number;
      }
    | undefined;
}
