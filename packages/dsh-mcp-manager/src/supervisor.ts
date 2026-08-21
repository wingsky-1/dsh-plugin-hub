/**
 * dsh-mcp-manager — 连接监督器与工具定义（依赖 transport / protocol）。
 *
 * ConnectionSupervisor 管理单个服务器的 client/transport 代际、连接成功
 * 后的工具同步与断开后的有界指数退避重连；同文件承载工具定义构建链
 * （命名 / 文本投影 / 截断 / 输出 schema 校验 / buildToolDefinition），
 * 它们只被监督器的 syncTools 使用。
 * 由 lib/index.js 组合根 re-export。
 */

import { createHash } from "node:crypto";
import { createTransport } from "./transport.js";
import type { StdioTransport, HttpTransport } from "./transport.js";
import { SCOPE_GLOBAL, SCOPE_PROJECT } from "./scope.js";
import { MCPClient } from "./protocol.js";
import type { ServerConfig } from "./types.js";
import type { DshTool } from "../../../types/dsh.js";
import type { Context, LoggerService } from "@deepseek-ai/cordis";

/** 重连策略（解析后）。 */
export interface ReconnectPolicy {
  enabled: boolean;
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

/** McpManager 最小面（supervisor 使用；避免 index↔supervisor 循环 import）。
 * tools 面取官方 Context（register 入参为官方 ToolDefinition），自建 DshTool
 * 在注册点经边界收窄传入（见 registerTool 调用处）。 */
export interface ManagerLite {
  ctx: Pick<Context, "tools">;
  logger: LoggerService;
  enhancement: { enhanceEmptyDescriptions?: boolean; resultTruncateBytes?: number };
  emitStatus(): void;
  recordCatalogTools(serverName: string, toolMeta: Map<string, { description?: unknown }>): Promise<void>;
}

// --------------------------------------------------------- 工具命名 / 截断

/** 默认单次工具调用超时（毫秒）。下探自 60s：死工具（服务器已断线但工具未注销）
 * 会让模型阻塞一整轮；15s 内快速失败并携带"服务器不可用"说明更划算。 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 15_000;

/** 重连默认策略（与官方 dsh-mcp-client 一致）。 */
export const RECONNECT_DEFAULTS = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
});

/** 工具结果渲染截断上限（字节）。extractText 现状不截断，超长 JSON 全量进上下文。 */
export const DEFAULT_RESULT_TRUNCATE_BYTES = 8192;

/** DeepSeek 函数名契约：最多 64 字符、仅 [A-Za-z0-9_-]。 */
const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

/** 从 (serverName, rawName) 派生模型可见的公开工具名。 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, "_");
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/** 把 MCP 返回的 content 块投影为文本（图片/音频/资源降级为占位符）。 */
function extractText(mcpContent: unknown[], toolName: string): string {
  const parts = [];
  for (const value of mcpContent) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      parts.push("[unsupported content type: unknown]");
      continue;
    }
    const block = value as Record<string, unknown>;
    switch (block.type) {
      case "text":
        if (block.text !== undefined) parts.push(block.text);
        break;
      case "image":
        parts.push(`[image: ${block.mimeType ?? "unknown"}, content discarded]`);
        break;
      case "audio":
        parts.push(`[audio: ${block.mimeType ?? "unknown"}, content discarded]`);
        break;
      case "resource":
      case "resource_link":
        parts.push("[resource: content discarded]");
        break;
      default:
        parts.push(`[unsupported content type: ${block.type}]`);
    }
  }
  return parts.join("\n") || `(${toolName} returned no text content)`;
}

/**
 * 按字节截断文本（L3，防超长 JSON 全量进上下文）。
 * 尾部标注截断提示，防模型基于截断内容产生幻觉。
 * @param text 原始文本。
 * @param maxBytes 截断上限（字节，UTF-8）。
 * @returns 截断后的文本（含标注）。
 */
export function truncateText(text: unknown, maxBytes: number): unknown {
  if (typeof text !== "string" || text === "") return text;
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = `\n…（已截断：原文 ${Buffer.byteLength(text, "utf8")} 字节，仅显示前 ${maxBytes} 字节）`;
  const budget = Math.max(maxBytes - Buffer.byteLength(suffix, "utf8"), 64);
  let truncated = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8");
  // 避免截断点落在多字节字符中间产生替换符。
  if (truncated.endsWith("\uFFFD")) truncated = truncated.slice(0, -1);
  return `${truncated}${suffix}`;
}

// ------------------------------------------------------------------ schema

/**
 * 输出 schema 支持子集校验（对齐 @deepseek-ai/dsh-tools assertSupportedJsonSchema）。
 * 业界最佳实践（与官方 dsh-mcp-client 一致）：
 *  - 工具参数（parameters）**原样直传** MCP 的 inputSchema——dsh 注册表不校验
 *    parameters，运行时校验器只读取支持的键、忽略未知键（$schema/minimum/
 *    propertyNames 等），宽容接受是安全且符合生态标准的；
 *  - 输出 schema（structuredContent）用本函数**严格校验**：完全落在支持子集
 *    才携带，任何未知关键字或非法结构（如 schema 形式的 additionalProperties、
 *    propertyNames、$schema）整体回退为自由 JsonValue（{}），绝不剥键改造——
 *    剥键会改变语义且与官方校验规则存在偏差。
 */
const SCHEMA_TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];
const SCHEMA_CONSTRAINT_KEYS = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const"]);
const SCHEMA_ANNOTATION_KEYS = new Set(["description", "title", "default", "examples"]);
/** 与 oneOf 互斥的兄弟关键字。 */
const SCHEMA_ONE_OF_SIBLING_KEYS = ["properties", "required", "additionalProperties", "items", "enum", "const"];

/** 标量是否匹配声明的 schema 类型（与 dsh-tools scalarMatches 一致）。 */
function scalarMatchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}

/** 校验一个 schema 节点（及全部后代）是否完全落在支持子集内。 */
function checkSchemaNode(node: Record<string, unknown>, depth: number, seen: Set<object>): boolean {
  if (depth > 32) return false;
  if (typeof node !== "object" || node === null || Array.isArray(node)) return false;
  if (seen.has(node)) return false; // 循环引用
  seen.add(node);
  try {
    for (const key of Object.keys(node)) {
      if (SCHEMA_CONSTRAINT_KEYS.has(key) || SCHEMA_ANNOTATION_KEYS.has(key)) continue;
      return false; // 未知关键字（$schema、minimum、propertyNames、format…）→ 不支持
    }
    if (Object.hasOwn(node, "description") && typeof node.description !== "string") return false;
    if (Object.hasOwn(node, "title") && typeof node.title !== "string") return false;
    const hasType = Object.hasOwn(node, "type");
    const hasOneOf = Object.hasOwn(node, "oneOf");
    if (hasType && hasOneOf) return false; // type 与 oneOf 互斥
    if (!hasType && !hasOneOf) {
      // 注解-only / 空 schema：可接受，但兄弟约束键需要 type/oneOf
      for (const key of SCHEMA_ONE_OF_SIBLING_KEYS) if (Object.hasOwn(node, key)) return false;
      return true;
    }
    if (hasOneOf) {
      // oneOf 旁不得有兄弟约束键
      for (const key of SCHEMA_ONE_OF_SIBLING_KEYS) if (Object.hasOwn(node, key)) return false;
      if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) return false;
      for (const branch of node.oneOf) if (!checkSchemaNode(branch, depth + 1, seen)) return false;
      return true;
    }
    const type = node.type;
    if (typeof type !== "string" || !SCHEMA_TYPES.includes(type)) return false;
    if (type === "object") {
      if (Object.hasOwn(node, "properties")) {
        if (typeof node.properties !== "object" || node.properties === null || Array.isArray(node.properties)) return false;
        for (const value of Object.values(node.properties)) {
          if (!checkSchemaNode(value as Record<string, unknown>, depth + 1, seen)) return false;
        }
      }
      if (Object.hasOwn(node, "required")) {
        if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== "string")) return false;
        const declared = Object.hasOwn(node, "properties") ? (node.properties as Record<string, unknown>) : {};
        for (const key of node.required) if (!Object.hasOwn(declared, key)) return false; // required 必须在 properties 中
      }
      if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") return false;
    } else if (type === "array") {
      if (Object.hasOwn(node, "items") && !checkSchemaNode(node.items as Record<string, unknown>, depth + 1, seen)) return false;
    } else {
      if (Object.hasOwn(node, "enum")) {
        if (!Array.isArray(node.enum)) return false;
        for (const value of node.enum) if (!scalarMatchesType(type, value)) return false;
      }
      if (Object.hasOwn(node, "const") && !scalarMatchesType(type, node.const)) return false;
    }
    return true;
  } finally {
    seen.delete(node);
  }
}

/**
 * 严格校验输出 schema 是否完全落在 dsh 支持子集内；支持则原样返回，
 * 否则返回 undefined（调用方回退为自由 JsonValue）。
 */
export function assertSupportedOutputSchema(schema: unknown): unknown {
  if (schema === undefined || schema === null) return undefined;
  return checkSchemaNode(schema as Record<string, unknown>, 0, new Set()) ? schema : undefined;
}

// ---------------------------------------------------------- 工具定义构建

/** 构建 dsh 工具定义（契约与官方 dsh-mcp-client 一致）。
 * @param opts 感知增强选项：{enhanceEmptyDescriptions, resultTruncateBytes}。
 */
export function buildToolDefinition(client: MCPClient, tool: Record<string, unknown>, server: ServerConfig, opts: { enhanceEmptyDescriptions?: boolean; resultTruncateBytes?: number } = {}): DshTool {
  const rawName = tool.name as string;
  const structuredSchema = assertSupportedOutputSchema(tool.outputSchema);
  const enhanceEmpty = opts.enhanceEmptyDescriptions !== false;
  // L2：空 description 工具拼接静态能力短语（来自服务器自定义描述，只读静态配置——
  // 绝不拼连接状态，保证 tools 数组稳定、provider 工具缓存可命中）。
  const rawDescription = (tool.description as string | undefined) ?? "";
  let description = rawDescription;
  if (enhanceEmpty && (rawDescription === "" || rawDescription.trim() === "") && typeof server.description === "string" && server.description !== "") {
    description = `[${server.description}]`;
  }
  const resultTruncateBytes = Number.isFinite(opts.resultTruncateBytes) ? (opts.resultTruncateBytes as number) : DEFAULT_RESULT_TRUNCATE_BYTES;
  const renderText = (text: unknown) => truncateText(text, resultTruncateBytes);
  return {
    name: publicToolName(server.name, rawName),
    description,
    // 业界标准（官方 dsh-mcp-client）：parameters 原样直传 MCP inputSchema，
    // 宽容接受——dsh 注册不校验 parameters，运行时校验忽略未知键。
    parameters: tool.inputSchema ?? {},
    output: {
      schema: {
        type: "object",
        properties: {
          content: { type: "array", items: {} },
          structuredContent: structuredSchema ?? {},
        },
        required: structuredSchema === undefined ? ["content"] : ["content", "structuredContent"],
        additionalProperties: false,
      },
      render(_args: unknown, value?: unknown) {
        const content = Array.isArray(value && (value as { content?: unknown }).content) ? (value as { content?: unknown[] }).content as unknown[] : [];
        return [{ type: "text", text: renderText(extractText(content, rawName)) as string }];
      },
    },
    async execute(args: unknown, exec: { signal?: AbortSignal; [key: string]: unknown }) {
      const timeoutMs = server.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
      const result = await client.callTool(rawName, typeof args === "object" && args !== null ? args : {}, {
        signal: exec.signal,
        timeoutMs,
      });
      const resultObj = result as { content?: unknown; isError?: unknown; structuredContent?: unknown; toolResult?: unknown } | undefined;
      if (!Array.isArray(resultObj?.content)) {
        const rendered = result && "toolResult" in (result as object) ? JSON.stringify(resultObj?.toolResult) : "(no output)";
        const text = typeof rendered === "string" ? rendered : "(no output)";
        if (resultObj?.isError === true) throw new Error(renderText(text) as string);
        return {
          content: [{ type: "text", text: renderText(text) }],
          ...(resultObj?.structuredContent !== undefined ? { structuredContent: resultObj.structuredContent } : {}),
        };
      }
      const text = extractText(resultObj!.content as unknown[], rawName);
      if (resultObj?.isError === true) throw new Error(renderText(text) as string);
      return {
        content: resultObj!.content,
        ...(resultObj?.structuredContent !== undefined ? { structuredContent: resultObj.structuredContent } : {}),
      };
    },
  };
}

// ------------------------------------------------------- 连接监督器

/**
 * 一个服务器的连接监督器：管理 client/transport 代际，连接成功后把工具
 * 同步进 ctx.tools，断开后按有界指数退避重连，预算耗尽则注销工具并停止。
 */
export class ConnectionSupervisor {
  manager: ManagerLite;
  server: ServerConfig;
  scope: string;
  client: MCPClient | undefined;
  transport: StdioTransport | HttpTransport | undefined;
  toolDisposers: Map<string, () => void>;
  reconnectTimer: NodeJS.Timeout | undefined;
  failedAttempts: number;
  connectedAt: number | undefined;
  disposed: boolean;
  status: string;
  error: unknown;
  tools: string[];
  toolMeta: Map<string, { description?: unknown }>;
  syncChain: Promise<unknown>;
  reconnectPolicy: ReconnectPolicy;

  constructor(manager: ManagerLite, server: ServerConfig, scope: string = SCOPE_GLOBAL) {
    this.manager = manager;
    this.server = server;
    this.scope = scope;
    this.client = undefined;
    this.transport = undefined;
    this.toolDisposers = new Map();
    this.reconnectTimer = undefined;
    this.failedAttempts = 0;
    this.connectedAt = undefined;
    this.disposed = false;
    this.status = "stopped";
    this.error = undefined;
    this.tools = [];
    this.toolMeta = new Map();
    this.syncChain = Promise.resolve();
    this.reconnectPolicy = resolveReconnect(server.reconnect);
  }

  setStatus(status: string, error?: unknown) {
    this.status = status;
    this.error = error;
    this.manager.emitStatus();
  }

  enqueueSync<T>(doSync: () => Promise<T> | T): Promise<T> {
    const run = this.syncChain.then(doSync);
    this.syncChain = run.catch(() => {});
    return run;
  }

  async connect(opts: { startup?: boolean } = {}): Promise<void> {
    const { startup = false } = opts;
    if (this.disposed) return;
    if (this.client !== undefined) return; // 已在连接/已连接
    if (!this.server.enabled) {
      this.setStatus("disabled");
      return;
    }
    this.setStatus(this.connectedAt === undefined ? "connecting" : "reconnecting");
    const server = this.server;
    const transport = createTransport(server);
    const client = new MCPClient(transport);
    this.transport = transport;
    this.client = client;

    const closeHandler = (error: Error) => {
      if (this.disposed) return;
      if (this.client !== client) return;
      this.teardownGeneration(error);
    };
    if ("onClose" in transport && transport.onClose !== undefined) transport.onClose(closeHandler);

    try {
      await transport.connect();
      await client.initialize();
      await this.enqueueSync(() => this.syncTools(client, startup));
      if (this.disposed || this.client !== client) return;
      this.failedAttempts = 0;
      this.connectedAt = Date.now();
      this.setStatus("connected");
      this.manager.logger.info(`dsh-mcp-manager(${server.name}): connected, ${this.tools.length} tool(s) registered`);
    } catch (error) {
      if (this.disposed || this.client !== client) return;
      this.manager.logger.warn(`dsh-mcp-manager(${server.name}): connection attempt failed: ${String(error)}`);
      this.teardownGeneration(error, true);
    }
  }

  /** 当前代际断开：清空引用并安排重连。 */
  teardownGeneration(error: unknown, schedule = true) {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    if (client !== undefined) {
      this.enqueueSync(async () => {
        if (this.disposed) return;
        for (const dispose of this.toolDisposers.values()) dispose();
        this.toolDisposers = new Map();
        this.tools = [];
        this.toolMeta = new Map();
      });
      const transport = client.transport;
      if (transport !== undefined && typeof transport.close === "function") {
        transport.close().catch(() => {});
      }
    }
    if (this.disposed) return;
    if (schedule) this.scheduleReconnect(error);
    else this.setStatus("failed", error);
  }

  scheduleReconnect(error: unknown) {
    const policy = this.reconnectPolicy;
    if (!policy.enabled) {
      this.setStatus("failed", error ?? new Error("reconnect disabled"));
      return;
    }
    if (this.connectedAt !== undefined && Date.now() - this.connectedAt >= policy.maxDelayMs) {
      this.failedAttempts = 0;
    }
    this.connectedAt = undefined;
    this.failedAttempts += 1;
    if (this.failedAttempts > policy.maxAttempts) {
      this.enqueueSync(async () => {
        for (const dispose of this.toolDisposers.values()) dispose();
        this.toolDisposers = new Map();
        this.tools = [];
        this.toolMeta = new Map();
      });
      this.setStatus("failed", new Error(`reconnect gave up after ${policy.maxAttempts} attempts: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (this.failedAttempts - 1));
    this.setStatus("reconnecting", error instanceof Error ? error : new Error(String(error)));
    this.manager.logger.warn(`dsh-mcp-manager(${this.server.name}): reconnect in ${delayMs}ms (attempt ${this.failedAttempts}/${policy.maxAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.client = undefined;
      void this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  /** 拉取工具列表并整体替换注册（代际安全：先取后换）。 */
  async syncTools(client: MCPClient, startup: boolean): Promise<void> {
    const definitions = new Map<string, DshTool>();
    const toolMeta = new Map<string, { description?: unknown }>();
    let cursor;
    do {
      const response = await client.listTools(cursor);
      const responseObj = response as { tools?: unknown[]; nextCursor?: unknown } | undefined;
      const tools = responseObj?.tools ?? [];
      for (const tool of tools) {
        const publicName = publicToolName(this.server.name, (tool as Record<string, unknown>).name as string);
        if (definitions.has(publicName)) {
          throw new Error(`server "${this.server.name}" listed tool "${(tool as Record<string, unknown>).name}" more than once — invalid tool list`);
        }
        definitions.set(publicName, buildToolDefinition(client, tool as Record<string, unknown>, this.server, this.manager.enhancement));
        // 工具描述元数据（保留供 GUI 展示；不再用于能力目录——目录是纯静态数据源，
        // 聚合连接后数据会让 digest 随连接状态抖动而反复注入）。
        toolMeta.set(publicName, { description: (tool as Record<string, unknown>).description ?? "" });
      }
      cursor = responseObj?.nextCursor as string | undefined;
    } while (cursor !== undefined && cursor !== null && cursor !== "");

    for (const dispose of this.toolDisposers.values()) dispose();
    const disposers = new Map<string, () => void>();
    try {
      for (const [publicName, definition] of definitions) {
        // 边界收窄：自建 DshTool（宽松契约面）→ 官方 ToolDefinition；
        // buildToolDefinition 构造的对象本就满足官方 register 运行时校验。
        disposers.set(publicName, this.manager.ctx.tools.register(definition as Parameters<typeof this.manager.ctx.tools.register>[0]));
      }
    } catch (error) {
      for (const dispose of disposers.values()) dispose();
      this.manager.logger.error(`dsh-mcp-manager(${this.server.name}): tool registration failed, no tools registered: ${String(error)}`);
      if (startup) throw error;
      return;
    }
    this.toolDisposers = disposers;
    this.tools = [...definitions.keys()].sort();
    this.toolMeta = toolMeta;
    // 连接成功：把工具描述摘要写入目录缓存（持久化；与实时连接状态解耦）。
    await this.manager.recordCatalogTools(this.server.name, toolMeta);
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    if (client !== undefined) {
      const transport = client.transport;
      if (transport !== undefined && typeof transport.close === "function") {
        try {
          await transport.close();
        } catch {
          // 关闭失败不影响注销
        }
      }
    }
    await this.syncChain;
    for (const dispose of this.toolDisposers.values()) dispose();
    this.toolDisposers = new Map();
    this.tools = [];
    this.toolMeta = new Map();
    this.setStatus("stopped");
  }
}

/** 解析重连策略（含默认值）。 */
export function resolveReconnect(config: Record<string, unknown> | undefined): ReconnectPolicy {
  return {
    enabled: (config?.enabled as boolean | undefined) ?? RECONNECT_DEFAULTS.enabled,
    initialDelayMs: (config?.initialDelayMs as number | undefined) ?? RECONNECT_DEFAULTS.initialDelayMs,
    maxDelayMs: (config?.maxDelayMs as number | undefined) ?? RECONNECT_DEFAULTS.maxDelayMs,
    maxAttempts: (config?.maxAttempts as number | undefined) ?? RECONNECT_DEFAULTS.maxAttempts,
  };
}
