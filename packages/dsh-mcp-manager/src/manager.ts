/**
 * dsh-mcp-manager — MCP 服务器管理器（单一事实源）。
 *
 * McpManager 持有全局存储 + 当前会话项目的项目级存储、每个服务器的监督器
 * 与状态通知。全局服务器常连；项目级服务器（<项目根>/.dsh/mcp.json）只在
 * 当前会话 cwd 属于该项目时连接（跟随会话切换）。
 *
 * 类型自 types.ts 取；manager.ts 不 import apply.ts / index.ts（防循环引用）。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ServerResponse } from "node:http";
import type { SseHub } from "../../../shared/sse-hub.js";
import { dshHome } from "../../../shared/dsh-home.js";
import type { Context, LoggerService } from "@deepseek-ai/cordis";
import type { ServerConfig, ClientUiConfig } from "./types.ts";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { CatalogCache } from "./catalog.ts";
import { normalizeServer } from "./normalize.ts";
import { normalizeUiConfig, buildConfigUiPatch } from "./config-schema.ts";
import { McpStore } from "./store.ts";
import { ConnectionSupervisor } from "./supervisor.ts";
import { SCOPE_GLOBAL, SCOPE_PROJECT, normalizeScope } from "./scope.ts";
import { catalogCacheFile, summarizeToolDescriptions } from "./catalog.ts";
import {
  McpMiddleware,
  msgOf,
  userStateFile,
  loadUserState,
  saveUserState,
  catalogCacheFileFor,
  readCatalogServerFromDisk,
  loadDisabledTools,
  saveDisabledTools,
} from "./middleware.ts";
import type { MiddlewareMode, ProjectUnit, DisabledToolsMap } from "./middleware.ts";

/** 中间层 all 模式的全局虚拟 root（全局服务器经中间层访问时的路由 key）。 */
export const MIDDLEWARE_GLOBAL_ROOT = "@global";

/** DSH 全局家目录（shared/dsh-home.js 语义：DSH_HOME 非空白原样采用、空白
 *  视同未设置回落 ~/.dsh；#517 收敛）。resolve 为本处 .dsh 标记排除的对比
 *  用途服务。 */
function dshHomePath() {
  return resolve(dshHome());
}

/**
 * 剥 mcp__<server>__ 前缀还原裸名（#382 F4 展示口径统一）。前缀不匹配（不可
 * 剥）原样返回；剥后为空或仍以 mcp__ 开头（跨 server 注册名）原样返回。超长
 * 哈希名剥出截断键——与 guard 层（tools/pre-execute 路径二按注册名反解）结果
 * 相同，禁用表键口径统一生效。
 */
function stripMcpPrefix(registeredName: string, serverName: string): string {
  const prefix = `mcp__${serverName}__`;
  if (!registeredName.startsWith(prefix)) return registeredName;
  let name = registeredName;
  while (name.startsWith(prefix)) name = name.slice(prefix.length);
  if (name === "" || name.startsWith("mcp__")) return registeredName;
  return name;
}

/**
 * 管理器：持有全局存储 + 当前会话项目的项目级存储、每个服务器的监督器
 * 与状态通知。全局服务器常连；项目级服务器（<项目根>/.dsh/mcp.json）只在
 * 当前会话 cwd 属于该项目时连接（跟随会话切换）。
 */
export class McpManager {
  ctx: Context;
  store: McpStore;
  supervisors: Map<string, ConnectionSupervisor>;
  listeners: Set<() => void>;
  logger: LoggerService;
  projectRoot: string | undefined;
  projectStore: McpStore | undefined;
  reconcileBusy: boolean;
  projectStores: Map<string, McpStore>;
  enhancement: { enhanceEmptyDescriptions?: boolean; resultTruncateBytes?: number };
  catalogCache: CatalogCache;
  catalogCachePath: string;
  uiConfigSource: () => any;
  /** 设置命名空间写入 sink（apply 时经 ctx.inject(["settings"]) 注入；注入不到则写不可用）。 */
  uiUpdate?: (patch: Record<string, unknown>) => Promise<unknown>;
  /**
   * SSE 连接枢纽（共享 shared/sse-hub，#515）：makeEventsRoute 惰性创建；
   * 广播/卸载 disposer 收口到 hub（连接表 + 心跳 + 上限淘汰 + stalled/maxAge
   * 主动回收）。取代旧 sseConnections Set + per-connection 心跳（#268）。
   */
  sseHub?: SseHub;
  /** 中间层模式（Config.middleware 归一化）。 */
  middlewareMode: MiddlewareMode;
  /** 中间层实例（连接池 + 目录 + 路由；惰性创建）。 */
  middleware: McpMiddleware | undefined;
  /** userDisabled 持久化路径。 */
  userStatePath: string;
  /** 运行时注册表（内存态，不落盘）：供其他插件经 ctx.mcpManager 注入服务器。
   * 双轨 reconcile：store.data.servers（持久化）+ runtimeRegistry（运行时）。
   * 同名冲突策略：runtime 优先（运行时注入是「当前会话」语义）。 */
  runtimeRegistry: Map<string, ServerConfig>;
  /** registerServer 串行队列（防 reconcileBusy 吞注册；多插件并发注册排队）。 */
  private registerQueue: Promise<void>;

  constructor(ctx: Context, store: McpStore) {
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
    // 感知增强选项（apply 时设置）：enhanceEmptyDescriptions / resultTruncateBytes。
    this.enhancement = {};
    // 目录缓存：serverName → { summary }（磁盘持久化，digest 的稳定数据源）。
    this.catalogCache = new Map();
    this.catalogCachePath = catalogCacheFile();
    this.uiConfigSource = () => ({ position: "top-right", offsetX: 8, offsetY: 8, blankY: 40 });
    this.middlewareMode = "off";
    this.middleware = undefined;
    this.userStatePath = userStateFile();
    this.runtimeRegistry = new Map();
    this.registerQueue = Promise.resolve();
  }

  /** 读取 settings 命名空间中的 MCP UI 配置（供 /api/dsh-mcp/config 返回）。 */
  uiConfig(): ClientUiConfig {
    return normalizeUiConfig(this.uiConfigSource());
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
    await this.uiUpdate({ ui: buildConfigUiPatch(raw) });
    return this.uiConfig();
  }

  /** 从磁盘加载目录缓存（损坏/缺失 → 空缓存，不崩溃）。 */
  async loadCatalogCache(): Promise<void> {
    try {
      if (!existsSync(this.catalogCachePath)) return;
      const raw = await readFile(this.catalogCachePath, "utf8");
      const parsed = JSON.parse(raw) as { entries?: Record<string, unknown> } | null;
      if (parsed && typeof parsed === "object" && typeof parsed.entries === "object" && parsed.entries !== null) {
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
  async recordCatalogTools(serverName: string, toolMeta: Map<string, { description?: unknown }>): Promise<void> {
    const summary = summarizeToolDescriptions(toolMeta);
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
      this.logger.warn(`dsh-mcp-manager: catalog cache write failed: ${String(error)}`);
    }
  }

  onStatus(handler: () => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
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

  /** 项目根发现：从 cwd 向上找 .git / .dsh / .mcp.json 标记，找不到用 cwd 本身。
   *  .dsh 标记须排除 DSH 全局家目录（默认 ~/.dsh，尊重 DSH_HOME）——否则 home
   *  下任何无标记目录（如 ~/dev/leetcode）向上都会命中 ~/.dsh，把 home 误判为
   *  项目根并加载 ~/.dsh/mcp.json，导致别的会话串入不属于它的项目级 MCP。 */
  async findProjectRoot(cwd: string | undefined): Promise<string> {
    const dshHome = dshHomePath();
    let current = resolve(cwd ?? process.cwd());
    for (let depth = 0; depth < 16; depth += 1) {
      const dotDsh = join(current, ".dsh");
      // .dsh 目录存在且不是 DSH 全局家目录才算项目标记。
      const hasProjectDsh = existsSync(dotDsh) && resolve(dotDsh) !== dshHome;
      if (existsSync(join(current, ".git")) || hasProjectDsh || existsSync(join(current, ".mcp.json"))) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return resolve(cwd ?? process.cwd());
  }

  /** 当前会话的项目级存储（无活动项目时抛错）。 */
  async projectStoreOrThrow(): Promise<McpStore> {
    if (this.projectStore === undefined) {
      throw new Error("no active project session (call session with a cwd first)");
    }
    return this.projectStore;
  }

  /** 归一化项目根（realpath；失败回退 resolve）。中间层路由使用。 */
  async normalizedProjectRoot(cwd: string | undefined): Promise<string | undefined> {
    if (cwd === undefined || cwd === null || cwd === "") return undefined;
    return this.findProjectRoot(cwd);
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
   * codegraph 等 runtime 注册的服务器不落 store，单源会误判「非全局」——P1 修正。 */
  isGlobalServer(name: string): boolean {
    return this.store.data.servers.some((server) => server.name === name) || this.runtimeRegistry.has(name);
  }

  /** 中间层宿主：全局服务器配置（all 模式使用）。 */
  globalServers(): ServerConfig[] {
    return this.store.data.servers;
  }

  /** 中间层宿主：持久化 userDisabled。 */
  async saveUserState(units: Map<string, ProjectUnit>): Promise<void> {
    await saveUserState(this.userStatePath, units);
  }

  /** 中间层宿主：root 的目录缓存文件路径。 */
  catalogCachePathFor(root: string): string {
    return catalogCacheFileFor(root);
  }

  /** 初始化中间层（apply 时按模式调用；幂等）。 */
  async initMiddleware(mode: MiddlewareMode, policy: Record<string, unknown>): Promise<McpMiddleware> {
    this.middlewareMode = mode;
    if (this.middleware !== undefined) return this.middleware;
    const mw = new McpMiddleware(
      {
        ctx: this.ctx,
        logger: this.logger,
        projectServersFor: (root) => this.projectServersFor(root),
        globalServers: () => this.globalServers(),
        normalizedProjectRoot: (cwd) => this.normalizedProjectRoot(cwd),
        saveUserState: (units) => this.saveUserState(units),
        emitStatus: () => this.emitStatus(),
        catalogCachePath: (root) => this.catalogCachePathFor(root),
        isGlobalServer: (name) => this.isGlobalServer(name),
        isRuntimeServer: (name) => this.isRuntimeServer(name),
      },
      {
        allowTools: (policy.allowTools as Record<string, string[]> | undefined) ?? undefined,
        denyTools: (policy.denyTools as Record<string, string[]> | undefined) ?? undefined,
      },
    );
    try {
      // 加载 userDisabled 并注入中间层实例（单元创建时合并；重启不丢）。
      this.disabledByRoot = await loadUserState(this.userStatePath);
      mw.disabledByRoot = this.disabledByRoot;
      // 加载工具级禁用（三层结构；合并式写盘，绝不整表覆盖）。
      this.disabledTools = await loadDisabledTools(this.userStatePath);
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
  async setToolDisabled(root: string, server: string, tool: string, disabled: boolean): Promise<void> {
    const tools = this.disabledTools.get(root) ?? new Map<string, Set<string>>();
    const set = tools.get(server) ?? new Set<string>();
    if (disabled) set.add(tool);
    else set.delete(tool);
    if (set.size > 0) tools.set(server, set);
    else tools.delete(server);
    if (tools.size > 0) this.disabledTools.set(root, tools);
    else this.disabledTools.delete(root);
    await saveDisabledTools(this.userStatePath, this.disabledTools);
    this.emitStatus();
  }

  /** 读取/复用某项目根的 store（工作区缓存命中直接返回，不重复读盘）。 */
  async projectStoreFor(root: string | undefined): Promise<McpStore | undefined> {
    if (typeof root !== "string" || root === "") return undefined;
    let store = this.projectStores.get(root);
    if (store === undefined) {
      store = new McpStore(join(root, ".dsh", "mcp.json"));
      await store.load();
      this.projectStores.set(root, store);
    } else {
      // 缓存命中也要检查磁盘：项目 mcp.json 在 git 仓库内，pull/checkout/手动
      // 编辑后应自动生效，不依赖重启宿主（只重读配置，不启停连接）。
      try {
        await store.reloadIfChanged();
      } catch (error) {
        this.logger.warn(`dsh-mcp-manager: reload project config failed: ${String(error)}`);
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
   * （#359）：dsh-codegraph 等插件经运行时注入注册的服务器，连接成功、工具可用，
   * 但此前不在目录里——模型看不到能力，只能自己翻 CLI。同名 runtime 优先
   * （与 reconcile 双轨一致）。
   */
  async catalogServersFor(cwd: string | undefined): Promise<Map<string, { server: ServerConfig; scope: string }>> {
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
    const root = cwd === undefined || cwd === null || cwd === "" ? undefined : await this.findProjectRoot(cwd);
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

  /** 磁盘 last-good 摘要缓存（root → server → { mtimeMs, summary }）；
   * #569 防 pre-step 每轮重复读盘解析（目录文件最大 ~256KB，JSON parse 有成本）。 */
  private diskCatalogSummaryCache = new Map<string, Map<string, { mtimeMs: number; summary: string | undefined }>>();

  /**
   * 合成注入端目录缓存视图（#569 修复核心）：以 B（supervisor 摘要缓存）为基底，
   * 逐服务器按「scope + 模式」用中间层目录摘要覆盖——修复「middleware 采集的
   * 工具摘要注入端读不到」：
   * - 用户手写 server.description 由 composeCatalogEntries 处理（优先级最高），
   *   不在此视图内；
   * - 本视图只负责注入端的 ②（中间层目录摘要）与 ③（B 缓存摘要）两级回退；
   * - **判 middlewareMode 而非 middleware 实例**（评审修正①）：热切换 off 后
   *   middleware 实例与 units 残留（apply.setMiddlewareMode 只卸载 ws_mcp_* 工具），
   *   判实例会错误读中间层目录。
   *
   * root 映射（与 middlewareTakes 同口径 + 热切换残留兜底，评审修正②③）：
   * - mode=off → 全部走 B（无中间层目录语义）；
   * - scope=project → 该 cwd 归一化项目 root 的单元 → 无则磁盘 last-good；
   * - scope=global → @global 单元/磁盘（all 模式权威；project 模式热切换残留/
   *   上次 all 会话的 last-good 兜底）→ 仍无则保留 B。
   * 严格按 scope 解析、不跨 scope 混配同名服务器（防不同配置被错配）。
   * 单元不存在时读磁盘 last-good（带 mtime 缓存），**不主动 projectUnitFor**
   * ——pre-step 无连接副作用。
   * @param cwd 会话 cwd（与 catalogServersFor 同源解析项目 root）。
   * @param servers catalogServersFor 的输出（name → { server, scope }）。
   * @returns CatalogCache 形态视图（name → { summary }），可直接喂 composeCatalogEntries。
   */
  async catalogViewFor(
    cwd: string | undefined,
    servers: Map<string, { server: ServerConfig; scope: string }>,
  ): Promise<CatalogCache> {
    const view: CatalogCache = new Map();
    for (const [name, entry] of this.catalogCache) view.set(name, { summary: entry.summary });
    const mw = this.middleware;
    if (mw === undefined || this.middlewareMode === "off") return view;
    // 项目 root 只解析一次（所有 project scope 服务器共用；空 cwd → 无项目单元）。
    const cwdRoot = cwd === undefined || cwd === null || cwd === "" ? undefined : await this.normalizedProjectRoot(cwd);
    for (const [name, { scope }] of servers) {
      if (name === "") continue;
      // root 解析：project scope → 项目 root；global scope → @global（all 权威，
      // project 模式残留兜底）。跨 scope 不混配（同名项目级/全局是两份配置）。
      const root = scope === SCOPE_PROJECT ? cwdRoot : MIDDLEWARE_GLOBAL_ROOT;
      if (root === undefined) continue;
      const summary = await this.middlewareCatalogSummary(mw, root, name);
      if (summary !== undefined) view.set(name, { summary });
    }
    return view;
  }

  /** 查中间层单服务器目录摘要：内存单元优先，单元缺失/无该服务器 → 磁盘
   * last-good 兜底（带 mtime 缓存，防 pre-step 每轮读盘）。返回 undefined
   * 表示中间层无此服务器数据（调用方保留 B 兜底）。 */
  private async middlewareCatalogSummary(mw: McpMiddleware, root: string, name: string): Promise<string | undefined> {
    const unit = mw.units.get(root);
    const catalog = unit?.catalog.get(name);
    const tools = catalog?.tools;
    if (tools !== undefined && tools.size > 0 && catalog?.unavailable === undefined) {
      // 内存单元（已含磁盘 last-good：单元创建时 loadCatalogCache 载入）→ 直接聚合。
      return summarizeToolDescriptions(tools as Map<string, { description?: unknown }>);
    }
    // 内存无该服务器数据（单元未建 / 条目缺失 / 发现失败）→ 磁盘 last-good 兜底。
    const file = this.catalogCachePathFor(root);
    const cachedRoot = this.diskCatalogSummaryCache.get(root);
    const cached = cachedRoot?.get(name);
    let mtimeMs = 0;
    try {
      if (!existsSync(file)) return undefined;
      const stat = statSync(file);
      mtimeMs = stat.mtimeMs;
    } catch {
      return undefined; // 文件消失/不可读 → 无磁盘兜底
    }
    if (cached?.mtimeMs === mtimeMs) return cached.summary;
    const persisted = await readCatalogServerFromDisk(file, name);
    if (persisted === undefined) return undefined;
    const summary = summarizeToolDescriptions(
      new Map(persisted.tools.map((tool) => [tool.name, { description: tool.description }])),
    );
    let rootCache = this.diskCatalogSummaryCache.get(root);
    if (rootCache === undefined) {
      rootCache = new Map();
      this.diskCatalogSummaryCache.set(root, rootCache);
    }
    rootCache.set(name, { mtimeMs, summary });
    return summary;
  }

  /**
   * 会话切换：只切 currentRoot + fire-and-forget 惰性启动（不 await 任何连接）。
   * 变更点驱动（#111/#228）：POST /api/dsh-mcp/session 永不挂起——连接/发现
   * 由中间层惰性驱动（per-root in-flight 去重），此处零连接副作用。
   * 兼容语义：middleware=off（旧行为）时切走仍断开旧项目 supervisor；
   * middleware=project/all 时项目级连接由中间层池常驻，切走不断开。
   */
  async setSession(cwd: string | undefined): Promise<void> {
    const root = cwd === undefined || cwd === null || cwd === "" ? undefined : await this.findProjectRoot(cwd);
    if (root === this.projectRoot && this.projectStore !== undefined) return;
    // 本就没有活动项目且新会话同样无项目（空 cwd）：保持幂等，避免反复
    // emitStatus → SSE → 客户端 refresh 的广播循环。
    if (root === undefined && this.projectStore === undefined) return;
    // off 模式（旧行为）：切走时断开旧项目 supervisor（不 await，避免挂起）。
    if (this.middlewareMode === "off") {
      for (const [name, supervisor] of [...this.supervisors]) {
        if (supervisor.scope === SCOPE_PROJECT) {
          this.supervisors.delete(name);
          void supervisor.disconnect();
        }
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
      this.logger.warn(`dsh-mcp-manager: reload global config failed: ${String(error)}`);
    }
    if (this.middlewareMode !== "off" && this.middleware !== undefined) {
      // 中间层：仅触达单元（fire-and-forget 惰性连接在 projectUnitFor 内）。
      // all 模式：无项目 cwd 也触达全局虚拟 root @global。
      const target = root !== undefined ? root : (this.middlewareMode === "all" ? MIDDLEWARE_GLOBAL_ROOT : undefined);
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
    const root = this.projectRoot ?? (this.middlewareMode === "all" ? MIDDLEWARE_GLOBAL_ROOT : undefined);
    if (root === undefined) return;
    // 单元缺失（宿主重启/状态丢失）先创建：projectUnitFor 负责惰性连接兜底。
    const unit = mw.units.get(root) ?? (await mw.projectUnitFor(root));
    if (unit === undefined) return;
    // 目标 = 配置全集（本项目/全局的全部 enabled 服务器），而非仅已有 entry。
    const servers = await this.projectServersFor(root);
    const targets = (servers ?? [])
      .filter((server: ServerConfig) => server.enabled !== false && !unit.userDisabled.has(server.name))
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
   */
  async refreshFromDisk(): Promise<void> {
    let changed = false;
    try {
      changed = (await this.store.reloadIfChanged()) || changed;
    } catch (error) {
      this.logger.warn(`dsh-mcp-manager: reload global config failed: ${String(error)}`);
    }
    if (this.projectStore !== undefined) {
      try {
        changed = (await this.projectStore.reloadIfChanged()) || changed;
      } catch (error) {
        this.logger.warn(`dsh-mcp-manager: reload project config failed: ${String(error)}`);
      }
    }
    changed = this.reconcileServers() || changed;
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
      for (const [name, supervisor] of [...this.supervisors]) {
        const want = desired.get(name);
        // 中间层接管（与 start 同口径单一事实源 middlewareTakes）：停掉不该以
        // supervisor 形态存在的连接（#413：all 模式 runtime 亦被接管，同样停）。
        const middlewareTakes = this.middlewareTakes(name, supervisor.scope);
        if (want === undefined || want.server.enabled === false || want.scope !== supervisor.scope || middlewareTakes) {
          this.stop(name);
          changed = true;
        }
      }
      for (const [name, want] of desired) {
        if (want.server.enabled === false) continue;
        // project 模式项目级：由中间层单元管理（touchMiddlewareUnit 惰性重建），
        // 不经 start；all 模式全局照常 start——start 内部下沉接管（触达 @global）。
        if (this.middlewareMode === "project" && want.scope === SCOPE_PROJECT) continue;
        const existing = this.supervisors.get(name);
        if (existing === undefined || existing.scope !== want.scope) {
          this.start(name, want.scope);
          // all 模式全局接管路径（start 内部触达池）不建 supervisor——池连接
          // 变化由 connectInternal emitStatus 上报，不计入 supervisor 集合变化。
          if (!this.middlewareTakes(name, want.scope)) changed = true;
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
      // codegraph 等动态注册服务器「浮窗重连断开后连不回」。仅限 global：
      // project 回退会把 runtime 条目挂错 scope，被下次 reconcile 无声停掉。
      if (server === undefined && scope === SCOPE_GLOBAL) {
        const runtime = this.runtimeRegistry.get(name);
        if (runtime !== undefined) {
          this.logger.warn(`dsh-mcp-manager: server "${name}" not in store; using runtime registry entry`);
          server = runtime;
        }
      }
    }
    if (server === undefined) return;
    // F3（#382）：中间层接管判定下沉到 start（与 reconcileServers 同口径，见
    // middlewareTakes）。all 模式全局非 runtime 不建 supervisor——杜绝「先建
    // supervisor 再被 reconcile 停掉」的竞态窗口（热更新后 mcp__ 注册残留 →
    // 中间层防双进程探测命中且无重试 → 掉线），改触达 @global 单元惰性连接；
    // 中间层模式项目级不建 supervisor，拆项目单元惰性重建。startAll / add /
    // update / reconcile 各入口自动收敛，无需逐处特判。
    if (this.middlewareTakes(name, scope)) {
      if (scope === SCOPE_PROJECT) this.touchMiddlewareUnit();
      else this.touchGlobalUnit(name);
      return;
    }
    const existing = this.supervisors.get(name);
    if (existing !== undefined && existing.client !== undefined) {
      // 已连接：若现有 config 与直传 config 不同（runtime 注入覆盖 store），重建。
      if (directConfig !== undefined && existing.server !== directConfig) {
        existing.disposed = true;
        const supervisor = new ConnectionSupervisor(this, directConfig, scope);
        this.supervisors.set(name, supervisor);
        void supervisor.connect();
      }
      return;
    }
    if (existing !== undefined && existing.scope !== scope) {
      // 同名服务器跨 scope 冲突：工具名会重复，拒绝启动
      this.logger.warn(`dsh-mcp-manager: server "${name}" already registered in scope "${existing.scope}" — skipping "${scope}"`);
      return;
    }
    if (existing !== undefined) existing.disposed = true;
    const supervisor = new ConnectionSupervisor(this, server, scope);
    this.supervisors.set(name, supervisor);
    void supervisor.connect();
  }

  /**
   * 中间层接管判定（start / reconcileServers 单一口径）：中间层模式的项目级，
   * 或 all 模式的全局级（**含 runtime 注入条目**，#413 消除豁免——all 模式
   * 统一无 mcp__ 前缀直呼，runtime 封装定义服务器经中间层目录投影 + callTool
   * 直呼执行；project / off 模式 runtime 照旧 supervisor 路径注册 mcp__ 工具）。
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
    void mw.projectUnitFor(MIDDLEWARE_GLOBAL_ROOT)
      .then((unit) => {
        if (unit === undefined || unit.userDisabled.has(name)) return;
        void mw.ensureConnected(MIDDLEWARE_GLOBAL_ROOT, name);
      })
      .catch((error: unknown) => {
        // #392 遗留⑥：不再静默吞错——projectUnitFor 失败时打 warn 日志，
        // 否则该服务器永不连接且无迹可查（ensureConnected 调用面仍会尝试）。
        this.logger.warn(`dsh-mcp-manager: touchGlobalUnit(${name}) failed: ${String(error)}`);
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
      const entry = unit.connections.get(name);
      if (entry !== undefined) {
        dropped = true;
        entry.disposed = true;
        if (entry.reconnectTimer !== undefined) clearTimeout(entry.reconnectTimer);
        const client = entry.client;
        entry.client = undefined;
        entry.transport = undefined;
        if (client !== undefined && client.transport !== undefined) void client.transport.close().catch(() => {});
        unit.connections.delete(name);
      }
      // #392 遗留①：目录条目随连接一并拆除——remove/update 后已删服务器不再以
      // 幽灵条目出现在 ws_mcp_list / ws_mcp_search（此前只拆连接，目录 TTL 内残留）。
      // 内存目录先行删除；磁盘 last-good 缓存异步同步（防重启后 loadCatalogCache
      // 把幽灵条目载回——persistCatalog 空采集不写盘，remove 后目录可能为空，必须
      // 显式清盘而非依赖全量覆盖写）。
      if (unit.catalog.delete(name)) {
        dropped = true;
        void mw.removeCatalogEntry(unit.root, name).catch(() => {});
      }
    }
    if (dropped) this.emitStatus();
  }

  stop(name: string): void {
    const supervisor = this.supervisors.get(name);
    if (supervisor === undefined) return;
    this.supervisors.delete(name);
    void supervisor.disconnect();
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
  async registerServer(options: Record<string, unknown>): Promise<{ name: string; existing: boolean }> {
    const { toolDefinitions, ...rest } = options;
    const config = normalizeServer(rest);
    if (Array.isArray(toolDefinitions)) config.toolDefinitions = toolDefinitions as ToolDefinition[];
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
    this.registerQueue = run.then(() => undefined, () => undefined);
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
        if (this.middlewareMode !== "off" && this.middleware !== undefined) {
          this.dropMiddlewareConnection(name);
        }
        this.reconcileServers();
      }
    });
    this.registerQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async add(server: Record<string, unknown>, scope: string = SCOPE_GLOBAL): Promise<ServerConfig> {
    const config = normalizeServer(server);
    const store = scope === SCOPE_PROJECT ? await this.projectStoreOrThrow() : this.store;
    if (store.find(config.name) !== undefined) {
      throw new Error(`server "${config.name}" already exists in ${scope} scope`);
    }
    store.upsert(config);
    await store.save();
    if (this.middlewareMode !== "off" && scope === SCOPE_PROJECT) {
      // 中间层：拆毁当前 root 单元（下次惰性重建读新配置）。
      this.touchMiddlewareUnit();
    }
    if (config.enabled !== false) this.start(config.name, scope);
    return config;
  }

  async update(name: string, patch: Record<string, unknown>, scope: string = SCOPE_GLOBAL): Promise<ServerConfig> {
    const store = scope === SCOPE_PROJECT ? await this.projectStoreOrThrow() : this.store;
    const existing = store.find(name);
    if (existing === undefined) throw new Error(`server "${name}" not found in ${scope} scope`);
    const merged = normalizeServer({ ...existing, ...patch, name });
    store.upsert(merged);
    await store.save();
    this.stop(name);
    if (this.middlewareMode !== "off") {
      // 中间层：拆池内旧配置连接（项目/全局单元统一处理；#382 此前只拆项目
      // 单元，all 模式全局旧连接残留导致编辑不生效）。
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
    if (this.middlewareMode !== "off") {
      // 中间层：拆池内连接 + 目录随单元重建收敛（#382 此前只拆项目单元，
      // all 模式全局删除后池连接残留——ws_mcp_call 仍可调用已删服务器）。
      this.dropMiddlewareConnection(name);
    }
    store.remove(name);
    await store.save();
  }

  /** 中间层辅助：拆毁当前 root 单元（配置变更后强制惰性重建）。 */
  private touchMiddlewareUnit(): void {
    const mw = this.middleware;
    if (mw === undefined || this.projectRoot === undefined) return;
    mw.teardownUnit(this.projectRoot);
  }

  async connect(name: string, scope: string = SCOPE_GLOBAL, directConfig?: ServerConfig): Promise<void> {
    let server = directConfig;
    if (server === undefined) {
      const store = scope === SCOPE_PROJECT ? await this.projectStoreOrThrow() : this.store;
      server = store.find(name);
      // F2（#382）：与 start 同款回退——runtime 注入条目不落 store，global
      // scope 查不到时回退 runtimeRegistry，修 codegraph 浮窗重连必失败。
      if (server === undefined && scope === SCOPE_GLOBAL) {
        const runtime = this.runtimeRegistry.get(name);
        if (runtime !== undefined) {
          this.logger.warn(`dsh-mcp-manager: server "${name}" not in store; using runtime registry entry`);
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
    if (this.middlewareTakes(name, scope) && this.middleware !== undefined) {
      const root = scope === SCOPE_PROJECT ? this.projectRoot : MIDDLEWARE_GLOBAL_ROOT;
      if (root === undefined) throw new Error("no active project session (call session with a cwd first)");
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
    if (existing !== undefined && existing.client !== undefined) return;
    if (existing !== undefined && existing.scope !== scope) throw new Error(`server "${name}" is registered in scope "${existing.scope}"`);
    if (existing !== undefined) existing.disposed = true;
    const supervisor = new ConnectionSupervisor(this, server, scope);
    this.supervisors.set(name, supervisor);
    await supervisor.connect();
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
    if (this.middlewareMode !== "off" && this.middleware !== undefined) {
      let targetUnit: ProjectUnit | undefined;
      const scoped = normalizeScope(scope ?? "");
      if (scoped === SCOPE_PROJECT) {
        // 项目级：定位当前项目 root 单元（同名跨 scope 修正——此前 all 模式
        // 误用全局 store 定位 @global，同名项目级服务器被写错单元）。
        targetUnit = this.projectRoot !== undefined ? this.middleware.units.get(this.projectRoot) : undefined;
      } else if (this.middlewareMode === "all" && this.store.find(name) !== undefined && !this.runtimeRegistry.has(name)) {
        targetUnit = this.middleware.units.get(MIDDLEWARE_GLOBAL_ROOT);
      } else {
        targetUnit = [...this.middleware.units.values()].find((unit) => unit.connections.has(name) || unit.userDisabled.has(name));
      }
      if (targetUnit !== undefined) {
        targetUnit.userDisabled.add(name);
        await this.saveUserState(this.middleware.units);
        const entry = targetUnit.connections.get(name);
        if (entry !== undefined) {
          entry.disposed = true;
          if (entry.reconnectTimer !== undefined) clearTimeout(entry.reconnectTimer);
          const client = entry.client;
          entry.client = undefined;
          entry.transport = undefined;
          if (client !== undefined && client.transport !== undefined) void client.transport.close().catch(() => {});
          targetUnit.connections.delete(name);
        }
        this.emitStatus();
        return;
      }
    }
    const supervisor = this.supervisors.get(name);
    if (supervisor === undefined) return;
    this.supervisors.delete(name);
    await supervisor.disconnect();
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
    const byStatus: Record<string, number> = { connected: 0, connecting: 0, reconnecting: 0, disabled: 0, stopped: 0, failed: 0 };
    for (const server of servers) byStatus[server.status as string] = (byStatus[server.status as string] ?? 0) + 1;
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
    const unit = this.middlewareUnitFor(server.name, scope);
    if (unit !== undefined) {
      const entry = unit.connections.get(server.name);
      if (entry !== undefined) {
        const catalog = unit.catalog.get(server.name);
        const disabledTools = this.disabledTools.get(unit.root)?.get(server.name);
        const globalTools = unit.root === MIDDLEWARE_GLOBAL_ROOT ? undefined : this.disabledTools.get(MIDDLEWARE_GLOBAL_ROOT)?.get(server.name);
        const tools = catalog !== undefined && catalog.unavailable === undefined ? [...catalog.tools.keys()] : [];
        const disabledList = tools.filter((tool) => (disabledTools?.has(tool) ?? false) || (globalTools?.has(tool) ?? false));
        return {
          ...server,
          scope,
          status: entry.status,
          // 目录发现失败（unavailable）时透出原因：解释 connected 却 0 工具。
          error: entry.error !== undefined ? msgOf(entry.error) : catalog?.unavailable,
          tools,
          disabledTools: disabledList.length > 0 ? disabledList : undefined,
        };
      }
      // #382 F4：userDisabled 短路——池中已断开（用户浮窗断开）的服务器不再落
      // supervisor 分支（all 模式全局经池接管后 supervisor 不复存在；同名 runtime
      // 残留时也不误显示其连接态）。#234 注释前提（全局 connect 走 supervisor 复活）
      // 随 F4 消失。
      if (unit.userDisabled.has(server.name)) {
        return { ...server, scope, status: "stopped", error: undefined, tools: [] };
      }
    }
    const supervisor = this.supervisors.get(server.name);
    // #382 F4：展示口径统一裸名——剥 mcp__<server>__ 前缀（与中间层投影分支、
    // 工具级禁用表键、guard 层反解口径一致；此前浮窗禁用提交带前缀名而 guard
    // 查裸名，禁用静默无效）。超长哈希名剥出截断键，与 guard 路径二反解结果
    // 相同，禁用链路一致生效；前缀不匹配（不可剥）原样返回。
    const supervisorTools = (supervisor?.tools ?? []).map((tool) => stripMcpPrefix(tool, server.name));
    const disabledForServer = this.disabledTools.get(MIDDLEWARE_GLOBAL_ROOT)?.get(server.name) ?? this.disabledTools.get(this.projectRoot ?? "")?.get(server.name);
    const supervisorDisabled = disabledForServer !== undefined ? supervisorTools.filter((tool) => disabledForServer.has(tool)) : [];
    return {
      ...server,
      scope,
      status: supervisor?.status ?? (server.enabled === false ? "disabled" : "stopped"),
      error: supervisor?.error !== undefined ? (supervisor.error as Error).message : undefined,
      tools: supervisorTools,
      disabledTools: supervisorDisabled.length > 0 ? supervisorDisabled : undefined,
    };
  }

  async dispose(): Promise<void> {
    if (this.statusTimer !== undefined) {
      clearTimeout(this.statusTimer);
      this.statusTimer = undefined;
    }
    for (const supervisor of this.supervisors.values()) {
      supervisor.disposed = true;
      if (supervisor.reconnectTimer !== undefined) clearTimeout(supervisor.reconnectTimer);
      await supervisor.syncChain;
      for (const dispose of supervisor.toolDisposers.values()) dispose();
    }
    this.supervisors = new Map();
    if (this.middleware !== undefined) {
      await this.middleware.dispose();
      this.middleware = undefined;
    }
  }
}