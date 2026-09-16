/**
 * dsh-mcp-manager — 中间层（工作空间 MCP 路由）。
 *
 * 模型面恒定两个工具（ws_mcp_search / ws_mcp_call），执行时按调用方会话
 * 当前 cwd（agent.session.header.cwd，实证已闭合）路由到对应工作空间的
 * MCP 连接池，实现「不同工作空间注入不同 MCP、无命名冲突」：
 * - 连接池：每工作空间一套常驻连接（惰性连接 + 超时 + LRU 淘汰）；
 * - 目录：每工作空间 ToolCatalog（惰性发现 + last-good 磁盘缓存 + 检索）；
 * - 策略：server/tool 两级 glob（deny 优先），按 @root/server 全名配置；
 * - 容错：normalizeToolName / normalizeArguments / msgOf / createRedactor。
 *
 * 双轨迁移：middleware 配置为 "off"（默认直呼）/ "project"（项目级走中间层，
 * 全局 mcp__ 直呼）/ "all"（全部走中间层）。
 *
 * 阶段 6 集中搬移：本文件归 connection/runtime/（中间层池），仅保留
 * McpMiddleware 类；原汇聚转发块删除（v3 §二：汇聚只留 src/index.ts）。
 *
 * #767 S1-3a：ws_mcp_call 执行路径（callTool 与 hostRedact）已迁 servers/dispatch 域，
 * callTool 缩成转发壳——执行器经 runtimePorts 的 dispatch 端口取，单元/策略/脱敏源仍由本类持有。
 *
 * #767 S1-4d：连接栈换成官方 @deepseek-ai/dsh-mcp-client。本类不再自建 transport / client，
 * 也不再自己排重连与防双进程探测——装载、拆卸与六态投影一律经 runtimePorts 的 lifecycle 端口
 * 交还 servers/lifecycle 的账本（官方 serverName 在应用根上活体预留，同 id 未释放就重挂当场抛）。
 * 目录改按 `ctx.tools.schemas()` 里 `mcp__<id>__` 前缀投影（裁定 W/K），执行路径改道
 * `ctx.tools.execute`（见 servers/dispatch）。
 *
 * W8 端口接线：跨域能力（catalog 新鲜判定与装箱、pipeline 投影/超时/取消息/脱敏/参数归一/
 * 策略裁决、workspace 全名解析与拼装、lifecycle 装载/拆卸/投影）一律经 `impl/service` 的
 * `runtimePorts.get()` 取；同子层的 supervisor（公名派生）与 limits 直取，跨端层 shared 的
 * MIDDLEWARE_GLOBAL_ROOT 经共享门面取，不占端口——端口只承载跨域能力。
 */

import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ToolExecutionInput,
  ToolExecutionResult,
  ToolExecutionToken,
} from "@deepseek-ai/dsh-tools";
import type { ServerConfig } from "../../config/interface.ts";
import { publicToolName } from "./supervisor.ts";
import { CALL_TIMEOUT_MS, CATALOG_TTL_MS } from "./limits.ts";
import {
  MIDDLEWARE_GLOBAL_ROOT,
  SERVER_STATES,
  type ServerState,
} from "../../../shared/interface.ts";
import { runtimePorts } from "./impl/service/index.ts";
import type { MiddlewareHost } from "./deps.ts";
import type { ProjectUnit, ConnectionEntry } from "./impl/middleware/type.ts";
import type { MiddlewarePolicy } from "../../pipeline/interface.ts";
import type { CatalogTool } from "../../catalog/interface.ts";
import type { DisabledToolsMap } from "../../store/interface.ts";

// ------------------------------------------------------------ 连接池

/**
 * 中间层：工作空间 MCP 连接池 + 目录 + 路由执行。
 * 一个实例服务所有工作空间（projectUnits: Map<root, ProjectUnit>）。
 */
export class McpMiddleware {
  host: MiddlewareHost;
  /** root（realpath 归一化）→ 工作空间单元。 */
  units: Map<string, ProjectUnit>;
  /** 策略（按 @root/server 全名配置）。 */
  policy: MiddlewarePolicy;
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

  constructor(host: MiddlewareHost, policy: MiddlewarePolicy = {}) {
    this.host = host;
    this.units = new Map();
    this.policy = policy;
  }

  /** 读取/创建 root 的单元（root 无项目标记 → undefined）。 */
  async projectUnitFor(root: string | undefined): Promise<ProjectUnit | undefined> {
    if (root === undefined) return undefined;
    let unit = this.units.get(root);
    if (unit === undefined) {
      const servers = await this.host.projectServersFor(root);
      if (servers === undefined) return undefined;
      unit = {
        root,
        connections: new Map(),
        catalog: new Map(),
        userDisabled: new Set(this.disabledByRoot.get(root) ?? []),
        lastTouchedAt: Date.now(),
        inFlight: new Map(),
      };
      this.units.set(root, unit);
      // 加载 last-good 目录缓存（空采集不写盘；目录与连接分开淘汰）。
      await this.loadCatalogCache(root);
      // 后台惰性连接（fire-and-forget，不阻塞调用方）。
      for (const server of servers) {
        if (server.enabled !== false) void this.ensureConnected(root, server.name);
      }
    }
    unit.lastTouchedAt = Date.now();
    return unit;
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
    const servers = await this.host.projectServersFor(root);
    const server = servers?.find((entry) => entry.name === serverName);
    if (server === undefined || server.enabled === false) return;
    const existing = unit.inFlight.get(serverName);
    if (existing !== undefined) return existing as Promise<void>;
    const promise = this.connectInternal(root, serverName, opts);
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
    const unit = this.units.get(root);
    if (unit === undefined) return;
    const force = opts.force === true;
    const { lifecycle } = runtimePorts.get();
    const entry = unit.connections.get(serverName);
    // 短路用**读时刷新后**的状态（statusOf，裁定 U）：非 force 时 connected/connecting 不进
    // （防重复建连）；reconnecting 同样不进——官方自己在退避重连，我方重挂会撞同一 id 的
    // serverName 活体预留（实测 §2.9-16）。force（用户显式「连接」/切回前台恢复）忽略当前
    // 状态总是受控重建——修半开死连接卡在 connected 后 connect/refresh 均短路失效（#412）。
    const state = this.statusOf(root, serverName);
    if (!force && (state === "connected" || state === "connecting" || state === "reconnecting")) {
      return;
    }
    // 重建路径先拆旧代际并**等**结算（裁定 V）：官方 serverName 是整个应用根的活体预留，
    // 同 id 未释放就重挂当场抛。虚拟单元（toolDefinitions）没有官方实例：不进账本也不置
    // 废弃位——它的重建语义由下面 wrapped 分支的同状态短路决定（#413 原语义）。
    if (entry !== undefined && !Array.isArray(entry.server.toolDefinitions)) {
      entry.disposed = true;
      if (entry.id !== undefined) await lifecycle.disposeServer(entry.id);
    }
    const servers = await this.host.projectServersFor(root);
    const server = servers?.find((entry) => entry.name === serverName);
    if (server === undefined || server.enabled === false) return;
    // #413：封装定义服务器（runtime 注入 toolDefinitions）——
    // execute 为调用方 JS 直呼 CLI，不经远端 MCP，**不派官方实例**。
    // 中间层以「虚拟连接」（无 id/handle，status=connected）+ 目录从 toolDefinitions
    // 投影存在；执行走 callTool 的封装直呼分支。
    // 判定用 Array.isArray（空数组也算封装声明——调用方显式声明无工具，
    // 不应回退远端装载）。
    if (Array.isArray(server.toolDefinitions)) {
      const existingWrapped = unit.connections.get(serverName);
      if (
        existingWrapped !== undefined &&
        (existingWrapped.status === "connected" || existingWrapped.status === "connecting")
      )
        return;
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
      this.projectWrappedCatalog(root, serverName, server);
      this.host.logger.info(
        `dsh-mcp-manager(${serverName}@${root}): wrapped (toolDefinitions) connected`,
      );
      this.host.emitStatus();
      return;
    }
    // 防双进程探测（#382 F5）与它的一次性重试已删除：换引擎后「同名服务器只能有一个实例」
    // 由官方 serverName 的活体预留保证（同 id 二次挂载当场抛，实测 §2.9-16），跨 root 同名
    // 各自由 (scope,name) 分配的 id 区分——探测与重试都是旧栈的补丁，留着只会与官方判重打架。
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
        // 六态窗口内只推进状态：装上之后 id/handle 才回得来，这里不能碰代际守卫。
        onState: (next: ServerState) => {
          if (newEntry.disposed) return;
          newEntry.status = next;
          this.host.emitStatus();
        },
      });
    } catch (error) {
      // 装载期异常（loader.load 失败 / 账本撞键等）：实例没挂上，只能落 failed 等人重试。
      newEntry.status = "failed";
      newEntry.error = this.redact(error);
      newEntry.readySettled = true;
      this.host.logger.warn(
        `dsh-mcp-manager(${serverName}@${root}): mount failed: ${this.redact(error)}`,
      );
      this.host.emitStatus();
      return;
    }
    // 账本键与句柄只有装载返回后才可得，而窗口内的 onState 可能已点亮状态——就绪位只能在此补写。
    newEntry.id = mounted.id;
    newEntry.handle = mounted.entry.handle;
    newEntry.readySettled = true;
    // 代际守卫（拆除期竞态）：拆除动作到达后这一代已不在册，但实例已经挂上——必须发起释放，
    // 否则官方实例与它占着的 serverName 预留会永久泄漏。
    if (newEntry.disposed || unit.connections.get(serverName) !== newEntry) {
      lifecycle.releaseServer(mounted.id);
      return;
    }
    if (mounted.outcome.kind === "settled") {
      newEntry.status = mounted.outcome.state;
      newEntry.error = mounted.outcome.error;
      if (mounted.outcome.state === "connected") {
        newEntry.everConnected = true;
        newEntry.connectedAt = Date.now();
        await this.discover(root, serverName);
        this.host.logger.info(`dsh-mcp-manager(${serverName}@${root}): connected`);
      } else if (mounted.outcome.state === "failed") {
        // 文案已是「我方判词 + 官方原文」（窗口把归属本实例的官方日志接在了 error 上）。
        this.host.logger.warn(
          `dsh-mcp-manager(${serverName}@${root}): connection failed: ${mounted.outcome.error}`,
        );
      }
      this.host.emitStatus();
    }
    // outcome.kind === "discarded"：本次结算作废，状态由拆除路径负责，这里不动。
  }

  /**
   * 把工具注册面上属于本实例的条目投影进目录（裁定 W + 裁定 K）。
   *
   * 采集动作本身已交还官方（syncTools 负责分页、注册、`tools/list_changed`），本块只剩
   * 「注册面 → per-root 目录」这一层投影：官方注册名是 `mcp__<id>__<tool>`，去掉前缀即裸名，
   * description 与 parameters 都在 `schemas()` 里（实测 §2.9-4），不需要第二份工具清单。
   * `entry.id` 不存在（虚拟单元、或尚未装载完成）时无面可投影，直接返回。
   */
  async discover(root: string, serverName: string): Promise<void> {
    const unit = this.units.get(root);
    if (unit === undefined) return;
    const entry = unit.connections.get(serverName);
    if (entry === undefined || entry.id === undefined) return;
    const { catalog } = runtimePorts.get();
    if (catalog.isCatalogFresh(unit.catalog.get(serverName))) return; // fresh
    const prefix = `mcp__${entry.id}__`;
    try {
      const tools: Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }> = [];
      for (const schema of this.registeredSchemas()) {
        const name = schema?.name;
        if (typeof name !== "string" || !name.startsWith(prefix)) continue;
        tools.push({
          name: name.slice(prefix.length),
          description: typeof schema.description === "string" ? schema.description : "",
          inputSchema: (schema.parameters ?? {}) as Record<string, unknown>,
        });
      }
      unit.catalog.set(serverName, {
        discoveredAt: Date.now(),
        tools: catalog.boundCatalogTools(tools),
      });
      // 落盘失败由外层 catch 收口报错；不 await 会让失败变成未处理拒绝而不是日志
      await this.persistCatalog(root);
    } catch (error) {
      unit.catalog.set(serverName, {
        discoveredAt: 0,
        tools: new Map(),
        unavailable: this.redact(error),
      });
    }
  }

  /**
   * #413：从封装定义（toolDefinitions）投影目录，替代远端 discover。
   * 封装 execute 为调用方 JS 直呼（不经远端 MCP），目录数据源即调用方定义：
   * name/description 直取；dsh-tools 的 parameters（ToolSchema）即 JSON Schema
   * 形态，直接作 CatalogTool.inputSchema（与 supervisor 封装分支同口径）。
   */
  private projectWrappedCatalog(root: string, serverName: string, server: ServerConfig): void {
    const unit = this.units.get(root);
    if (unit === undefined) return;
    const tools = new Map<string, CatalogTool>();
    if (Array.isArray(server.toolDefinitions)) {
      for (const def of server.toolDefinitions) {
        if (typeof def?.name !== "string" || def.name === "") continue;
        tools.set(def.name, {
          description: typeof def.description === "string" ? def.description : "",
          inputSchema: (def.parameters ?? {}) as Record<string, unknown>,
        });
      }
    }
    unit.catalog.set(serverName, { discoveredAt: Date.now(), tools });
  }

  /** 凭据脱敏（连接/发现/调用错误路径统一使用；P1 修复）。 */
  private redact(error: unknown): string {
    return runtimePorts.get().pipeline.createRedactor(this.allServers())(error);
  }

  /** 注册面读口：取不到/非数组一律当空——探测与投影都不许因为读不到注册表而阻塞。 */
  private registeredSchemas(): ReadonlyArray<{
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
  }> {
    const tools = this.host.ctx.tools;
    if (tools === undefined || typeof tools.schemas !== "function") return [];
    try {
      const schemas = tools.schemas();
      return Array.isArray(schemas) ? schemas : [];
    } catch {
      return [];
    }
  }

  /**
   * 该 id 前缀下是否已有注册工具——「已连上」的唯一正向证据（官方不暴露状态 API，
   * 成功连接零日志：实测 §2.7 spike2 / §2.9-4）。
   */
  private hasRegisteredTools(id: string): boolean {
    const prefix = `mcp__${id}__`;
    return this.registeredSchemas().some(
      (schema) => typeof schema?.name === "string" && schema.name.startsWith(prefix),
    );
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
    // 虚拟连接单元（toolDefinitions）没有官方实例、从不 mount：它的态由配置面与拆除位直接
    // 决定（#413「虚拟连接即 connected」是既有契约），进投影只会让「无 id / 无句柄」这些
    // 与它无关的输入面参与裁决。
    if (Array.isArray(entry.server.toolDefinitions)) {
      const state: ServerState =
        entry.server.enabled === false || unit.userDisabled.has(serverName)
          ? SERVER_STATES.disabled
          : entry.disposed
            ? SERVER_STATES.stopped
            : SERVER_STATES.connected;
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
      hasTools: (id) => this.hasRegisteredTools(id),
    });
    entry.status = state;
    return state;
  }

  /** 目录 last-good 持久化（空采集不写盘；public 供测试与外部触发）。 */
  async persistCatalog(root: string): Promise<void> {
    const unit = this.units.get(root);
    if (unit === undefined) return;
    let anyTools = false;
    const payload: Record<string, unknown> = {};
    for (const [serverName, catalog] of unit.catalog) {
      // #413：runtime 注入条目（内存态，不落盘）目录只驻内存——防卸载/重启后
      // 幽灵条目被 loadCatalogCache 载回（与 removeCatalogEntry 清理同类问题）。
      if (this.host.isRuntimeServer?.(serverName) === true) continue;
      if (catalog.tools.size === 0) continue;
      anyTools = true;
      payload[serverName] = {
        discoveredAt: catalog.discoveredAt,
        tools: [...catalog.tools.entries()].map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    }
    if (!anyTools) return;
    const file = this.host.catalogCachePath(root);
    try {
      const dir = dirname(file);
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, root, entries: payload }, null, 2), "utf8");
      await rename(tmp, file);
    } catch (error) {
      this.host.logger.warn(
        `dsh-mcp-manager: catalog cache write failed: ${runtimePorts.get().pipeline.msgOf(error)}`,
      );
    }
  }

  /**
   * 从磁盘 last-good 目录缓存中清除单服务器条目（remove/update 后调用；#392 遗留①）。
   * persistCatalog 是全量覆盖且空采集不写盘——remove 后该 root 目录可能已空，若不显式
   * 清盘，磁盘缓存仍残留已删服务器条目，插件重启/@global 单元重建时 loadCatalogCache
   * 把幽灵条目载回（ws_mcp_list 再次列出）。这里读现有缓存、删条目、写回；条目删空则
   * 删除缓存文件。内存目录由调用方（dropMiddlewareConnection）先行删除。
   */
  async removeCatalogEntry(root: string, serverName: string): Promise<void> {
    const file = this.host.catalogCachePath(root);
    try {
      if (!existsSync(file)) return;
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        root?: unknown;
        entries?: Record<string, unknown>;
      } | null;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        typeof parsed.entries !== "object" ||
        parsed.entries === null
      )
        return;
      if (!(serverName in parsed.entries)) return;
      delete parsed.entries[serverName];
      if (Object.keys(parsed.entries).length === 0) {
        await rm(file, { force: true }).catch(() => {});
        return;
      }
      const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
      await writeFile(
        tmp,
        JSON.stringify({ version: 1, root, entries: parsed.entries }, null, 2),
        "utf8",
      );
      await rename(tmp, file);
    } catch (error) {
      this.host.logger.warn(
        `dsh-mcp-manager: catalog cache remove failed: ${runtimePorts.get().pipeline.msgOf(error)}`,
      );
    }
  }

  /** 加载 root 的 last-good 目录缓存（缺失/损坏 → 空）。 */
  async loadCatalogCache(root: string): Promise<void> {
    const unit = this.units.get(root);
    if (unit === undefined) return;
    const file = this.host.catalogCachePath(root);
    try {
      if (!existsSync(file)) return;
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as { entries?: Record<string, unknown> } | null;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.entries === "object" &&
        parsed.entries !== null
      ) {
        for (const [serverName, entry] of Object.entries(parsed.entries)) {
          const rec = entry as { discoveredAt?: unknown; tools?: unknown } | undefined;
          if (typeof rec !== "object" || rec === null) continue;
          const tools = new Map<string, CatalogTool>();
          if (Array.isArray(rec.tools)) {
            for (const tool of rec.tools) {
              const toolRec = tool as
                { name?: unknown; description?: unknown; inputSchema?: unknown } | undefined;
              if (
                typeof toolRec !== "object" ||
                toolRec === null ||
                typeof toolRec.name !== "string"
              )
                continue;
              tools.set(toolRec.name, {
                description: typeof toolRec.description === "string" ? toolRec.description : "",
                inputSchema: (toolRec.inputSchema ?? {}) as Record<string, unknown>,
              });
            }
          }
          unit.catalog.set(serverName, {
            discoveredAt: typeof rec.discoveredAt === "number" ? rec.discoveredAt : 0,
            tools,
          });
        }
      }
    } catch {
      // 损坏缓存忽略
    }
  }

  /**
   * 执行 ws_mcp_call。本片（#767 S1-3a）起只是转发壳：路由校验、策略裁决、两条执行分支与
   * 结果投影在 servers/dispatch 域（impl/call 的 executeMcpCall），中间层仍持有单元表、
   * 策略、脱敏源与**转发登记表**，经显式入参按引用递入——不落第二份事实源。
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
    const { dispatch, pipeline, workspace } = runtimePorts.get();
    // 公名派生只在这里发生一次：唯一派生点是 supervisor 的 publicToolName，dispatch 拿名字用、
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
        allServers: () => this.allServers(),
        disabledTools: this.disabledTools,
        policy: this.policy,
        catalogTtlMs: CATALOG_TTL_MS,
        defaultCallTimeoutMs: CALL_TIMEOUT_MS,
        pipeline,
        workspace,
      });
    } finally {
      // finally 是硬要求（RECON 反例 1）：漏了这一步，残留 token 就是一处永久放行位。
      if (parent !== undefined) this.forwarding.delete(parent);
    }
  }

  private allServers(): ServerConfig[] {
    const servers: ServerConfig[] = [];
    for (const unit of this.units.values()) {
      for (const entry of unit.connections.values()) servers.push(entry.server);
    }
    return servers;
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
    if (entry.id !== undefined) runtimePorts.get().lifecycle.releaseServer(entry.id);
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
    const unit = this.units.get(root);
    if (unit === undefined) return;
    for (const serverName of [...unit.connections.keys()]) {
      this.releaseConnection(root, serverName);
    }
    unit.connections.clear();
    this.units.delete(root);
  }

  /** 全部拆毁（插件卸载）。保持同步体：组合根的卸载链依赖这里同步摘账。 */
  async dispose(): Promise<void> {
    for (const root of [...this.units.keys()]) this.teardownUnit(root);
    this.units.clear();
  }
}
