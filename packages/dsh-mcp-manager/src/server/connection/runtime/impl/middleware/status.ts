/**
 * dsh-mcp-manager — 官方连接状态与本地六态的桥接（内部嫁接）。
 *
 * 官方 rc.3 的 `connectionStatusOf` / `onChange` 是连接事实的第一手来源；本模块只做
 * 状态映射与条目回写，不持有池、不装配路由，也不进入包的公开导出面。
 */
import { SERVER_STATES, type ServerState } from "../../../../../shared/interface.ts";
import type { McpConnectionStatus } from "../../../../shared/interface.ts";
import type { SchemaView } from "../../../../catalog/interface.ts";
import { runtimePorts } from "../service/index.ts";
import type { ConnectionEntry, ProjectUnit } from "./type.ts";

/** 官方连接状态 → 本包六态。状态句柄存在时它是第一手事实源。 */
export function officialServerState(status: McpConnectionStatus): ServerState {
  switch (status.state) {
    case "connected":
      return SERVER_STATES.connected;
    case "connecting":
      return SERVER_STATES.connecting;
    case "reconnecting":
      return SERVER_STATES.reconnecting;
    case "waiting-credentials":
    case "failed":
      return SERVER_STATES.failed;
    case "closed":
      return SERVER_STATES.stopped;
  }
}

/** 官方状态变更的落账：状态、错因、首次连上时间与 everConnected 由同一事件回写。 */
export function observeOfficialStatus(
  entry: ConnectionEntry,
  status: McpConnectionStatus,
  redact: (error: unknown) => string,
): void {
  entry.status = officialServerState(status);
  const lastError =
    status.state === "waiting-credentials" ||
    status.state === "reconnecting" ||
    status.state === "failed"
      ? status.lastError
      : undefined;
  if (lastError !== undefined) entry.error = redact(lastError);
  if (status.state === "connected") {
    entry.everConnected = true;
    entry.connectedAt = status.connectedAt;
  }
}

/** 摘除官方状态订阅；句柄保留，用于拆除后的 closure 结算检查。 */
export function unsubscribeStatus(entry: ConnectionEntry): void {
  const unsubscribe = entry.statusUnsubscribe;
  entry.statusUnsubscribe = undefined;
  unsubscribe?.();
}

/** 无官方状态句柄时的注册面投影（旧宿主 / 夹具路径）。 */
export function projectedEntryState(
  unit: ProjectUnit,
  serverName: string,
  entry: ConnectionEntry,
  schemas: () => SchemaView,
): ServerState {
  const { lifecycle } = runtimePorts.get();
  return lifecycle.projectServerState(entry.id ?? "", {
    enabled: entry.server.enabled !== false,
    userDisabled: unit.userDisabled.has(serverName),
    tornDown: entry.disposed,
    disposed: entry.handle?.disposed === true,
    // 条目落进 connections 就等于「我方已发起 mount」（远程分支唯一的创建点）。不用
    // entry.id 当判据：id 要等装载窗口结算才回得来，拿它判会让整个窗口期投影成 stopped，
    // 且 connecting 永远不可达——而窗口期的正确状态就是 connecting。
    mountStarted: true,
    readySettled: entry.readySettled,
    // 窗口在途且已判废才算过期：常规路径下 readySettled 会在写回状态前为真。
    windowExpired: entry.status === "failed" && !entry.readySettled,
    everConnected: entry.everConnected,
    reconnectEnabled: entry.server.reconnect?.enabled !== false,
    hasTools: (id) => runtimePorts.get().catalog.catalogDirectory.hasRegisteredTools(schemas(), id),
  });
}
