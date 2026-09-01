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
 * 职责拆分（#286 附加）：本文件保留连接池核心（McpMiddleware 类）并汇聚
 * 转发全部公共符号——常量（middleware-const）、纯函数与目录检索
 * （middleware-utils）、状态持久化（middleware-state）、工具注册
 * （middleware-register）、类型（middleware-types）；index.ts / manager.ts
 * 的 import 与 re-export 面保持不变。
 */

import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ServerConfig } from "./types.ts";
import { MCPClient } from "./protocol.ts";
import { createTransport } from "./transport.ts";
import {
  CONNECT_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  CATALOG_TTL_MS,
  MAX_TOOLS_PER_SERVER,
  MAX_BYTES_PER_TOOL,
  MAX_TOTAL_CATALOG_BYTES,
} from "./middleware-const.ts";
import {
  withTimeout,
  msgOf,
  createRedactor,
  parseFullServerName,
  normalizeToolName,
  normalizeArguments,
  policyAllows,
  policyDenialReason,
  fullServerName,
  isToolDenied,
  toolDisabledReason,
  MIDDLEWARE_GLOBAL_ROOT,
} from "./middleware-utils.ts";
import type {
  MiddlewareHost,
  ProjectUnit,
  MiddlewarePolicy,
  ConnectionEntry,
  CatalogTool,
  DisabledToolsMap,
} from "./middleware-types.ts";



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
  async ensureConnected(root: string, serverName: string, opts: { force?: boolean } = {}): Promise<void> {
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
      unit.inFlight.delete(serverName);
    }
  }

  private async connectInternal(root: string, serverName: string, opts: { force?: boolean } = {}): Promise<void> {
    const unit = this.units.get(root);
    if (unit === undefined) return;
    const force = opts.force === true;
    const entry = unit.connections.get(serverName);
    // 非 force：已 connected/connecting 短路，防重复建连。
    // force（用户显式「连接」/切回前台恢复）：忽略当前状态，总是受控重建——
    // 修半开死连接卡在 connected 后 connect/refresh 均短路失效（#412）。
    if (!force && entry !== undefined && (entry.status === "connected" || entry.status === "connecting")) return;
    // 重连路径：旧 entry（failed，或 force 重建的死连接）的 transport 先 close，
    // 防 streamable-http 半开 socket 累积泄漏（P1 修复）。
    if (entry !== undefined) {
      const oldClient = entry.client;
      const oldTransport = entry.transport;
      entry.client = undefined;
      entry.transport = undefined;
      if (oldClient !== undefined && oldTransport !== undefined) {
        void oldTransport.close().catch(() => {});
      }
    }
    const servers = await this.host.projectServersFor(root);
    const server = servers?.find((entry) => entry.name === serverName);
    if (server === undefined || server.enabled === false) return;
    // 与官方 dsh-mcp-client 并存（方案 E2）：运行时探测官方/其他插件是否已注册
    // 同名 server 的 mcp__ 工具（说明该 server 已有其他实例连接）→ 跳过本实例，
    // 防同一 server 双进程。探测失败（tools.schemas 不可用）不阻塞连接。
    if (this.host.ctx.tools !== undefined && typeof this.host.ctx.tools.schemas === "function") {
      try {
        const registered = this.host.ctx.tools.schemas();
        const prefix = `mcp__${serverName}__`;
        if (Array.isArray(registered) && registered.some((schema) => typeof schema?.name === "string" && (schema.name as string).startsWith(prefix))) {
          this.host.logger.warn(`dsh-mcp-manager(${serverName}@${root}): server 已由其他插件（如官方 dsh-mcp-client）注册 mcp__ 工具，跳过本实例连接（防双进程）`);
          // F5（#382）：命中多为热更新/模式切换窗口期——旧实例 mcp__ 注册尚未
          // 注销（dispose 为 fire-and-forget）。确保存在可挂重试定时器的 entry
          // （首次连接无旧 entry → 落 failed 占位；旧 entry 保留其退避语义），
          // 安排一次有界延迟重试，避免窗口期「一次定终身」掉线；重试经
          // ensureConnected（尊重 userDisabled + in-flight 去重），再命中仍跳过
          // （官方 client 真接管场景不空转）。
          // #412 force 重建：复用旧 entry 可能是 connected 死连接，必须置
          // failed——否则 probeRetry 3s 后 ensureConnected（无 force）对
          // connected 短路，重试永不执行（死循环）。
          const retryEntry = unit.connections.get(serverName) ?? {
            server,
            client: undefined,
            transport: undefined,
            status: "failed",
            error: undefined,
            connectedAt: undefined,
            reconnectTimer: undefined,
            disposed: false,
            failedAttempts: 0,
          };
          retryEntry.status = "failed";
          retryEntry.client = undefined;
          retryEntry.transport = undefined;
          unit.connections.set(serverName, retryEntry);
          this.scheduleProbeRetry(root, serverName);
          return;
        }
      } catch {
        // 探测失败不阻塞
      }
    }
    const transport = createTransport(server);
    const client = new MCPClient(transport);
    const newEntry: ConnectionEntry = {
      server,
      client,
      transport,
      status: "connecting",
      error: undefined,
      connectedAt: undefined,
      reconnectTimer: undefined,
      disposed: false,
      failedAttempts: entry?.failedAttempts ?? 0,
      probeRetried: entry?.probeRetried ?? false,
    };
    unit.connections.set(serverName, newEntry);
    const closeHandler = (error: Error) => {
      if (newEntry.disposed) return;
      if (unit.connections.get(serverName) !== newEntry) return;
      newEntry.status = "failed";
      newEntry.error = error;
      newEntry.connectedAt = undefined;
      this.host.emitStatus();
      this.scheduleReconnect(root, serverName);
    };
    if ("onClose" in transport && transport.onClose !== undefined) transport.onClose(closeHandler);
    try {
      await withTimeout(transport.connect(), CONNECT_TIMEOUT_MS, `connect timed out (${CONNECT_TIMEOUT_MS}ms)`);
      await withTimeout(client.initialize(), CONNECT_TIMEOUT_MS, `initialize timed out (${CONNECT_TIMEOUT_MS}ms)`);
      await this.discover(root, serverName);
      if (newEntry.disposed || unit.connections.get(serverName) !== newEntry) return;
      newEntry.status = "connected";
      newEntry.connectedAt = Date.now();
      newEntry.failedAttempts = 0;
      newEntry.probeRetried = false;
      this.host.logger.info(`dsh-mcp-manager(${serverName}@${root}): connected`);
      this.host.emitStatus();
    } catch (error) {
      if (newEntry.disposed || unit.connections.get(serverName) !== newEntry) return;
      this.host.logger.warn(`dsh-mcp-manager(${serverName}@${root}): connection attempt failed: ${this.redact(error)}`);
      newEntry.status = "failed";
      newEntry.error = error;
      newEntry.failedAttempts += 1;
      this.host.emitStatus();
      this.scheduleReconnect(root, serverName);
    }
  }

  /** 后台重连（有界指数退避：500ms 起、30s 上限、10 次后停止后台重试；
   * 用户手动 connect 或 ws_mcp_call 触发时重新尝试——常驻语义）。 */
  private scheduleReconnect(root: string, serverName: string): void {
    const unit = this.units.get(root);
    if (unit === undefined) return;
    const entry = unit.connections.get(serverName);
    if (entry === undefined || entry.disposed) return;
    if (entry.reconnectTimer !== undefined) return;
    if (entry.failedAttempts > 10) {
      // 预算耗尽：停止后台重试（保留 failed 状态；手动/调用触发可再试）。
      this.host.logger.warn(`dsh-mcp-manager(${serverName}@${root}): reconnect gave up after 10 attempts`);
      return;
    }
    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(entry.failedAttempts - 1, 6));
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = undefined;
      if (entry.disposed) return;
      void this.connectInternal(root, serverName);
    }, delayMs);
    entry.reconnectTimer.unref?.();
  }

  /**
   * 防双进程探测命中后的一次性有界重试（#382 F5）。定时器复用 entry.reconnectTimer
   * 槽位（teardownUnit/disconnect 路径统一清理）；重试经 ensureConnected——它
   * 查 userDisabled + in-flight 去重，不会复活用户已断开的服务器、不与手动重连
   * 并发冲突。每代 entry 只重试一次（probeRetried 标记；连接成功复位），官方
   * dsh-mcp-client 真接管时不会反复空转。
   */
  private scheduleProbeRetry(root: string, serverName: string): void {
    const unit = this.units.get(root);
    if (unit === undefined) return;
    const entry = unit.connections.get(serverName);
    if (entry === undefined || entry.disposed) return;
    if (entry.reconnectTimer !== undefined) return;
    if (entry.probeRetried === true) return;
    entry.probeRetried = true;
    const PROBE_RETRY_DELAY_MS = 3000;
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = undefined;
      if (entry.disposed) return;
      void this.ensureConnected(root, serverName);
    }, PROBE_RETRY_DELAY_MS);
    entry.reconnectTimer.unref?.();
  }

  /** 发现工具并写入目录（per-root in-flight 去重）。 */
  async discover(root: string, serverName: string): Promise<void> {
    const unit = this.units.get(root);
    if (unit === undefined) return;
    const entry = unit.connections.get(serverName);
    if (entry === undefined || entry.client === undefined) return;
    const catalog = unit.catalog.get(serverName);
    if (catalog !== undefined && catalog.unavailable === undefined && Date.now() - catalog.discoveredAt <= CATALOG_TTL_MS) {
      return; // fresh
    }
    try {
      const tools = await withTimeout(this.listToolsAll(entry.client), DISCOVERY_TIMEOUT_MS, `discovery timed out (${DISCOVERY_TIMEOUT_MS}ms)`);
      const bounded = new Map<string, CatalogTool>();
      let totalBytes = 0;
      for (const tool of tools) {
        if (bounded.size >= MAX_TOOLS_PER_SERVER) break;
        const name = String(tool.name ?? "");
        if (name === "") continue;
        const description = typeof tool.description === "string" ? tool.description : "";
        const descriptionBytes = Buffer.byteLength(description, "utf8");
        if (descriptionBytes > MAX_BYTES_PER_TOOL) {
          bounded.set(name, { description: description.slice(0, MAX_BYTES_PER_TOOL), inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown> });
        } else {
          bounded.set(name, { description, inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown> });
        }
        totalBytes += descriptionBytes + JSON.stringify(bounded.get(name)?.inputSchema ?? {}).length;
        if (totalBytes > MAX_TOTAL_CATALOG_BYTES) break;
      }
      unit.catalog.set(serverName, { discoveredAt: Date.now(), tools: bounded });
      this.persistCatalog(root);
    } catch (error) {
      unit.catalog.set(serverName, { discoveredAt: 0, tools: new Map(), unavailable: this.redact(error) });
    }
  }

  /** 凭据脱敏（连接/发现/调用错误路径统一使用；P1 修复）。 */
  private redact(error: unknown): string {
    return createRedactor(this.allServers())(error);
  }

  private async listToolsAll(client: MCPClient): Promise<Array<Record<string, unknown>>> {
    const all: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    do {
      const response = (await client.listTools(cursor)) as { tools?: unknown[]; nextCursor?: unknown } | undefined;
      const tools = response?.tools ?? [];
      for (const tool of tools) {
        if (typeof tool === "object" && tool !== null) all.push(tool as Record<string, unknown>);
      }
      cursor = response?.nextCursor as string | undefined;
    } while (cursor !== undefined && cursor !== null && cursor !== "");
    return all;
  }

  /** 目录 last-good 持久化（空采集不写盘；public 供测试与外部触发）。 */
  async persistCatalog(root: string): Promise<void> {
    const unit = this.units.get(root);
    if (unit === undefined) return;
    let anyTools = false;
    const payload: Record<string, unknown> = {};
    for (const [serverName, catalog] of unit.catalog) {
      if (catalog.tools.size === 0) continue;
      anyTools = true;
      payload[serverName] = {
        discoveredAt: catalog.discoveredAt,
        tools: [...catalog.tools.entries()].map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema })),
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
      this.host.logger.warn(`dsh-mcp-manager: catalog cache write failed: ${msgOf(error)}`);
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
      const parsed = JSON.parse(raw) as { version?: unknown; root?: unknown; entries?: Record<string, unknown> } | null;
      if (parsed === null || typeof parsed !== "object" || typeof parsed.entries !== "object" || parsed.entries === null) return;
      if (!(serverName in parsed.entries)) return;
      delete parsed.entries[serverName];
      if (Object.keys(parsed.entries).length === 0) {
        await rm(file, { force: true }).catch(() => {});
        return;
      }
      const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, root, entries: parsed.entries }, null, 2), "utf8");
      await rename(tmp, file);
    } catch (error) {
      this.host.logger.warn(`dsh-mcp-manager: catalog cache remove failed: ${msgOf(error)}`);
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
      if (parsed && typeof parsed === "object" && typeof parsed.entries === "object" && parsed.entries !== null) {
        for (const [serverName, entry] of Object.entries(parsed.entries)) {
          const rec = entry as { discoveredAt?: unknown; tools?: unknown } | undefined;
          if (typeof rec !== "object" || rec === null) continue;
          const tools = new Map<string, CatalogTool>();
          if (Array.isArray(rec.tools)) {
            for (const tool of rec.tools) {
              const toolRec = tool as { name?: unknown; description?: unknown; inputSchema?: unknown } | undefined;
              if (typeof toolRec !== "object" || toolRec === null || typeof toolRec.name !== "string") continue;
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

  /** 执行 ws_mcp_call：路由 + 一致性校验 + 策略 + 调用。 */
  async callTool(
    fullName: string,
    toolRaw: string,
    rawArgs: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const parsed = parseFullServerName(fullName);
    if (parsed === undefined) {
      throw new Error(`ws_mcp_call: unknown server ${JSON.stringify(fullName)}; 格式应为 @<root>/<server>`);
    }
    const unit = this.units.get(parsed.root);
    if (unit === undefined) {
      throw new Error(`ws_mcp_call: 工作空间 ${JSON.stringify(parsed.root)} 未激活；请先 ws_mcp_search 或 ws_mcp_list`);
    }
    const entry = unit.connections.get(parsed.server);
    if (entry === undefined || entry.status === "failed") {
      if (unit.userDisabled.has(parsed.server)) {
        throw new Error(`ws_mcp_call: server ${JSON.stringify(fullName)} 已被用户禁用；可先在 GUI「MCP」浮窗中重新连接`);
      }
      throw new Error(`ws_mcp_call: server ${JSON.stringify(fullName)} 未连接或连接失败，请先 ws_mcp_search 或 ws_mcp_list 确认 server 已连接`);
    }
    if (entry.status === "connecting") {
      throw new Error(`ws_mcp_call: server ${JSON.stringify(fullName)} 连接仍在进行，请稍后重试；连接完成后再调用`);
    }
    const tool = normalizeToolName(parsed.server, toolRaw);
    // 工具级禁用（先查禁用表再查策略；P0-1 三入口统一走 isToolDenied）。
    const policyKey = fullServerName(parsed.root, parsed.server);
    if (isToolDenied(this.disabledTools, this.policy, policyKey, tool)) {
      // 策略拒绝与禁用拒绝文案区分（策略拒绝附「调整 middlewarePolicy 配置」下一步）。
      if (!policyAllows(this.policy, policyKey, tool)) {
        const reason = policyDenialReason(this.policy, policyKey, tool);
        throw new Error(`${reason ?? `ws_mcp_call: 工具 ${JSON.stringify(`${policyKey}/${tool}`)} 被策略拒绝`}；如需放行请调整 middlewarePolicy 配置`);
      }
      throw new Error(toolDisabledReason(policyKey, tool));
    }
    const catalog = unit.catalog.get(parsed.server);
    const stale =
      catalog !== undefined && catalog.unavailable === undefined && Date.now() - catalog.discoveredAt > CATALOG_TTL_MS;
    if (stale) {
      // stale：仍可调用（目录只是提示），但 schema 可能过期——在结果前置提示。
    }
    if (entry.client === undefined) {
      throw new Error(`ws_mcp_call: server ${JSON.stringify(fullName)} 未就绪（client 缺失）；请稍后重试或重新连接`);
    }
    const args = normalizeArguments(rawArgs);
    try {
      const result = await withTimeout(
        entry.client.callTool(tool, typeof args === "object" && args !== null ? args : {}, {
          signal,
          timeoutMs: CALL_TIMEOUT_MS,
        }),
        CALL_TIMEOUT_MS + 2000,
        `ws_mcp_call: 调用超时（${CALL_TIMEOUT_MS}ms），可重试；若反复超时请用 ws_mcp_detail 核对参数或检查服务器状态`,
        signal,
      );
      const resultObj = result as { content?: unknown; isError?: unknown; structuredContent?: unknown } | undefined;
      if (resultObj?.isError === true) {
        throw new Error(this.hostRedact(`ws_mcp_call: 远端工具返回错误：${msgOf(resultObj.content)}；可先用 ws_mcp_detail 核对参数 schema 后重试`));
      }
      if (stale) {
        // schema 可能已过期：结果前置提示（不改变调用结果结构）。
        const hint = { type: "text", text: "（提示：本工具目录已过期，schema 可能已变更，请重新 ws_mcp_search）" };
        const content = Array.isArray(resultObj?.content) ? [hint, ...(resultObj.content as unknown[])] : [hint];
        return { ...resultObj, content };
      }
      return resultObj;
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      throw new Error(this.hostRedact(`ws_mcp_call: ${JSON.stringify(`${parsed.server}/${tool}`)} 调用失败：${msgOf(error)}；可先用 ws_mcp_detail 核对参数 schema，或确认服务器已连接后重试`));
    }
  }

  private hostRedact(text: string): string {
    const redactor = createRedactor([...this.allServers()]);
    return redactor(new Error(text));
  }

  private allServers(): ServerConfig[] {
    const servers: ServerConfig[] = [];
    for (const unit of this.units.values()) {
      for (const entry of unit.connections.values()) servers.push(entry.server);
    }
    return servers;
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

  /** 拆毁一个单元（断开全部连接，保留目录缓存）。 */
  teardownUnit(root: string): void {
    const unit = this.units.get(root);
    if (unit === undefined) return;
    for (const entry of unit.connections.values()) {
      entry.disposed = true;
      if (entry.reconnectTimer !== undefined) clearTimeout(entry.reconnectTimer);
      const client = entry.client;
      entry.client = undefined;
      entry.transport = undefined;
      if (client !== undefined && client.transport !== undefined) {
        void client.transport.close().catch(() => {});
      }
    }
    unit.connections.clear();
    this.units.delete(root);
  }

  /** 全部拆毁（插件卸载）。 */
  async dispose(): Promise<void> {
    for (const root of [...this.units.keys()]) this.teardownUnit(root);
    this.units.clear();
  }
}

// ------------------------------------------------------------ 汇聚转发
// 导出面与拆分前完全一致（index.ts / manager.ts / smoke 验收契约）。

// 常量与模式归一化
export {
  CONNECT_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  CATALOG_TTL_MS,
  CATALOG_LRU_MAX,
  MAX_TOOLS_PER_SERVER,
  MAX_BYTES_PER_TOOL,
  MAX_TOTAL_CATALOG_BYTES,
  LIST_DEFAULT_TOOLS_PER_SERVER,
  LIST_MAX_TOOLS_PER_SERVER,
  normalizeMiddlewareMode,
} from "./middleware-const.ts";
// 纯函数与目录检索
export {
  withTimeout,
  fullServerName,
  parseFullServerName,
  normalizeToolName,
  normalizeArguments,
  msgOf,
  createRedactor,
  globMatch,
  policyAllows,
  bareServerName,
  policyDenialReason,
  isToolDenied,
  toolDisabledReason,
  parseDisabledTools,
  scoreTool,
  searchCatalog,
  searchCatalogMulti,
  listCatalog,
  findToolDetail,
  MIDDLEWARE_GLOBAL_ROOT,
} from "./middleware-utils.ts";
// 状态持久化
export { userStateFile, loadUserState, saveUserState, catalogCacheFileFor, loadDisabledTools, saveDisabledTools } from "./middleware-state.ts";
// 工具注册
export { registerMiddlewareTools } from "./middleware-register.ts";
// 类型
export type {
  MiddlewareMode,
  MiddlewarePolicy,
  ProjectUnit,
  ConnectionEntry,
  CatalogServer,
  CatalogTool,
  SearchHit,
  ListToolEntry,
  ListServerEntry,
  ListCatalogResult,
  ToolDetail,
  MiddlewareHost,
  DisabledToolsMap,
} from "./middleware-types.ts";

