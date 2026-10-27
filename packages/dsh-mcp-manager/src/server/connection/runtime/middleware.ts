/**
 * dsh-mcp-manager — 中间层（工作空间 MCP 路由）。
 *
 * 模型面恒定两个工具（ws_mcp_search / ws_mcp_call），执行时按调用方会话
 * 当前 cwd（agent.session.header.cwd，实证已闭合）路由到对应工作空间的
 * MCP 连接池，实现「不同工作空间注入不同 MCP、无命名冲突」：
 * - 连接池：每工作空间一套常驻连接（惰性连接 + 超时 + LRU 淘汰）；
 * - 目录：每工作空间 ToolCatalog（惰性发现 + last-good 磁盘缓存 + 检索）；
 * - 容错：normalizeToolName / normalizeArguments / msgOf / createRedactor。
 *
 * 单池（#767 笔 1a/笔 2）：全部服务器一律经中间层单元触达；配置里已无模式键
 * （`mcp__*` 也不再在模型可见面），故本文不再有任何模式分支。
 *
 * 阶段 6 集中搬移：本文件归 connection/runtime/（中间层池），仅保留
 * McpMiddleware 类；原汇聚转发块删除（v3 §二：汇聚只留 src/index.ts）。
 *
 * #767 S1-3a：ws_mcp_call 执行路径（callTool 与 hostRedact）已迁 servers/dispatch 域，
 * callTool 缩成转发壳——执行器经 runtimePorts 的 dispatch 端口取，单元/禁用表仍由本类持有，
 * 脱敏源由宿主经 MiddlewareHost.redactionServers 同步供给（#770-8，本类不拼全集）。
 *
 * #767 S1-4d：连接栈换成官方 @deepseek-ai/dsh-mcp-client。本类不再自建 transport / client，
 * 也不再自己排重连与防双进程探测——装载、拆卸与六态投影一律经 runtimePorts 的 lifecycle 端口
 * 交还 servers/lifecycle 的账本（官方 serverName 在应用根上活体预留，同 id 未释放就重挂当场抛）。
 * 目录改按 `ctx.tools.schemas()` 里 `mcp__<id>__` 前缀投影（裁定 W/K），执行路径改道
 * `ctx.tools.execute`（见 servers/dispatch）。
 *
 * W8 端口接线：跨域能力（catalog 新鲜判定与装箱、pipeline 投影/超时/取消息/脱敏/参数归一/
 * 策略裁决、workspace 全名解析与拼装、lifecycle 装载/拆卸/投影）一律经 `impl/service` 的
 * `runtimePorts.get()` 取；server/shared 的公名派生与同子层 limits 直取，跨端层 shared 的
 * MIDDLEWARE_GLOBAL_ROOT 经共享门面取，不占端口——端口只承载跨域能力。
 */

import type {
  ToolExecutionInput,
  ToolExecutionResult,
  ToolExecutionToken,
} from "@deepseek-ai/dsh-tools";
import type { ServerConfig } from "../../config/interface.ts";
import { DEFAULT_TOOL_CALL_TIMEOUT_MS, publicToolName } from "../../shared/interface.ts";
import { CATALOG_TTL_MS } from "./limits.ts";
import {
  MIDDLEWARE_GLOBAL_ROOT,
  SERVER_STATES,
  type ServerState,
} from "../../../shared/interface.ts";
import type { SchemaView } from "../../catalog/interface.ts";
import { runtimePorts } from "./impl/service/index.ts";
import type { MiddlewareHost } from "./deps.ts";
import type { ProjectUnit, ConnectionEntry } from "./impl/middleware/type.ts";
import type { DisabledToolsMap } from "../../store/interface.ts";

// ------------------------------------------------------------ 每 root 初始化任务登记（#1168）

/**
 * 每实例的「root 初始化任务」登记表（root → 在飞 init）。#1168 窗口 B：解「同根并发首次
 * 读各建一份单元（后写覆盖先写）/ 拿到未载入目录缓存的半初始化单元」。init 在读配置前同步
 * 占位，所有并发 `projectUnitFor` 共享同一次 init。
 *
 * 用模块级 WeakMap 而非类成员：类成员会进入 .d.ts 声明块（加字段即导出面/ABI diff）。
 * 按实例建键，不跨实例共享。`units` 保持 `Map<string, ProjectUnit>`（不存 Promise）。
 */
const pendingRootInits = new WeakMap<McpMiddleware, Map<string, InitTask>>();

/**
 * 一个 root 的在飞初始化任务句柄。
 * - `promise`：整段 init（读配置 → 建单元 → 载入目录缓存 → 登记 enabled 连接）的共享任务；
 *   **不等远端连接本身**（连接是 fire-and-forget）。
 * - `cancelled`：teardown/dispose 撤销；迟到的 init 收敛时据此自我作废，绝不把已拆单元写回
 *   `units`（防迟到复活）。
 */
interface InitTask {
  promise: Promise<ProjectUnit | undefined>;
  cancelled: boolean;
}

/** 取（或按实例惰性建）该中间层的 init 登记表。 */
function initRegistryFor(self: McpMiddleware): Map<string, InitTask> {
  const registry = pendingRootInits.get(self);
  if (registry === undefined) {
    const created = new Map<string, InitTask>();
    pendingRootInits.set(self, created);
    return created;
  }
  return registry;
}

/**
 * 撤销某 root 在飞的 init（teardownUnit / dispose 共用）：标记作废**并同步**把登记摘掉，
 * 于是「拆掉后紧接着重新 projectUnitFor」能立即开新一代 init，不必等旧代的配置/缓存
 * await 收敛；旧代迟到时靠 cancelled + `registry.get(root) === task` 身份守卫自我作废，
 * 既不会复活已拆单元，也不会误删新一代登记。
 */
function cancelPendingInit(self: McpMiddleware, root: string): void {
  const registry = pendingRootInits.get(self);
  if (registry === undefined) return;
  const task = registry.get(root);
  if (task === undefined) return;
  task.cancelled = true;
  // 身份守卫：只有仍指向本 task 才摘，避免与同 tick 内新登记的代际互相踩。
  if (registry.get(root) === task) registry.delete(root);
}

/**
 * 一次 root 初始化的真正工作：读配置 → 建单元 → 载入目录缓存 → 派发 enabled 连接的
 * in-flight 任务，然后 resolve 单元（**不等远端连接本身**）。
 *
 * 身份/取消守卫：每个 await 之后、发布进 `units` 之前都复核 `registry.get(root) === task`
 * 且 `!task.cancelled`——被 teardown/dispose 撤销或已被新一代取代的 init 一律返回 undefined，
 * 既不把已拆单元写回 `units`（防迟到复活），也不让旧代摘掉新代的登记。
 */
async function runRootInit(
  self: McpMiddleware,
  root: string,
  task: InitTask,
): Promise<ProjectUnit | undefined> {
  const registry = initRegistryFor(self);
  // 已被撤销（teardown/dispose 在本任务真正开跑前就摘了登记）→ 直接退出。
  if (!initOwned(registry, root, task)) return undefined;
  const servers = await self.host.projectServersFor(root);
  if (!initOwned(registry, root, task)) return undefined;
  // 无项目标记（root 不可用）→ 不建单元。
  if (servers === undefined) return undefined;
  const unit = buildProjectUnit(self, root);
  // 发布前最后一次守卫：配置读取期间的 teardown 会摘掉登记 → 不写表。
  if (!initOwned(registry, root, task)) return undefined;
  self.units.set(root, unit);
  await loadRootCatalog(self, root, unit, task, registry);
  // await 的续体是**新的微任务**：载入期间（或载入刚结束时）的 teardown 可能发生在 helper
  // 守卫之后、这次续体之前——故此处再复核一次归属与「仍是本代单元」，被撤销/换代的 init
  // 一律返回 undefined，既不派发连接也不把已拆单元当结果返回（防迟到复活）。
  if (!initOwned(registry, root, task) || self.units.get(root) !== unit) return undefined;
  // 后台惰性连接（fire-and-forget，不阻塞调用方）。单池（#767 笔 1a）后本层是唯一
  // 连接路径：单元内**全部** enabled 服务器都归本层，不再有所有权过滤器。
  // #903 M4：浮空拒绝即 unhandled——失败记 warn（错因已由 connectInternal 落
  // entry.error，日志只记名，不重复泄露凭据面）。ensureConnected 内的登记在**任何
  // await 之前**同步完成（#1168 窗口 A），故此处返回时 in-flight 标记已在册。
  launchBackgroundConnects(self, root, servers);
  unit.lastTouchedAt = Date.now();
  return unit;
}

/** init 归属守卫：未被 teardown/dispose 撤销，且登记未被新一代顶替。 */
function initOwned(registry: Map<string, InitTask>, root: string, task: InitTask): boolean {
  return !task.cancelled && registry.get(root) === task;
}

/** 建空白单元（并发 init 的产物，形状固定在此）。 */
function buildProjectUnit(self: McpMiddleware, root: string): ProjectUnit {
  return {
    root,
    connections: new Map(),
    userDisabled: new Set(self.disabledByRoot.get(root) ?? []),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
}

/**
 * 载入 last-good 目录缓存（空采集不写盘；目录与连接分开淘汰）。目录内存态自 #767 S1-3b
 * 起归 catalog 域，本层只负责「建单元时登记 root 并载入」。并发调用方等的是本 init 的
 * promise，故它们拿到的单元一定已完成目录载入（不再是半初始化对象）。
 *
 * 只负责「载入 + 失败清理」，取消/换代判定归调用方（await 续体那道微任务缝只有调用方能
 * 补上）。载入期间被撤销时，撤销方（teardownUnit / dispose）本身就会把已发布单元拆掉，
 * 故此处无需再拆。
 */
async function loadRootCatalog(
  self: McpMiddleware,
  root: string,
  unit: ProjectUnit,
  task: InitTask,
  registry: Map<string, InitTask>,
): Promise<void> {
  try {
    await runtimePorts
      .get()
      .catalog.catalogDirectory.ensureRootLoaded(root, self.host.catalogCachePath(root));
  } catch (error) {
    // 载入失败：单元已发布但目录半载入，绝不能留在表里当下次读取的权威——按双守卫
    // （仍是自己发布的这一代、且登记仍归本任务）拆掉后**重抛**：调用方见失败，且登记已由
    // awaitPendingInit 的 finally 清掉，下次 projectUnitFor 可重试。
    if (self.units.get(root) === unit && registry.get(root) === task) self.teardownUnit(root);
    throw error;
  }
}

/**
 * 派发全部 enabled 服务器的后台惰性连接（fire-and-forget，不阻塞调用方）。
 * ensureConnected 内的登记在**任何 await 之前**同步完成（#1168 窗口 A），故本函数
 * 返回时 in-flight 标记已在册。
 */
function launchBackgroundConnects(
  self: McpMiddleware,
  root: string,
  servers: ServerConfig[],
): void {
  for (const server of servers) {
    if (server.enabled === false) continue;
    void self.ensureConnected(root, server.name).catch(() => {
      self.host.logger.warn(
        `dsh-mcp-manager: background connect ${server.name}@${root} failed (see entry error)`,
      );
    });
  }
}

/**
 * 等一次 init 任务收敛并清理登记：成功/失败都把 `registry` 里这条（仅当仍指向本 task）
 * 摘掉，使失败不留下永久 pending、下次调用可重试；已被 teardown 取消时 init 返回
 * undefined（调用方视为「无单元」）。
 */
async function awaitPendingInit(
  self: McpMiddleware,
  root: string,
  task: InitTask,
): Promise<ProjectUnit | undefined> {
  const registry = initRegistryFor(self);
  try {
    return await task.promise;
  } finally {
    // 所有权校验：仅当登记仍指向本 task 才清理，避免误删新一代 init 的占位。
    if (registry.get(root) === task) registry.delete(root);
  }
}

// ------------------------------------------------------------ 连接池

/**
 * 就绪封装定义服务器：回答「注入的封装定义如何就绪？」——execute 为调用方 JS
 * 直呼，不经远端、不派官方实例，以虚拟连接（无 id/handle，status=connected）+
 * 目录投影存在；判定用 Array.isArray（空数组也算封装声明，不回退远端装载）。
 * 远端装载与结算在 mountRemoteServer 内（不同问题）。
 *
 * 模块函数而非私有方法：类成员会进入 .d.ts 声明块（导出面快照按块比对），
 * 纯内部分拆放模块级才能让导出面零 diff。
 * @returns 是封装定义（已处理）返回 true；否则 false（调用方走远端装载）。
 */
function connectWrappedServer(
  unit: ProjectUnit,
  root: string,
  serverName: string,
  server: ServerConfig,
  host: MiddlewareHost,
): boolean {
  // #413：封装定义服务器（runtime 注入 toolDefinitions）——
  // execute 为调用方 JS 直呼 CLI，不经远端 MCP，**不派官方实例**。
  // 中间层以「虚拟连接」（无 id/handle，status=connected）+ 目录从 toolDefinitions
  // 投影存在；执行走 callTool 的封装直呼分支。
  // 判定用 Array.isArray（空数组也算封装声明——调用方显式声明无工具，
  // 不应回退远端装载）。
  if (!Array.isArray(server.toolDefinitions)) return false;
  const existingWrapped = unit.connections.get(serverName);
  if (
    existingWrapped !== undefined &&
    (existingWrapped.status === "connected" || existingWrapped.status === "connecting")
  )
    return true;
  const wrappedEntry: ConnectionEntry = {
    server,
    id: undefined,
    handle: undefined,
    status: "connected",
    error: undefined,
    connectedAt: Date.now(),
    readySettled: true,
    everConnected: true,
    disposed: false,
  };
  unit.connections.set(serverName, wrappedEntry);
  runtimePorts.get().catalog.catalogDirectory.projectWrappedTools({
    root,
    serverName,
    definitions: server.toolDefinitions,
  });
  host.logger.info(`dsh-mcp-manager(${serverName}@${root}): wrapped (toolDefinitions) connected`);
  host.emitStatus();
  return true;
}

/** 远端装载的宿主能力面（调用点在类内现造闭包，私有读口不出类）。 */
interface MountRemoteFaces {
  host: MiddlewareHost;
  registeredSchemas(): SchemaView;
  registeredToolMeta(id: string): Map<string, { description?: unknown }>;
  redact(error: unknown): string;
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
function ownsMount(unit: ProjectUnit, name: string, entry: ConnectionEntry): boolean {
  return !entry.disposed && unit.connections.get(name) === entry;
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

async function mountRemoteServer(
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
  const current = unit.connections.get(serverName);
  if (current !== undefined && current !== entry) return;
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
      onMounted: (id) =>
        recordPendingMount(unit, serverName, newEntry, id, lifecycle.releaseServer),
      // 六态窗口内只推进状态：装上之后 id/handle 才回得来，这里不能碰代际守卫。
      onState: (next: ServerState) => {
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
}

/**
 * connected 结算的副作用：注册面 → 目录投影 + B 层摘要缓存 + info 日志。
 * 与 failed 分支同为「结算副作用」但成因与产出不同，故各自成函数。
 *
 * 模块函数而非私有方法：理由同 mountRemoteServer（导出面零 diff）。 */
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

/**
 * 非 force 时的状态短路：connected / connecting / reconnecting 都不再进（裁定 U）。
 * reconnecting 同样不进——官方自己在退避重连，我方重挂会撞同一 id 的 serverName
 * 活体预留（实测 §2.9-16）。force（用户显式「连接」/切回前台恢复）忽略当前状态
 * 总是受控重建——修半开死连接卡在 connected 后 connect/refresh 均短路失效（#412）。
 */
export function shortCircuitsOnState(state: ServerState | undefined, force: boolean): boolean {
  if (force) return false;
  return state === "connected" || state === "connecting" || state === "reconnecting";
}

/**
 * 重建前拆旧代际并**等**结算（裁定 V）：官方 serverName 是整个应用根的活体预留，
 * 同 id 未释放就重挂当场抛。虚拟单元（toolDefinitions）没有官方实例：不进账本也不置
 * 废弃位——它的重建语义由 wrapped 分支的同状态短路决定（#413 原语义）。
 */
export async function disposePreviousGeneration(
  entry: ConnectionEntry | undefined,
  disposeServer: (id: string) => unknown,
): Promise<void> {
  if (entry === undefined || Array.isArray(entry.server.toolDefinitions)) return;
  entry.disposed = true;
  const pending = entry.pendingMount;
  const id = entry.id ?? (pending?.released === true ? undefined : pending?.id);
  if (id !== undefined) {
    if (pending !== undefined) pending.released = true;
    await disposeServer(id);
  }
}

/** 可连接的服务器配置：缺省（未在册）或已启用=false 即 undefined。 */
export function connectableServer(
  servers: ServerConfig[] | undefined,
  serverName: string,
): ServerConfig | undefined {
  const server = servers?.find((candidate) => candidate.name === serverName);
  if (server === undefined || server.enabled === false) return undefined;
  return server;
}

/**
 * 虚拟连接单元（toolDefinitions，从不挂官方实例）的六态：
 * 禁用 → disabled；已拆 → stopped；其余 → connected（#413「虚拟连接即 connected」
 * 是既有契约）。进官方投影只会让「无 id / 无句柄」这些与它无关的输入面参与裁决。
 */
export function virtualUnitState(entry: ConnectionEntry, userDisabled: boolean): ServerState {
  if (entry.server.enabled === false || userDisabled) return SERVER_STATES.disabled;
  return entry.disposed ? SERVER_STATES.stopped : SERVER_STATES.connected;
}

/**
 * 中间层：工作空间 MCP 连接池 + 目录 + 路由执行。
 * 一个实例服务所有工作空间（projectUnits: Map<root, ProjectUnit>）。
 */
export class McpMiddleware {
  host: MiddlewareHost;
  /** root（realpath 归一化）→ 工作空间单元。 */
  units: Map<string, ProjectUnit>;
  /** 用户禁用映射（root → Set<server>），单元创建时合并。 */
  disabledByRoot: Map<string, Set<string>> = new Map();
  /** 工具级禁用（root → server → Set<tool>；root=@global 跨工作空间共享）。 */
  disabledTools: DisabledToolsMap = new Map();
  /**
   * 在飞的转发子调用登记表：我方 dispatch 经 `ctx.tools.execute` 派出去的子调用，其
   * `parent` 就是这次外层调用的 token，派发前登记、结算后注销（try/finally）。
   * pre-execute guard 只按发起者放行（裁定 R/Z）——集合外的一律走工具级裁决，
   * 模型直呼不会因为名字像就被放行。集合随实例消亡，热切换重建中间层即清空。
   */
  forwarding: Set<ToolExecutionToken> = new Set();

  constructor(host: MiddlewareHost) {
    this.host = host;
    this.units = new Map();
  }

  /** 读取/创建 root 的单元（root 无项目标记 → undefined）。
   *
   *  #1168 窗口 B（并发初始化去重）：先查在飞 init，再决定要不要建单元——同根的并发
   *  首次调用共享同一个 init 任务（同一代单元），不再各建一份（后写覆盖先写）。init 在
   *  **配置读取开始前**就同步占位（Promise.resolve().then 把真正工作推迟一拍，但登记
   *  在同一同步段完成），堵住「两个调用都越过 units.get 判空」的窗口。
   *
   *  init 何时 resolve：目录缓存（last-good）已载入、且 enabled 连接的 in-flight 任务已
   *  登记之后——不等远端连接本身（连接是 fire-and-forget）。于是并发首次读拿到的一定是
   *  已完成目录载入的完整单元，而不是半初始化对象。
   */
  async projectUnitFor(root: string | undefined): Promise<ProjectUnit | undefined> {
    if (root === undefined) return undefined;
    // 在飞 init 优先于 units 查询：同根并发首次读共享同一次 init（#1168 窗口 B）。
    const registry = initRegistryFor(this);
    const pending = registry.get(root);
    if (pending !== undefined) return awaitPendingInit(this, root, pending);
    // 无在飞 init 且已有成单元：直接触达。
    const existing = this.units.get(root);
    if (existing !== undefined) {
      existing.lastTouchedAt = Date.now();
      return existing;
    }
    // 同步占位后再排队真正的工作：登记与判空在同一同步段，杜绝并发各建一份。
    const task: InitTask = { promise: Promise.resolve(undefined), cancelled: false };
    task.promise = Promise.resolve().then(() => runRootInit(this, root, task));
    registry.set(root, task);
    return awaitPendingInit(this, root, task);
  }

  /** 连接一个服务器（in-flight 去重；失败后台重连）。
   * @param opts.force 用户显式连接（浮窗「连接」/切回前台恢复）时 true：忽略
   *  entry 当前状态（含半开卡在 connected 的死连接），总是受控重建；惰性/重试
   *  路径缺省 false，保持「已 connected 则短路」防重复建连。
   */
  async ensureConnected(
    root: string,
    serverName: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const unit = this.units.get(root);
    if (unit === undefined) return;
    if (unit.userDisabled.has(serverName)) return;
    // #1168 窗口 A：配置 await 早于登记 → 读工具采样时 inFlight 还空着，于是跳过发现等待
    // 就去列目录，冷启动首列 0 servers。登记覆盖「配置校验 + 连接 + 投影」整段任务。
    const existing = unit.inFlight.get(serverName);
    if (existing !== undefined) return existing as Promise<void>;
    // 推迟一拍再真调：让下面的 set 先落地，登记严格早于 connectInternal 执行体。闭包在
    // 真调前复核 attempt 所有权——登记与调用之间隔着一个微任务，teardown / 换代会在这之间
    // 发生，届时旧 attempt 不得挂到新一代单元上。
    const promise: Promise<void> = Promise.resolve().then(() => {
      if (this.units.get(root) !== unit || unit.inFlight.get(serverName) !== promise) return;
      return this.connectInternal(root, serverName, opts);
    });
    unit.inFlight.set(serverName, promise);
    try {
      await promise;
    } finally {
      // 所有权校验：仅当标记仍指向本次 attempt 才清除。强制拆除（abandonInFlight）
      // 后同名可能已挂上新 attempt——被废弃的旧 attempt 迟到收敛时不得误删新标记
      // （误删窗口内第三次 ensureConnected 会绕过去重）。
      if (unit.inFlight.get(serverName) === promise) unit.inFlight.delete(serverName);
    }
  }

  /** 废弃某服务器跨全部单元的在途建连标记。
   *  不变式：in-flight 去重只对「存活 entry 的重复建连」有意义——entry 被强制
   *  拆除（remove/update/disconnect）时，同名旧 attempt 可能仍 pending（装载等待窗口
   *  在预算内不返回），残留标记会把后续 ensureConnected（含 force 的用户显式「连接」）
   *  全部吞掉，且旧 attempt 收敛时命中让位/disposed 守卫静默返回、无人补连 → 这段时间内
   *  该服务器无法重连。拆除时必须同步废弃标记；旧 attempt 稍后收敛由 connectInternal
   *  的让位/disposed 守卫兜底，无副作用。 */
  abandonInFlight(serverName: string): void {
    for (const unit of this.units.values()) unit.inFlight.delete(serverName);
  }

  private async connectInternal(
    root: string,
    serverName: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    // 捕获本次 attempt 的身份（单元 + in-flight 登记）。每个 await 之后都复核：被 abandon /
    // teardown 换代、被同名新 attempt 顶替、或已被用户禁用的 attempt 一律静默退出，绝不在
    // 新一代单元上挂旧连接，也绝不越过禁用状态去挂（#1168 窗口 A 的身份守卫）。
    const unit = this.units.get(root);
    if (unit === undefined) return;
    // 本 attempt 的 in-flight 登记就是调用方挂的那一条（调用方先 set 再经微任务调进来）。
    const attempt = unit.inFlight.get(serverName);
    const stillCurrent = (): boolean =>
      this.units.get(root) === unit &&
      unit.inFlight.get(serverName) === attempt &&
      !unit.userDisabled.has(serverName);
    const force = opts.force === true;
    const { lifecycle } = runtimePorts.get();
    const entry = unit.connections.get(serverName);
    // 短路用**读时刷新后**的状态（statusOf，裁定 U）：非 force 时 connected/connecting 不进
    // （防重复建连）；reconnecting 同样不进——官方自己在退避重连，我方重挂会撞同一 id 的
    // serverName 活体预留（实测 §2.9-16）。force（用户显式「连接」/切回前台恢复）忽略当前
    // 状态总是受控重建——修半开死连接卡在 connected 后 connect/refresh 均短路失效（#412）。
    if (shortCircuitsOnState(this.statusOf(root, serverName), force)) return;
    // 配置校验先于 dispose（旧代际要拆，但若这台已不被启用/配置已消失就别白拆）。
    const servers = await this.host.projectServersFor(root);
    const server = connectableServer(servers, serverName);
    if (server === undefined || !stillCurrent()) return;
    // 让位校验后再拆旧代际并等结算（官方 serverName 是活体预留，同 id 未释放就重挂当场抛）。
    await disposePreviousGeneration(entry, (id) => lifecycle.disposeServer(id));
    if (!stillCurrent()) return;
    // 拆除窗口内宿主配置可能已变（删除 / enabled=false）——`server` 是拆除**前**读的旧配置，
    // 直接挂它会把已移除的服务器照旧挂上（QA P1）。故拆后复读一次配置，按最新配置裁决并挂载。
    const freshServers = await this.host.projectServersFor(root);
    const freshServer = connectableServer(freshServers, serverName);
    if (freshServer === undefined || !stillCurrent()) return;
    // 防双进程探测（#382 F5）与它的一次性重试已删除：换引擎后「同名服务器只能有一个实例」
    // 由官方 serverName 的活体预留保证（同 id 二次挂载当场抛，实测 §2.9-16），跨 root 同名
    // 各自由 (scope,name) 分配的 id 区分——探测与重试都是旧栈的补丁，留着只会与官方判重打架。
    if (connectWrappedServer(unit, root, serverName, freshServer, this.host)) return;
    await mountRemoteServer(unit, root, serverName, freshServer, entry, this.mountFaces());
  }

  /**
   * 装载面：注册面视图 / 工具元信息 / 脱敏都是本类方法的转发，形状与调用点无关——
   * 建连结算与 #1014 B7b 的重投影共用同一份，故抽成一处。
   */
  private mountFaces(): MountRemoteFaces {
    return {
      host: this.host,
      registeredSchemas: () => this.registeredSchemas(),
      registeredToolMeta: (id) => this.registeredToolMeta(id),
      redact: (error) => this.redact(error),
    };
  }

  /**
   * 重投影全部在册连接的目录（#1014 B7b）：tools/change 的失效消费口。
   *
   * 为什么按 server diff 而不是无脑全刷：宿主 tools/change **无载荷**（原话「故意不做作用域
   * 过滤」），且本包 visibility 的 restrict 自身也会发它——无条件全刷会把连接翻转期的
   * 事件密度直接转成落盘密度。故这里扫一遍注册面、按 `mcp__<id>__` 前缀与现有目录条目逐台
   * 比对，只对**确实变了**的 server 登记失效并重投影。
   *
   * 「变了」的判定是**内容指纹**（裸名 + description + inputSchema）相等性：目录条目丢过
   * unavailable 的一律视为变了（它已经不是可信快照，得靠一次成功投影重建）。
   *
   * 并发语义（复核后定为**不做在途合并**）：宿主 tools/change 无载荷、无序列化，且本包
   * visibility 的 restrict 自身也发它，一次变更至少两次并发进来。实测过「在途合并」——它
   * 挡不住本场景（首次调用在第一个 await 之前已同步写完目录，第二次是被内容比对挡下的），
   * 且引入了更坏的后果：在途期间内容再变时，第二次被静默跳过又无补偿事件，目录会**一直**
   * 停在旧内容直到下一次变化或 TTL 到期。丢更新比「两次落盘可能乱序」更难自愈，故不做合并。
   * 残留：两次并发投影的落盘可能乱序，磁盘 last-good 短暂落后于内存态；内存态是权威读面，
   * 且下一次投影会覆盖落盘，故按可自愈的已知残留登记，不另加状态面。
   */
  async reprojectCatalogs(): Promise<void> {
    const { catalog } = runtimePorts.get();
    const schemas = this.registeredSchemas();
    for (const [root, unit] of this.units) {
      for (const [serverName, entry] of unit.connections) {
        const id = entry.id;
        if (id === undefined || entry.disposed) continue;
        const current = catalog.catalogDirectory.entryFor(root, serverName);
        const live = liveSignature(schemas, id);
        if (
          !shouldReproject(
            current?.tools,
            current?.unavailable !== undefined,
            currentSignature(current),
            live,
          )
        ) {
          continue;
        }
        catalog.catalogDirectory.markDirty(root, serverName);
        await projectConnectedCatalog(root, serverName, id, this.mountFaces());
      }
    }
  }

  /**
   * 注册面读口：取不到/非数组一律当空——投影与六态投影都不许因为读不到注册表而阻塞。
   * 视图本身是宿主能力（入参契约），本层现取后按值递给 catalog 域的投影与读口。
   */
  private registeredSchemas(): SchemaView {
    const tools = this.host.ctx.tools;
    if (tools === undefined || typeof tools.schemas !== "function") return [];
    try {
      const schemas = tools.schemas();
      return Array.isArray(schemas) ? schemas : [];
    } catch {
      return [];
    }
  }

  /** 注册面 → 注册名→描述 表（B 层摘要缓存的数据源；与目录投影同一次前缀过滤口径）。 */
  private registeredToolMeta(id: string): Map<string, { description?: unknown }> {
    const prefix = `mcp__${id}__`;
    const meta = new Map<string, { description?: unknown }>();
    for (const schema of this.registeredSchemas()) {
      const name = schema?.name;
      if (typeof name !== "string" || !name.startsWith(prefix)) continue;
      meta.set(name, {
        description: typeof schema.description === "string" ? schema.description : "",
      });
    }
    return meta;
  }

  /** 凭据脱敏（连接/发现/调用错误路径统一使用；#770-8 经宿主全集快照，与 manager/dispatch 同源）。 */
  private redact(error: unknown): string {
    return runtimePorts.get().pipeline.createRedactor([...this.host.redactionServers()])(error);
  }

  /**
   * 读时刷新的六态投影（裁定 U）：域外读点（manager.summarize）与重建短路都从这里取状态，
   * 不再直接读 `entry.status`。为什么必须刷新：官方不暴露状态 API，而「曾连上、工具前缀消失」
   * 只在读的这一刻才可判——不重算，GUI 会永远停在陈旧的 connected（设计 §3.1/§3.3）。
   */
  statusOf(root: string, serverName: string): ServerState | undefined {
    const unit = this.units.get(root);
    const entry = unit?.connections.get(serverName);
    if (unit === undefined || entry === undefined) return undefined;
    if (Array.isArray(entry.server.toolDefinitions)) {
      const state = virtualUnitState(entry, unit.userDisabled.has(serverName));
      entry.status = state;
      return state;
    }
    const { lifecycle } = runtimePorts.get();
    const state = lifecycle.projectServerState(entry.id ?? "", {
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
      hasTools: (id) =>
        runtimePorts
          .get()
          .catalog.catalogDirectory.hasRegisteredTools(this.registeredSchemas(), id),
    });
    entry.status = state;
    return state;
  }

  /**
   * health 顶层 `tools` 计数的聚合读口（#767 笔 1a）：该 (root, server) 目录投影里的
   * 工具条数。与 `summary().tools` / 目录读口同源（裸名条数即注册名条数）。
   */
  toolCountOf(root: string, serverName: string): number {
    return runtimePorts.get().catalog.catalogDirectory.entryFor(root, serverName)?.tools.size ?? 0;
  }

  /**
   * 执行 ws_mcp_call。本片（#767 S1-3a）起只是转发壳：路由校验、策略裁决、两条执行分支与
   * 结果投影在 servers/dispatch 域（impl/call 的 executeMcpCall），中间层仍持有单元表、
   * 策略与**转发登记表**，经显式入参按引用递入——不落第二份事实源。脱敏源不由本类持有，
   * 经宿主 redactionServers 快照转供（#770-8，与 manager.redactError 同一秘密源）。
   *
   * @param identity 调用方身份（`ToolRunContext` 里 dispatch 真正需要的字段）。为什么不是
   *   单个 agent：转发改道后 dispatch 要合成子调用 id 并透传 parent（裁定 R/Y/Z），而
   *   `parent` 同时是「这次调用出自我方转发」的标识——guard 只放行同时登记过的发起者。
   */
  async callTool(
    fullName: string,
    toolRaw: string,
    rawArgs: unknown,
    signal: AbortSignal | undefined,
    identity: {
      agent?: unknown;
      callId: ToolExecutionInput["callId"];
      rootCallId?: ToolExecutionInput["rootCallId"];
      parent?: ToolExecutionToken;
    },
  ): Promise<unknown> {
    const { dispatch, pipeline, workspace, catalog: catalogPort } = runtimePorts.get();
    // 目录条目读口按本次调用的 root 闭包：dispatch 只读「这次全名指向的那个 root」的条目。
    const catalogRoot = workspace.parseFullServerName(fullName)?.root;
    // 公名派生只在这里发生一次：唯一派生点是 server/shared/tool-names.ts 的 publicToolName，dispatch 拿名字用、
    // 不得自己拼 `mcp__<id>__<tool>`——哈希/截断规则一旦分叉，某些工具会永远查不到。
    const registeredNameFor = (id: string, tool: string): string => publicToolName(id, tool);
    // 必须箭头绑定：注册表方法裸引用会丢 this（dispatch 直接把它当能力调用）。
    const execute = (input: ToolExecutionInput): Promise<ToolExecutionResult> =>
      this.host.ctx.tools.execute(input);
    const parent = identity.parent;
    if (parent !== undefined) this.forwarding.add(parent);
    try {
      return await dispatch.executeMcpCall({
        fullName,
        toolRaw,
        rawArgs,
        signal,
        agent: identity.agent,
        callId: identity.callId,
        ...(identity.rootCallId === undefined ? {} : { rootCallId: identity.rootCallId }),
        ...(parent === undefined ? {} : { parent }),
        forwarding: this.forwarding,
        registeredNameFor,
        execute,
        units: this.units,
        // 目录条目读口：本层持 catalog 域读口，dispatch 不引该域门面（免多一条跨模块边）。
        catalogEntryFor: (serverName) =>
          catalogRoot === undefined
            ? undefined
            : catalogPort.catalogDirectory.entryFor(catalogRoot, serverName),
        allServers: () => this.host.redactionServers(),
        disabledTools: this.disabledTools,
        catalogTtlMs: CATALOG_TTL_MS,
        defaultCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
        pipeline,
        workspace,
      });
    } finally {
      // finally 是硬要求（RECON 反例 1）：漏了这一步，残留 token 就是一处永久放行位。
      if (parent !== undefined) this.forwarding.delete(parent);
    }
  }

  /**
   * 拆掉一个 (root, server) 的连接（裁定 X）：换引擎后**账本化拆除的唯一落点**，
   * disconnect / remove / update / unregister / evict / 插件卸载共用。
   *
   * 只**发起** release、不等结算（裁定 V）：拆除是同步语义，而官方 dispose 会等在途首连
   * （挂死的服务器能等到 SDK 的 60s）；要等结算的重建路径走 connectInternal 的 disposeServer。
   *
   * @returns 是否真的拆掉了在册条目（调用方据此决定要不要广播状态）。
   */
  releaseConnection(root: string, serverName: string): boolean {
    const unit = this.units.get(root);
    const entry = unit?.connections.get(serverName);
    if (unit === undefined || entry === undefined) return false;
    entry.disposed = true;
    const id = entry.id ?? entry.pendingMount?.id;
    if (id !== undefined) {
      if (entry.pendingMount !== undefined) entry.pendingMount.released = true;
      runtimePorts.get().lifecycle.releaseServer(id);
    }
    unit.connections.delete(serverName);
    return true;
  }

  /** LRU 淘汰：无活动引用（lastTouchedAt 最旧）且超过上限时淘汰最旧单元。
   * @global 单元豁免（#382 F3）：全局服务器常连语义不随多项目切换被淘汰
   * （supervisor 时代全局永不淘汰，池接管后需显式豁免保持等价语义）。 */
  evictIfNeeded(maxUnits = 16): void {
    while (this.units.size > maxUnits) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [root, unit] of this.units) {
        if (root === MIDDLEWARE_GLOBAL_ROOT) continue;
        if (unit.lastTouchedAt < oldestAt) {
          oldestAt = unit.lastTouchedAt;
          oldestKey = root;
        }
      }
      if (oldestKey === undefined) break;
      this.teardownUnit(oldestKey);
    }
  }

  /** 拆毁一个单元（逐条走账本拆除，保留目录缓存）。 */
  teardownUnit(root: string): void {
    // 撤销在飞 init（在查 units 之前）：init 可能尚未发布单元，teardown 必须能取消它，
    // 否则它稍后收敛会把单元写回 `units`（迟到复活），或让下次 projectUnitFor 等旧代。
    cancelPendingInit(this, root);
    const unit = this.units.get(root);
    if (unit === undefined) return;
    for (const serverName of [...unit.connections.keys()]) {
      this.releaseConnection(root, serverName);
    }
    unit.connections.clear();
    // 目录内存态与单元同生共死（#767 S1-3b）：不 drop 会让已淘汰 root 的目录留在域内，
    // 下次同 root 建单元时 ensureRootLoaded 的「已在册」短路遂把内存态当权威、不再读盘。
    runtimePorts.get().catalog.catalogDirectory.dropRoot(root);
    this.units.delete(root);
  }

  /** 全部拆毁（插件卸载）。保持同步体：组合根的卸载链依赖这里同步摘账。 */
  async dispose(): Promise<void> {
    for (const root of [...this.units.keys()]) this.teardownUnit(root);
    // 未发布单元的在飞 init 不在 units 键里，逐个摘登记防迟到复活/挂起。
    const registry = pendingRootInits.get(this);
    if (registry !== undefined) {
      for (const root of [...registry.keys()]) cancelPendingInit(this, root);
    }
    this.units.clear();
  }
}
/**
 * 该 id 前缀下当前注册面的**指纹**：工具裸名 + description + inputSchema。
 *
 * 为什么不能只比裸名（#1014 复核 P0-1）：远端 tools/list_changed 最常见的形态就是**只改
 * description 或 inputSchema**、工具名集合不动。只比名字会让目录继续发旧描述与旧参数 schema，
 * 模型照着旧参数调用——而 #1014 §2 的目标正是「模型可能看到或调用已删除的 schema」。
 * 指纹逐项拼接后整体比较，避免逐字段比较带来的分支爆炸。
 */
function liveSignature(schemas: SchemaView, id: string): string {
  const prefix = `mcp__${id}__`;
  const parts: string[] = [];
  for (const schema of schemas) {
    const name = schema?.name;
    if (typeof name !== "string" || !name.startsWith(prefix)) continue;
    const description = typeof schema.description === "string" ? schema.description : "";
    const parameters = JSON.stringify(schema.parameters ?? {});
    parts.push(`${name.slice(prefix.length)}\u0000${description}\u0000${parameters}`);
  }
  parts.sort();
  return parts.join("\u0001");
}

/**
 * 该不该为这台重投影：目录条目不存在、丢过 unavailable（已不是可信快照）、或**指纹**与
 * 注册面不一致，三者任一即需要。
 *
 * 形参收字符串而不是目录条目类型——收条目就得多一条 runtime → catalog 的类型边
 *（verify-dir-imports 的 crossModuleRefs 基线会 +1）。
 */
function shouldReproject(
  currentTools: ReadonlyMap<string, unknown> | undefined,
  hasUnavailable: boolean,
  currentSignature: string,
  liveSignatureText: string,
): boolean {
  if (currentTools === undefined || hasUnavailable) return true;
  return currentSignature !== liveSignatureText;
}

/**
 * 目录条目当前内容的指纹（与 liveSignature 同口径：裸名 + description + inputSchema）。
 * 目录侧存的是剥掉前缀后的裸名与已装箱的 inputSchema，按同样形状拼即可逐字比较。
 */
function currentSignature(entry: { tools: ReadonlyMap<string, unknown> } | undefined): string {
  if (entry === undefined) return "";
  const parts: string[] = [];
  for (const [name, tool] of entry.tools) {
    const value = tool as { description?: unknown; inputSchema?: unknown };
    const description = typeof value.description === "string" ? value.description : "";
    parts.push(`${name}\u0000${description}\u0000${JSON.stringify(value.inputSchema ?? {})}`);
  }
  parts.sort();
  return parts.join("\u0001");
}
