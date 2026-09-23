/**
 * dsh-mcp-manager — MCP 服务器管理器（单一事实源）。
 *
 * McpManager 持有全局存储 + 当前会话项目的项目级存储、连接池宿主面与状态通知。
 * 全局服务器常连；项目级服务器（<项目根>/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json）只在当前会话 cwd 属于
 * 该项目时连接（跟随会话切换）。
 *
 * **单池（#767 笔 1a）**：连接只有一本账 = 中间层单元表 `middleware.units`
 * （键 = (root, 裸名)）。此前 manager 自持的那条「直连账本」并行路径已整体退役
 * ——池归属判定（旧 `middlewareTakes`）恒真，本类不再持有任何条目表。
 *
 * 类型自各域门面取；manager.ts 不 import apply.ts / index.ts（防循环引用）。
 */

import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { SseHub } from "../../../../../../shared/sse-hub.js";
import type { Context, LoggerService } from "@deepseek-ai/cordis";
import type { ServerConfig } from "../../config/interface.ts";
import type { ClientUiConfig } from "../../../shared/interface.ts";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { CatalogCache, CatalogViewResolver, SchemaView } from "../../catalog/interface.ts";
import type { McpStore } from "../../store/interface.ts";
import type { McpStatsCollector } from "../../stats/interface.ts";
import type { McpMiddleware } from "../runtime/interface.ts";
import type { ConnectionEntry, ProjectUnit } from "../interface.ts";
import type { DisabledToolsMap } from "../../store/interface.ts";
import {
  EMPTY_STATUS_COUNTS,
  MIDDLEWARE_GLOBAL_ROOT,
  SCOPE_GLOBAL,
  SCOPE_PROJECT,
  SERVER_STATES,
} from "../../../shared/interface.ts";
import { orchestratorPorts } from "./impl/service/index.ts";
import { fileMode, readTextFile, writeFileAtomic } from "../../shared/interface.ts";

/**
 * 计算期望连接集合：回答「池里该有哪些 (root, 裸名)？」——全局 store + 项目级 store
 * （同名跨 root 各成一条）+ runtime 注入（同名优先）；释放与触达的执行在
 * reconcileServers 内（不同问题）。
 *
 * 模块函数而非私有方法：类成员会进入 .d.ts 声明块（导出面快照按块比对），
 * 纯内部分拆放模块级才能让导出面零 diff。 */
function buildDesiredServers(
  store: McpStore,
  projectStore: McpStore | undefined,
  runtimeRegistry: Map<string, ServerConfig>,
  poolRootFor: (scope: string) => string,
): Map<string, { name: string; server: ServerConfig; scope: string }> {
  const desired = new Map<string, { name: string; server: ServerConfig; scope: string }>();
  const keyFor = (scope: string, name: string): string => `${poolRootFor(scope)}\u0000${name}`;
  for (const server of store.data.servers) {
    desired.set(keyFor(SCOPE_GLOBAL, server.name), {
      name: server.name,
      server,
      scope: SCOPE_GLOBAL,
    });
  }
  if (projectStore !== undefined) {
    for (const server of projectStore.data.servers) {
      const key = keyFor(SCOPE_PROJECT, server.name);
      // 同名跨 root 各成一条（键含 root）——不再「项目级被全局顶掉」。
      if (!desired.has(key)) {
        desired.set(key, { name: server.name, server, scope: SCOPE_PROJECT });
      }
    }
  }
  // 双轨合并：runtimeRegistry（内存态，运行时注入）并入 desired，同名 runtime 优先。
  for (const [name, server] of runtimeRegistry) {
    desired.set(keyFor(SCOPE_GLOBAL, name), { name, server, scope: SCOPE_GLOBAL });
  }
  return desired;
}

/**
 * 目录缓存写盘（H2 等价接入，#767 S2-C）：登记路径（`catalogSummaryFile`）经
 * file-io `writeFileAtomic`（mode 取登记表 + 同路径写串行 + 失败清理临时名）；
 * 未登记路径（单测 tmp 覆盖 `catalogCachePath`）回落既有直写形状——`writeFileAtomic`
 * 对未登记路径抛 I6，直接调等于把回落写盘变成 warn（store.save 的 S2-B 同式）。
 * 序列化形状（`{ version: 1, entries }` + 2 空格）逐字节不变：序列化收敛不是本笔的事。
 *
 * 模块函数而非私有方法：类成员会进入 .d.ts 声明块（导出面快照按块比对），
 * 纯内部分拆放模块级才能让导出面零 diff。 */
async function writeCatalogCacheFile(file: string, data: string): Promise<void> {
  let registered = true;
  try {
    fileMode(file);
  } catch {
    registered = false;
  }
  if (registered) {
    await writeFileAtomic(file, data);
    return;
  }
  const dir = dirname(file);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  // R2 硬化（#767 S2-C 筆3）：回落临时名加随机后缀 + 失败清理（与 file-io `writeOnce` 同式）；
  // mode 沿既有回落形状（无 mode），只补唯一性与清理，不改写盘语义。
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, "utf8");
    await rename(tmp, file);
  } catch (cause) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/**
 * #770-A3 只读投影：回答「GET /servers 给 GUI 看什么？」——配置中的凭据永不明文下发。
 *
 * - env/headers：敏感值整体省略（字段缺省，不用 "[REDACTED]" 占位符——占位符会被
 *   客户端表单原样读回并 PATCH 落盘，把占位符写成真凭据；省略后缺键在写路径即「沿用既有」）。
 *   GUI 需区分「有秘密（空白即保留）」与「无秘密」时看 hasSecrets 布尔。
 * - url：按 B8 仅脱敏 userinfo/searchParams（username/password/查询值替换为
 *   "[REDACTED]"，原串形态替换、host/path/查询键保留可诊断）；非法 URL 原样返回。
 * - toolDefinitions/status 不进投影：前者是运行时内存面（含函数，不可序列化），
 *   后者由 summarize 按读时刷新重算。
 *
 * 写路径永不消费投影值：add/update/normalizeServer 只读客户端表单直送的完整配置，
 * 从不读 summary()/summarize() 的产出；投影中的省略（缺键）与脱敏 URL 若被回写，
 * update 经 stripProjectionPatch 丢弃并沿用既有值（回写链由单测锁定）。
 *
 * 模块函数而非私有方法：类成员会进入 .d.ts 声明块（导出面快照按块比对），
 * 纯内部分拆放模块级才能让导出面零 diff。 */
function hasProjectionSecrets(server: ServerConfig): boolean {
  if (server.env !== undefined && Object.keys(server.env).length > 0) return true;
  if (server.headers !== undefined && Object.keys(server.headers).length > 0) return true;
  if (typeof server.url === "string" && server.url !== "") {
    try {
      const parsed = new URL(server.url);
      if (parsed.username !== "" || parsed.password !== "") return true;
      for (const value of parsed.searchParams.values()) {
        if (value !== "") return true;
      }
    } catch {
      // 非法 URL 无可判秘密，按无秘密处理（normalizeServer 写时仍会拒绝非法 URL）。
    }
  }
  return false;
}

/**
 * URL 只读投影（B8 口径）：仅 userinfo/searchParams 值替换为 "[REDACTED]"，
 * host/path/查询键保留。原串形态替换（decoded + percent-encoded 双形态同 B8
 * addSecretPair），非法 URL 原样返回。
 *
 * 模块函数而非私有方法：理由同上（导出面零 diff）。 */
function redactUrlForSummary(url: unknown): string | undefined {
  if (typeof url !== "string" || url === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const secrets = new Set<string>();
  const addSecret = (value: string): void => {
    if (value.length === 0) return;
    secrets.add(value);
    try {
      secrets.add(encodeURIComponent(value));
    } catch {
      // 编码失败忽略 raw 形态，decoded 已注册（与 pipeline redact 同式）。
    }
  };
  addSecret(parsed.username);
  addSecret(parsed.password);
  for (const value of parsed.searchParams.values()) addSecret(value);
  if (secrets.size === 0) return url;
  const ordered = [...secrets].sort((left, right) => right.length - left.length);
  let out = url;
  for (const secret of ordered) out = out.split(secret).join("[REDACTED]");
  return out;
}

/**
 * 单条服务器配置的只读投影（summarize 两分支共用）：安全字段原样带上，
 * env/headers 值省略、url 按 B8 脱敏、附 hasSecrets 布尔。
 *
 * 模块函数而非私有方法：理由同上（导出面零 diff）。 */
function projectServerForSummary(server: ServerConfig): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    name: server.name,
    transport: server.transport,
  };
  if (server.enabled !== undefined) projected.enabled = server.enabled;
  if (server.toolCallTimeoutMs !== undefined)
    projected.toolCallTimeoutMs = server.toolCallTimeoutMs;
  if (server.reconnect !== undefined) projected.reconnect = server.reconnect;
  if (server.description !== undefined) projected.description = server.description;
  let argsHadSecret = false;
  if (server.transport === "stdio") {
    if (server.command !== undefined) projected.command = server.command;
    if (server.args !== undefined) {
      // #925：凭据形 flag 的参数值掩码（与 pipeline redact 同口径，端口取）；
      // flag 名与非秘密元素保留可诊断，掩码值回写时由 stripProjectionPatch 丢弃。
      const masked = orchestratorPorts.get().pipeline.maskSecretArgsForDisplay(server.args ?? []);
      projected.args = masked;
      argsHadSecret = masked.some((entry) => entry.includes("[REDACTED]"));
    }
    if (server.cwd !== undefined) projected.cwd = server.cwd;
    // env 整体省略（见本块头注释）；有无秘密只经 hasSecrets 告知 GUI。
  } else {
    const redactedUrl = redactUrlForSummary(server.url);
    if (redactedUrl !== undefined) projected.url = redactedUrl;
    // headers 整体省略（同 env）。
  }
  projected.hasSecrets = hasProjectionSecrets(server) || argsHadSecret;
  return projected;
}

/**
 * 写路径回写 guard（update 用）：投影值永不落盘——含 "[REDACTED]"（及 URL 序列化后的
 * "%5BREDACTED%5D"）的 url 整字段丢弃、env/headers 内含占位符的键丢弃（整表被清空则
 * 整字段丢弃），调用方沿既有值保留。add 无既有值可保，命中占位符即抛错（见 add）。
 *
 * 模块函数而非私有方法：理由同上（导出面零 diff）。 */
function stripProjectionPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...patch };
  const isProjection = (value: unknown): boolean =>
    typeof value === "string" && (value.includes("[REDACTED]") || value.includes("%5BREDACTED%5D"));
  if (isProjection(next.url)) delete next.url;
  if (Array.isArray(next.args) && next.args.some((entry) => isProjection(entry))) delete next.args;
  for (const key of ["env", "headers"] as const) {
    const table = next[key];
    if (typeof table === "object" && table !== null && !Array.isArray(table)) {
      const kept = Object.entries(table as Record<string, unknown>).filter(
        ([, value]) => !isProjection(value),
      );
      if (kept.length === 0) delete next[key];
      else next[key] = Object.fromEntries(kept);
    }
  }
  return next;
}

/**
 * 管理器：持有全局存储 + 当前会话项目的项目级存储、连接池宿主面与状态通知。
 * 全局服务器常连；项目级服务器（<项目根>/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json）只在当前会话 cwd 属于
 * 该项目时连接（跟随会话切换）。
 */
export class McpManager {
  ctx: Context;
  store: McpStore;
  listeners: Set<() => void>;
  logger: LoggerService;
  projectRoot: string | undefined;
  projectStore: McpStore | undefined;
  reconcileBusy: boolean;
  projectStores: Map<string, McpStore>;
  catalogCache: CatalogCache;
  catalogCachePath: string;
  uiConfigSource: () => unknown;
  /** 设置命名空间写入 sink（apply 时经 ctx.inject(["settings"]) 注入；注入不到则写不可用）。 */
  uiUpdate?: (patch: Record<string, unknown>) => Promise<unknown>;
  /**
   * SSE 连接枢纽（共享 shared/sse-hub，#515）：makeEventsRoute 惰性创建；
   * 广播/卸载 disposer 收口到 hub（连接表 + 心跳 + stalled/maxAge 主动回收）。
   * 取代旧 sseConnections Set + per-connection 心跳（#268）。
   */
  sseHub?: SseHub;
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
      catalogCachePathFor: (root) => this.catalogCachePathFor(root),
    });
    this.uiConfigSource = () => ({ position: "top-right", offsetX: 8, offsetY: 8, blankY: 40 });
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
      const raw = await readTextFile(this.catalogCachePath);
      if (raw === null) return;
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
      const payload = { version: 1, entries: Object.fromEntries(this.catalogCache) };
      await writeCatalogCacheFile(this.catalogCachePath, JSON.stringify(payload, null, 2));
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

  /** 单元的 root：项目级取当前项目根，其余取全局虚拟 root（与中间层单元同口径）。 */
  private poolRootFor(scope: string): string {
    return scope === SCOPE_PROJECT
      ? (this.projectRoot ?? MIDDLEWARE_GLOBAL_ROOT)
      : MIDDLEWARE_GLOBAL_ROOT;
  }

  /**
   * 注册名中段 → (root, 裸名) 反查（id 化的 mcp__ 注册名还原成禁用表键）。
   *
   * 为什么由 manager 提供：id 是装载期由官方实例的 serverName 定下的（裁定 AG① 明确 id 不进
   * 注入面），只有自持账本的一侧知道 (id → root, 裸名)。注入端在装配点把这个能力**按入参**递进
   * guard（与既有 resolveRoot 同一形态），因此不新增跨域值边、也不动任何端口键。
   */
  serverNameForId(id: string): { root: string; server: string } | undefined {
    for (const unit of this.middleware?.units.values() ?? []) {
      for (const [name, entry] of unit.connections) {
        if (entry.id === id) return { root: unit.root, server: name };
      }
    }
    return undefined;
  }

  /**
   * 公共查询面 `ctx.mcpManager.getTools` 的数据源（M5 = A，本笔换源）：该服务器在
   * 连接池里的**注册名**清单（`mcp__<id>__<tool>`，与 `ctx.tools` 注册表一致）。
   *
   * 口径不变：返回注册名、不是裸名（裸名是 `summary().tools` / 目录读口的口径）。
   * 数据源从旧直连账本的 `toolMeta` 换成**单元表**——旧实现只由直连路径填充，被中间层
   * 接管的服务器恒返回 `[]`（既有缺陷 A13/B6）；单池合并后那条路径已不存在。
   *
   * 虚拟连接单元（toolDefinitions，无 id/handle）没有宿主注册名，返回空表。
   */
  registeredToolsFor(name: string): Array<{ name: string; description?: string }> {
    const entry = this.poolEntryFor(name);
    if (entry?.id === undefined) return [];
    const prefix = `mcp__${entry.id}__`;
    const tools: Array<{ name: string; description?: string }> = [];
    for (const schema of this.registeredSchemas()) {
      const toolName = schema?.name;
      if (typeof toolName !== "string" || !toolName.startsWith(prefix)) continue;
      tools.push({
        name: toolName,
        description: typeof schema.description === "string" ? schema.description : undefined,
      });
    }
    return tools;
  }

  /** 池内该裸名的连接条目（跨单元查；同名跨 root 各成一条，取先命中者，与旧账本同口径）。 */
  private poolEntryFor(name: string): ConnectionEntry | undefined {
    for (const unit of this.middleware?.units.values() ?? []) {
      const entry = unit.connections.get(name);
      if (entry !== undefined) return entry;
    }
    return undefined;
  }

  onStatus(handler: () => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** 脱敏秘密源的唯一事实源（#770-8）：全局 store + 全部 projectStores 缓存 + runtimeRegistry。
   *
   * 为什么是同步快照：middleware 的 redact/callTool 与本类的 redactError 都是同步路径，
   * 而按 root 取配置的 projectServersFor 是 async（同步内不可 await）；脱敏只读已在内存的
   * 缓存快照，不触发磁盘读。未进缓存的项目 root 不在此列——要读它必须走 async 链（本相按
   * 裁决不做，调用链保持同步，见 MiddlewareHost.redactionServers）。
   *
   * 为什么含 disabled/unconnected：凭据是否出现在错误文案与服务器当下是否启用/已连接
   * 无关——未连接与 disabled 条目的 secret 同样须抹掉（双向缺口的反例）。此处不做
   * enabled 过滤，调用方也不得再过滤。
   *
   * 三处同调：本方法 ↔ middleware.redact ↔ dispatch redactMcpError（经 host.redactionServers
   * 转供的同一快照），底层同 pipeline.createRedactor。
   *
   * #770-A1：快照在调用方展开 ${ENV} 模板（经 configModel.expandServerEnv）再交
   * createRedactor——错误文案里出现的是展开后的凭据明文，不是落盘的模板字面量；
   * redactor 内禁止读 process.env（保持纯函数），展开是调用方的职责。无模板时
   * 展开恒等（新对象、值不变）；未设置的变量展开为空串，由 addSecretPair 跳过
   * （空串不注册，避免把空匹配当秘密）。 */
  getRedactionServers(): ServerConfig[] {
    const { configModel } = orchestratorPorts.get();
    const servers: ServerConfig[] = this.store.data.servers.map((server) =>
      configModel.expandServerEnv(server),
    );
    for (const store of this.projectStores.values()) {
      for (const server of store.data.servers) servers.push(configModel.expandServerEnv(server));
    }
    if (
      this.projectStore !== undefined &&
      ![...this.projectStores.values()].includes(this.projectStore)
    ) {
      for (const server of this.projectStore.data.servers)
        servers.push(configModel.expandServerEnv(server));
    }
    for (const server of this.runtimeRegistry.values())
      servers.push(configModel.expandServerEnv(server));
    return servers;
  }

  /** B8：错误日志脱敏（经 getRedactionServers 全集 + createRedactor）。
   * 日志与 HTTP body 同口径（C-ERR 契约），error 可能含凭据明文。
   * #770-A2：公开给路由错误边界（RoutesManager.redactError）——manager 已是
   * 路由的结构参数，复用同一秘密源，不为 api 域另开脱敏口（附录 G·G19：api 域
   * 不直持 manager 实例 beyond 既有结构参数，脱敏能力经此方法面递入）。
   * 每次现建 redactor（per-request 可接受：错误路径低频，无缓存必要）。 */
  redactError(error: unknown): string {
    return orchestratorPorts.get().pipeline.createRedactor(this.getRedactionServers())(error);
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
   * 中间层宿主：按 root 读取服务器配置。虚拟 root "@global" 返回
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

  /** 中间层宿主：全局服务器配置（@global 单元装载用）。 */
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

  /**
   * 初始化中间层（apply 时无条件调用；幂等）。单池合并后连接池是唯一连接路径，
   * 池归属恒为「全部服务器」——#767 笔 2 删掉 `middlewarePolicy` 后不再接受任何入参。
   */
  async initMiddleware(): Promise<McpMiddleware> {
    const { runtime, configStore, workspace } = orchestratorPorts.get();
    if (this.middleware !== undefined) return this.middleware;
    const mw = new runtime.McpMiddleware({
      ctx: this.ctx,
      logger: this.logger,
      projectServersFor: (root) => this.projectServersFor(root),
      redactionServers: () => this.getRedactionServers(),
      globalServers: () => this.globalServers(),
      normalizedProjectRoot: (cwd) => workspace.normalizedProjectRoot(cwd),
      saveUserState: (units) => this.saveUserState(units),
      emitStatus: () => this.emitStatus(),
      catalogCachePath: (root) => this.catalogCachePathFor(root),
      isGlobalServer: (name) => this.isGlobalServer(name),
      isRuntimeServer: (name) => this.isRuntimeServer(name),
      recordCatalogTools: (name, tools) => this.recordCatalogTools(name, tools),
    });
    try {
      // 加载 userDisabled 并注入中间层实例（单元创建时合并；重启不丢）。
      this.disabledByRoot = await configStore.loadUserState(this.userStatePath);
      mw.disabledByRoot = this.disabledByRoot;
      // 加载工具级禁用（三层结构；合并式写盘，绝不整表覆盖）。
      this.disabledTools = await configStore.loadDisabledTools(this.userStatePath);
      mw.disabledTools = this.disabledTools;
    } catch (error) {
      // #392 遗留⑤：加载失败时清理半初始化状态——this.middleware 保持未赋值，
      // 不会被后续逻辑当已初始化实例使用。
      this.disabledByRoot = new Map();
      this.disabledTools = new Map();
      throw error;
    }
    this.middleware = mw;
    return mw;
  }

  /** userDisabled 映射（root → Set<server>），中间层单元创建时合并。 */
  disabledByRoot: Map<string, Set<string>> = new Map();

  /** 工具级禁用（root → server → Set<tool>）；root=@global 跨工作空间共享。 */
  disabledTools: DisabledToolsMap = new Map();

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
    const { configStore, upgrade } = orchestratorPorts.get();
    let store = this.projectStores.get(root);
    if (store === undefined) {
      // 读前落定包分区新形态（S2-D 反转装饰）：触发时机由 upgrade 包装内卡——先搬后读
      // `await` 串行；`new` 留本侧经既有 ConfigStorePort（upgrade 域不认业务）。落定失败即抛
      //（禁回落 undefined），回调不执行、不缓存半成品。
      store = await upgrade.withSettledProjectConfig(root, this.logger, async (settledPath) => {
        const fresh = new configStore.McpStore(settledPath);
        await fresh.load();
        return fresh;
      });
      this.projectStores.set(root, store);
    } else {
      // 缓存命中也要检查磁盘：项目 mcp.json 在 git 仓库内，pull/checkout/手动
      // 编辑后应自动生效，不依赖重启宿主（只重读配置，不启停连接）。
      // #903 M5-A：命中分支同样先过 settle 包装——旧扁平 legacy 在首次缓存后重现
      // （切旧分支/降级写）时，否则永不归位；settle 幂等，开销仅几次 existsSync。
      // const 捕获：else 分支的非空收窄进不了回调闭包，直接用外层 store 会 TS18048。
      const cached = store;
      try {
        await upgrade.withSettledProjectConfig(root, this.logger, async () => {
          await cached.reloadIfChanged();
        });
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
   *
   * 同名碰撞取项目条目（#770-11，项目优先）：与 buildDesiredServers/reconcile
   * 同口径——连接层同名跨 root 各成一条（键含 root，谁也不顶谁），目录按裸名
   * 只取一条时取会话项目那条（scope=SCOPE_PROJECT）。
   * - 预期 breaking：同名碰撞进目录的配置翻转，模型可见工具集/描述随之变化。
   *   digest 只含名集合（见 catalog/impl/digest），名集不变时 digest 不变，
   *   但条目内容仍经 catalogViewFor/compose 进入注入文本。
   * - summary() 仍列全局 + 项目两条（GUI 两条 vs 模型取其一）属预期，不在此收敛。
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
        // 同名项目覆盖全局（#770-11 项目优先）：目录按裸名只取一条，取会话项目那条。
        servers.set(server.name, { server, scope: SCOPE_PROJECT });
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
   * 单池后项目级连接恒由中间层池按 root 常驻，切走不断开。
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
    // 只切 currentRoot；项目级连接由中间层单元按 root 常驻，切走不断开（单池语义）。
    this.projectRoot = root;
    this.projectStore = undefined;
    if (root !== undefined) {
      this.projectStore = await this.projectStoreFor(root);
    }
    // 全局配置同样重读（外部手动编辑 <DSH_HOME>/@wingsky-1/dsh-mcp-manager/mcp.json）。
    try {
      await this.store.reloadIfChanged();
    } catch (error) {
      this.logger.warn(`dsh-mcp-manager: reload global config failed: ${this.redactError(error)}`);
    }
    if (this.middleware !== undefined) {
      // 仅触达单元（fire-and-forget 惰性连接在 projectUnitFor 内）。无项目 cwd 也回落
      // 全局虚拟 root @global——单池后 @global 恒可达（可达性三件套之二）。
      const target = root ?? MIDDLEWARE_GLOBAL_ROOT;
      void this.middleware.projectUnitFor(target).then(
        (unit) => {
          if (unit !== undefined) this.middleware?.evictIfNeeded();
        },
        (error: unknown) => {
          // #903 M4：fire-and-forget 必须带拒绝处理，否则 projectServersFor/
          // ensureRootLoaded 翻错即 unhandled rejection（setSession 永不挂起，但错不能丢）。
          this.logger.warn(
            `dsh-mcp-manager: setSession touch unit(${target}) failed: ${this.redactError(error)}`,
          );
        },
      );
    }
    this.emitStatus();
  }

  /**
   * 切回前台恢复：对当前工作空间连接的受控重建（对齐 SSE forceReconnect，#412）。
   * 移动端切后台会静默掐断 TCP（半开，双方收不到 FIN/RST → transport onClose 不触发），
   * 连接池 entry 可能卡在 connected 而实际已死；此入口忽略当前状态 force 重建
   * 当前工作空间单元（当前项目 root；无项目时回落 @global）内所有非
   * userDisabled 连接。force 重建健康连接一次代价低（本地 stdio / http 重连毫秒级），
   * 与 SSE 每次切回前台 forceReconnect 的语义对称。调用方：POST /api/dsh-mcp/resume
   *（客户端 visibilitychange 回前台触发）。
   *
   * 目标集合从「单元已有 entry」扩为「配置中全部 enabled 服务器」（#412 复报）：
   * - 宿主 dsh web 重启/状态丢失后 units 清空、entry 全失——只按 connections.keys()
   *   重建拿不到任何目标；先 projectUnitFor 确保单元创建（其内部惰性连接全部
   *   enabled 服务器是兜底），再对配置全集 force 重建（覆盖半开卡 connected、
   *   entry 缺失、从未连接过的服务器）。
   * - 仍尊重 userDisabled（用户断开的不复活）与无项目时的 @global 回落。
   */
  async resumeReconnect(): Promise<void> {
    const mw = this.middleware;
    if (mw === undefined) return;
    const root = this.projectRoot ?? MIDDLEWARE_GLOBAL_ROOT;
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
    this.reconcileServers();
    // 配置变了就广播一帧：接收方（浮窗/客户端）据此回拉 GET /servers。连接集合自身的
    // 异步结算还会各自 emitStatus（start → ensureConnected 结算路径）。
    this.emitStatus();
  }

  /**
   * 按当前配置同步连接池：池内不再需要的（移除 / 禁用 / 归属 root 已变）释放，
   * 配置里新增或恢复的经中间层单元触达。
   *
   * **键是 (归属 root, 裸名)**（单池后与单元表同构）：同名跨 scope（全局 + 项目级）
   * 各成一条，不再互相顶掉——旧直连账本按裸名键，同名只能活一个，那条限制随账本退役。
   * runtime 注入条目仍与 store 全局同名时**优先**（双轨合并，与 summary/catalogServersFor 同口径）。
   *
   * 同步方法（触达与释放都是同步发起 + 异步结算）；防重入（读取路径可并发）。
   * @returns {boolean} 连接集合是否变化（释放了在册连接，或触达了尚未在册的服务器）
   */
  reconcileServers(): boolean {
    if (this.reconcileBusy) return false;
    this.reconcileBusy = true;
    try {
      const desired = buildDesiredServers(
        this.store,
        this.projectStore,
        this.runtimeRegistry,
        (scope) => this.poolRootFor(scope),
      );
      let changed = false;
      const mw = this.middleware;
      if (mw !== undefined) {
        // 单池后「拆」只有这一个落点——旧直连账本的 stop 随账本一并退役。
        for (const unit of [...mw.units.values()]) {
          for (const serverName of [...unit.connections.keys()]) {
            const want = desired.get(`${unit.root}\u0000${serverName}`);
            if (want === undefined || want.server.enabled === false) {
              if (mw.releaseConnection(unit.root, serverName)) changed = true;
            }
          }
        }
      }
      for (const want of desired.values()) {
        if (want.server.enabled === false) continue;
        const root = want.scope === SCOPE_PROJECT ? this.projectRoot : MIDDLEWARE_GLOBAL_ROOT;
        if (root === undefined) continue;
        // 「集合变化」= 该 (root, 裸名) 还不在池里（单元未建 / 该条目未建）。实例缺失时
        // 什么都触达不了，不计变化。
        if (mw !== undefined && !(mw.units.get(root)?.connections.has(want.name) ?? false)) {
          changed = true;
        }
        // 全部服务器一律经中间层单元触达（单池）：项目级幂等触达当前项目单元，
        // 全局级触达 @global 单元；两侧都由 start 内部下沉。
        this.start(want.name, want.scope);
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
   * 启动一个服务器的连接（单池后唯一的连接路径）。
   *
   * 全部服务器都归中间层单元持有：项目级幂等触达当前项目单元，全局级触达 @global
   * 单元。startAll / add / update / reconcile / registerServer 各入口自动收敛，
   * 无需逐处特判。配置来源一律是宿主面 `projectServersFor(root)`（store + runtime
   * 注入并集），因此不再需要「config 直传」入参。
   *
   * #616 根因修复保留：项目级分支是幂等触达（projectUnitFor + 单台 ensureConnected），
   * 不是旧 touchMiddlewareUnit 的整单元拆毁——浮窗连接/断开任意服务器触发的
   * reconcile 不再把当前项目单元连人带连接整个拆掉。
   *
   * 中间层实例缺失（未经 apply 装配）时打 warn 并放弃：不退化成官方直装——那条
   * 并行路径已退役，硬装会在池不知情的情况下占住官方 serverName 活体预留。
   */
  start(name: string, scope: string = SCOPE_GLOBAL): void {
    if (this.middleware === undefined) {
      this.logger.warn(
        `dsh-mcp-manager: 中间层未就绪，服务器 "${name}" 的连接未建立（全部服务器只经中间层单元）`,
      );
      return;
    }
    if (scope === SCOPE_PROJECT) this.ensureMiddlewareServer(name);
    else this.touchGlobalUnit(name);
  }

  /**
   * 触达 @global 单元并确保该全局服务器连接（start 的全局级路径）。
   * projectUnitFor 首次触达会连带惰性连接全部全局服务器，等价 startAll 语义；
   * userDisabled 命中不连（与浮窗断开语义一致）。
   */
  private touchGlobalUnit(name: string): void {
    const mw = this.middleware;
    if (mw === undefined) return;
    void mw
      .projectUnitFor(MIDDLEWARE_GLOBAL_ROOT)
      .then(async (unit) => {
        if (unit === undefined || unit.userDisabled.has(name)) return;
        // #903 M4：内层 void 浮空时 ensureConnected 翻错无人接——await 链入外层
        // .catch（与 ensureMiddlewareServer 同式）。
        await mw.ensureConnected(MIDDLEWARE_GLOBAL_ROOT, name);
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
   * 处理项目单元，@global 池连接与目录残留导致「已删服务器仍可调用」。
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
    // R4：内存态不走 assertEnvPolicy——不落盘即无 baked 风险，调用方本就持有 process.env。
    if (Array.isArray(toolDefinitions))
      config.toolDefinitions = toolDefinitions as ToolDefinition[];
    const run = this.registerQueue.then(async () => {
      if (this.runtimeRegistry.has(config.name) || this.store.find(config.name) !== undefined) {
        return { name: config.name, existing: true };
      }
      this.runtimeRegistry.set(config.name, config);
      // #413 时序显式化：注册即连接走 start。单池后 runtime 条目与 store 全局条目
      // 同路——@global 单元的配置数据源（projectServersFor）已并入 runtimeRegistry，
      // 因此不需要 config 直传。中间层未就绪窗口（provide→initMiddleware 之间的
      // async 空隙）start 会 warn 并不建连接，由 apply 的 reconcileServers
      // （initMiddleware 后无条件执行）按同一口径补齐。
      if (config.enabled !== false) this.start(config.name, SCOPE_GLOBAL);
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
   * - **先删 runtimeRegistry 再拆中间层连接**（#413 QA P2-1）：drop 时数据源
   *   （projectServersFor 含 runtime）已不再返回该服务器，任何并发
   *   ensureConnected/connect 都查不到配置而无法重建虚拟连接——堵死注销后
   *   瞬时复活窗口，且不写 userDisabled（避免持久化污染导致同名 re-register
   *   被静默阻止连接，与 disconnect 的「用户主动断开」语义区分）；
   * - 拆中间层连接与目录条目（#413：runtime 条目在 @global 单元，须显式清理，
   *   否则 unregister 后 ws_mcp_list/call 残留幽灵）；
   * - reconcile 回落 store 配置。
   */
  async unregisterServer(name: string): Promise<void> {
    const run = this.registerQueue.then(async () => {
      if (this.runtimeRegistry.has(name)) {
        this.runtimeRegistry.delete(name);
        // 单池后「拆」统一走池账本（旧直连账本的 stop 已随账本退役）。
        this.dropMiddlewareConnection(name);
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
    // #770-A3 回写 guard：新建无既有值可保，投影占位符进写路径即抛错（调用方重填真值）。
    for (const [key, value] of Object.entries(server)) {
      if (
        typeof value === "string" &&
        (value.includes("[REDACTED]") || value.includes("%5BREDACTED%5D"))
      ) {
        throw new Error(
          `server ${JSON.stringify(key)} must not contain projection placeholder "[REDACTED]" (re-enter the real value)`,
        );
      }
      if (key === "args" && Array.isArray(value)) {
        for (const sub of value) {
          if (
            typeof sub === "string" &&
            (sub.includes("[REDACTED]") || sub.includes("%5BREDACTED%5D"))
          ) {
            throw new Error(
              `server ${JSON.stringify(key)} must not contain projection placeholder "[REDACTED]" (re-enter the real value)`,
            );
          }
        }
      }
      if ((key === "env" || key === "headers") && typeof value === "object" && value !== null) {
        for (const sub of Object.values(value as Record<string, unknown>)) {
          if (
            typeof sub === "string" &&
            (sub.includes("[REDACTED]") || sub.includes("%5BREDACTED%5D"))
          ) {
            throw new Error(
              `server ${JSON.stringify(key)} must not contain projection placeholder "[REDACTED]" (re-enter the real value)`,
            );
          }
        }
      }
    }
    const config = orchestratorPorts.get().configModel.normalizeServer(server);
    // #770-2 环境净化：写边界凭据策略门（与 update/import 同门；normalize 保持纯形状校验）。
    orchestratorPorts
      .get()
      .configModel.assertEnvPolicy(config.env, config.headers, undefined, config.url, config.args);
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
    // #770-A3 回写 guard：投影值永不落盘——占位符 URL/键丢弃并沿用既有值（缺键即保留，
    // 与客户端省略语义同源）；客户端直调投影 payload 亦被此处兜底。
    const merged = configModel.normalizeServer({
      ...existing,
      ...stripProjectionPatch(patch),
      name,
    });
    // #770-2 环境净化：写边界凭据策略门（审合并后落盘形态；与 add/import 同门）。
    configModel.assertEnvPolicy(merged.env, merged.headers, undefined, merged.url, merged.args);
    store.upsert(merged);
    await store.save();
    // 单池后「拆旧配置连接」只有池账本一个落点（项目/全局单元统一处理；
    // #382 此前只拆项目单元，全局旧连接残留导致编辑不生效）。
    this.dropMiddlewareConnection(name);
    if (merged.enabled !== false) {
      // 编辑后重新连接（即便此前未连接）
      this.start(name, scope);
    }
    return merged;
  }

  async remove(name: string, scope: string = SCOPE_GLOBAL): Promise<void> {
    const store = scope === SCOPE_PROJECT ? await this.projectStoreOrThrow() : this.store;
    // 单池后「拆」统一走池账本（含目录条目清理，防 remove 后 ws_mcp_call 仍可调用）。
    this.dropMiddlewareConnection(name);
    store.remove(name);
    await store.save();
  }

  /**
   * 显式连接（浮窗「连接」/ 宿主 API）：解除 userDisabled + force 受控重建。
   *
   * 单池后只有一条路径——中间层单元：按 scope 定位 root 单元、清 userDisabled、
   * force 重建该连接。#412：force 是必需的——entry 可能半开卡在 connected，
   * ensureConnected 的 connected 短路会让显式「连接」看起来无效。
   */
  async connect(name: string, scope: string = SCOPE_GLOBAL): Promise<void> {
    const store = scope === SCOPE_PROJECT ? await this.projectStoreOrThrow() : this.store;
    let server = store.find(name);
    // F2（#382）：runtime 注入条目不落 store，global scope 查不到时回退
    // runtimeRegistry（与 summary/catalogServersFor 同口径）。
    if (server === undefined && scope === SCOPE_GLOBAL) {
      const runtime = this.runtimeRegistry.get(name);
      if (runtime !== undefined) {
        this.logger.warn(
          `dsh-mcp-manager: server "${name}" not in store; using runtime registry entry`,
        );
        server = runtime;
      }
    }
    if (server === undefined) throw new Error(`server "${name}" not found in ${scope} scope`);
    const mw = this.middleware;
    if (mw === undefined) throw new Error("middleware is not initialized (apply first)");
    const root = scope === SCOPE_PROJECT ? this.projectRoot : MIDDLEWARE_GLOBAL_ROOT;
    if (root === undefined)
      throw new Error("no active project session (call session with a cwd first)");
    const unit = await mw.projectUnitFor(root);
    if (unit === undefined) throw new Error(`workspace ${root} has no project MCP config`);
    unit.userDisabled.delete(name);
    await this.saveUserState(mw.units);
    // force 受控重建（#412）：半开卡在 connected 的连接也强制重建（切回前台/刷新
    // 都走同一入口）。
    await mw.ensureConnected(root, name, { force: true });
  }

  /**
   * 显式断开（浮窗「断开」/ 宿主 API）：写 userDisabled + 拆池内连接。
   *
   * 定位（单池后只剩池这一侧）：
   * - scope=project → 当前项目 root 单元（#392：避免同名全局服务器把项目级断开错写进 @global）；
   * - 全局配置（store，非 runtime）→ @global 单元（#382：不按 units 遍历序猜）；
   * - 其余（runtime 注入等）→ 遍历命中该条目的单元。
   * 前置约束（#770-11 C/A 相）：无 scope 同名调用仍按上法定 @global，而目录
   * （catalogServersFor）同名取项目——两者分叉；无 scope 调用方须显式传 scope
   * （#392 同式），本相不动 API 缺省（路由层缺 scope 即归一化为 global）。
   * 拆除只发起不等结算（裁定 V）：官方 dispose 会等在途首连，挂死的服务器能把它拖到 SDK 的 60s 超时。
   */
  async disconnect(name: string, scope?: string): Promise<void> {
    const mw = this.middleware;
    if (mw === undefined) return;
    let targetUnit: ProjectUnit | undefined;
    const scoped = orchestratorPorts.get().workspace.normalizeScope(scope ?? "");
    if (scoped === SCOPE_PROJECT) {
      targetUnit = this.projectRoot !== undefined ? mw.units.get(this.projectRoot) : undefined;
    } else if (this.store.find(name) !== undefined && !this.runtimeRegistry.has(name)) {
      targetUnit = mw.units.get(MIDDLEWARE_GLOBAL_ROOT);
    } else {
      targetUnit = [...mw.units.values()].find(
        (unit) => unit.connections.has(name) || unit.userDisabled.has(name),
      );
    }
    if (targetUnit === undefined) return;
    targetUnit.userDisabled.add(name);
    await this.saveUserState(mw.units);
    mw.releaseConnection(targetUnit.root, name);
    // 断开即废弃同名在途标记：拆除时旧 attempt 仍 pending（挂至超时）会吞掉
    // 紧随的显式「连接」（connect→ensureConnected 去重短路，force 也不豁免）。
    mw.abandonInFlight(name);
    this.emitStatus();
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
    };
  }

  /**
   * 投影单元：该 (server, scope) 归属的中间层单元。单池后全部条目都在池里，
   * 只剩「单元还没建出来 / 无项目 root」这两种缺失。
   */
  private middlewareUnitFor(serverName: string, scope: string): ProjectUnit | undefined {
    const mw = this.middleware;
    if (mw === undefined) return undefined;
    const root = scope === SCOPE_PROJECT ? this.projectRoot : MIDDLEWARE_GLOBAL_ROOT;
    return root === undefined ? undefined : mw.units.get(root);
  }

  summarize(server: ServerConfig, scope: string): Record<string, unknown> {
    // 单池（#767 笔 1a）：状态与工具列表一律从连接池单元 + 目录投影取（旧实现的
    // 「直连账本兜底分支」随账本退役）。
    // #770-A3 只读投影：两分支一律经 projectServerForSummary（env/headers 省略、
    // url 按 B8 仅脱敏 userinfo/searchParams），永不明文下发凭据；写路径
    // （add/update）永不消费此处产出（见 stripProjectionPatch）。
    const { catalog: catalogPort } = orchestratorPorts.get();
    const unit = this.middlewareUnitFor(server.name, scope);
    const entry = unit?.connections.get(server.name);
    if (unit !== undefined && entry !== undefined) {
      const catalog = catalogPort.catalogDirectory.entryFor(unit.root, server.name);
      const disabledTools = this.disabledTools.get(unit.root)?.get(server.name);
      const globalTools =
        unit.root === MIDDLEWARE_GLOBAL_ROOT
          ? undefined
          : this.disabledTools.get(MIDDLEWARE_GLOBAL_ROOT)?.get(server.name);
      const tools =
        catalog !== undefined && catalog.unavailable === undefined ? [...catalog.tools.keys()] : [];
      const disabledList = tools.filter(
        (tool) => (disabledTools?.has(tool) ?? false) || (globalTools?.has(tool) ?? false),
      );
      // #770-L4 显示侧脱敏（分诊结论）：settled outcome.error 可含凭据——① handle.ready
      // 拒因来自官方（官方手握展开后的明文 Config，其文案不透明，不能证伪不回显输入）；
      // ② failed 文案经 withOfficialLogs 接入官方日志收集链原文（同不透明）。且状态与错因
      // 分源（status 读时刷新、error 结算时冻结）：常驻重连成功后 connected 可携 stale
      // failed 文案，故 connected 分支亦须脱敏。脱敏只在显示侧（redaction 快照 +
      // redactError），lifecycle 域内原文不动；已脱敏源二次脱敏恒等无害。
      const rawError = entry.error !== undefined ? entry.error : catalog?.unavailable;
      const error = rawError !== undefined ? this.redactError(rawError) : undefined;
      return {
        ...projectServerForSummary(server),
        scope,
        // 状态经读时刷新的投影取（裁定 U）：entry.status 只在装载窗口结算时写入，
        // 「曾连上、工具前缀消失」这类事实只有重算才看得见。
        status: this.middleware?.statusOf(unit.root, server.name),
        // 目录发现失败（unavailable）时透出原因：解释 connected 却 0 工具。
        error,
        tools,
        disabledTools: disabledList.length > 0 ? disabledList : undefined,
      };
    }
    // 单元缺失 / 该服务器不在池里（未连接、userDisabled 断开、配置禁用）：禁用 → disabled，
    // 其余 → stopped，工具面为空（与旧直连账本的兜底分支同口径）。
    return {
      ...projectServerForSummary(server),
      scope,
      status: server.enabled === false ? SERVER_STATES.disabled : SERVER_STATES.stopped,
      error: undefined,
      tools: [],
      disabledTools: undefined,
    };
  }

  async dispose(): Promise<void> {
    if (this.statusTimer !== undefined) {
      clearTimeout(this.statusTimer);
      this.statusTimer = undefined;
    }
    // 逐条摘账 + 发起释放（**不** await disposeServer：与组合根卸载链的
    // releaseLifecycle() + flushDisposals() 分工一致——中间层 dispose 逐单元走
    // releaseServer 摘账，结算与错因由卸载链统一排空）。
    this.stats.dispose();
    if (this.middleware !== undefined) {
      await this.middleware.dispose();
      this.middleware = undefined;
    }
  }
}
