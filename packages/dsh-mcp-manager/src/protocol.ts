/**
 * dsh-mcp-manager — MCP 协议客户端（独立模块）。
 *
 * 极简 JSON-RPC 客户端，运行在任意实现了 `request(msg, opts)` /
 * `connect()` 的传输之上（鸭子类型，不 import 传输模块）。
 * 由 lib/index.js 组合根 re-export。
 */

// ----------------------------------------------------------- MCP 协议

/** 传输最小面（鸭子类型；任意实现 request/connect 的传输均可）。 */
export interface McpTransport {
  request(message: unknown, opts?: unknown): Promise<unknown>;
  connect?(): Promise<void>;
  close?(): Promise<void>;
}

/** 极简 MCP 客户端：initialize / notifications/initialized / tools/list / tools/call。 */
export class MCPClient {
  transport: McpTransport;
  nextId = 1;
  initialized = false;

  constructor(transport: McpTransport) {
    this.transport = transport;
  }

  async request(method: string, params?: unknown, opts: unknown = {}): Promise<unknown> {
    const id = this.nextId++;
    const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined && params !== null) message.params = params;
    const payload = await this.transport.request(message, opts);
    if (payload === undefined) return undefined;
    const payloadObj = payload as { error?: { message?: unknown }; result?: unknown };
    if (payloadObj.error !== undefined) {
      const error = payloadObj.error;
      throw new Error(`MCP ${method}: ${error.message ?? JSON.stringify(error)}`);
    }
    return payloadObj.result;
  }

  async notify(method: string, params?: unknown): Promise<unknown> {
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined && params !== null) message.params = params;
    return this.transport.request(message);
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "dsh-mcp-manager", version: "0.1.0" },
    });
    this.initialized = true;
    await this.notify("notifications/initialized");
    return result;
  }

  async listTools(cursor?: string) {
    return this.request("tools/list", cursor === undefined ? {} : { cursor });
  }

  async callTool(rawName: string, args?: unknown, opts?: unknown) {
    return this.request("tools/call", { name: rawName, arguments: args }, opts);
  }
}
