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
 * routes / catalog / import），本文件保留插件契约、McpManager、
 * normalizeServer、apply 与各模块的 re-export（导出面不变）。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ServerResponse } from "node:http";
import z from "schemastery";
import { installSettingsNamespace } from "../../../shared/settings-namespace.js";
// 官方类型层（issue #16/#48，锁版见 pnpm-workspace catalog；仅 import type，
// 编译期擦除，禁止运行时值导入——contract-check 有门禁）。
import type { Context, LoggerService } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
// 类型面加载（declare module 合并）：dsh-agent 注入 agent/* 事件（含 pre-step
// waterfall）、dsh-tools 注入 ctx.tools、dsh-system-prompt 注入 ctx.systemPrompt。
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-tools";
import type { ServerConfig } from "./types.js";
import type { CatalogCache, CatalogDecision, CatalogMessage, SupervisorLite, CatalogAgent } from "./catalog.js";

// 组合根内部使用的依赖（re-export 见文件底部）。
import { defaultStorePath, McpStore } from "./store.js";
import { DEFAULT_TOOL_CALL_TIMEOUT_MS, DEFAULT_RESULT_TRUNCATE_BYTES, ConnectionSupervisor } from "./supervisor.js";
import {
  SCOPE_GLOBAL,
  SCOPE_PROJECT,
  normalizeScope,
} from "./scope.js";
import {
  DEFAULT_ANNOUNCE_CATALOG,
  DEFAULT_CATALOG_MAX_ENTRIES,
  catalogCacheFile,
  summarizeToolDescriptions,
  resolveCatalogInjection,
} from "./catalog.js";
import { makeRoutes, makeEventsRoute, makeHealthRoute, sseData, uiConfigChangedFrame } from "./routes.js";

/** 稳定的 cordis 插件名。 */
export const name = "mcp-manager";

/** 需要已初始化的工具注册表、web 服务器与提示词组装器。 */
export const inject = ["tools", "webServer", "systemPrompt"];

/** MCP 服务器名命名空间约束（与官方 dsh-mcp-client 一致）。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;


/** 空 description 工具的条件拼接默认开启。 */
export const DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS = true;

/** MCP 浮窗 UI 配置（插件自身 Config 的 `ui` 子对象，标准 cordis 配置注入）。 */
export interface UiPlacementConfig {
  /** 浮窗胶囊锚点：右上 / 右下（默认 top-right = 历史行为）。 */
  position: "top-right" | "bottom-right";
  /** 胶囊偏移：x 水平、y 垂直、blankY 空白会话垂直偏移。 */
  offset: { x: number; y: number; blankY: number };
}

/** 默认浮窗 UI 配置（与升级前一致，无回归）。 */
export const DEFAULT_UI_CONFIG: UiPlacementConfig = {
  position: "top-right",
  offset: { x: 8, y: 8, blankY: 40 },
};

const UiConfigSchema = z.object({
  position: z.union([z.const("top-right"), z.const("bottom-right")]).default("top-right"),
  offset: z.object({
    x: z.number().default(8),
    y: z.number().default(8),
    blankY: z.number().default(40),
  }).default({ x: 8, y: 8, blankY: 40 }),
});

/** 客户端消费的浮窗 UI 配置（GET /api/dsh-mcp/config 的扁平形状）。 */
export interface ClientUiConfig {
  position: "top-right" | "bottom-right";
  offsetX: number;
  offsetY: number;
  blankY: number;
}

/**
 * 归一化浮窗 UI 配置（纯函数，可单测）。
 * 兼容三种形态：新 `Config.ui` 嵌套、旧隐藏命名空间的扁平 `position/offset`、
 * 客户端扁平 `position/offsetX/offsetY/blankY`。非法或缺失 → 安全回退默认，不抛。
 */
export function normalizeUiConfig(raw: unknown): ClientUiConfig {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const ui = (
    typeof src.ui === "object" && src.ui !== null ? (src.ui as Record<string, unknown>) : src
  ) as Record<string, unknown>;
  const position = ui.position === "bottom-right" ? "bottom-right" : "top-right";
  const offset = (typeof ui.offset === "object" && ui.offset !== null ? ui.offset : {}) as Record<string, unknown>;
  const clampNum = (value: unknown, dflt: number): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : dflt;
  const offsetX = clampNum(ui.offsetX ?? offset.x, DEFAULT_UI_CONFIG.offset.x);
  const offsetY = clampNum(ui.offsetY ?? offset.y, DEFAULT_UI_CONFIG.offset.y);
  const blankY = clampNum(ui.blankY ?? offset.blankY, DEFAULT_UI_CONFIG.offset.blankY);
  return { position, offsetX, offsetY, blankY };
}

/** 面板垂直锚点规则：底部锚点（bottom-right）→ 向上弹出；否则顶部锚点（向下弹出）。 */
export function panelAnchorForPosition(position: string | undefined): "top" | "bottom" {
  return position === "bottom-right" ? "bottom" : "top";
}

/** 面板垂直定位纯函数（供 smoke 断言翻转分支；clamp 到视口内，不溢出）。 */
export function panelTopForAnchor(
  anchor: "top" | "bottom",
  pillTop: number,
  pillBottom: number,
  panelHeight: number,
  gap: number,
): number {
  return anchor === "bottom" ? Math.max(6, pillTop - panelHeight - gap) : Math.max(6, pillBottom + gap);
}

/**
 * 插件 Config schema（标准 cordis 配置注入入口；含 `ui` 子对象）。
 * 迁移后 position/offset 走插件自身 Config 而非隐藏命名空间，设置页插件卡可编辑。
 */
export const Config: z<{
  enabled: boolean;
  announceToAgent: boolean;
  storePath: string;
  announceCatalog: boolean;
  catalogMaxEntries: number;
  enhanceEmptyDescriptions: boolean;
  resultTruncateBytes: number;
  ui: UiPlacementConfig;
}> = z.object({
  enabled: z.boolean().default(true).description("是否启用本插件"),
  announceToAgent: z.boolean().default(true).description("是否向 Agent 宣告插件（能力清单由 <available_mcp_servers> 承担）"),
  storePath: z.string().description("全局服务器配置路径，留空用默认 <DSH_HOME>/dsh-mcp.json").disabled(true),
  announceCatalog: z.boolean().default(DEFAULT_ANNOUNCE_CATALOG).description("是否注入 MCP 能力目录（<available_mcp_servers>）"),
  catalogMaxEntries: z.number().default(DEFAULT_CATALOG_MAX_ENTRIES).description("目录注入条目上限").disabled(true),
  enhanceEmptyDescriptions: z.boolean().default(DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS).description("空描述工具条件拼接自定义描述"),
  resultTruncateBytes: z.number().default(DEFAULT_RESULT_TRUNCATE_BYTES).description("工具结果截断字节数").disabled(true),
  ui: UiConfigSchema,
});


// ------------------------------------------------------------ 管理器

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
  sseConnections?: Set<ServerResponse>;

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
  }

  /** 读取 settings 命名空间中的 MCP UI 配置（供 /api/dsh-mcp/config 返回）。 */
  uiConfig(): ClientUiConfig {
    return normalizeUiConfig(this.uiConfigSource());
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

  emitStatus(): void {
    for (const handler of [...this.listeners]) handler();
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
   */
  async catalogServersFor(cwd: string | undefined): Promise<Map<string, { server: ServerConfig; scope: string }>> {
    const servers = new Map<string, { server: ServerConfig; scope: string }>();
    for (const server of this.store.data.servers) {
      if (server.enabled === false) continue;
      servers.set(server.name, { server, scope: SCOPE_GLOBAL });
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
   * 会话切换：按 cwd 发现项目根，停掉旧项目的项目级服务器，加载并连接
   * 新项目的项目级服务器。全局服务器不受影响。
   */
  async setSession(cwd: string | undefined): Promise<void> {
    const root = cwd === undefined || cwd === null || cwd === "" ? undefined : await this.findProjectRoot(cwd);
    if (root === this.projectRoot && this.projectStore !== undefined) return;
    // 本就没有活动项目且新会话同样无项目（空 cwd）：保持幂等，避免反复
    // emitStatus → SSE → 客户端 refresh 的广播循环。
    if (root === undefined && this.projectStore === undefined) return;
    for (const [name, supervisor] of [...this.supervisors]) {
      if (supervisor.scope === SCOPE_PROJECT) {
        this.supervisors.delete(name);
        await supervisor.disconnect();
      }
    }
    this.projectRoot = root;
    this.projectStore = undefined;
    if (root !== undefined) {
      // projectStoreFor 内部做磁盘变更检测（外部修改 mcp.json 自动重读）。
      this.projectStore = await this.projectStoreFor(root);
    }
    // 全局配置同样重读（外部手动编辑 ~/.dsh/dsh-mcp.json）。
    try {
      await this.store.reloadIfChanged();
    } catch (error) {
      this.logger.warn(`dsh-mcp-manager: reload global config failed: ${String(error)}`);
    }
    this.reconcileServers();
    this.emitStatus();
  }

  /**
   * 重读磁盘配置（全局 + 当前项目）并同步连接集合。
   * 供「浮窗刷新」等读取路径调用：外部修改 mcp.json 后无需重启宿主。
   * 仅在配置或连接集合实际变化时广播，避免空转 SSE → 客户端 refresh 循环。
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
      let changed = false;
      for (const [name, supervisor] of [...this.supervisors]) {
        const want = desired.get(name);
        if (want === undefined || want.server.enabled === false || want.scope !== supervisor.scope) {
          this.stop(name);
          changed = true;
        }
      }
      for (const [name, want] of desired) {
        if (want.server.enabled === false) continue;
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

  start(name: string, scope: string = SCOPE_GLOBAL): void {
    const store = scope === SCOPE_PROJECT ? this.projectStore : this.store;
    if (store === undefined) return;
    const server = store.find(name);
    if (server === undefined) return;
    const existing = this.supervisors.get(name);
    if (existing !== undefined && existing.client !== undefined) return;
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

  async add(server: Record<string, unknown>, scope: string = SCOPE_GLOBAL): Promise<ServerConfig> {
    const config = normalizeServer(server);
    const store = scope === SCOPE_PROJECT ? await this.projectStoreOrThrow() : this.store;
    if (store.find(config.name) !== undefined) {
      throw new Error(`server "${config.name}" already exists in ${scope} scope`);
    }
    store.upsert(config);
    await store.save();
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
    if (merged.enabled !== false) {
      // 编辑后重新连接（即便此前未连接）
      this.start(name, scope);
    }
    return merged;
  }

  async remove(name: string, scope: string = SCOPE_GLOBAL): Promise<void> {
    const store = scope === SCOPE_PROJECT ? await this.projectStoreOrThrow() : this.store;
    this.stop(name);
    store.remove(name);
    await store.save();
  }

  async connect(name: string, scope: string = SCOPE_GLOBAL): Promise<void> {
    const store = scope === SCOPE_PROJECT ? await this.projectStoreOrThrow() : this.store;
    const server = store.find(name);
    if (server === undefined) throw new Error(`server "${name}" not found in ${scope} scope`);
    const existing = this.supervisors.get(name);
    if (existing !== undefined && existing.client !== undefined) return;
    if (existing !== undefined && existing.scope !== scope) throw new Error(`server "${name}" is registered in scope "${existing.scope}"`);
    if (existing !== undefined) existing.disposed = true;
    const supervisor = new ConnectionSupervisor(this, server, scope);
    this.supervisors.set(name, supervisor);
    await supervisor.connect();
  }

  async disconnect(name: string): Promise<void> {
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
    const byStatus: Record<string, number> = { connected: 0, connecting: 0, reconnecting: 0, disabled: 0, stopped: 0, failed: 0 };
    for (const server of servers) byStatus[server.status as string] = (byStatus[server.status as string] ?? 0) + 1;
    return {
      cwd: this.projectRoot ?? undefined,
      projectRoot: this.projectRoot ?? undefined,
      servers,
      counts: byStatus,
    };
  }

  summarize(server: ServerConfig, scope: string): Record<string, unknown> {
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
    for (const supervisor of this.supervisors.values()) {
      supervisor.disposed = true;
      if (supervisor.reconnectTimer !== undefined) clearTimeout(supervisor.reconnectTimer);
      await supervisor.syncChain;
      for (const dispose of supervisor.toolDisposers.values()) dispose();
    }
    this.supervisors = new Map();
  }
}

/** 校验并规范化一条服务器配置。 */
export function normalizeServer(input: unknown): ServerConfig {
  if (typeof input !== "object" || input === null) throw new Error("server config must be an object");
  const src = input as Record<string, unknown>;
  const name = String(src.name ?? "").trim();
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`server name must match ${SERVER_NAME_PATTERN.source}`);
  }
  const transport = src.transport === "streamable-http" ? "streamable-http" : src.transport === "stdio" ? "stdio" : undefined;
  if (transport === undefined) throw new Error('transport must be "stdio" or "streamable-http"');
  if (transport === "stdio") {
    if (typeof src.command !== "string" || (src.command as string).trim() === "") {
      throw new Error("stdio server requires a command");
    }
  } else {
    if (typeof src.url !== "string" || (src.url as string).trim() === "") {
      throw new Error("streamable-http server requires a url");
    }
    try {
      new URL(src.url as string);
    } catch {
      throw new Error(`invalid url: ${src.url}`);
    }
  }
  const server: ServerConfig = {
    name,
    transport,
    enabled: src.enabled !== false,
    toolCallTimeoutMs: typeof src.toolCallTimeoutMs === "number" && (src.toolCallTimeoutMs as number) > 0
      ? Math.floor(src.toolCallTimeoutMs as number)
      : DEFAULT_TOOL_CALL_TIMEOUT_MS,
    reconnect: (src.reconnect as Record<string, unknown> | undefined) ?? {},
    // 能力目录的自定义描述（用户手写；MCP 协议无服务器级自描述，完整保留不截断）。
    description: typeof src.description === "string" && (src.description as string).trim() !== ""
      ? (src.description as string).trim()
      : undefined,
  };
  if (transport === "stdio") {
    server.command = src.command as string;
    if (Array.isArray(src.args)) server.args = (src.args as unknown[]).map(String);
    if (typeof src.cwd === "string" && (src.cwd as string) !== "") server.cwd = src.cwd as string;
    if (typeof src.env === "object" && src.env !== null) {
      server.env = Object.fromEntries(Object.entries(src.env as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
    }
  } else {
    server.url = src.url as string;
    if (typeof src.headers === "object" && src.headers !== null) {
      server.headers = Object.fromEntries(Object.entries(src.headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
    }
  }
  return server;
}

// -------------------------------------------------------------- 提示词

/** 向 Agent 宣告插件（announceToAgent 开启时注入）。能力清单由动态目录
 * （<available_mcp_servers>，见 L1）承担，此处只说明管理界面与使用约束。 */
export const MCP_GUIDANCE =
  "本机已安装 dsh-mcp-manager 插件（DSH MCP 管理器）：会话界面右上角浮窗管理 MCP 服务器（全局配置 ~/.dsh/dsh-mcp.json；项目级配置 <项目根>/.dsh/mcp.json，跟随会话切换展示并连接对应项目的服务器；支持 stdio / streamable-http，可粘贴 mcpServers JSON 导入，不预设任何服务器）。已配置服务器的能力清单见会话内的 <available_mcp_servers>（仅描述能力，不代表连接状态）；服务器连接后其工具以 mcp__<server>__<tool> 注册可用。限制：MCP 工具在真实服务器上执行，先确认再操作；stdio 服务器的子进程继承宿主权限；工具结果可能含敏感信息。用户提到「MCP / mcp 服务 / 上下文服务器」时即指本插件，请据此协作。";

// -------------------------------------------------------------- 挂载

/**
 * 挂载 MCP 管理器：加载存储、启动已启用服务器、注册路由与提示词。
 * @param {import("@deepseek-ai/cordis").Context} ctx - 宿主插件上下文。
 * @param config 解析后的插件配置。
 */
export async function apply(ctx: Context, config: Record<string, unknown> | undefined): Promise<void> {
  const enabled = config?.enabled !== false;
  const announceToAgent = config?.announceToAgent !== false;
  const storePath = typeof config?.storePath === "string" && config.storePath !== ""
    ? config.storePath
    : defaultStorePath();

  // 感知增强配置（对抗性评审 v2）。默认值引用具名常量（单一事实源）。
  const announceCatalog = (config?.announceCatalog as boolean | undefined) ?? DEFAULT_ANNOUNCE_CATALOG;
  const catalogMaxEntries = Number.isFinite(config?.catalogMaxEntries) && (config?.catalogMaxEntries as number) > 0 ? Math.floor(config?.catalogMaxEntries as number) : DEFAULT_CATALOG_MAX_ENTRIES;
  const enhanceEmptyDescriptions = (config?.enhanceEmptyDescriptions as boolean | undefined) ?? DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS;
  const resultTruncateBytes = Number.isFinite(config?.resultTruncateBytes) && (config?.resultTruncateBytes as number) > 0 ? Math.floor(config?.resultTruncateBytes as number) : DEFAULT_RESULT_TRUNCATE_BYTES;

  const store = new McpStore(storePath);
  await store.load();
  const manager = new McpManager(ctx, store);
  manager.enhancement = { enhanceEmptyDescriptions, resultTruncateBytes };

  // 插件自身 Config schema（标准 cordis 配置注入路径）：position/offset 不再藏于
  // 隐藏命名空间，设置页插件卡可编辑；配置变更经既有 SSE events 通道广播一帧，
  // 客户端收到后重新 GET /api/dsh-mcp/config 就地更新浮窗位置（无需重启/轮询）。
  const broadcastUiConfigChanged = () => {
    for (const res of manager.sseConnections ?? []) {
      try {
        res.write(uiConfigChangedFrame());
      } catch {
        // 连接已断，等待 close 事件清理
      }
    }
  };
  installSettingsNamespace(ctx, "dsh-mcp-manager", Config, config ?? {}, {
    setSource: (source) => {
      manager.uiConfigSource = source as () => any;
    },
    onChange: () => {
      broadcastUiConfigChanged();
    },
  });


  let disposeRoutes = () => {};
  let disposeSection = () => {};
  let disposeInjection = () => {};

  if (enabled) {
    await manager.startAll();
    await manager.loadCatalogCache();

    // L1 能力目录注入（history-based 去重，仿 dsh-tool-skill catalog）：
    // 决策逻辑在 resolveCatalogInjection（纯函数，可单测）。
    if (announceCatalog) {
      // 官方强类型 payload：PreStepDecision waterfall（{kind:'reject'}|{kind:'enter';messages}）。
      // 目录决策逻辑在纯函数 resolveCatalogInjection（自建 CatalogDecision 宽面，
      // 可单测），此处仅做边界收窄/放宽。
      disposeInjection = ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
        const decision = await next();
        signal.throwIfAborted();
        // 目录数据源按会话 cwd 计算（工作区缓存），不跟随 host 的"当前工作区"
        // 实时状态——切换工作区不改变本会话目录集合，MCP 没变化就不重复注入。
        const supervisors = await manager.catalogServersFor(agent?.session?.header?.cwd);
        // 边界放宽：纯函数吃自建宽面 CatalogDecision，返回值即本轮 PreStepDecision
        return resolveCatalogInjection(
          decision as unknown as CatalogDecision,
          messages as CatalogMessage[],
          supervisors as Map<string, SupervisorLite>,
          catalogMaxEntries,
          manager.catalogCache,
          agent as unknown as CatalogAgent | undefined
        ) as unknown as PreStepDecision;
      });
    }

    disposeRoutes = ctx.effect(() => {
      const routes = makeRoutes(manager);
      const eventsRoute = makeEventsRoute(manager);
      const healthRoute = makeHealthRoute(manager);
      const disposers = [...routes, eventsRoute, healthRoute].map((route) => ctx.webServer.register(route));
      // 状态变化 → 广播 SSE 帧（连接集合在 makeEventsRoute 中惰性创建）。
      const unsubscribeStatus = manager.onStatus(() => {
        for (const res of manager.sseConnections ?? []) {
          try {
            res.write(sseData({ type: "summary" }));
          } catch {
            // 连接已断，等待 close 事件清理
          }
        }
      });
      return () => {
        unsubscribeStatus();
        for (const dispose of disposers) dispose();
        for (const res of manager.sseConnections ?? []) {
          try {
            res.destroy();
          } catch {
            // 已关闭
          }
        }
        if (manager.sseConnections !== undefined) manager.sseConnections.clear();
      };
    }, "dsh-mcp-manager: routes");
    if (announceToAgent) {
      // 官方 SystemPrompt.section(opts) 签名（PromptSection）；此处传参满足其形状，
      // 经 unknown 中转以维持局部最小面写法。
      disposeSection = (ctx.systemPrompt as unknown as { section(opts: Record<string, unknown>): () => void }).section({
        name: "plugin:dsh-mcp-manager",
        order: 160,
        text: MCP_GUIDANCE,
      });
    }
  }

  ctx.effect(() => () => {
    disposeInjection();
    disposeSection();
    disposeRoutes();
    void manager.dispose();
  }, "dsh-mcp-manager: dispose");
}

// ------------------------------------------------------------ re-export
// 导出面与拆分前 lib/index.js 完全一致（smoke 验收契约）。

// 存储
export { defaultStorePath, McpStore } from "./store.js";
// 传输
export { expandEnv, HttpTransport, parseSsePayload, StdioTransport, createTransport } from "./transport.js";
// 协议
export { MCPClient } from "./protocol.js";
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
} from "./supervisor.js";
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
} from "./catalog.js";
// mcpServers JSON 导入
export { fromClaudeEntry, parseClaudeJson } from "./import.js";
// 路由
export { ROUTES, makeRoutes, makeEventsRoute, makeHealthRoute, sseData, uiConfigChangedFrame, broadcastFrame } from "./routes.js";
export { SCOPE_GLOBAL, SCOPE_PROJECT, normalizeScope } from "./scope.js";
// 仓库共享层（loopback 围栏 / writeJson / readJsonBody）
export { isLoopbackRequest } from "../../../shared/loopback.js";
export { writeJson, readJsonBody } from "../../../shared/host-utils.js";
