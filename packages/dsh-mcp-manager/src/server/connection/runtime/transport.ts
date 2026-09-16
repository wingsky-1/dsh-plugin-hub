/**
 * dsh-mcp-manager — MCP 传输层（独立模块）。
 *
 * stdio / streamable-http 两种传输：子进程生命周期、换行 JSON-RPC 帧解析、
 * SSE 响应解析、Mcp-Session-Id 会话保持等能力面由官方
 * @modelcontextprotocol/sdk 的 StdioClientTransport / StreamableHTTPClientTransport
 * 承担（issue #11，决策 #47 approved；devDependency，构建期经 bundle-host
 * 内联进产物）。本模块保留：
 *  - 子进程环境的安全过滤（凭据形状环境变量不透传）；
 *  - supervisor 依赖的适配面：connect / close / onClose / `sdk` 实例暴露。
 * 由 lib/index.js 组合根 re-export。
 *
 * ${ENV} 模板展开与凭据词根的物理定义在 config 域（#767 S1-1 迁出）；本模块经 deps 端口
 * 取用（I2①：跨域不得有值边）。
 */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ServerConfig } from "../../config/interface.ts";
import { runtimePorts } from "./impl/service/index.ts";

// ------------------------------------------------- env 展开 / 子进程环境

/** 构建 stdio 子进程环境：父环境去掉凭据形状与陈旧 DSH_* 名，再合并显式 env（支持 ${ENV} 引用）。
 * 显式传入完整环境后 SDK 不再套用其默认白名单（getDefaultEnvironment），安全语义与自写版一致。
 * 凭据词根与展开器取自 config 域端口——本域不再持有第二份定义。 */
function buildChildEnv(extra: Record<string, unknown> | undefined): Record<string, string> {
  const { SECRET_ENV_NAME, expandEnvObject } = runtimePorts.get().configEnv;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SECRET_ENV_NAME.test(key)) continue;
    if (key.startsWith("DSH_")) continue;
    env[key] = value;
  }
  return { ...env, ...expandEnvObject(extra) };
}

// ------------------------------------------------------------- MCP 传输

/**
 * streamable-http 传输：薄适配官方 StreamableHTTPClientTransport——
 * POST JSON-RPC、SSE 流式响应、`Mcp-Session-Id` 会话保持、断线重连均由 SDK 承担；
 * headers 支持 ${ENV} 展开（凭据不落盘明文）。
 */
export class HttpTransport {
  url: string;
  headers: Record<string, string>;
  /** 官方 SDK 传输实例（MCPClient.initialize 经 SDK Client.connect 挂入）。 */
  readonly sdk: StreamableHTTPClientTransport;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
    this.sdk = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: runtimePorts.get().configEnv.expandEnvObject(headers) },
    });
  }

  /** streamable-http 无连接态（SDK start 仅初始化内部状态）：真正的建连由
   * MCPClient.initialize() 经 SDK Client.connect 驱动。supervisor 统一调用。 */
  async connect(): Promise<void> {}

  onClose(handler: (error: Error) => void) {
    // SDK transport 的 onclose 为回调属性且 Client.connect 会链式保留既有值，
    // 这里同样叠加而非覆盖。
    const previous = this.sdk.onclose;
    this.sdk.onclose = () => {
      previous?.();
      handler(new Error("MCP streamable-http transport closed"));
    };
  }

  async close(): Promise<void> {
    await this.sdk.close();
  }
}

/**
 * stdio 传输：薄适配官方 StdioClientTransport——spawn、stdin 写入背压、
 * stdout 换行 JSON 帧解析、退出清理（TERM→KILL 兜底）均由 SDK 承担。
 * 本类保留自写版的两项宿主语义：
 *  - 子进程环境安全过滤（buildChildEnv：剔除凭据形状 / DSH_* 名 + ${ENV} 展开）；
 *  - stderr 尾部留存（stderrTail）用于启动失败诊断。
 */
export class StdioTransport {
  command: string;
  args: string[];
  env: Record<string, unknown>;
  cwd: string | undefined;
  /** 官方 SDK 传输实例（MCPClient.initialize 经 SDK Client.connect 挂入）。 */
  readonly sdk: StdioClientTransport;
  /** 子进程 stderr 尾部（最多 4000 字节），连接失败时附入错误消息辅助诊断。 */
  stderrTail = "";
  /** 断开原因（onerror 记录最近错误；未出错即退出时为通用退出消息）。 */
  closeReason: Error;

  constructor(config: {
    command: string;
    args?: string[];
    env?: Record<string, unknown>;
    cwd?: string;
  }) {
    this.command = config.command;
    this.args = config.args ?? [];
    this.env = config.env ?? {};
    this.cwd = config.cwd || undefined;
    this.sdk = new StdioClientTransport({
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      env: buildChildEnv(this.env),
      stderr: "pipe",
    });
    this.closeReason = new Error(`MCP stdio server exited (command=${this.command})`);
    // stderr 立即可监听（SDK 在 start 前即创建 PassThrough，早启输出不丢）。
    this.sdk.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
    });
    // onerror 记录最近错误，作为 onclose 断开原因传递给 supervisor。
    this.sdk.onerror = (error) => {
      this.closeReason = error;
    };
  }

  /** 连接由 MCPClient.initialize() 经 SDK Client.connect 统一驱动
   * （spawn + initialize 版本协商 + notifications/initialized）；此处保持
   * supervisor 调用面不变、无独立动作（避免双重 start）。 */
  async connect(): Promise<void> {}

  onClose(handler: (error: Error) => void) {
    // 与 HttpTransport 同策略：叠加而非覆盖（Client.connect 也会再链一层）。
    const previous = this.sdk.onclose as (() => unknown) | undefined;
    this.sdk.onclose = () => {
      previous?.();
      handler(this.closeReason);
    };
  }

  async close(): Promise<void> {
    await this.sdk.close();
  }
}

/** 按传输类型创建传输实例。 */
export function createTransport(server: ServerConfig): StdioTransport | HttpTransport {
  if (server.transport === "stdio") {
    return new StdioTransport({
      command: server.command as string,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
    });
  }
  return new HttpTransport(server.url as string, server.headers ?? {});
}
