/**
 * dsh-mcp-manager — 远端服务器装载与结算（内部实现）。
 *
 * 从 runtime/middleware.ts 拆出：中间层池只保留类与单元生命周期，装载窗口、官方状态
 * 订阅与目录投影在这里闭环。模块函数而非类成员——类成员会进入 .d.ts 声明块，破坏导出面
 * 零 diff。
 */
import type { ServerConfig } from "../../../../config/interface.ts";
import type { SchemaView } from "../../../../catalog/interface.ts";
import type { McpConnectionStatus } from "../../../../shared/interface.ts";
import type { MiddlewareHost } from "../../deps.ts";
import { runtimePorts } from "../service/index.ts";
import { observeOfficialStatus } from "./status.ts";
import type { ConnectionEntry, ProjectUnit } from "./type.ts";

/** 远端装载的宿主能力面（调用点在类内现造闭包，私有读口不出类）。 */
export interface MountRemoteFaces {
  host: MiddlewareHost;
  registeredSchemas(): SchemaView;
  registeredToolMeta(id: string): Map<string, { description?: unknown }>;
  redact(error: unknown): string;
  /** 记账：该 id 由本插件装载，模型可见面与直呼守卫只处理这些 id。 */
  ownServer(id: string): void;
}

/** 该条目的位置是否已被更新的 attempt 顶替。 */
function hasSuccessor(
  unit: ProjectUnit,
  name: string,
  entry: ConnectionEntry | undefined,
): boolean {
  const current = unit.connections.get(name);
  return current !== undefined && current !== entry;
}

function recordPendingMount(
  unit: ProjectUnit,
  name: string,
  entry: ConnectionEntry,
  id: string,
  release: (id: string) => void,
): void {
  const pending = { id, released: false };
  entry.pendingMount = pending;
  if (!ownsMount(unit, name, entry)) {
    pending.released = true;
    release(id);
  }
}

function releaseDiscardedMount(
  entry: ConnectionEntry,
  id: string,
  release: (id: string) => void,
): void {
  if (entry.pendingMount?.released !== true) release(id);
}

/**
 * 远端装载与结算：回答「远端服务器怎么挂上并落定？」——让位校验 + 占位 entry +
 * mountServer（含六态窗口 onState）+ 代际守卫 + settled/failed/discarded 结算；
 * 状态短路、旧代际拆除与配置加载在 connectInternal 主路（不同问题）。
 *
 * 模块函数而非私有方法：类成员会进入 .d.ts 声明块（导出面快照按块比对），
 * 纯内部分拆放模块级才能让导出面零 diff。
 * @param entry 装载前在册的旧条目（让位校验用；让位即静默返回）。
 */
export async function mountRemoteServer(
  unit: ProjectUnit,
  root: string,
  serverName: string,
  server: ServerConfig,
  entry: ConnectionEntry | undefined,
  faces: MountRemoteFaces,
): Promise<void> {
  const { lifecycle } = runtimePorts.get();
  // 让位校验：本次 attempt 期间（上方 await 窗口内）entry 已被强制拆除并由更新的 attempt
  // 重建（abandonInFlight 语义）——在装载前退避：既防旧配置的 entry 覆盖新 entry，也不把
  // 新代际的账本键错拆掉（拆除点已挪到让位校验与本处之后）。
  if (hasSuccessor(unit, serverName, entry)) return;
  const newEntry: ConnectionEntry = {
    server,
    id: undefined,
    handle: undefined,
    status: "connecting",
    error: undefined,
    connectedAt: undefined,
    readySettled: false,
    everConnected: false,
    disposed: false,
  };
  unit.connections.set(serverName, newEntry);
  let mounted: Awaited<ReturnType<typeof lifecycle.mountServer>>;
  try {
    mounted = await lifecycle.mountServer({
      root,
      server,
      shouldMount: () => ownsMount(unit, serverName, newEntry),
      onMounted: (id) => {
        faces.ownServer(id);
        recordPendingMount(unit, serverName, newEntry, id, lifecycle.releaseServer);
      },
      // 六态窗口内只推进状态：装上之后 id/handle 才回得来，这里不能碰代际守卫。
      onState: (next) => {
        if (!ownsMount(unit, serverName, newEntry)) return;
        newEntry.status = next;
        faces.host.emitStatus();
      },
    });
  } catch (error) {
    if (!ownsMount(unit, serverName, newEntry)) return;
    // 装载期异常（loader.load 失败 / 账本撞键等）：实例没挂上，只能落 failed 等人重试。
    newEntry.status = "failed";
    newEntry.error = faces.redact(error);
    newEntry.readySettled = true;
    faces.host.logger.warn(
      `dsh-mcp-manager(${serverName}@${root}): mount failed: ${faces.redact(error)}`,
    );
    faces.host.emitStatus();
    return;
  }
  // 账本键与句柄只有装载返回后才可得，而窗口内的 onState 可能已点亮状态——就绪位只能在此补写。
  newEntry.id = mounted.id;
  newEntry.handle = mounted.entry.handle;
  newEntry.readySettled = true;
  // 代际守卫（拆除期竞态）：拆除动作到达后这一代已不在册，但实例已经挂上——必须发起释放，
  // 否则官方实例与它占着的 serverName 预留会永久泄漏。
  if (!ownsMount(unit, serverName, newEntry)) {
    releaseDiscardedMount(newEntry, mounted.id, lifecycle.releaseServer);
    return;
  }
  if (mounted.outcome.kind === "settled") {
    newEntry.status = mounted.outcome.state;
    newEntry.error = mounted.outcome.error;
    if (mounted.outcome.state === "connected") {
      newEntry.everConnected = true;
      newEntry.connectedAt = Date.now();
      // 注册面 → 目录的投影自 #767 S1-3b 起归 catalog 域：id 前缀、脱敏与
      await projectConnectedCatalog(root, serverName, mounted.id, faces);
      // connected 日志随「连接真的建成」这一事件走，不随投影走（#1014 复核 P1-6）：
      // tools/change 驱动的重投影也会经过 projectConnectedCatalog，把日志留在那里会让
      // 未连接的服务器在每次注册面变化时都打一条 connected。
      faces.host.logger.info(`dsh-mcp-manager(${serverName}@${root}): connected`);
    } else if (mounted.outcome.state === "failed") {
      // 文案已是「我方判词 + 官方原文」（窗口把归属本实例的官方日志接在了 error 上）。
      faces.host.logger.warn(
        `dsh-mcp-manager(${serverName}@${root}): connection failed: ${mounted.outcome.error}`,
      );
    }
    faces.host.emitStatus();
  }
  // outcome.kind === "discarded"：本次结算作废，状态由拆除路径负责，这里不动。
  const status = mounted.entry.module.connectionStatusOf?.(mounted.entry.handle.statusFiber);
  if (status === undefined) return;
  newEntry.connectionStatus = status;
  const publish = (next: McpConnectionStatus): void => {
    if (!ownsMount(unit, serverName, newEntry)) return;
    observeOfficialStatus(newEntry, next, (error) => faces.redact(error));
    faces.host.emitStatus();
  };
  newEntry.statusUnsubscribe = status.onChange(publish);
  // 订阅后再读当前值，避免「读值 → 订阅」之间的翻转丢失。
  publish(status.current());
}

/**
 * connected 结算的副作用：注册面 → 目录投影 + B 层摘要缓存 + info 日志。
 * 与 failed 分支同为「结算副作用」但成因与产出不同，故各自成函数。
 *
 * 模块函数而非私有方法：理由同 mountRemoteServer（导出面零 diff）。
 */
export async function projectConnectedCatalog(
  root: string,
  serverName: string,
  id: string,
  faces: MountRemoteFaces,
): Promise<void> {
  // 注册面 → 目录的投影自 #767 S1-3b 起归 catalog 域：id 前缀、脱敏与
  // runtime 判定都是本层就地给的闭包（目录域不持服务器表）。
  await runtimePorts.get().catalog.catalogDirectory.projectRegisteredTools({
    root,
    serverName,
    id,
    schemas: faces.registeredSchemas(),
    cachePath: () => faces.host.catalogCachePath(root),
    redact: (error) => faces.redact(error),
    isRuntimeServer: (name) => faces.host.isRuntimeServer(name),
    warn: (message) => faces.host.logger.warn(message),
  });
  // B 层摘要缓存（原直连账本 mountEntry 结算路径的行为）：单池后由池侧继续喂，
  // 否则 /health.catalogCacheEntries 与注入端目录视图的 B 层兜底会静默失源。
  await faces.host.recordCatalogTools?.(serverName, faces.registeredToolMeta(id));
}

/** 条目是否仍由本代际持有（未被拆除、未被同名新代际顶替）。 */
export function ownsMount(unit: ProjectUnit, name: string, entry: ConnectionEntry): boolean {
  return !entry.disposed && unit.connections.get(name) === entry;
}
