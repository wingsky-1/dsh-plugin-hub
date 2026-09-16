/**
 * dsh-mcp-manager — MCP 服务器管理器（单一事实源）。
 *
 * McpManager 持有全局存储 + 当前会话项目的项目级存储、每个服务器的监督器
 * 与状态通知。全局服务器常连；项目级服务器（<项目根>/.dsh/mcp.json）只在
 * 当前会话 cwd 属于该项目时连接（跟随会话切换）。
 *
 * 类型自 types 域门面取；manager.ts 不 import apply.ts / index.ts（防循环引用）。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SseHub } from "../../../../../../shared/sse-hub.js";
import type { Context, LoggerService } from "@deepseek-ai/cordis";
import type { ServerConfig } from "../../config/interface.ts";
import type { ClientUiConfig } from "../../../shared/interface.ts";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { CatalogCache, CatalogViewResolver, SchemaView } from "../../catalog/interface.ts";
import type { McpStore } from "../../store/interface.ts";
import type { McpStatsCollector } from "../../stats/interface.ts";
import type { McpMiddleware } from "../runtime/interface.ts";
import type { MiddlewareMode } from "../../workspace/interface.ts";
import type { ProjectUnit } from "../interface.ts";
import type { DisabledToolsMap } from "../../store/interface.ts";
import type { MountedPlugin } from "../../shared/interface.ts";
import {
  EMPTY_STATUS_COUNTS,
  MIDDLEWARE_GLOBAL_ROOT,
  SCOPE_GLOBAL,
  SCOPE_PROJECT,
  SERVER_STATES,
  type ServerState,
} from "../../../shared/interface.ts";
import { stripMcpPrefix } from "./tool-names.ts";
import { orchestratorPorts } from "./impl/service/index.ts";

/**
 * 直连账本条目（裁定 AF 形态 B）：manager 自持的「一个 (scope, name) 的官方实例」全部我方痕迹。
 *
 * 形状与旧 `ConnectionSupervisor` 的**外部可读面**守恒（裁定 C）：`status` / `tools` /
 * `server` / `scope` 四个键被 /health 的 JSON 键集、`RoutesManager.supervisors`、
 * `SupervisorLite` 与 `shared/service.ts` 的 getTools 契约读到，改名或改形会连锁到
 * 跨端契约与客户端；因此是「换内部实现」，不是「换外部形状」。
 *
 * id / handle / readySettled / everConnected 四个字段是官方引擎接手后新增的输入面：官方不暴露
 * 任何状态 API，六态只能由「我方动作 + 账本句柄 + 注册面前缀」投影（见 servers/lifecycle 的
 * projectServerState）。
 *
 * 刻意不 export：它是子层内部数据结构，出现在 `McpManager.supervisors` 的类型里即可（tsc 会把
 * 非导出接口写进 manager.d.ts，导出面快照因此只含 McpManager 块的类型名，不新增符号）。
 */
interface DirectEntry {
  /** 归一化后的服务器配置（reconcile 的 desired 比对与 mountServer 入参）。 */
  server: ServerConfig;
  /** 服务器归属（global/project）；GUI 与能力目录用。 */
  scope: string;
  /** 装载作用域 root（项目根绝对路径或 @global）：账本键与 id 的分配作用域。 */
  root: string;
  /** 官方实例的 serverName（装载返回后写回）；也是 `mcp__<id>__` 前缀源。 */
  id?: string;
  /** 官方实例句柄（六态投影的 disposed 输入面，与 McpMiddleware 的 entry.handle 同义）。 */
  handle?: MountedPlugin;
  /** 六态；窗口内的推进由 mountServer 的 onState 写入，读点经 refreshEntryState 重算。 */
  status: ServerState;
  /** 我方文案（官方首连失败的具体 cause 拿不到，见 lifecycle/impl/state 头注释）。 */
  error?: unknown;
  /** 注册名（`mcp__<id>__<tool>`）列表；与旧 supervisor.tools 同口径（升序）。 */
  tools: string[];
  /** 注册名 → 描述（`ctx.mcpManager.getTools` 的公共 ABI 数据源，返注册名）。 */
  toolMeta: Map<string, { description?: unknown }>;
  /** 我方已发起挂载：同步判据，与旧 supervisor 的「client 已建」等价（防窗口内重复 mount 撞账本键）。 */
  mountStarted: boolean;
  /** 等待窗口已结算（成功与失败都算）。 */
  readySettled: boolean;
  /** 该代际曾进入 connected（区分首连失败与连上过又掉线）。 */
  everConnected: boolean;
  /** 我方已发起拆除（晚到结算据此丢弃）。 */
  disposed: boolean;
  /** 进入 connected 的时刻（重连判定用）。 */
  connectedAt?: number;
}

/**
 * 管理器：持有全局存储 + 当前会话项目的项目级存储、每个服务器的监督器
 * 与状态通知。全局服务器常连；项目级服务器（<项目根>/.dsh/mcp.json）只在
 * 当前会话 cwd 属于该项目时连接（跟随会话切换）。
 */
export class McpManager {
  ctx: Context;
  store: McpStore;
  /**
   * 直连账本：服务器名 → 条目（官方实例的生命周期由 servers/lifecycle 的账本持有，本表只记
   * 「我方对该 (scope, name) 做了什么」）。Map 名与值的外部可读形状保持不变（裁定 C）。
   */
  supervisors: Map<string, DirectEntry>;
  listeners: Set<() => void>;
  logger: LoggerService;
  projectRoot: string | undefined;
  projectStore: McpStore | undefined;
  reconcileBusy: boolean;
  projectStores: Map<string, McpStore>;
  catalogCache: CatalogCache;
  catalogCachePath: string;
  uiConfigSource: () => any;
  /** 设置命名空间写入 sink（apply 时经 ctx.inject(["settings"]) 注入；注入不到则写不可用）。 */
  uiUpdate?: (patch: Record<string, unknown>) => Promise<unknown>;
  /**
   * SSE 连接枢纽（共享 shared/sse-hub，#515）：makeEventsRoute 惰性创建；
   * 广播/卸载 disposer 收口到 hub（连接表 + 心跳 + stalled/maxAge 主动回收）。
   * 取代旧 sseConnections Set + per-connection 心跳（#268）。
   */
  sseHub?: SseHub;
  /** 中间层模式（Config.middleware 归一化）。 */
  middlewareMode: MiddlewareMode;
  /** 中间层实例（连接池 + 目录 + 路由；惰性创建）。 */
  middleware: McpMiddleware | undefined;
  /** userDisabled 持久化路径。 */
  userStatePath: string;
  /** MCP 调用统计收集器（可用于 debug 模式量化调用指标与渐进式披露漏斗）。 */
  stats: McpStatsCollector;
  /** 运行时注册表（内存态，不落盘）：供其他插件经 ctx.mcpManager 注入服务器。
   * 双轨 reconcile：store.data.servers（持久化）+ runtimeRegistry（运行时）。
   * 同名冲突策略：runtime 优先（运行时注入是「当前会话」语义）。 */
  runtimeRegistry: Map<string, ServerConfig>;
  /** registerServer 串行队列（防 reconcileBusy 吞注册；多插件并发注册排队）。 */
  private registerQueue: Promise<void>;
  /** 注入端目录缓存视图解析器（catalog/impl/cache-view/index.ts 工厂闭包；含 mtime 缓存）。 */
  private catalogViewResolver: CatalogViewResolver;

  constructor(ctx: Context, store: McpStore) {
    const { catalog, configStore, stats } = orchestratorPorts.get();
    this.ctx = ctx;
    this.store = store;
    this.supervisors = new Map();
    this.listeners = new Set();
    this.logger = ctx.logger;
    this.projectRoot = undefined;
    this.projectStore = undefined;
    // 配置重读 → 连接同步的防重入标志（读取路径可并发调用）。
    this.reconcileBusy = false;
    // 项目级 store 缓存（root → McpStore）：按工作区缓存配置，切换会话不销毁，
    // 目录数据源（agent/pre-step）按会话 cwd 从缓存读取，与实时连接状态解耦。
    this.projectStores = new Map();
    // 目录缓存：serverName → { summary }（磁盘持久化，digest 的稳定数据源）。
    this.catalogCache = new Map();
    this.catalogCachePath = catalog.catalogCacheFile();
    // 目录视图解析器：host 面用读取器（middleware/模式热切换后取最新引用）。
    this.catalogViewResolver = catalog.makeCatalogViewFor({
      getCatalogCache: () => this.catalogCache,
      getMiddleware: () => this.middleware,
      getMiddlewareMode: () => this.middlewareMode,
      catalogCachePathFor: (root) => this.catalogCachePathFor(root),
    });
    this.uiConfigSource = () => ({ position: "top-right", offsetX: 8, offsetY: 8, blankY: 40 });
    this.middlewareMode = "off";
    this.middleware = undefined;
    this.userStatePath = configStore.userStateFile();
    this.stats = new stats.McpStatsCollector({ logger: ctx.logger });
    this.runtimeRegistry = new Map();
    this.registerQueue = Promise.resolve();
  }

  /** 读取 settings 命名空间中的 MCP UI 配置（供 /api/dsh-mcp/config 返回）。 */
  uiConfig(): ClientUiConfig {
    return orchestratorPorts.get().configModel.normalizeUiConfig(this.uiConfigSource());
  }

  /**
   * 写入浮窗 UI 配置（/api/dsh-mcp/config POST）。
   * 把客户端扁平形态归一化为 `Config.ui` 嵌套补丁，经设置命名空间持久化
   * （settings.update 落盘 → scope.watch → onChange → SSE 广播一帧），随后返回
   * 归一化后的最新配置。settings 服务不可用时抛错（写不可用）。
   */
  async updateUiConfig(raw: unknown): Promise<ClientUiConfig> {
    if (typeof this.uiUpdate !== "function") {
      throw new Error("ui config is not writable: settings service unavailable");
    }
    await this.uiUpdate({ ui: orchestratorPorts.get().configModel.buildConfigUiPatch(raw) });
    return this.uiConfig();
  }

  /** 从磁盘加载目录缓存（损坏/缺失 → 空缓存，不崩溃）。 */
  async loadCatalogCache(): Promise<void> {
    try {
      if (!existsSync(this.catalogCachePath)) return;
      const raw = await readFile(this.catalogCachePath, "utf8");
      const parsed = JSON.parse(raw) as { entries?: Record<string, unknown> } | null;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.entries === "object" &&
        parsed.entries !== null
      ) {
        for (const [name, entry] of Object.entries(parsed.entries)) {
          if (typeof (entry as { summary?: unknown } | undefined)?.summary === "string") {
            this.catalogCache.set(name, { summary: (entry as { summary: string }).summary });
          }
        }
      }
    } catch {
      // 损坏缓存忽略（保持空，下次连接重建）
    }
  }

  /**
   * 连接成功后记录工具描述摘要到目录缓存（**只在摘要实质变化时落盘**——
   * 保证重连拿到相同描述不触发 digest 变化、不重复注入）。
   * 缓存是持久数据（磁盘），与实时连接状态解耦：断开/重连不清空 → 目录稳定。
   */
  async recordCatalogTools(
    serverName: string,
    toolMeta: Map<string, { description?: unknown }>,
  ): Promise<void> {
    const summary = orchestratorPorts.get().catalog.summarizeToolDescriptions(toolMeta);
    const current = this.catalogCache.get(serverName)?.summary;
    if (summary === undefined || summary === current) return;
    this.catalogCache.set(serverName, { summary });
    try {
      const dir = dirname(this.catalogCachePath);
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      const tmp = `${this.catalogCachePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
      const payload = { version: 1, entries: Object.fromEntries(this.catalogCache) };
      await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
      await rename(tmp, this.catalogCachePath);
    } catch (error) {
      this.logger.warn(`dsh-mcp-manager: catalog cache write failed: ${this.redactError(error)}`);
    }
  }

  // ------------------------------------------------------------ 直连账本（裁定 AF 形态 B）

  /**
   * 注册面读口：取不到 / 非数组一律当空——六态投影与工具面投影都不许因为读不到注册表而阻塞
   * （与 McpMiddleware.registeredSchemas 同口径）。
   */
  private registeredSchemas(): SchemaView {
    const tools = this.ctx?.tools;
    if (tools === undefined || typeof tools.schemas !== "function") return [];
    try {
      const schemas = tools.schemas();
      return Array.isArray(schemas) ? schemas : [];
    } catch {
      return [];
    }
  }

  /** 账本键的作用域 root：项目级取当前项目根，其余取全局虚拟 root（与中间层单元同口径）。 */
  private ledgerRootFor(scope: string): string {
    return scope === SCOPE_PROJECT
      ? (this.projectRoot ?? MIDDLEWARE_GLOBAL_ROOT)
      : MIDDLEWARE_GLOBAL_ROOT;
  }

  /**
   * 建条目（同步登记 + 置「已发起挂载」位）：装载由 mountEntry 另行发起。
   *
   * mountStarted 在**同一个同步段**内置位，因此 `start` 的重复调用判据、`connect` 的短路判据
   * 与六态投影的输入面三者看到的都是同一个事实（旧栈里那是 supervisor 的 `client` 引用）。
   */
  private createEntry(server: ServerConfig, scope: string): DirectEntry {
    return {
      server,
      scope,
      root: this.ledgerRootFor(scope),
      id: undefined,
      handle: undefined,
      status: server.enabled === false ? SERVER_STATES.disabled : SERVER_STATES.stopped,
      error: undefined,
      tools: [],
      toolMeta: new Map(),
      mountStarted: true,
      readySettled: false,
      everConnected: false,
      disposed: false,
      connectedAt: undefined,
    };
  }

  /**
   * 摘账并**发起**拆除（只发起不等结算，裁定 V/X 的拆除语义）：显式置废弃位先于任何 await，
   * 使在途装载窗口的晚到结算走「已不在册 → 发起释放」的代际守卫分支，官方 serverName 预留
   * 因此不会泄漏。
   */
  private dropEntry(entry: DirectEntry): void {
    entry.disposed = true;
    if (entry.id !== undefined) orchestratorPorts.get().lifecycle.releaseServer(entry.id);
  }

  /** 注册面 → 条目的工具面投影（id 前缀剥离后的注册名列表与描述元数据）。 */
  private refreshEntryTools(entry: DirectEntry): void {
    const prefix = `mcp__${entry.id ?? ""}__`;
    const tools: string[] = [];
    const toolMeta = new Map<string, { description?: unknown }>();
    for (const schema of this.registeredSchemas()) {
      const name = schema?.name;
      if (typeof name !== "string" || !name.startsWith(prefix)) continue;
      tools.push(name);
      toolMeta.set(name, {
        description: typeof schema.description === "string" ? schema.description : "",
      });
    }
    entry.tools = tools.sort();
    entry.toolMeta = toolMeta;
  }

  /**
   * 读时刷新的六态投影（裁定 U，与 McpMiddleware.statusOf 同形）：官方不暴露状态 API，而
   * 「曾连上、注册面前缀消失」这类事实只有重算才看得见——不刷新，GUI 会永远停在陈旧的
   * connected。投影结果就地写回条目，供 /health 这类不经 summarize 的读点取用。
   */
  private refreshEntryState(entry: DirectEntry): ServerState {
    const { lifecycle } = orchestratorPorts.get();
    const state = lifecycle.projectServerState(entry.id ?? "", {
      enabled: entry.server.enabled !== false,
      // 直连账本不落 userDisabled：off/project 的全局直连断开与旧 supervisor 路径同口径，不写盘。
      userDisabled: false,
      tornDown: entry.disposed,
      disposed: entry.handle?.disposed === true,
      // 我方已发起挂载（createEntry 与置位在同一同步段内完成，读点看不到中间的假 stopped）。
      mountStarted: entry.mountStarted,
      readySettled: entry.readySettled,
      windowExpired: entry.status === SERVER_STATES.failed && !entry.readySettled,
      everConnected: entry.everConnected,
      reconnectEnabled: entry.server.reconnect?.enabled !== false,
      hasTools: (id) => this.hasRegisteredTools(id),
    });
    entry.status = state;
    return state;
  }

  /** 注册面里该 id 前缀下是否已有工具（「已连上」的唯一正向证据）。 */
  private hasRegisteredTools(id: string): boolean {
    const prefix = `mcp__${id}__`;
    return this.registeredSchemas().some(
      (schema) => typeof schema?.name === "string" && schema.name.startsWith(prefix),
    );
  }

  /**
   * 发起一次直连装载（异步结算在 Promise 内，调用方一律 void）。
   *
   * 三处刻意不做：不裁决配置语义（mountServer 有意不判 enabled，归调用方）、窗口失败不 dispose
   * （连接失败的实例保留给官方后台重连）、不吞装载期异常之外的东西（解析失败 / 账本撞键落
   * failed 条目 + warn，等人重试）。
   *
   * 装载前先把**中间层池里同名同 root 的条目**放掉：模式热切换（all→project/off）时池条目
   * 与直连条目共用同一个 id，池那侧不先摘账，官方账本会因同一 serverName 当场抛（裁定 AF 的
   * 「反向同理」）。稳态下池里没有该条目，此行是 no-op。
   */
  private async mountEntry(entry: DirectEntry): Promise<void> {
    const { lifecycle } = orchestratorPorts.get();
    try {
      if (entry.server.enabled === false) {
        // 配置面禁用不发起装载（mountServer 刻意不裁决 enabled），态由 projectServerState 投影。
        entry.readySettled = true;
        this.emitStatus();
        return;
      }
      this.middleware?.releaseConnection(entry.root, entry.server.name);
      const mounted = await lifecycle.mountServer({
        root: entry.root,
        server: entry.server,
        // 窗口内只推进状态：id / 句柄要等装载返回，这里不能碰代际守卫。
        onState: (next: ServerState) => {
          if (entry.disposed) return;
          entry.status = next;
          this.emitStatus();
        },
      });
      entry.id = mounted.id;
      entry.handle = mounted.entry.handle;
      entry.readySettled = true;
      // 代际守卫（拆除期竞态）：拆除动作到达后这一代已不在册，但实例已经挂上——必须发起释放，
      // 否则官方实例与它占着的 serverName 预留会永久泄漏（与中间层 connectInternal 同形）。
      if (entry.disposed || this.supervisors.get(entry.server.name) !== entry) {
        lifecycle.releaseServer(mounted.id);
        return;
      }
      if (mounted.outcome.kind === "settled") {
        entry.status = mounted.outcome.state;
        entry.error = mounted.outcome.error;
        if (mounted.outcome.state === SERVER_STATES.connected) {
          entry.everConnected = true;
          entry.connectedAt = Date.now();
          this.refreshEntryTools(entry);
          // 目录摘要 B 层投影（裁定 AG②）：远端 supervisor 路径的 recordCatalogTools 随本片
          // 改派消失，不补这一口，全局服务器的工具描述摘要就不再入缓存、模型面 digest 变化。
          await this.recordCatalogTools(entry.server.name, entry.toolMeta);
        }
        this.emitStatus();
      }
    } catch (error) {
      // 装载期异常（loader 解析失败 / 账本撞键 / lifecycle 域未装配）：实例没挂上，只能落 failed
      // 等人重试。这里必须吞：装载是 fire-and-forget 发起的，上抛会变成未处理拒绝。
      entry.status = SERVER_STATES.failed;
      entry.error = error;
      entry.readySettled = true;
      this.logger.warn(
        `dsh-mcp-manager: mount "${entry.server.name}" failed: ${this.redactError(error)}`,
      );
      this.emitStatus();
    }
  }

  /**
   * 重建一个已装载条目（start 的直传 config 替换分支 / connect 的受控重建）。
   *
   * 顺序不变式（裁定 V）：**先 await disposeServer(旧 id) 再 mount**——官方 serverName 是整个
   * 应用根的活体预留，旧实例未结算就挂同 id 新实例会被官方账本当场抛。拆除路径（disconnect /
   * remove / update / stop）反过来只发起不等结算。
   */
  private async remountEntry(
    name: string,
    existing: DirectEntry,
    server: ServerConfig,
    scope: string,
  ): Promise<void> {
    const { lifecycle } = orchestratorPorts.get();
    existing.disposed = true;
    // 新代际先登记（与旧栈「同步 set 新实例」同语义）：重建窗口内并发到来的 reconcile / start
    // 看到的是新条目而不是空档，不会对同一个 id 二次发起装载。
    const entry = this.createEntry(server, scope);
    this.supervisors.set(name, entry);
    if (existing.id !== undefined) {
      try {
        await lifecycle.disposeServer(existing.id);
      } catch (error) {
        // 旧代际释放失败不阻断新代际：官方的预留由它自己的回收链兜底，抛出去只会让重连整条断。
        this.logger.warn(
          `dsh-mcp-manager: dispose old generation of "${name}" failed: ${this.redactError(error)}`,
        );
      }
    }
    await this.mountEntry(entry);
  }

  /**
   * 注册名中段 → (root, 裸名) 反查（id 化的 mcp__ 注册名还原成禁用表键）。
   *
   * 为什么由 manager 提供：id 是装载期由官方实例的 serverName 定下的（裁定 AG① 明确 id 不进
   * 注入面），只有自持账本的一侧知道 (id → root, 裸名)。注入端在装配点把这个能力**按入参**递进
   * guard（与既有 resolveRoot 同一形态），因此不新增跨域值边、也不动任何端口键。
   */
  serverNameForId(id: string): { root: string; server: string } | undefined {
    for (const [name, entry] of this.supervisors) {
      if (entry.id === id) return { root: entry.root, server: name };
    }
    return undefined;
  }

  onStatus(handler: () => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** B8：错误日志脱敏（配置全集 + runtime 注入并集经 createRedactor）。
   * 日志与 HTTP body 同口径（C-ERR 契约），error 可能含凭据明文。 */
  private redactError(error: unknown): string {
    const servers: ServerConfig[] = [...this.store.data.servers];
    for (const server of this.runtimeRegistry.values()) servers.push(server);
    return orchestratorPorts.get().pipeline.createRedactor(servers)(error);
  }

  /** coalesce 定时器（同一 tick 内多次状态变化合并为一次广播）。 */
  private statusTimer: NodeJS.Timeout | undefined;

  /** 状态变化广播（coalesce：同 tick 多次 emitStatus 只广播一次，防 SSE 风暴）。 */
  emitStatus(): void {
    if (this.statusTimer !== undefined) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      for (const handler of [...this.listeners]) handler();
    }, 0);
    this.statusTimer.unref?.();
  }

  /** 当前会话的项目级存储（无活动项目时抛错）。 */
  async projectStoreOrThrow(): Promise<McpStore> {
    if (this.projectStore === undefined) {
      throw new Error("no active project session (call session with a cwd first)");
    }
    return this.projectStore;
  }

  /**
   * 中间层宿主：按 root 读取服务器配置。all 模式的虚拟 root "@global" 返回
   * 全局配置 **+ runtime 注入条目**（#413：runtime 封装定义服务器由中间层接管，
   * 数据源必须可见；独立合并，不污染 store.data.servers 持久化数组）。
   */
  async projectServersFor(root: string): Promise<ServerConfig[] | undefined> {
    if (root === MIDDLEWARE_GLOBAL_ROOT) {
      const servers = [...this.store.data.servers];
      for (const server of this.runtimeRegistry.values()) servers.push(server);
      return servers;
    }
    const store = await this.projectStoreFor(root);
    return store?.data.servers;
  }

  /** 中间层宿主：该 server 是否 runtime 注入（目录不写盘判定；#413）。 */
  isRuntimeServer(name: string): boolean {
    return this.runtimeRegistry.has(name);
  }

  /** 中间层宿主：该 server 是否全局级（双源：store + runtimeRegistry）。
   * runtime 注册的服务器不落 store，单源会误判「非全局」——P1 修正。 */
  isGlobalServer(name: string): boolean {
    return (
      this.store.data.servers.some((server) => server.name === name) ||
      this.runtimeRegistry.has(name)
    );
  }

  /** 中间层宿主：全局服务器配置（all 模式使用）。 */
  globalServers(): ServerConfig[] {
    return this.store.data.servers;
  }

  /** 中间层宿主：持久化 userDisabled。 */
  async saveUserState(units: Map<string, ProjectUnit>): Promise<void> {
    await orchestratorPorts.get().configStore.saveUserState(this.userStatePath, units);
  }

  /** 中间层宿主：root 的目录缓存文件路径。 */
  catalogCachePathFor(root: string): string {
    return orchestratorPorts.get().configStore.catalogCacheFileFor(root);
  }

  /** 初始化中间层（apply 时按模式调用；幂等）。 */
  async initMiddleware(
    mode: MiddlewareMode,
    policy: Record<string, unknown>,
  ): Promise<McpMiddleware> {
    const { runtime, configStore, workspace } = orchestratorPorts.get();
    this.middlewareMode = mode;
    if (this.middleware !== undefined) return this.middleware;
    const mw = new runtime.McpMiddleware(
      {
        ctx: this.ctx,
        logger: this.logger,
        projectServersFor: (root) => this.projectServersFor(root),
        globalServers: () => this.globalServers(),
        normalizedProjectRoot: (cwd) => workspace.normalizedProjectRoot(cwd),
        saveUserState: (units) => this.saveUserState(units),
        emitStatus: () => this.emitStatus(),
        catalogCachePath: (root) => this.catalogCachePathFor(root),
        isGlobalServer: (name) => this.isGlobalServer(name),
        isRuntimeServer: (name) => this.isRuntimeServer(name),
        middlewareOwnsServer: (root, name) => this.middlewareOwnsServer(root, name),
      },
      {
        allowTools: (policy.allowTools as Record<string, string[]> | undefined) ?? undefined,
        denyTools: (policy.denyTools as Record<string, string[]> | undefined) ?? undefined,
      },
    );
    try {
      // 加载 userDisabled 并注入中间层实例（单元创建时合并；重启不丢）。
      this.disabledByRoot = await configStore.loadUserState(this.userStatePath);
      mw.disabledByRoot = this.disabledByRoot;
      // 加载工具级禁用（三层结构；合并式写盘，绝不整表覆盖）。
      this.disabledTools = await configStore.loadDisabledTools(this.userStatePath);
      mw.disabledTools = this.disabledTools;
    } catch (error) {
      // #392 遗留⑤：加载失败时清理半初始化状态——this.middleware 保持未赋值
      // （不会被后续逻辑当已初始化实例使用），middlewareMode 回退 off 防误用。
      this.disabledByRoot = new Map();
      this.disabledTools = new Map();
      this.middlewareMode = "off";
      throw error;
    }
    this.middleware = mw;
    return mw;
  }

  /** userDisabled 映射（root → Set<server>），中间层单元创建时合并。 */
  disabledByRoot: Map<string, Set<string>> = new Map();

  /** 工具级禁用（root → server → Set<tool>）；root=@global 跨工作空间共享。 */
  disabledTools: DisabledToolsMap = new Map();

  /** 中间层模式热切换（apply 注入；设置页「中间层模式」下拉调用）。 */
  setMiddlewareMode?: (mode: MiddlewareMode) => Promise<void>;

  /**
   * 设置/解除单个工具禁用（宿主 API PATCH /api/dsh-mcp/tool-disable 调用）。
   * 合并式写盘（先读现有文件再覆盖本 root 段，绝不整表覆盖）——
   * 防多工作空间互相抹掉禁用记录。
   * @param root 目标 root（全局服务器用 MIDDLEWARE_GLOBAL_ROOT）。
   * @param server 服务器裸名。
   * @param tool 远端工具裸名。
   * @param disabled true=禁用 / false=解除。
   * 工具级禁用独立于服务器级 enabled：服务器级复活不清工具级状态。
   */
  async setToolDisabled(
    root: string,
    server: string,
    tool: string,
    disabled: boolean,
  ): Promise<void> {
    const { configStore } = orchestratorPorts.get();
    const tools = this.disabledTools.get(root) ?? new Map<string, Set<string>>();
    const set = tools.get(server) ?? new Set<string>();
    if (disabled) set.add(tool);
    else set.delete(tool);
    if (set.size > 0) tools.set(server, set);
    else tools.delete(server);
    if (tools.size > 0) this.disabledTools.set(root, tools);
    else this.disabledTools.delete(root);
    await configStore.saveDisabledTools(this.userStatePath, this.disabledTools);
    this.emitStatus();
  }

  /** 读取/复用某项目根的 store（工作区缓存命中直接返回，不重复读盘）。 */
  async projectStoreFor(root: string | undefined): Promise<McpStore | undefined> {
    if (typeof root !== "string" || root === "") return undefined;
    const { configStore } = orchestratorPorts.get();
    let store = this.projectStores.get(root);
    if (store === undefined) {
      store = new configStore.McpStore(join(root, ".dsh", "mcp.json"));
      await store.load();
      this.projectStores.set(root, store);
    } else {
      // 缓存命中也要检查磁盘：项目 mcp.json 在 git 仓库内，pull/checkout/手动
      // 编辑后应自动生效，不依赖重启宿主（只重读配置，不启停连接）。
      try {
        await store.reloadIfChanged();
      } catch (error) {
        this.logger.warn(
          `dsh-mcp-manager: reload project config failed: ${this.redactError(error)}`,
        );
      }
    }
    return store;
  }

  /**
   * 会话目录数据源：全局服务器 + 该 cwd 所属项目的项目级服务器（**配置层面**，
   * 与 host 当前 setSession 状态解耦）。此前直接用 manager.supervisors（实时
   * 连接状态、跟随"当前工作区"）——切换工作区会断开/连接项目级服务器，导致
   * 别的会话的目录集合抖动、每次抖动注入一条目录更新消息。按 cwd 计算后：
   * 工作区 MCP 没变化 → digest 不变 → 不重新注入。
   *
   * 运行时注入（registerServer 的 runtimeRegistry，内存态）同样并入目录数据源
   * （#359）：插件经运行时注入注册的服务器，连接成功、工具可用，
   * 但此前不在目录里——模型看不到能力，只能自己翻 CLI。同名 runtime 优先
   * （与 reconcile 双轨一致）。
   */
  async catalogServersFor(
    cwd: string | undefined,
  ): Promise<Map<string, { server: ServerConfig; scope: string }>> {
    const servers = new Map<string, { server: ServerConfig; scope: string }>();
    for (const server of this.store.data.servers) {
      if (server.enabled === false) continue;
      servers.set(server.name, { server, scope: SCOPE_GLOBAL });
    }
    // 运行时注入（registerServer 内存态）：并入目录数据源，同名 runtime 优先。
    for (const [name, server] of this.runtimeRegistry) {
      if (server.enabled === false) continue;
      servers.set(name, { server, scope: SCOPE_GLOBAL });
    }
    const { workspace } = orchestratorPorts.get();
    const root =
      cwd === undefined || cwd === null || cwd === ""
        ? undefined
        : await workspace.findProjectRoot(cwd);
    const store = root === undefined ? undefined : await this.projectStoreFor(root);
    if (store !== undefined) {
      for (const server of store.data.servers) {
        if (server.enabled === false) continue;
        // 同名项目级服务器被全局顶掉（与 supervisor 的同名冲突策略一致）。
        if (!servers.has(server.name)) servers.set(server.name, { server, scope: SCOPE_PROJECT });
      }
    }
    return servers;
  }

  /**
   * 合成注入端目录缓存视图（#569 修复核心）：实现在 catalog/impl/cache-view/index.ts
   * （makeCatalogViewFor 工厂闭包，含磁盘 last-good mtime 缓存），本方法为
   * 薄桥接（C-DIR：catalogViewFor 迁出 catalog 域，宿主最小面）。
   * @param cwd 会话 cwd（与 catalogServersFor 同源解析项目 root）。
   * @param servers catalogServersFor 的输出（name → { server, scope }）。
   * @returns CatalogCache 形态视图（name → { summary }），可直接喂 composeCatalogEntries。
   */
  async catalogViewFor(
    cwd: string | undefined,
    servers: Map<string, { server: ServerConfig; scope: string }>,
  ): Promise<CatalogCache> {
    return this.catalogViewResolver(cwd, servers);
  }

  /**
   * 会话切换：只切 currentRoot + fire-and-forget 惰性启动（不 await 任何连接）。
   * 变更点驱动（#111/#228）：POST /api/dsh-mcp/session 永不挂起——连接/发现
   * 由中间层惰性驱动（per-root in-flight 去重），此处零连接副作用。
   * 兼容语义：middleware=off（旧行为）时切走仍断开旧项目 supervisor；
   * middleware=project/all 时项目级连接由中间层池常驻，切走不断开。
   */
  async setSession(cwd: string | undefined): Promise<void> {
    const { workspace } = orchestratorPorts.get();
    const root =
      cwd === undefined || cwd === null || cwd === ""
        ? undefined
        : await workspace.findProjectRoot(cwd);
    if (root === this.projectRoot && this.projectStore !== undefined) return;
    // 本就没有活动项目且新会话同样无项目（空 cwd）：保持幂等，避免反复
    // emitStatus → SSE → 客户端 refresh 的广播循环。
    if (root === undefined && this.projectStore === undefined) return;
    // off 模式（旧行为）：切走时断开旧项目 supervisor（不 await，避免挂起）。
    if (this.middlewareMode === "off") {
      for (const [name, entry] of [...this.supervisors]) {
        if (entry.scope === SCOPE_PROJECT) this.stop(name);
      }
    }
    // 只切 currentRoot；项目级 supervisor 在中间层模式下由中间层接管。
    this.projectRoot = root;
    this.projectStore = undefined;
    if (root !== undefined) {
      this.projectStore = await this.projectStoreFor(root);
    }
    // 全局配置同样重读（外部手动编辑 ~/.dsh/dsh-mcp.json）。
    try {
      await this.store.reloadIfChanged();
    } catch (error) {
      this.logger.warn(`dsh-mcp-manager: reload global config failed: ${this.redactError(error)}`);
    }
    if (this.middlewareMode !== "off" && this.middleware !== undefined) {
      // 中间层：仅触达单元（fire-and-forget 惰性连接在 projectUnitFor 内）。
      // all 模式：无项目 cwd 也触达全局虚拟 root @global。
      const target =
        root !== undefined
          ? root
          : this.middlewareMode === "all"
            ? MIDDLEWARE_GLOBAL_ROOT
            : undefined;
      if (target !== undefined) {
        void this.middleware.projectUnitFor(target).then((unit) => {
          if (unit !== undefined) this.middleware?.evictIfNeeded();
        });
      }
    } else {
      // 非中间层模式：异步 reconcile（不 await，避免挂起）。
      this.reconcileServers();
    }
    this.emitStatus();
  }

  /**
   * 切回前台恢复：对当前工作空间连接的受控重建（对齐 SSE forceReconnect，#412）。
   * 移动端切后台会静默掐断 TCP（半开，双方收不到 FIN/RST → transport onClose 不触发），
   * 连接池 entry 可能卡在 connected 而实际已死；此入口忽略当前状态 force 重建
   * 当前工作空间单元（当前项目 root；all 模式无项目时回退 @global）内所有非
   * userDisabled 连接。force 重建健康连接一次代价低（本地 stdio / http 重连毫秒级），
   * 与 SSE 每次切回前台 forceReconnect 的语义对称。调用方：POST /api/dsh-mcp/resume
   *（客户端 visibilitychange 回前台触发）。
   *
   * 目标集合从「单元已有 entry」扩为「配置中全部 enabled 服务器」（#412 复报）：
   * - 宿主 dsh web 重启/状态丢失后 units 清空、entry 全失——只按 connections.keys()
   *   重建拿不到任何目标；先 projectUnitFor 确保单元创建（其内部惰性连接全部
   *   enabled 服务器是兜底），再对配置全集 force 重建（覆盖半开卡 connected、
   *   entry 缺失、从未连接过的服务器）。
   * - 仍尊重 userDisabled（用户断开的不复活）与 all 模式 @global 回退。
   */
  async resumeReconnect(): Promise<void> {
    const mw = this.middleware;
    if (mw === undefined || this.middlewareMode === "off") return;
    const root =
      this.projectRoot ?? (this.middlewareMode === "all" ? MIDDLEWARE_GLOBAL_ROOT : undefined);
    if (root === undefined) return;
    // 单元缺失（宿主重启/状态丢失）先创建：projectUnitFor 负责惰性连接兜底。
    const unit = mw.units.get(root) ?? (await mw.projectUnitFor(root));
    if (unit === undefined) return;
    // 目标 = 配置全集（本项目/全局的全部 enabled 服务器），而非仅已有 entry。
    const servers = await this.projectServersFor(root);
    const targets = (servers ?? [])
      .filter(
        (server: ServerConfig) => server.enabled !== false && !unit.userDisabled.has(server.name),
      )
      .map((server: ServerConfig) => server.name);
    await Promise.all(
      targets.map((name) =>
        mw.ensureConnected(root, name, { force: true }).catch(() => {
          // ensureConnected 内部已捕获连接失败并落 failed + 退避重连；这里只兜底
          // 防未处理 reject，单个服务器恢复失败不阻断其余。
        }),
      ),
    );
  }

  /**
   * 重读磁盘配置（全局 + 当前项目）并同步连接集合。
   * 供「浮窗刷新」等读取路径调用：外部修改 mcp.json 后无需重启宿主。
   * 仅在配置或连接集合实际变化时广播，避免空转 SSE → 客户端 refresh 循环。
   * 变更点驱动（#111）：读取路径不再调用本方法（GET /servers 纯读）；本方法
   * 仅由 fs.watch 变更点与用户操作 API 调用。
   *
   * #616 修复：两次 reloadIfChanged 均为 false（配置未变）时直接早退、不再
   * reconcile——全局 watcher 监听的是整个 `~/.dsh` 目录，插件自身的
   * user-state 写盘（saveUserState/saveDisabledTools，浮窗连接/断开必写）会
   * 触发 watcher 事件；此前无配置变化也走 reconcileServers，是「用户操作
   * 全局服务器 → 项目级单元被误拆」链路的放大器（根因见 start 内注释）。
   */
  async refreshFromDisk(): Promise<void> {
    let configChanged = false;
    try {
      configChanged = (await this.store.reloadIfChanged()) || configChanged;
    } catch (error) {
      this.logger.warn(`dsh-mcp-manager: reload global config failed: ${this.redactError(error)}`);
    }
    if (this.projectStore !== undefined) {
      try {
        configChanged = (await this.projectStore.reloadIfChanged()) || configChanged;
      } catch (error) {
        this.logger.warn(
          `dsh-mcp-manager: reload project config failed: ${this.redactError(error)}`,
        );
      }
    }
    if (!configChanged) return;
    const changed = this.reconcileServers();
    if (changed) this.emitStatus();
  }

  /**
   * 按当前配置同步 supervisor：配置中移除/禁用的断开，新增/恢复的启动。
   * 同步方法（start/stop 均为同步登记 + 异步连接）；防重入（读取路径可并发）。
   * @returns {boolean} 是否有连接集合变化
   */
  reconcileServers(): boolean {
    if (this.reconcileBusy) return false;
    this.reconcileBusy = true;
    try {
      const desired = new Map();
      for (const server of this.store.data.servers) {
        desired.set(server.name, { server, scope: SCOPE_GLOBAL });
      }
      if (this.projectStore !== undefined) {
        for (const server of this.projectStore.data.servers) {
          // 同名项目级被全局顶掉（与 start 的跨 scope 冲突策略一致）。
          if (!desired.has(server.name)) desired.set(server.name, { server, scope: SCOPE_PROJECT });
        }
      }
      // 双轨合并：runtimeRegistry（内存态，运行时注入）并入 desired，同名 runtime 优先。
      // 中间层模式：#413 起 all 模式 runtime 归一中台（同 store 全局走 @global 单元），
      // project 模式 runtime 仍全局 supervisor 路径。
      for (const [name, server] of this.runtimeRegistry) {
        desired.set(name, { server, scope: SCOPE_GLOBAL });
      }
      let changed = false;
      for (const [name, entry] of [...this.supervisors]) {
        const want = desired.get(name);
        // 中间层接管（与 start 同口径单一事实源 middlewareTakes）：停掉不该以
        // 直连账本形态存在的连接（#413：all 模式 runtime 亦被接管，同样停）。
        // 热切换（all→project/off）的「先释放账本再交给另一侧」正落在这里：stop 先摘账，
        // 下方 start 才可能把同一个 id 交给中间层（裁定 AF）。
        const middlewareOwned = this.middlewareOwns(entry.server, entry.scope);
        if (
          want === undefined ||
          want.server.enabled === false ||
          want.scope !== entry.scope ||
          middlewareOwned
        ) {
          this.stop(name);
          changed = true;
        }
      }
      for (const [name, want] of desired) {
        if (want.server.enabled === false) continue;
        // project 模式项目级：由中间层单元管理（ensureMiddlewareServer 幂等触达，#616），
        // 不经 start；all 模式全局照常 start——start 内部下沉接管（触达 @global）。
        if (this.middlewareMode === "project" && want.scope === SCOPE_PROJECT) continue;
        const existing = this.supervisors.get(name);
        if (existing === undefined || existing.scope !== want.scope) {
          this.start(name, want.scope);
          // 中间层持有的条目（all 模式全局、封装定义条目）不建直连条目——池连接变化由
          // connectInternal emitStatus 上报，不计入直连账本的集合变化。
          if (!this.middlewareOwns(want.server, want.scope)) changed = true;
        }
      }
      return changed;
    } finally {
      this.reconcileBusy = false;
    }
  }

  async startAll(): Promise<void> {
    for (const server of this.store.data.servers) {
      if (server.enabled !== false) this.start(server.name, SCOPE_GLOBAL);
    }
  }

  /**
   * 启动服务器监督器。
   * @param name 服务器名
   * @param scope 作用域（全局/项目）
   * @param directConfig 运行时 config 直传（registerServer 注入路径；缺省读 store）。
   *   修 P0（评审③）：同名 runtime 优先生效——store 已有同名时，直传 config 优先于 store 版本。
   */
  start(name: string, scope: string = SCOPE_GLOBAL, directConfig?: ServerConfig): void {
    let server = directConfig;
    if (server === undefined) {
      const store = scope === SCOPE_PROJECT ? this.projectStore : this.store;
      if (store === undefined) return;
      server = store.find(name);
      // F2（#382）：runtime 注入条目不落 store——global scope 查不到时回退
      // runtimeRegistry（双轨合并，与 summary/catalogServersFor 同口径），修
      // 修 runtime 注册服务器「浮窗重连断开后连不回」。仅限 global：
      // project 回退会把 runtime 条目挂错 scope，被下次 reconcile 无声停掉。
      if (server === undefined && scope === SCOPE_GLOBAL) {
        const runtime = this.runtimeRegistry.get(name);
        if (runtime !== undefined) {
          this.logger.warn(
            `dsh-mcp-manager: server "${name}" not in store; using runtime registry entry`,
          );
          server = runtime;
        }
      }
    }
    if (server === undefined) return;
    // F3（#382）：中间层接管判定下沉到 start（与 reconcileServers 同口径，见
    // middlewareTakes）。all 模式全局非 runtime 不建直连条目——杜绝「先建条目
    // 再被 reconcile 停掉」的竞态窗口（热更新后 mcp__ 注册残留 →
    // 中间层防双进程探测命中且无重试 → 掉线），改触达 @global 单元惰性连接；
    // 中间层模式项目级不建直连条目，走 ensureMiddlewareServer 幂等触达。
    // startAll / add / update / reconcile 各入口自动收敛，无需逐处特判。
    //
    // #616 根因修复：项目级分支此前是 touchMiddlewareUnit()（teardownUnit 拆毁
    // 整个当前项目单元）。reconcileServers 对项目级条目（supervisors 恒无）每次
    // 都会走到 start——浮窗连接/断开任意服务器（saveUserState 写 ~/.dsh → 全局
    // fs.watch → refreshFromDisk → reconcile）就会把当前项目单元连人带连接整个
    // 拆掉，且拆后无任何 projectUnitFor 触达，项目级全部显示/实际断开，直到
    // 切换工作目录（setSession → projectUnitFor）才重建。改为与 touchGlobalUnit
    // 对称的幂等触达（确保单元存在 + 确保该服务器连接），reconcile 不再有拆毁
    // 副作用。
    // 封装定义条目恒交中间层（裁决 (c)'）：虚拟连接 + 目录投影，模型经 ws_mcp_call
    // （@<root>/<server>）触达——它没有 mcp__ 宿主注册，直呼面在目标态也不存在。
    if (this.middlewareOwns(server, scope)) {
      if (this.middleware === undefined) {
        // 目标态里中间层实例恒在（apply 无条件建）；实例缺失时**不退化成官方装载**——
        // 封装条目的 execute 是调用方 JS，派官方实例等于为一份不存在的远端起子进程。
        this.logger.warn(
          `dsh-mcp-manager: 中间层未就绪，服务器 "${name}" 的连接未建立（封装定义条目只经中间层虚拟连接）`,
        );
        return;
      }
      if (scope === SCOPE_PROJECT) this.ensureMiddlewareServer(name);
      else this.touchGlobalUnit(name);
      return;
    }
    const existing = this.supervisors.get(name);
    if (existing !== undefined && existing.mountStarted) {
      // 已发起装载（同步判据，与旧 supervisor 的 client 已建等价）：若现有 config 与直传
      // config 不同（runtime 注入覆盖 store），受控重建。
      if (directConfig !== undefined && existing.server !== directConfig) {
        // B5/D2：替换分支复用拆除语义（释放旧代际 + 注销旧工具），而非只置 disposed——
        // 旧代际残留泄漏官方实例/子进程与工具注册。start 保持同步：重建的 await 链在
        // void 里跑，旧代际释放先于新代际挂载（裁定 V 的顺序不变式，由 remountEntry 保证）。
        void this.remountEntry(name, existing, directConfig, scope);
      }
      return;
    }
    if (existing !== undefined && existing.scope !== scope) {
      // 同名服务器跨 scope 冲突：工具名会重复，拒绝启动
      this.logger.warn(
        `dsh-mcp-manager: server "${name}" already registered in scope "${existing.scope}" — skipping "${scope}"`,
      );
      return;
    }
    // B5：未发起装载的旧条目同样走拆除语义（摘账 + 发起释放 + 注销残留工具）。
    if (existing !== undefined) this.dropEntry(existing);
    const entry = this.createEntry(server, scope);
    this.supervisors.set(name, entry);
    void this.mountEntry(entry);
  }

  /** 封装定义条目（toolDefinitions）：它的 execute 是调用方 JS，连接由中间层虚拟连接承载。 */
  private isWrapped(server: ServerConfig | undefined): boolean {
    return Array.isArray(server?.toolDefinitions);
  }

  /**
   * 该条目的连接是否归中间层持有 = 模式判定 `middlewareTakes` **或**封装定义条目。
   *
   * 为什么封装条目与模式无关（#767 S1-5b 主控裁决 (c)'）：最终形态里没有 `off`/`project`，也
   * 不再有 `mcp__*` 直呼面——封装定义的触达面只能是 `ws_mcp_call`（`@<root>/<server>`）。所以
   * 它**恒**交中间层虚拟连接，与当前模式无关；正常 transport 条目的模式语义一字未动。
   */
  private middlewareOwns(server: ServerConfig | undefined, scope: string): boolean {
    if (server === undefined) return false;
    return this.middlewareTakes(server.name, scope) || this.isWrapped(server);
  }

  /**
   * 宿主面：该 (root, server) 的连接是否归本层持有（中间层建单元时按它收窄惰性连接范围）。
   *
   * 为什么不复用 `middlewareTakes`：中间层拿不到配置（它只有 root + name），而 root 反推
   * scope 后还要回答「这台是不是封装条目」——配置只在本层有，所以判定留在这里、按入参递进去。
   */
  middlewareOwnsServer(root: string, name: string): boolean {
    const scope = root === MIDDLEWARE_GLOBAL_ROOT ? SCOPE_GLOBAL : SCOPE_PROJECT;
    const server =
      scope === SCOPE_GLOBAL
        ? (this.store.find(name) ?? this.runtimeRegistry.get(name))
        : this.projectStores.get(root)?.find(name);
    return this.middlewareOwns(server, scope);
  }

  /**
   * 中间层接管判定（start / reconcileServers 的模式口径）：中间层模式的项目级，
   * 或 all 模式的全局级（**含 runtime 注入条目**，#413 消除豁免——all 模式
   * 统一无 mcp__ 前缀直呼，runtime 封装定义服务器经中间层目录投影 + callTool
   * 直呼执行；project / off 模式 runtime 照旧注册 mcp__ 工具，改派后由直连账本装载）。
   */
  private middlewareTakes(name: string, scope: string): boolean {
    if (this.middlewareMode === "off" || this.middleware === undefined) return false;
    if (scope === SCOPE_PROJECT) return true;
    return this.middlewareMode === "all" && scope === SCOPE_GLOBAL;
  }

  /**
   * 触达 @global 单元并确保该全局服务器连接（all 模式 start 接管路径）。
   * projectUnitFor 首次触达会连带惰性连接全部全局服务器，等价 startAll 语义；
   * userDisabled 命中不连（与浮窗断开语义一致）。
   */
  private touchGlobalUnit(name: string): void {
    const mw = this.middleware;
    if (mw === undefined) return;
    void mw
      .projectUnitFor(MIDDLEWARE_GLOBAL_ROOT)
      .then((unit) => {
        if (unit === undefined || unit.userDisabled.has(name)) return;
        void mw.ensureConnected(MIDDLEWARE_GLOBAL_ROOT, name);
      })
      .catch((error: unknown) => {
        // #392 遗留⑥：不再静默吞错——projectUnitFor 失败时打 warn 日志，
        // 否则该服务器永不连接且无迹可查（ensureConnected 调用面仍会尝试）。
        this.logger.warn(
          `dsh-mcp-manager: touchGlobalUnit(${name}) failed: ${this.redactError(error)}`,
        );
      });
  }

  /**
   * 幂等触达当前项目单元并确保该服务器连接（#616：start 的中间层项目级接管路径，
   * 取代旧 touchMiddlewareUnit 的整单元拆毁语义）。
   * - 单元缺失（宿主重启 / 首次 reconcile）：projectUnitFor 创建 + 惰性连接全部；
   * - 单元已存在（配置热重载 / 误触发的 reconcile）：保留既有连接，仅对**该**服务器
   *   ensureConnected（connected/connecting 短路，幂等）；
   * - entry 已存在但 store 配置已变（手工编辑 mcp.json 热重载）：force 单台重建——
   *   旧实现的配置生效来自整单元拆毁的副作用，此处改为精确到单台，不殃及同单元
   *   其他连接。
   * userDisabled 命中不连（与浮窗断开语义一致）；无活动项目 root 静默返回
   * （与旧 touchMiddlewareUnit 同口径）。
   */
  private ensureMiddlewareServer(name: string): void {
    const mw = this.middleware;
    if (mw === undefined || this.projectRoot === undefined) return;
    // 入口捕获 root（评审 P2-3）：.then 回调内不再读 this.projectRoot——
    // setSession 切换后实例字段已变，沿用调用时快照保证 root 与 unit 配套。
    const root = this.projectRoot;
    void mw
      .projectUnitFor(root)
      .then(async (unit) => {
        if (unit === undefined || unit.userDisabled.has(name)) return;
        const current = this.projectStore?.find(name);
        const entry = unit.connections.get(name);
        // 配置一致性比对（同源 store 实例）：未重载时 entry.server 与 current
        // 为同一对象引用恒等；真变更必经 reloadIfChanged → load() 整组换新
        // 对象（键序由 normalizeServer 固定），内容不同则串必不同——假阴性
        // 不存在；唯一假阳性是用户手排 mcp.json 键序（值不变）触发一次性
        // force 重连，重建后自愈、不循环。
        if (
          entry !== undefined &&
          current !== undefined &&
          JSON.stringify(entry.server) !== JSON.stringify(current)
        ) {
          await mw.ensureConnected(root, name, { force: true });
          return;
        }
        await mw.ensureConnected(root, name);
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `dsh-mcp-manager: ensureMiddlewareServer(${name}) failed: ${this.redactError(error)}`,
        );
      });
  }

  /**
   * 拆除中间层池中该 server 的连接（update/remove 配置变更后强制重建；
   * 不写 userDisabled——与 disconnect 的禁用语义区分）。此前 update/remove 仅
   * 处理项目单元，all 模式全局池连接与目录残留导致「已删服务器仍可调用」。
   */
  private dropMiddlewareConnection(name: string): void {
    const mw = this.middleware;
    if (mw === undefined) return;
    let dropped = false;
    for (const unit of mw.units.values()) {
      // 拆除落点统一走账本（裁定 X）：只发起 release、不等结算——拆除路径是同步语义。
      if (mw.releaseConnection(unit.root, name)) dropped = true;
      // #392 遗留①：目录条目随连接一并拆除——remove/update 后已删服务器不再以
      // 幽灵条目出现在 ws_mcp_list / ws_mcp_search（此前只拆连接，目录 TTL 内残留）。
      // 内存目录先行删除；磁盘 last-good 缓存异步同步（防重启后 loadCatalogCache
      // 把幽灵条目载回——persistCatalog 空采集不写盘，remove 后目录可能为空，必须
      // 显式清盘而非依赖全量覆盖写）。
      const { catalogDirectory } = orchestratorPorts.get().catalog;
      if (catalogDirectory.entryFor(unit.root, name) !== undefined) {
        // 内存目录先行删除（原语义：`unit.catalog.delete(name)` 为真才同步清盘）；磁盘
        // last-good 缓存异步同步，路径由本层算好按入参递入（目录域不推路径）。
        void catalogDirectory
          .removeRootEntry(unit.root, name, {
            cachePath: this.catalogCachePathFor(unit.root),
            warn: (message) => this.logger.warn(message),
          })
          .catch(() => {});
        catalogDirectory.dropServer(unit.root, name);
        dropped = true;
      }
    }
    // 拆除即废弃同名在途建连标记：entry 被强拆后旧 attempt 仍可能 pending 至
    // CONNECT_TIMEOUT_MS，残留去重标记会吞掉 remove/update 后的同名重连（含
    // 重加配置立即重建）——详见 middleware.abandonInFlight 不变式。
    mw.abandonInFlight(name);
    if (dropped) this.emitStatus();
  }

  /** 停掉一个直连条目：摘账 + 发起释放（拆除是同步语义，不等结算——裁定 V/X）。 */
  stop(name: string): void {
    const entry = this.supervisors.get(name);
    if (entry === undefined) return;
    this.supervisors.delete(name);
    this.dropEntry(entry);
  }

  /**
   * 运行时注册服务器（内存态，不落盘）。
   * 供其他插件经 ctx.mcpManager 注入（官方 storageDomain service 模式）。
   * - 同名已存在（store 或 runtime）：返回 { name, existing: true }，不抛错；
   * - 注册即连接（走 start 的 config 直传分支，同名 runtime 优先）；
   * - 串行队列防 reconcileBusy 吞注册；多插件并发注册排队。
   * @param options 注册入参；`toolDefinitions` 可选——提供时该服务器工具
   *   全部用调用方封装定义注册（supervisor 跳过远端 schema 投影，execute
   *   来自调用方；命名仍按 publicToolName 的 mcp__ 前缀规则）。
   */
  async registerServer(
    options: Record<string, unknown>,
  ): Promise<{ name: string; existing: boolean }> {
    const { toolDefinitions, ...rest } = options;
    const config = orchestratorPorts.get().configModel.normalizeServer(rest);
    if (Array.isArray(toolDefinitions))
      config.toolDefinitions = toolDefinitions as ToolDefinition[];
    const run = this.registerQueue.then(async () => {
      if (this.runtimeRegistry.has(config.name) || this.store.find(config.name) !== undefined) {
        return { name: config.name, existing: true };
      }
      this.runtimeRegistry.set(config.name, config);
      // #413 时序显式化：注册即连接走 start 的 config 直传分支；start 内部按
      // middlewareTakes 判定（all 模式全局 → 触达 @global 单元，不建 supervisor、
      // 不注册 mcp__；project/off 或中间层未就绪 → supervisor 路径）。中间层
      // 未就绪窗口（provide→initMiddleware 之间的 async 空隙）暂落 supervisor，
      // 由 apply 的 reconcileServers（initMiddleware 后无条件执行）按同口径收敛
      // （stop supervisor + 重定向 @global 单元）；若收敛瞬间旧 mcp__ 注册尚未
      // 注销（dispose fire-and-forget），中间层防双进程探测命中 → F5 有界重试
      // 兜底，与 #382 热切换窗口同语义。
      if (config.enabled !== false) this.start(config.name, SCOPE_GLOBAL, config);
      return { name: config.name, existing: false };
    });
    this.registerQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 运行时注销（不影响 store 持久化条目；同名 store 条目回落）。
   * - 销毁 supervisor（stop，不碰 store）；
   * - **先删 runtimeRegistry 再拆中间层连接**（#413 QA P2-1）：drop 时数据源
   *   （projectServersFor 含 runtime）已不再返回该服务器，任何并发
   *   ensureConnected/connect 都查不到配置而无法重建虚拟连接——堵死注销后
   *   瞬时复活窗口，且不写 userDisabled（避免持久化污染导致同名 re-register
   *   被静默阻止连接，与 disconnect 的「用户主动断开」语义区分）；
   * - 拆中间层连接与目录条目（#413：all 模式 runtime 归一中台后虚拟连接在
   *   @global 单元，须显式清理，否则 unregister 后 ws_mcp_list/call 残留幽灵）；
   * - reconcile 回落 store 配置。
   */
  async unregisterServer(name: string): Promise<void> {
    const run = this.registerQueue.then(async () => {
      if (this.runtimeRegistry.has(name)) {
        this.stop(name);
        this.runtimeRegistry.delete(name);
        if (this.middleware !== undefined) {
          // 按名拆除对池是幂等的：off 模式下正常 transport 条目本就不在池里（no-op），
          // 而封装定义条目在 off 下也由池持有（裁决 (c)'），必须拆。
          this.dropMiddlewareConnection(name);
        }
        this.reconcileServers();
      }
    });
    this.registerQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async add(server: Record<string, unknown>, scope: string = SCOPE_GLOBAL): Promise<ServerConfig> {
    const config = orchestratorPorts.get().configModel.normalizeServer(server);
    const store = scope === SCOPE_PROJECT ? await this.projectStoreOrThrow() : this.store;
    if (store.find(config.name) !== undefined) {
      throw new Error(`server "${config.name}" already exists in ${scope} scope`);
    }
    store.upsert(config);
    await store.save();
    // #616：中间层项目级此前在此 touchMiddlewareUnit() 拆毁整个当前单元——
    // 新服务器经下方 start → ensureMiddlewareServer 幂等补连即可生效，无需
    // 拆毁单元殃及既有项目级连接。
    if (config.enabled !== false) this.start(config.name, scope);
    return config;
  }

  async update(
    name: string,
    patch: Record<string, unknown>,
    scope: string = SCOPE_GLOBAL,
  ): Promise<ServerConfig> {
    const { configModel } = orchestratorPorts.get();
    const store = scope === SCOPE_PROJECT ? await this.projectStoreOrThrow() : this.store;
    const existing = store.find(name);
    if (existing === undefined) throw new Error(`server "${name}" not found in ${scope} scope`);
    const merged = configModel.normalizeServer({ ...existing, ...patch, name });
    store.upsert(merged);
    await store.save();
    this.stop(name);
    if (this.middleware !== undefined) {
      // 中间层：拆池内旧配置连接（项目/全局单元统一处理；#382 此前只拆项目
      // 单元，all 模式全局旧连接残留导致编辑不生效）。off 模式下按名拆除对
      // 正常 transport 条目是 no-op，对封装定义条目（恒交中间层）必需。
      this.dropMiddlewareConnection(name);
    }
    if (merged.enabled !== false) {
      // 编辑后重新连接（即便此前未连接）
      this.start(name, scope);
    }
    return merged;
  }

  async remove(name: string, scope: string = SCOPE_GLOBAL): Promise<void> {
    const store = scope === SCOPE_PROJECT ? await this.projectStoreOrThrow() : this.store;
    this.stop(name);
    if (this.middleware !== undefined) {
      // 中间层：拆池内连接 + 目录随单元重建收敛（#382 此前只拆项目单元，
      // all 模式全局删除后池连接残留——ws_mcp_call 仍可调用已删服务器）。
      // 同 update：off 模式要拆的只有封装定义条目（恒交中间层）。
      this.dropMiddlewareConnection(name);
    }
    store.remove(name);
    await store.save();
  }

  async connect(
    name: string,
    scope: string = SCOPE_GLOBAL,
    directConfig?: ServerConfig,
  ): Promise<void> {
    let server = directConfig;
    if (server === undefined) {
      const store = scope === SCOPE_PROJECT ? await this.projectStoreOrThrow() : this.store;
      server = store.find(name);
      // F2（#382）：与 start 同款回退——runtime 注入条目不落 store，global
      // scope 查不到时回退 runtimeRegistry，修 runtime 注册服务器浮窗重连必失败。
      if (server === undefined && scope === SCOPE_GLOBAL) {
        const runtime = this.runtimeRegistry.get(name);
        if (runtime !== undefined) {
          this.logger.warn(
            `dsh-mcp-manager: server "${name}" not in store; using runtime registry entry`,
          );
          server = runtime;
        }
      }
    }
    if (server === undefined) throw new Error(`server "${name}" not found in ${scope} scope`);
    // F4（#382）：被中间层接管的服务器连接走连接池（userDisabled 解除 + 惰性
    // 连接）——此前只有项目级走池，all 模式全局走 supervisor 复活（注册 mcp__
    // 前缀工具），既导致浮窗带前缀展示，又让中间层防双进程探测持续命中、永不
    // 接管。project/off 模式 runtime 仍走 supervisor 路径（#413：仅 all 模式
    // 归一中间层）。
    if (this.middlewareOwns(server, scope) && this.middleware !== undefined) {
      const root = scope === SCOPE_PROJECT ? this.projectRoot : MIDDLEWARE_GLOBAL_ROOT;
      if (root === undefined)
        throw new Error("no active project session (call session with a cwd first)");
      const unit = await this.middleware.projectUnitFor(root);
      if (unit === undefined) throw new Error(`workspace ${root} has no project MCP config`);
      unit.userDisabled.delete(name);
      await this.saveUserState(this.middleware.units);
      // force 受控重建（#412）：用户显式「连接」即使 entry 半开卡在 connected
      // 也强制重建——此前 ensureConnected 对 connected 短路，半开死连接点「连接」
      // 无效（切回前台/刷新均无恢复入口）。
      await this.middleware.ensureConnected(root, name, { force: true });
      return;
    }
    const existing = this.supervisors.get(name);
    // 短路用**读时刷新后**的状态（裁定 U）：connected / connecting 是「链路在我方手里」的两个
    // 可判时点，重复 connect 不该把它们推倒重来；failed / reconnecting 是「该重建」的态——
    // 用户显式「连接」正是这两个态的恢复入口（旧栈的 client 判据在失败后已置空，同语义）。
    if (existing !== undefined) {
      const state = this.refreshEntryState(existing);
      if (state === SERVER_STATES.connected || state === SERVER_STATES.connecting) return;
    }
    if (existing !== undefined && existing.scope !== scope)
      throw new Error(`server "${name}" is registered in scope "${existing.scope}"`);
    // B5：重建路径先 await 旧代际释放再挂新实例（裁定 V：官方 serverName 是活体预留，
    // 同 id 未结算就重挂当场抛）；旧代际的残留工具随官方 dispose 一并注销。
    if (existing !== undefined) {
      await this.remountEntry(name, existing, server, scope);
      return;
    }
    const entry = this.createEntry(server, scope);
    this.supervisors.set(name, entry);
    await this.mountEntry(entry);
  }

  async disconnect(name: string, scope?: string): Promise<void> {
    // 中间层模式：userDisabled 持久化 + 连接池拆毁该连接。
    // #382：定位按接管口径显式进行——all 模式全局（store 配置）固定定位 @global
    // 单元（此前按 units 遍历序找第一个命中，同名服务器同时存在于项目与 @global
    // 单元时可能写错单元）；#413：all 模式 runtime 注入条目同样在 @global 单元
    // （虚拟连接），走遍历兜底定位。
    // #392：scope 显式传入时按 scope 精确定位单元——项目级固定定位当前项目 root
    // 单元，避免同名全局服务器把项目级 disconnect 错写进 @global 单元。
    // 拆连接前关 transport（此前直接 delete 丢 entry，stdio 子进程/socket 泄漏）。
    // 触发条件放宽到「该条目由中间层持有」：off 模式下封装定义条目也在池里（裁决 (c)'），
    // 它的断开同样要落 userDisabled + 池拆除；正常 transport 条目在 off 下仍走下面的直连路径。
    const disconnectTarget =
      this.store.find(name) ?? this.runtimeRegistry.get(name) ?? this.projectStore?.find(name);
    if (
      this.middleware !== undefined &&
      (this.middlewareMode !== "off" || this.isWrapped(disconnectTarget))
    ) {
      let targetUnit: ProjectUnit | undefined;
      const scoped = orchestratorPorts.get().workspace.normalizeScope(scope ?? "");
      if (scoped === SCOPE_PROJECT) {
        // 项目级：定位当前项目 root 单元（同名跨 scope 修正——此前 all 模式
        // 误用全局 store 定位 @global，同名项目级服务器被写错单元）。
        targetUnit =
          this.projectRoot !== undefined ? this.middleware.units.get(this.projectRoot) : undefined;
      } else if (
        this.middlewareMode === "all" &&
        this.store.find(name) !== undefined &&
        !this.runtimeRegistry.has(name)
      ) {
        targetUnit = this.middleware.units.get(MIDDLEWARE_GLOBAL_ROOT);
      } else {
        targetUnit = [...this.middleware.units.values()].find(
          (unit) => unit.connections.has(name) || unit.userDisabled.has(name),
        );
      }
      if (targetUnit !== undefined) {
        targetUnit.userDisabled.add(name);
        await this.saveUserState(this.middleware.units);
        // 同上：账本化拆除（只发起不等结算）。
        this.middleware.releaseConnection(targetUnit.root, name);
        // 断开即废弃同名在途标记：拆除时旧 attempt 仍 pending（挂至超时）会吞掉
        // 紧随的显式「连接」（connect→ensureConnected 去重短路，force 也不豁免）。
        this.middleware.abandonInFlight(name);
        this.emitStatus();
        return;
      }
    }
    const entry = this.supervisors.get(name);
    if (entry === undefined) return;
    this.supervisors.delete(name);
    // 拆除只发起不等结算（裁定 V）：官方 dispose 会等在途首连，挂死的服务器能把它拖到 SDK 的
    // 60s 超时；需要等结算的重建路径走 remountEntry 的 disposeServer。
    this.dropEntry(entry);
  }

  async reconnect(name: string, scope: string = SCOPE_GLOBAL): Promise<void> {
    // #392：断开与连接同口径传 scope——reconnect(scope) 时断开也按同一单元定位，
    // 避免 disconnect 走默认全局定位与 connect 的项目定位不一致。
    await this.disconnect(name, scope);
    await this.connect(name, scope);
  }

  /** 面板数据：配置 + 实时状态 + 工具列表 + 项目信息。 */
  summary(): Record<string, unknown> {
    const servers: Record<string, unknown>[] = [];
    for (const server of this.store.data.servers) {
      servers.push(this.summarize(server, SCOPE_GLOBAL));
    }
    if (this.projectStore !== undefined) {
      for (const server of this.projectStore.data.servers) {
        servers.push(this.summarize(server, SCOPE_PROJECT));
      }
    }
    // 查询面完整性（#329 评审修正）：runtime 条目并入 summary，
    // 否则 getStatus/list 看不到运行时注册的服务器（消费方无法感知状态）。
    for (const server of this.runtimeRegistry.values()) {
      servers.push(this.summarize(server, SCOPE_GLOBAL));
    }
    // 六态计数键与键序的物理定义在 shared/status.ts（两端同一份）；必须展开成新对象，
    // 否则下面的计数会就地改动共享单例。
    const byStatus: Record<string, number> = { ...EMPTY_STATUS_COUNTS };
    for (const server of servers)
      byStatus[server.status as string] = (byStatus[server.status as string] ?? 0) + 1;
    return {
      cwd: this.projectRoot ?? undefined,
      projectRoot: this.projectRoot ?? undefined,
      servers,
      counts: byStatus,
      middlewareMode: this.middlewareMode,
    };
  }

  /**
   * 中间层投影单元：该 server 在当前模式下由中间层接管时返回其所在单元，
   * 否则 undefined（supervisor 路径照旧）。project 模式仅项目级走池；
   * all 模式全局也经虚拟 root @global 走池（与 reconcileServers 的
   * middlewareTakes 判定同口径）。
   */
  private middlewareUnitFor(serverName: string, scope: string): ProjectUnit | undefined {
    const mw = this.middleware;
    if (mw === undefined || this.middlewareMode === "off") return undefined;
    // 与 start/reconcileServers 同口径（#382 F4 + #413）：all 模式全局（含
    // runtime 注入条目）映射 @global 单元。
    if (!this.middlewareTakes(serverName, scope)) return undefined;
    const root = scope === SCOPE_PROJECT ? this.projectRoot : MIDDLEWARE_GLOBAL_ROOT;
    return root === undefined ? undefined : mw.units.get(root);
  }

  summarize(server: ServerConfig, scope: string): Record<string, unknown> {
    // 中间层模式（#228 回归修复）：被中间层接管的服务器从连接池 + 目录缓存
    // 投影状态与工具列表——此前只读 supervisors，项目级无 supervisor 条目恒
    // 兜底 "stopped"，浮窗/summary 与真实连接态脱节。返回形状不变。
    const { pipeline, catalog: catalogPort } = orchestratorPorts.get();
    const unit = this.middlewareUnitFor(server.name, scope);
    if (unit !== undefined) {
      const entry = unit.connections.get(server.name);
      if (entry !== undefined) {
        const catalog = catalogPort.catalogDirectory.entryFor(unit.root, server.name);
        const disabledTools = this.disabledTools.get(unit.root)?.get(server.name);
        const globalTools =
          unit.root === MIDDLEWARE_GLOBAL_ROOT
            ? undefined
            : this.disabledTools.get(MIDDLEWARE_GLOBAL_ROOT)?.get(server.name);
        const tools =
          catalog !== undefined && catalog.unavailable === undefined
            ? [...catalog.tools.keys()]
            : [];
        const disabledList = tools.filter(
          (tool) => (disabledTools?.has(tool) ?? false) || (globalTools?.has(tool) ?? false),
        );
        return {
          ...server,
          scope,
          // 状态经读时刷新的投影取（裁定 U）：entry.status 只在装载窗口结算时写入，
          // 「曾连上、工具前缀消失」这类事实只有重算才看得见。
          status: this.middleware?.statusOf(unit.root, server.name),
          // 目录发现失败（unavailable）时透出原因：解释 connected 却 0 工具。
          error: entry.error !== undefined ? pipeline.msgOf(entry.error) : catalog?.unavailable,
          tools,
          disabledTools: disabledList.length > 0 ? disabledList : undefined,
        };
      }
      // #382 F4：userDisabled 短路——池中已断开（用户浮窗断开）的服务器不再落
      // 直连账本分支（all 模式全局经池接管后直连条目不复存在；同名 runtime
      // 残留时也不误显示其连接态）。#234 注释前提（全局 connect 走 supervisor 复活）
      // 随 F4 消失。
      if (unit.userDisabled.has(server.name)) {
        return { ...server, scope, status: "stopped", error: undefined, tools: [] };
      }
    }
    const entry = this.supervisors.get(server.name);
    // #382 F4：展示口径统一裸名——剥 mcp__<id>__ 前缀（与中间层投影分支、工具级禁用表键、
    // guard 层反解口径一致；此前浮窗禁用提交带前缀名而 guard 查裸名，禁用静默无效）。前缀源
    // 自本片起是**账本 id**（注册名 id 化，裁定 AG①）；超长哈希名剥出截断键，与 guard 路径
    // 二反解结果相同，禁用链路一致生效；前缀不匹配（不可剥）原样返回。
    const entryTools = (entry?.tools ?? []).map((tool) => stripMcpPrefix(tool, entry?.id ?? ""));
    // B19：禁用查询与中间层分支同口径——@global 与 projectRoot 禁用集**合并判定**
    // （现状 ?? 二者只取其一，跨空间禁用漏算）。@global 跨工作空间共享、项目根
    // 目录级追加，任一命中即禁用。
    const globalDisabled = this.disabledTools.get(MIDDLEWARE_GLOBAL_ROOT)?.get(server.name);
    const projectDisabled =
      this.projectRoot !== undefined
        ? this.disabledTools.get(this.projectRoot)?.get(server.name)
        : undefined;
    const entryDisabled = entryTools.filter(
      (tool) => (globalDisabled?.has(tool) ?? false) || (projectDisabled?.has(tool) ?? false),
    );
    return {
      ...server,
      scope,
      // 状态经读时刷新的投影取（裁定 U）：条目 status 只在装载窗口结算时写入，
      // 「曾连上、工具前缀消失」这类事实只有重算才看得见。
      status:
        entry === undefined
          ? server.enabled === false
            ? SERVER_STATES.disabled
            : SERVER_STATES.stopped
          : this.refreshEntryState(entry),
      error: entry?.error !== undefined ? (entry.error as Error).message : undefined,
      tools: entryTools,
      disabledTools: entryDisabled.length > 0 ? entryDisabled : undefined,
    };
  }

  async dispose(): Promise<void> {
    if (this.statusTimer !== undefined) {
      clearTimeout(this.statusTimer);
      this.statusTimer = undefined;
    }
    // 逐条摘账 + 发起释放（**不** await disposeServer：与组合根卸载链的
    // releaseLifecycle() + flushDisposals() 分工一致——manager.dispose() 先摘账，
    // 结算与错因由卸载链统一排空；releaseOne 对已摘键是 no-op，双重释放安全）。
    for (const entry of this.supervisors.values()) this.dropEntry(entry);
    this.supervisors = new Map();
    this.stats.dispose();
    if (this.middleware !== undefined) {
      await this.middleware.dispose();
      this.middleware = undefined;
    }
  }
}
