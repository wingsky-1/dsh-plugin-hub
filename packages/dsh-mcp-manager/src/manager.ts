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
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ServerResponse } from "node:http";
import type { Context, LoggerService } from "@deepseek-ai/cordis";
import type { ServerConfig, ClientUiConfig } from "./types.ts";
import type { CatalogCache } from "./catalog.ts";
import { normalizeServer } from "./normalize.ts";
import { normalizeUiConfig, buildConfigUiPatch } from "./config-schema.ts";
import { McpStore } from "./store.ts";
import { ConnectionSupervisor } from "./supervisor.ts";
import { SCOPE_GLOBAL, SCOPE_PROJECT } from "./scope.ts";
import { catalogCacheFile, summarizeToolDescriptions } from "./catalog.ts";
import {
  McpMiddleware,
  msgOf,
  userStateFile,
  loadUserState,
  saveUserState,
  catalogCacheFileFor,
} from "./middleware.ts";
import type { MiddlewareMode, ProjectUnit } from "./middleware.ts";

/** 中间层 all 模式的全局虚拟 root（全局服务器经中间层访问时的路由 key）。 */
export const MIDDLEWARE_GLOBAL_ROOT = "@global";

/** DSH 全局家目录（与官方 dsh-home-paths 同语义：DSH_HOME ?? ~/.dsh）。 */
function dshHomePath() {
  const envHome = process.env.DSH_HOME;
  return resolve(envHome !== undefined && envHome !== "" ? envHome : join(homedir(), ".dsh"));
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
  sseConnections?: Set<ServerResponse>;
  /** SSE 心跳定时器清理函数（makeEventsRoute 注册；卸载 disposer 统一执行，#268）。 */
  sseHeartbeatCleanups?: Set<() => void>;
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

  /** 中间层宿主：按 root 读取服务器配置。all 模式的虚拟 root "@global" 返回全局配置。 */
  async projectServersFor(root: string): Promise<ServerConfig[] | undefined> {
    if (root === MIDDLEWARE_GLOBAL_ROOT) return this.store.data.servers;
    const store = await this.projectStoreFor(root);
    return store?.data.servers;
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
      },
      {
        allowTools: (policy.allowTools as Record<string, string[]> | undefined) ?? undefined,
        denyTools: (policy.denyTools as Record<string, string[]> | undefined) ?? undefined,
      },
    );
    // 加载 userDisabled 并注入中间层实例（单元创建时合并；重启不丢）。
    this.disabledByRoot = await loadUserState(this.userStatePath);
    mw.disabledByRoot = this.disabledByRoot;
    this.middleware = mw;
    return mw;
  }

  /** userDisabled 映射（root → Set<server>），中间层单元创建时合并。 */
  disabledByRoot: Map<string, Set<string>> = new Map();

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
      // 中间层 project/all 模式：runtime 仅全局 supervisor 路径（不拆单元、不走中间层连接池）。
      for (const [name, server] of this.runtimeRegistry) {
        desired.set(name, { server, scope: SCOPE_GLOBAL });
      }
      let changed = false;
      for (const [name, supervisor] of [...this.supervisors]) {
        const want = desired.get(name);
        // runtime 条目豁免中间层接管（走全局 supervisor 路径，不被中间层停掉/跳过）。
        const isRuntime = this.runtimeRegistry.has(name);
        // 中间层 project/all 模式：项目级（all 含全局）服务器由中间层接管
        // （不注册 mcp__ 工具，避免双连接双进程）。runtime 条目例外。
        const middlewareTakes = !isRuntime && this.middlewareMode !== "off" && (
          supervisor.scope === SCOPE_PROJECT || (this.middlewareMode === "all" && supervisor.scope === SCOPE_GLOBAL)
        );
        if (want === undefined || want.server.enabled === false || want.scope !== supervisor.scope || middlewareTakes) {
          this.stop(name);
          changed = true;
        }
      }
      for (const [name, want] of desired) {
        if (want.server.enabled === false) continue;
        // runtime 条目豁免中间层跳过（走全局 supervisor 路径，reconcile 不杀 runtime）。
        const isRuntime = this.runtimeRegistry.has(name);
        // 中间层 project/all 模式：项目级（all 含全局）跳过 supervisor（由中间层惰性连接）。
        // runtime 条目例外。
        if (!isRuntime && this.middlewareMode !== "off" && (
          want.scope === SCOPE_PROJECT || (this.middlewareMode === "all" && want.scope === SCOPE_GLOBAL)
        )) continue;
        const existing = this.supervisors.get(name);
        if (existing === undefined || existing.scope !== want.scope) {
          this.start(name, want.scope);
          changed = true;
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
    }
    if (server === undefined) return;
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
   */
  async registerServer(server: Record<string, unknown>): Promise<{ name: string; existing: boolean }> {
    const config = normalizeServer(server);
    const run = this.registerQueue.then(async () => {
      if (this.runtimeRegistry.has(config.name) || this.store.find(config.name) !== undefined) {
        return { name: config.name, existing: true };
      }
      this.runtimeRegistry.set(config.name, config);
      if (this.middlewareMode !== "off") {
        // 中间层模式：runtime 服务器走全局 supervisor 路径（不落盘，不拆单元）。
      }
      if (config.enabled !== false) this.start(config.name, SCOPE_GLOBAL, config);
      return { name: config.name, existing: false };
    });
    this.registerQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 运行时注销（不影响 store 持久化条目；同名 store 条目回落）。
   * - 销毁 supervisor（stop，不碰 store）；
   * - 移除 runtimeRegistry 条目 → 下次 reconcile 回落 store 配置。
   */
  async unregisterServer(name: string): Promise<void> {
    const run = this.registerQueue.then(async () => {
      if (this.runtimeRegistry.has(name)) {
        this.stop(name);
        this.runtimeRegistry.delete(name);
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
    if (this.middlewareMode !== "off" && scope === SCOPE_PROJECT) {
      // 中间层：拆毁当前 root 单元（下次惰性重建读新配置）。
      this.touchMiddlewareUnit();
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
    if (this.middlewareMode !== "off" && scope === SCOPE_PROJECT) {
      // 中间层：拆毁当前 root 单元（下次惰性重建读新配置）。
      this.touchMiddlewareUnit();
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
    }
    if (server === undefined) throw new Error(`server "${name}" not found in ${scope} scope`);
    // 中间层模式：项目级连接走中间层连接池（userDisabled 解除 + 惰性连接）。
    if (this.middlewareMode !== "off" && scope === SCOPE_PROJECT && this.middleware !== undefined) {
      const root = this.projectRoot;
      if (root === undefined) throw new Error("no active project session (call session with a cwd first)");
      const unit = await this.middleware.projectUnitFor(root);
      if (unit === undefined) throw new Error(`workspace ${root} has no project MCP config`);
      unit.userDisabled.delete(name);
      await this.saveUserState(this.middleware.units);
      await this.middleware.ensureConnected(root, name);
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

  async disconnect(name: string): Promise<void> {
    // 中间层模式：项目级断开 → userDisabled 持久化 + 连接池拆毁该连接。
    if (this.middlewareMode !== "off" && this.middleware !== undefined) {
      const unit = [...this.middleware.units.values()].find((entry) => entry.connections.has(name) || entry.userDisabled.has(name));
      if (unit !== undefined) {
        unit.userDisabled.add(name);
        await this.saveUserState(this.middleware.units);
        unit.connections.delete(name);
        return;
      }
    }
    const supervisor = this.supervisors.get(name);
    if (supervisor === undefined) return;
    this.supervisors.delete(name);
    await supervisor.disconnect();
  }

  async reconnect(name: string, scope: string = SCOPE_GLOBAL): Promise<void> {
    await this.disconnect(name);
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
    const taken = scope === SCOPE_PROJECT || (this.middlewareMode === "all" && scope === SCOPE_GLOBAL);
    if (!taken) return undefined;
    const root = scope === SCOPE_PROJECT ? this.projectRoot : MIDDLEWARE_GLOBAL_ROOT;
    return root === undefined ? undefined : mw.units.get(root);
  }

  summarize(server: ServerConfig, scope: string): Record<string, unknown> {
    // 中间层模式（#228 回归修复）：被中间层接管的服务器从连接池 + 目录缓存
    // 投影状态与工具列表——此前只读 supervisors，项目级无 supervisor 条目恒
    // 兜底 "stopped"，浮窗/summary 与真实连接态脱节。返回形状不变。
    // 注意不做 userDisabled 短路：all 模式全局 connect 走 supervisor 复活
    // （#234 既有限制），短路会把「supervisor 实际已连接」反向投影成 stopped。
    const unit = this.middlewareUnitFor(server.name, scope);
    if (unit !== undefined) {
      const entry = unit.connections.get(server.name);
      if (entry !== undefined) {
        const catalog = unit.catalog.get(server.name);
        return {
          ...server,
          scope,
          status: entry.status,
          // 目录发现失败（unavailable）时透出原因：解释 connected 却 0 工具。
          error: entry.error !== undefined ? msgOf(entry.error) : catalog?.unavailable,
          tools: catalog !== undefined && catalog.unavailable === undefined ? [...catalog.tools.keys()] : [],
        };
      }
    }
    const supervisor = this.supervisors.get(server.name);
    return {
      ...server,
      scope,
      status: supervisor?.status ?? (server.enabled === false ? "disabled" : "stopped"),
      error: supervisor?.error !== undefined ? (supervisor.error as Error).message : undefined,
      tools: supervisor?.tools ?? [],
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