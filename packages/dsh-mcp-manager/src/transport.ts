/**
 * dsh-mcp-manager — MCP 传输层（独立模块）。
 *
 * stdio / streamable-http 两种传输（零运行时依赖，直接基于
 * node:child_process 与全局 fetch 实现），以及 env 展开辅助与
 * 按传输类型创建实例的 createTransport。
 * 由 lib/index.js 组合根 re-export。
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ServerConfig } from "./types.js";

// ------------------------------------------------- env 展开 / 子进程环境

/** 凭据形状的环境变量名（父进程环境不自动透传给 MCP 子进程）。 */
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** 展开字符串中的 ${ENV_NAME} 引用（未设置 → 空字符串），用于 header/env 值。 */
export function expandEnv(value: unknown): string {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => {
    const resolved = process.env[name];
    return resolved !== undefined ? resolved : "";
  });
}

/** 递归展开对象值中的 ${ENV_NAME} 引用。 */
function expandEnvObject(input: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    out[key] = expandEnv(value);
  }
  return out;
}

/** 构建 stdio 子进程环境：父环境去掉凭据形状与陈旧 DSH_* 名，再合并显式 env（支持 ${ENV} 引用）。 */
function buildChildEnv(extra: Record<string, unknown> | undefined): Record<string, string> {
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
 * streamable-http 传输（MCP 2025-03-26）：POST JSON-RPC，携带/回传
 * `Mcp-Session-Id`；响应可能是 JSON 或 SSE 流。零依赖实现。
 */
export class HttpTransport {
  url: string;
  headers: Record<string, string>;
  sessionId: string | undefined;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
    this.sessionId = undefined;
  }

  /** streamable-http 无连接态：每次请求即建连。supervisor 统一调用。 */
  async connect(): Promise<void> {}

  async request(msg: { id?: unknown; [key: string]: unknown }, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    const { signal, timeoutMs } = opts;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...expandEnvObject(this.headers),
    };
    if (this.sessionId !== undefined) headers["mcp-session-id"] = this.sessionId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? 30_000);
    const onAbort = () => controller.abort();
    if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(msg),
        signal: controller.signal,
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId !== null && sessionId !== "") this.sessionId = sessionId;
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        const text = await response.text();
        const parsed = parseSsePayload(text, msg.id);
        if (parsed !== undefined) return parsed;
        if (msg.id === undefined) return undefined;
        throw new Error("MCP SSE response carried no matching payload");
      }
      const text = await response.text();
      if (text.trim() === "") return undefined; // 通知可能 202 无 body
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }
}

/** 从 SSE 文本中提取 id 匹配的 JSON 载荷。 */
export function parseSsePayload(text: string, id: unknown): unknown {
  const events = text.split(/\r?\n\r?\n/);
  for (const event of events) {
    const data = [];
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    try {
      const payload = JSON.parse(data.join("\n"));
      if (id === undefined || payload.id === id) return payload;
    } catch {
      // 跳过无法解析的事件
    }
  }
  return undefined;
}

/** stdio 传输：spawn 子进程，换行分隔 JSON-RPC。 */
export class StdioTransport {
  command: string;
  args: string[];
  env: Record<string, unknown>;
  cwd: string | undefined;
  child: ChildProcessWithoutNullStreams | undefined;
  pending: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout; cleanup?: () => void }>;
  closed: Promise<Error> | undefined;
  stderrTail: string;
  closeHandlers: Array<(error: Error) => void>;

  constructor(config: { command: string; args?: string[]; env?: Record<string, unknown>; cwd?: string }) {
    this.command = config.command;
    this.args = config.args ?? [];
    this.env = config.env ?? {};
    this.cwd = config.cwd || undefined;
    this.child = undefined;
    this.pending = new Map();
    this.closed = undefined;
    this.stderrTail = "";
    this.closeHandlers = [];
  }

  onClose(handler: (error: Error) => void) {
    this.closeHandlers.push(handler);
  }

  async connect(): Promise<void> {
    const child = spawn(this.command, this.args, {
      env: buildChildEnv(this.env),
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    this.child = child;

    // 子进程立即退出/命令不存在时，stdin 写入会触发 EPIPE 'error' 事件——
    // 若不监听，Node 会把它当未处理错误让宿主进程崩溃。写入失败由 request()
    // 的 write 回调 reject 正常传播；这里只做吞掉事件处理。
    child.stdin.on("error", () => {});

    const closed = new Promise<Error>((resolveClose) => {
      child.on("exit", (code, signal) => resolveClose(new Error(`MCP stdio server exited (code=${code}, signal=${signal ?? "none"})`)));
      child.on("error", (error) => resolveClose(error));
    });
    this.closed = closed;
    closed.then((error) => {
      for (const handler of [...this.closeHandlers]) handler(error);
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (typeof message.id === "number" || typeof message.id === "string") {
        const entry = this.pending.get(String(message.id));
        if (entry !== undefined) {
          this.pending.delete(String(message.id));
          entry.resolve(message);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-4000);
    });

    // spawn 完成（或失败）后表示连接建立。
    await new Promise<Error | void>((resolveReady) => {
      child.once("spawn", () => resolveReady());
      child.once("error", (error) => resolveReady(error));
    });
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`MCP stdio server failed to start: ${this.stderrTail.trim() || "no output"}`);
    }
  }

  request(msg: { id?: unknown; [key: string]: unknown }, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    const { signal, timeoutMs } = opts;
    if (this.child === undefined || this.child.stdin === undefined) {
      return Promise.reject(new Error("MCP stdio transport is not connected"));
    }
    if (msg.id === undefined) {
      // 通知：只写不等待
      return new Promise<void>((resolveNotify) => {
        try {
          this.child!.stdin!.write(`${JSON.stringify(msg)}\n`, resolveNotify as (error?: Error | null) => void);
        } catch {
          resolveNotify();
        }
      });
    }
    return new Promise((resolve, reject) => {
      const entry: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout; cleanup?: () => void } = { resolve, reject };
      this.pending.set(String(msg.id), entry);
      const timer = setTimeout(() => {
        if (this.pending.delete(String(msg.id))) {
          reject(new Error(`MCP stdio request timed out after ${timeoutMs ?? 30_000}ms`));
        }
      }, timeoutMs ?? 30_000);
      if (signal !== undefined) {
        const onAbort = () => {
          clearTimeout(timer);
          if (this.pending.delete(String(msg.id))) {
            const error = new Error("MCP stdio request aborted");
            error.name = "AbortError";
            reject(error);
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      entry.timer = timer;
      try {
        this.child!.stdin!.write(`${JSON.stringify(msg)}\n`, (error) => {
          if (error !== null && error !== undefined && this.pending.delete(String(msg.id))) {
            clearTimeout(entry.timer!);
            reject(error);
          }
        });
      } catch (error) {
        clearTimeout(entry.timer);
        if (this.pending.delete(String(msg.id))) reject(error);
      }
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer!);
      entry.reject(new Error("MCP stdio transport closed"));
    }
    this.pending.clear();
    if (child !== undefined) {
      const exit = new Promise<void>((resolveExit) => {
        child.once("exit", () => resolveExit());
        child.once("error", () => resolveExit());
      });
      try {
        child.kill();
      } catch {
        // 已退出
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已退出
        }
      }, 2000);
      timer.unref();
      await Promise.race([exit, new Promise<void>((resolveExit) => setTimeout(resolveExit, 3000))]);
      clearTimeout(timer);
    }
  }
}

/** 按传输类型创建传输实例。 */
export function createTransport(server: ServerConfig): StdioTransport | HttpTransport {
  if (server.transport === "stdio") {
    return new StdioTransport({ command: server.command as string, args: server.args, env: server.env, cwd: server.cwd });
  }
  return new HttpTransport(server.url as string, server.headers ?? {});
}
