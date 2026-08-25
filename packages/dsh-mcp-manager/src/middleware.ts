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
 * 由 lib/index.js 组合根 re-export。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ServerConfig } from "./types.js";
import type { Context, LoggerService } from "@deepseek-ai/cordis";
import type { ToolDefinition, PreToolDecision } from "@deepseek-ai/dsh-tools";
import { MCPClient } from "./protocol.js";
import type { StdioTransport, HttpTransport } from "./transport.js";
import { createTransport } from "./transport.js";

// ------------------------------------------------------------ 常量与类型

/** 中间层模式：off = 直呼（默认兼容）；project = 项目级走中间层；all = 全部走中间层。 */
export type MiddlewareMode = "off" | "project" | "all";

/** 归一化中间层模式（非法值回落 off）。 */
export function normalizeMiddlewareMode(value: unknown): MiddlewareMode {
  return value === "project" || value === "all" ? value : "off";
}

/** 连接超时（ms）。 */
export const CONNECT_TIMEOUT_MS = 10_000;
/** 工具发现（tools/list 全量）超时（ms）。 */
export const DISCOVERY_TIMEOUT_MS = 10_000;
/** 单次远端工具调用超时（ms）。 */
export const CALL_TIMEOUT_MS = 30_000;
/** 目录 TTL（ms）：24h。 */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
/** 每工作空间目录 LRU 上限。 */
export const CATALOG_LRU_MAX = 16;
/** 目录安全边界：单服务器工具数上限。 */
export const MAX_TOOLS_PER_SERVER = 512;
/** 目录安全边界：单工具描述字节上限。 */
export const MAX_BYTES_PER_TOOL = 4096;
/** 目录安全边界：目录总字节上限。 */
export const MAX_TOTAL_CATALOG_BYTES = 256 * 1024;

/** 策略过滤模式。 */
export interface MiddlewarePolicy {
  /** server 名（裸名，不含 @root 前缀）→ 允许的工具 glob（空 = 全部允许）。 */
  allowTools?: Record<string, string[]>;
  /** server 名（裸名）→ 拒绝的工具 glob（deny 优先）。 */
  denyTools?: Record<string, string[]>;
}

/** 连接池条目（每工作空间一套）。 */
export interface ProjectUnit {
  root: string;
  /** server 名（裸名）→ 连接条目。 */
  connections: Map<string, ConnectionEntry>;
  /** 目录缓存（last-good：连接断不丢）。 */
  catalog: Map<string, CatalogServer>;
  /** 用户禁用集合（持久化）。 */
  userDisabled: Set<string>;
  /** 最近触达时间（LRU 淘汰依据）。 */
  lastTouchedAt: number;
  /** 连接/发现 in-flight 去重（server 名 → Promise）。 */
  inFlight: Map<string, Promise<unknown>>;
}

/** 单服务器连接条目。 */
export interface ConnectionEntry {
  server: ServerConfig;
  client: MCPClient | undefined;
  transport: StdioTransport | HttpTransport | undefined;
  /** 连接状态：connecting / connected / failed / disabled。 */
  status: string;
  error: unknown;
  connectedAt: number | undefined;
  /** 后台重连定时器。 */
  reconnectTimer: NodeJS.Timeout | undefined;
  /** 代际断开清理。 */
  disposed: boolean;
}

/** 目录中的单服务器条目。 */
export interface CatalogServer {
  /** 发现时间戳。 */
  discoveredAt: number;
  /** 工具列表（裸名 → 描述 + schema 摘要）。 */
  tools: Map<string, CatalogTool>;
  /** 发现失败原因（unavailable 段）。 */
  unavailable?: string;
}

/** 目录中的单工具。 */
export interface CatalogTool {
  description: string;
  inputSchema: Record<string, unknown>;
}

/** ws_mcp_search 单条命中。 */
export interface SearchHit {
  server: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  score: number;
  matchedTerms: string[];
  fresh: boolean;
}

/** 中间层最小面（manager 提供）。 */
export interface MiddlewareHost {
  ctx: Pick<Context, "tools">;
  logger: LoggerService;
  /** 按 root 读取项目级服务器配置（惰性；root 无标记 → undefined）。 */
  projectServersFor(root: string): Promise<ServerConfig[] | undefined>;
  /** 全局服务器配置（走中间层 all 模式时使用）。 */
  globalServers(): ServerConfig[];
  /** 路由解析：cwd → 归一化项目根。 */
  normalizedProjectRoot(cwd: string | undefined): Promise<string | undefined>;
  /** 持久化 userDisabled。 */
  saveUserState(units: Map<string, ProjectUnit>): Promise<void>;
  /** 状态变化通知（SSE 标脏）。 */
  emitStatus(): void;
  /** 目录缓存文件路径（last-good 持久化）。 */
  catalogCachePath(root: string): string;
}

// ------------------------------------------------------------ 纯函数

/** server 全局唯一名：@<root>/<server>。 */
export function fullServerName(root: string, server: string): string {
  return `@${root}/${server}`;
}

/** 解析 @<root>/<server> 全名 → { root, server }；非法返回 undefined。
 * root 是绝对路径（以 / 开头），故从最后一个 `/` 分割（server 名不含 `/`）。 */
export function parseFullServerName(name: string): { root: string; server: string } | undefined {
  if (!name.startsWith("@")) return undefined;
  const slash = name.lastIndexOf("/");
  if (slash <= 1 || slash === name.length - 1) return undefined;
  return { root: name.slice(1, slash), server: name.slice(slash + 1) };
}

/** 归一化 ws_mcp_call 的 tool 参数（模型可能传 mcp__<server>__<tool> 全名）。 */
export function normalizeToolName(serverName: string, toolName: string): string {
  const prefix = `mcp__${serverName}__`;
  let name = toolName;
  if (name.startsWith("mcp__")) {
    while (name.startsWith(prefix)) name = name.slice(prefix.length);
    if (name.startsWith("mcp__")) {
      throw new Error(
        `ws_mcp_call: tool 参数疑似其他 MCP server 的注册全名（${JSON.stringify(toolName)}，server="${serverName}"）；请传该 server 上的裸名`,
      );
    }
  }
  return name;
}

/** 归一化 ws_mcp_call 的 arguments 参数（模型可能把参数字典填成 JSON 字符串）。 */
export function normalizeArguments(raw: unknown): unknown {
  let value: unknown = raw ?? {};
  let depth = 0;
  while (typeof value === "string" && depth < 4) {
    const trimmed = value.trim();
    if (trimmed.length === 0) return {};
    const head = trimmed.charCodeAt(0);
    const isContainerJson = head === 123 /* { */ || head === 91 /* [ */;
    const isQuotedJson = head === 34 /* " */;
    if (!isContainerJson && !isQuotedJson) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      break;
    }
    if (parsed !== null && typeof parsed === "object") return parsed;
    const inner = typeof parsed === "string" ? parsed.trim() : "";
    const innerLooksContainer = inner.startsWith("{") || inner.startsWith("[");
    if (!isQuotedJson || !innerLooksContainer) break;
    value = parsed;
    depth += 1;
  }
  return value;
}

/** 统一错误提取（Error/string/object 三态）。 */
export function msgOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** 凭据脱敏器：从服务器配置收集 secret 值，替换错误消息中的出现。 */
export function createRedactor(servers: readonly ServerConfig[]): (error: unknown) => string {
  const secrets = new Set<string>();
  for (const server of servers) {
    if (server.transport === "stdio") {
      for (const value of Object.values(server.env ?? {})) if (value.length > 0) secrets.add(value);
      const args = server.args ?? [];
      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index] ?? "";
        const equals = argument.indexOf("=");
        const flag = equals < 0 ? argument : argument.slice(0, equals);
        if (!/(?:token|secret|pass|key|auth|cookie|credential)/i.test(flag)) continue;
        const value = equals < 0 ? args[index + 1] : argument.slice(equals + 1);
        if (value !== undefined && value.length > 0) secrets.add(value);
      }
      continue;
    }
    for (const value of Object.values(server.headers ?? {})) if (value.length > 0) secrets.add(value);
    const url = server.url;
    if (typeof url === "string" && url !== "") {
      secrets.add(url);
      try {
        const parsed = new URL(url);
        if (parsed.username.length > 0) secrets.add(parsed.username);
        if (parsed.password.length > 0) secrets.add(parsed.password);
        for (const value of parsed.searchParams.values()) if (value.length > 0) secrets.add(value);
      } catch {
        // 非法 URL 忽略
      }
    }
  }
  const ordered = [...secrets].sort((left, right) => right.length - left.length);
  return (error: unknown): string => {
    let text: string;
    try {
      text = error instanceof Error ? error.message : String(error);
    } catch {
      text = "<unprintable error>";
    }
    for (const secret of ordered) text = text.split(secret).join("[REDACTED]");
    return text;
  };
}

/** 工具名匹配 glob（* 通配）。 */
export function globMatch(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === name;
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(name);
}

/** 策略裁决：deny 优先。返回 true = 允许。 */
export function policyAllows(policy: MiddlewarePolicy | undefined, server: string, tool: string): boolean {
  if (policy === undefined) return true;
  const deny = policy.denyTools?.[server];
  if (deny !== undefined && deny.some((pattern) => globMatch(pattern, tool))) return false;
  const allow = policy.allowTools?.[server];
  if (allow === undefined || allow.length === 0) return true;
  return allow.some((pattern) => globMatch(pattern, tool));
}

/** 策略拒绝原因（供 denialReason 提示）。 */
export function policyDenialReason(policy: MiddlewarePolicy | undefined, server: string, tool: string): string | undefined {
  if (policyAllows(policy, server, tool)) return undefined;
  const deny = policy?.denyTools?.[server];
  if (deny !== undefined && deny.some((pattern) => globMatch(pattern, tool))) {
    return `ws_mcp_call: 工具 ${JSON.stringify(`${server}/${tool}`)} 被 denyTools 策略拒绝`;
  }
  return `ws_mcp_call: 工具 ${JSON.stringify(`${server}/${tool}`)} 不在 allowTools 白名单内，被策略拒绝`;
}

// ------------------------------------------------------------ 目录检索

/** 简单分词（英文小写 + 中文保留）。 */
function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const words = lowered.match(/[a-z0-9_]+|[\u4e00-\u9fff]+/gu) ?? [];
  return words;
}

/** 跨字段打分：query 词命中 server 名 / 工具名 / description / 参数名。 */
export function scoreTool(query: string, server: string, toolName: string, tool: CatalogTool): { score: number; matchedTerms: string[] } {
  if (query === "") return { score: 0, matchedTerms: [] };
  const terms = tokenize(query);
  if (terms.length === 0) return { score: 0, matchedTerms: [] };
  const haystack = [
    tokenize(server).join(" "),
    tokenize(toolName).join(" "),
    tokenize(tool.description).join(" "),
    tokenize(JSON.stringify(Object.keys(tool.inputSchema ?? {}))).join(" "),
  ].join(" ");
  let score = 0;
  const matchedTerms: string[] = [];
  for (const term of terms) {
    if (term.length < 2) continue;
    if (haystack.includes(term)) {
      score += 1;
      matchedTerms.push(term);
    }
  }
  return { score, matchedTerms };
}

/** 检索目录：query 为空 → 能力摘要表（每服务器前 N 个工具）。 */
export function searchCatalog(
  units: Map<string, ProjectUnit>,
  root: string,
  query: string,
  limit: number,
): { results: SearchHit[]; unavailable: Array<{ server: string; reason: string }> } {
  const unit = units.get(root);
  if (unit === undefined) return { results: [], unavailable: [] };
  const results: SearchHit[] = [];
  const unavailable: Array<{ server: string; reason: string }> = [];
  for (const [serverName, catalog] of unit.catalog) {
    if (catalog.unavailable !== undefined) {
      unavailable.push({ server: fullServerName(root, serverName), reason: catalog.unavailable });
      continue;
    }
    const fresh = Date.now() - catalog.discoveredAt <= CATALOG_TTL_MS;
    const scored: Array<{ server: string; toolName: string; tool: CatalogTool; score: number; matchedTerms: string[] }> = [];
    for (const [toolName, tool] of catalog.tools) {
      const { score, matchedTerms } = scoreTool(query, serverName, toolName, tool);
      if (query !== "" && score === 0) continue;
      scored.push({ server: serverName, toolName, tool, score, matchedTerms });
    }
    scored.sort((a, b) => b.score - a.score || a.toolName.localeCompare(b.toolName));
    for (const hit of scored.slice(0, limit)) {
      results.push({
        server: fullServerName(root, hit.server),
        tool: hit.toolName,
        description: hit.tool.description,
        inputSchema: hit.tool.inputSchema,
        score: hit.score,
        matchedTerms: hit.matchedTerms,
        fresh,
      });
    }
  }
  return { results, unavailable };
}

// ------------------------------------------------------------ 连接池

/** 等待带超时（race 兜底）。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(message));
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

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
      // 后台惰性连接（fire-and-forget，不阻塞调用方）。
      for (const server of servers) {
        if (server.enabled !== false) void this.ensureConnected(root, server.name);
      }
    }
    unit.lastTouchedAt = Date.now();
    return unit;
  }

  /** 连接一个服务器（in-flight 去重；失败后台重连）。 */
  async ensureConnected(root: string, serverName: string): Promise<void> {
    const unit = this.units.get(root);
    if (unit === undefined) return;
    if (unit.userDisabled.has(serverName)) return;
    const servers = await this.host.projectServersFor(root);
    const server = servers?.find((entry) => entry.name === serverName);
    if (server === undefined || server.enabled === false) return;
    const existing = unit.inFlight.get(serverName);
    if (existing !== undefined) return existing as Promise<void>;
    const promise = this.connectInternal(root, serverName);
    unit.inFlight.set(serverName, promise);
    try {
      await promise;
    } finally {
      unit.inFlight.delete(serverName);
    }
  }

  private async connectInternal(root: string, serverName: string): Promise<void> {
    const unit = this.units.get(root);
    if (unit === undefined) return;
    const entry = unit.connections.get(serverName);
    if (entry !== undefined && (entry.status === "connected" || entry.status === "connecting")) return;
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
      this.host.logger.info(`dsh-mcp-manager(${serverName}@${root}): connected`);
      this.host.emitStatus();
    } catch (error) {
      if (newEntry.disposed || unit.connections.get(serverName) !== newEntry) return;
      this.host.logger.warn(`dsh-mcp-manager(${serverName}@${root}): connection attempt failed: ${msgOf(error)}`);
      newEntry.status = "failed";
      newEntry.error = error;
      this.host.emitStatus();
      this.scheduleReconnect(root, serverName);
    }
  }

  /** 后台重连（有界指数退避，常驻语义）。 */
  private scheduleReconnect(root: string, serverName: string): void {
    const unit = this.units.get(root);
    if (unit === undefined) return;
    const entry = unit.connections.get(serverName);
    if (entry === undefined || entry.disposed) return;
    if (entry.reconnectTimer !== undefined) return;
    const delayMs = 1000;
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = undefined;
      if (entry.disposed) return;
      void this.connectInternal(root, serverName);
    }, delayMs);
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
      unit.catalog.set(serverName, { discoveredAt: 0, tools: new Map(), unavailable: msgOf(error) });
    }
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

  /** 目录 last-good 持久化（空采集不写盘）。 */
  private async persistCatalog(root: string): Promise<void> {
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
      throw new Error(`ws_mcp_call: 工作空间 ${JSON.stringify(parsed.root)} 未激活；请先 ws_mcp_search`);
    }
    const entry = unit.connections.get(parsed.server);
    if (entry === undefined || entry.status === "failed") {
      if (unit.userDisabled.has(parsed.server)) {
        throw new Error(`ws_mcp_call: server ${JSON.stringify(fullName)} 已被用户禁用`);
      }
      throw new Error(`ws_mcp_call: server ${JSON.stringify(fullName)} 未连接或连接失败，请先 ws_mcp_search`);
    }
    if (entry.status === "connecting") {
      throw new Error(`ws_mcp_call: server ${JSON.stringify(fullName)} 连接仍在进行，请稍后重试`);
    }
    const tool = normalizeToolName(parsed.server, toolRaw);
    if (!policyAllows(this.policy, parsed.server, tool)) {
      const reason = policyDenialReason(this.policy, parsed.server, tool);
      throw new Error(reason ?? `ws_mcp_call: 工具 ${JSON.stringify(`${parsed.server}/${tool}`)} 被策略拒绝`);
    }
    const catalog = unit.catalog.get(parsed.server);
    const stale =
      catalog !== undefined && catalog.unavailable === undefined && Date.now() - catalog.discoveredAt > CATALOG_TTL_MS;
    if (stale) {
      // stale：仍可调用（目录只是提示），但 schema 可能过期——在结果前置提示。
    }
    if (entry.client === undefined) {
      throw new Error(`ws_mcp_call: server ${JSON.stringify(fullName)} 未就绪（client 缺失）`);
    }
    const args = normalizeArguments(rawArgs);
    try {
      const result = await withTimeout(
        entry.client.callTool(tool, typeof args === "object" && args !== null ? args : {}, {
          signal,
          timeoutMs: CALL_TIMEOUT_MS,
        }),
        CALL_TIMEOUT_MS + 2000,
        `ws_mcp_call: 调用超时（${CALL_TIMEOUT_MS}ms），可重试`,
        signal,
      );
      const resultObj = result as { content?: unknown; isError?: unknown; structuredContent?: unknown } | undefined;
      if (resultObj?.isError === true) {
        throw new Error(this.hostRedact(`ws_mcp_call: 远端工具返回错误：${msgOf(resultObj.content)}`));
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
      throw new Error(this.hostRedact(`ws_mcp_call: ${JSON.stringify(`${parsed.server}/${tool}`)} 调用失败：${msgOf(error)}`));
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

  /** LRU 淘汰：无活动引用（lastTouchedAt 最旧）且超过上限时淘汰最旧单元。 */
  evictIfNeeded(maxUnits = 16): void {
    while (this.units.size > maxUnits) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [root, unit] of this.units) {
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

// ------------------------------------------------------------ 工具注册

/**
 * 注册 ws_mcp_search / ws_mcp_call 两个中间层工具。
 * @param host 中间层宿主。
 * @param mw 中间层实例。
 * @param resolveRoot 路由：exec.agent → 归一化项目根（agent-less → undefined）。
 */
export function registerMiddlewareTools(
  ctx: Context,
  mw: McpMiddleware,
  resolveRoot: (agent: unknown) => Promise<string | undefined>,
): () => void {
  const disposers: Array<() => void> = [];

  const search: ToolDefinition = {
    name: "ws_mcp_search",
    description: "检索当前工作空间的 MCP 工具目录。先用本工具检索，再 ws_mcp_call 调用。空 query 返回能力摘要表。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "意图/关键词；空则列能力摘要" },
        server: { type: "string", description: "可选：@<root>/<server> 全名过滤" },
        limit: { type: "number", description: "返回条数上限（默认 5，上限 10）" },
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          results: { type: "array", items: {} },
          unavailable: { type: "array", items: {} },
        },
        required: ["results", "unavailable"],
        additionalProperties: false,
      },
      render(_args, value: unknown) {
        const v = (value ?? {}) as { results?: Array<Record<string, unknown>>; unavailable?: Array<Record<string, unknown>> };
        const lines = (v.results ?? []).map((hit) => {
          const server = String(hit.server ?? "");
          const tool = String(hit.tool ?? "");
          const description = String(hit.description ?? "");
          return `${server}/${tool}: ${description}`;
        });
        const body = lines.length > 0 ? lines.join("\n") : "（当前工作空间没有匹配的 MCP 工具）";
        const unavailable = (v.unavailable ?? []).map((entry) => `${String(entry.server ?? "")}: ${String(entry.reason ?? "")}`);
        return [{ type: "text", text: unavailable.length > 0 ? `${body}\n\n不可用服务器：\n${unavailable.join("\n")}` : body }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown, exec: { signal?: AbortSignal; agent?: unknown }) {
      const root = await resolveRoot(exec.agent);
      if (root === undefined) throw new Error("ws_mcp_search: 无法确定工作空间，请先选择工作区");
      const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
      const query = typeof params.query === "string" ? params.query : "";
      const serverFilter = typeof params.server === "string" ? params.server : undefined;
      const requested = typeof params.limit === "number" ? Math.floor(params.limit) : 5;
      const limit = Math.max(1, Math.min(requested, 10));
      const unit = await mw.projectUnitFor(root);
      if (unit === undefined) {
        return { results: [], unavailable: [] };
      }
      // 等待 in-flight 连接/发现（预算内），再搜索。
      const inflight = [...unit.inFlight.values()];
      if (inflight.length > 0) {
        try {
          await withTimeout(Promise.allSettled(inflight), 8000, "等待连接/发现超时");
        } catch {
          // 超时不阻塞搜索（返回已有目录）
        }
      }
      const { results, unavailable } = searchCatalog(mw.units, root, query, limit);
      const filtered = serverFilter === undefined ? results : results.filter((hit) => hit.server === serverFilter);
      return { results: filtered, unavailable };
    },
  };

  const call: ToolDefinition = {
    name: "ws_mcp_call",
    description: "调用当前工作空间的一个 MCP 工具。server/tool 来自 ws_mcp_search 返回（已知时可直呼，免搜索）。",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "必须：@<root>/<server> 全名（来自 ws_mcp_search）" },
        tool: { type: "string", description: "必须：远端工具裸名（来自 ws_mcp_search）" },
        arguments: { type: "object", additionalProperties: true, description: "参数，匹配 ws_mcp_search 返回的 inputSchema" },
      },
      required: ["server", "tool"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          content: { type: "array", items: {} },
          structuredContent: {},
        },
        required: ["content"],
        additionalProperties: false,
      },
      render(_args, value: unknown) {
        const v = (value ?? {}) as { content?: unknown };
        const content = Array.isArray(v.content) ? v.content : [];
        const parts: string[] = [];
        for (const block of content) {
          if (typeof block !== "object" || block === null) {
            parts.push("[unsupported MCP content]");
            continue;
          }
          const rec = block as Record<string, unknown>;
          if (rec.type === "text" && typeof rec.text === "string") {
            parts.push(rec.text);
            continue;
          }
          if (rec.type === "resource" || rec.type === "resource_link") {
            parts.push("[resource: content discarded]");
            continue;
          }
          parts.push(`[${String(rec.type ?? "unknown")} content]`);
        }
        return [{ type: "text", text: parts.length > 0 ? parts.join("\n") : "(MCP tool returned no content)" }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: CONNECT_TIMEOUT_MS + DISCOVERY_TIMEOUT_MS + CALL_TIMEOUT_MS + 5000,
    async execute(args: unknown, exec: { signal?: AbortSignal; agent?: unknown }) {
      const root = await resolveRoot(exec.agent);
      if (root === undefined) throw new Error("ws_mcp_call: 无法确定工作空间，请先选择工作区");
      const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
      const server = typeof params.server === "string" ? params.server : "";
      const tool = typeof params.tool === "string" ? params.tool : "";
      if (server === "" || tool === "") throw new Error("ws_mcp_call: server 与 tool 均为必填");
      const parsed = parseFullServerName(server);
      if (parsed === undefined || parsed.root !== root) {
        throw new Error(
          `ws_mcp_call: server ${JSON.stringify(server)} 不属于当前工作空间 ${JSON.stringify(root)}；路由一致性校验失败（防跨空间串台）`,
        );
      }
      // 确保连接已建立（等待 in-flight + 单次连接）。
      const unit = await mw.projectUnitFor(root);
      if (unit === undefined) throw new Error(`ws_mcp_call: 工作空间 ${JSON.stringify(root)} 无项目级 MCP 配置`);
      await mw.ensureConnected(root, parsed.server);
      return mw.callTool(server, tool, params.arguments, exec.signal);
    },
  };

  disposers.push(ctx.tools.register(search));
  disposers.push(ctx.tools.register(call));

  // 策略 guard 层（方案 v2）：tools/pre-execute 全局唯一执行点，防其他插件/
  // 入口绕行 ws_mcp_call 直接调用远端工具。对 ws_mcp_call 的调用统一过策略
  // （deny 优先）；其余工具放行（不干扰 mcp__ 直呼兼容路径）。
  if (typeof ctx.on === "function") {
    const guardDispose = ctx.on(
      "tools/pre-execute",
      async (exec: { name?: string; arguments?: unknown }, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
        if (exec?.name !== "ws_mcp_call") return next();
        const params = (typeof exec.arguments === "object" && exec.arguments !== null ? exec.arguments : {}) as Record<string, unknown>;
        const server = typeof params.server === "string" ? params.server : "";
        const tool = typeof params.tool === "string" ? params.tool : "";
        const parsed = parseFullServerName(server);
        if (parsed === undefined || parsed.server === "") return next();
        if (!policyAllows(mw.policy, parsed.server, tool)) {
          const reason = policyDenialReason(mw.policy, parsed.server, tool);
          return { kind: "deny", reason: reason ?? `ws_mcp_call: 工具被策略拒绝` };
        }
        return next();
      },
    );
    disposers.push(guardDispose);
  }

  return () => {
    for (const dispose of disposers) dispose();
  };
}

/** userDisabled 持久化文件路径。 */
export function userStateFile() {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-mcp-user-state.json");
}

/** 加载 userDisabled（损坏/缺失 → 空）。 */
export async function loadUserState(file: string): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  try {
    if (!existsSync(file)) return out;
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { disabled?: Record<string, string[]> } | null;
    if (parsed && typeof parsed === "object" && typeof parsed.disabled === "object" && parsed.disabled !== null) {
      for (const [root, names] of Object.entries(parsed.disabled)) {
        if (Array.isArray(names)) out.set(root, new Set(names.filter((name) => typeof name === "string")));
      }
    }
  } catch {
    // 损坏忽略
  }
  return out;
}

/** 持久化 userDisabled。 */
export async function saveUserState(file: string, units: Map<string, ProjectUnit>): Promise<void> {
  const disabled: Record<string, string[]> = {};
  for (const [root, unit] of units) {
    if (unit.userDisabled.size > 0) disabled[root] = [...unit.userDisabled].sort();
  }
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, disabled }, null, 2), "utf8");
    await rename(tmp, file);
  } catch {
    // 落盘失败不阻塞主流程
  }
}

/** 目录缓存文件路径（每工作空间一份；root 哈希防路径注入）。 */
export function catalogCacheFileFor(root: string) {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-mcp-catalog", `${hash}.json`);
}
