/**
 * dsh-mem0 — Stdio MCP 运行时进程执行器（MemoryExecutor 实现）。
 *
 * 核心职责：
 * 1. spawn 本地 Python stdio 子进程（server/mem0_server.py）；
 * 2. 维持 MCP 协议初始化握手（initialize -> notifications/initialized）；
 * 3. 封装 tools/call 发送与请求/响应关联；
 * 4. 异常退避与生命周期清理（disposer kill 子进程，零孤儿进程）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryExecutor } from "./tool-definitions.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: NodeJS.Timeout;
}

export class StdioMemoryExecutor implements MemoryExecutor {
  private proc?: ChildProcess;
  private reqId = 1;
  private pending = new Map<number, PendingRequest>();
  private ready = false;
  private scriptPath: string;
  private pythonBin: string;

  constructor(options?: { scriptPath?: string; pythonBin?: string }) {
    // 默认定位包内的 server/mem0_server.py
    this.scriptPath = options?.scriptPath ?? resolve(__dirname, "../server/mem0_server.py");
    this.pythonBin = options?.pythonBin ?? "python3";
  }

  public isReady(): boolean {
    return this.ready && this.proc !== undefined && !this.proc.killed;
  }

  public async start(envOverrides?: Record<string, string>): Promise<void> {
    if (this.isReady()) return;

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      ...envOverrides,
    };

    try {
      this.proc = spawn(this.pythonBin, [this.scriptPath], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.ready = false;
      return;
    }

    if (!this.proc.stdout || !this.proc.stdin) {
      this.ready = false;
      return;
    }

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      this.handleLine(line);
    });

    this.proc.on("exit", () => {
      this.ready = false;
      this.proc = undefined;
      for (const req of this.pending.values()) {
        clearTimeout(req.timer);
        req.reject(new Error("Python memory process exited"));
      }
      this.pending.clear();
    });

    // 握手初始化
    try {
      await this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "dsh-mem0", version: "0.1.0" },
      }, 10_000);

      this.sendNotification("notifications/initialized", {});
      this.ready = true;
    } catch {
      this.ready = false;
    }
  }

  public stop(): void {
    this.ready = false;
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.proc = undefined;
    }
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(new Error("Executor stopped"));
    }
    this.pending.clear();
  }

  public async search(query: string, userId?: string, limit?: number): Promise<string> {
    const res = await this.callTool("memory_search", {
      query,
      user_id: userId,
      limit: limit ?? 5,
    });
    return this.extractContent(res);
  }

  public async add(text: string, userId: string): Promise<string> {
    const res = await this.callTool("memory_add", {
      text,
      user_id: userId,
    });
    return this.extractContent(res);
  }

  public async list(userId: string): Promise<string> {
    const res = await this.callTool("memory_list", {
      user_id: userId,
    });
    return this.extractContent(res);
  }

  public async delete(memoryId: string): Promise<string> {
    const res = await this.callTool("memory_delete", {
      memory_id: memoryId,
    });
    return this.extractContent(res);
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    return this.sendRequest("tools/call", {
      name,
      arguments: args,
    }, 30_000);
  }

  private extractContent(result: any): string {
    if (!result) return "";
    if (typeof result === "string") return result;
    if (Array.isArray(result.content)) {
      return result.content
        .map((c: any) => (typeof c === "object" && c !== null && typeof c.text === "string" ? c.text : ""))
        .filter(Boolean)
        .join("\n");
    }
    return JSON.stringify(result, null, 2);
  }

  private sendNotification(method: string, params?: any): void {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.proc.stdin.write(msg + "\n");
  }

  private sendRequest(method: string, params: any, timeoutMs = 15_000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin || this.proc.stdin.destroyed) {
        return reject(new Error("Process stdin not available"));
      }
      const id = ++this.reqId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.proc.stdin.write(msg + "\n");
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const req = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(req.timer);
        if (msg.error) {
          req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          req.resolve(msg.result);
        }
      }
    } catch {
      // 忽略无法解析为 JSON 的非协议调试行
    }
  }
}
