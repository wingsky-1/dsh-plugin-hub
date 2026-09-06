/**
 * dsh-mem0 — Stdio MCP 运行时进程执行器（MemoryExecutor 实现）。
 *
 * 核心职责：
 * 1. spawn 本地 Python stdio 子进程（server/mem0_server.py）；
 * 2. 维持 MCP 协议初始化握手（initialize -> notifications/initialized）；
 * 3. 封装 tools/call 发送与请求/响应关联；
 * 4. 细粒度环境探测与自愈诊断（ENOENT, 依赖缺失检测）；
 * 5. 异常退避与生命周期清理（disposer kill 子进程，零孤儿进程）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryExecutor } from "./tool-definitions.ts";
import { probePythonEnvironment } from "./venv-manager.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** #612：指数退避自动重试间隔（毫秒），最多重试 3 次。 */
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

/** #612：stderr 环形日志缓冲行数（诊断抽屉尾随展示）。 */
const STDERR_TAIL_LINES = 200;

/**
 * #612：stderr 行脱敏——按值匹配环境覆盖中的敏感字段（真实 key 值），
 * 替换为掩码。LAN 代理会把 Host/Origin 重写为回环（围栏对 LAN 放行），
 * 日志下发前端前必须脱敏，防止 traceback 携带真实凭据。
 */
function redactSensitiveLines(lines: string[], envOverrides?: Record<string, string>): string[] {
  const secrets = new Set<string>();
  if (envOverrides) {
    for (const [key, value] of Object.entries(envOverrides)) {
      if (typeof value === "string" && value.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD/i.test(key)) {
        secrets.add(value);
      }
    }
  }
  if (secrets.size === 0) return lines;
  return lines.map((line) => {
    let out = line;
    for (const secret of secrets) {
      out = out.replaceAll(secret, "***redacted***");
    }
    return out;
  });
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: NodeJS.Timeout;
}

export type OfflineReason =
  | "ready"
  | "starting"
  | "python_not_found"
  | "dependency_missing"
  | "process_exited"
  | "env_build_failed"
  | "idle";

export interface ExecutorStatus {
  ready: boolean;
  reason: OfflineReason;
  detail?: string;
}

export class StdioMemoryExecutor implements MemoryExecutor {
  private proc?: ChildProcess;
  private reqId = 1;
  private pending = new Map<number, PendingRequest>();
  private ready = false;
  private reason: OfflineReason = "idle";
  private detail?: string;
  private scriptPath: string;
  private pythonBin: string;
  private lastEnvOverrides?: Record<string, string>;
  private retryPending = false;
  private retryAttempt = 0;
  private retryTimer?: NodeJS.Timeout;
  private stderrTailLines: string[] = [];

  constructor(options?: { scriptPath?: string; pythonBin?: string }) {
    this.scriptPath = options?.scriptPath ?? resolve(__dirname, "../server/mem0_server.py");
    this.pythonBin = options?.pythonBin ?? "python3";
  }

  public isReady(): boolean {
    return this.ready && this.proc !== undefined && !this.proc.killed;
  }

  public getStatus(): ExecutorStatus {
    return {
      ready: this.isReady(),
      reason: this.isReady() ? "ready" : this.reason,
      detail: this.detail,
    };
  }

  public setPythonBin(bin: string): void {
    const trimmed = bin.trim();
    if (trimmed && trimmed !== this.pythonBin) {
      this.pythonBin = trimmed;
    }
  }

  /**
   * #612：环境构建（buildEnvOverrides）失败时把失败状态落到 executor，
   * 取代此前"catch(warn) 后 reason 恒为初值 idle"的静默固化——
   * 前端 status 接口因此能看到明确失败原因并展示重试入口。
   */
  public markEnvBuildFailed(detail: string): void {
    if (this.isReady()) return;
    this.ready = false;
    this.reason = "env_build_failed";
    this.detail = detail;
  }

  /**
   * #612：服务 stderr 日志尾随（环形最近 200 行）。
   * 按值脱敏环境覆盖中的真实凭据后再返回（LAN 下发安全）。
   */
  public getStderrTail(): string[] {
    return redactSensitiveLines([...this.stderrTailLines], this.lastEnvOverrides);
  }

  public async start(envOverrides?: Record<string, string>): Promise<void> {
    if (this.isReady()) return;

    this.lastEnvOverrides = envOverrides;
    this.reason = "starting";
    this.detail = undefined;
    // 一次显式 start（无论手动或自动）都重置退避计数：这是新一轮启动尝试
    this.retryAttempt = 0;

    // 1. 预先探针检测环境可用性
    const probe = await probePythonEnvironment(this.pythonBin);
    if (!probe.ok) {
      this.ready = false;
      this.reason = probe.reason || "dependency_missing";
      this.detail = probe.detail;
      return;
    }
    this.pythonBin = probe.pythonBin;

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      ...envOverrides,
    };

    let child: ChildProcess;
    try {
      child = spawn(this.pythonBin, [this.scriptPath], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = child;
    } catch (err: any) {
      this.ready = false;
      this.reason = err?.code === "ENOENT" ? "python_not_found" : "process_exited";
      this.detail = err instanceof Error ? err.message : String(err);
      return;
    }

    child.on("error", (err: any) => {
      this.ready = false;
      if (err?.code === "ENOENT") {
        this.reason = "python_not_found";
        this.detail = `Command '${this.pythonBin}' not found. Please install Python 3.10+ or set custom pythonBin.`;
      } else {
        this.reason = "process_exited";
        this.detail = err?.message || String(err);
      }
    });

    if (!child.stdout || !child.stdin) {
      this.ready = false;
      this.reason = "process_exited";
      this.detail = "Process stdio streams are not available.";
      return;
    }

    // 监听 stderr 识别缺失模块等关键错误；#612：环形行缓冲供诊断抽屉尾随展示
    if (child.stderr) {
      let stderrLineBuf = "";
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderrLineBuf += text;
        const lines = stderrLineBuf.split("\n");
        stderrLineBuf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          this.stderrTailLines.push(line);
          if (this.stderrTailLines.length > STDERR_TAIL_LINES) {
            this.stderrTailLines.shift();
          }
        }
        if (text.includes("ModuleNotFoundError") || text.includes("No module named")) {
          this.reason = "dependency_missing";
          this.detail = "Required python package 'mem0ai' or 'fastmcp' is missing. Run: pip install mem0ai mcp";
        }
      });
    }

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      this.handleLine(line);
    });

    child.on("exit", (code) => {
      this.ready = false;
      this.proc = undefined;
      if (this.reason !== "python_not_found" && this.reason !== "dependency_missing") {
        this.reason = "process_exited";
        this.detail = `Python process exited with code ${code ?? "null"}.`;
      }
      for (const req of this.pending.values()) {
        clearTimeout(req.timer);
        req.reject(new Error("Python memory process exited"));
      }
      this.pending.clear();
    });

    // 握手初始化
    try {
      await this.sendRequest(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "dsh-mem0", version: "0.2.0" },
        },
        10_000,
      );

      this.sendNotification("notifications/initialized", {});
      this.ready = true;
      this.reason = "ready";
      this.detail = undefined;
    } catch (err) {
      this.ready = false;
      this.reason = "process_exited";
      this.detail = `Handshake failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  public stop(): void {
    this.ready = false;
    this.reason = "idle";
    // #612：停止时取消任何挂起的自动重试（stop 语义 = 显式终止）
    this.cancelAutoRetry();
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

  public async restart(envOverrides?: Record<string, string>): Promise<void> {
    this.stop();
    await this.start(envOverrides ?? this.lastEnvOverrides);
  }

  /**
   * #612：启动失败后的指数退避自动重试（5s/15s/60s，最多 3 次）。
   * - 与 stop/restart 互斥：任何显式 stop（含 restart 前置 stop）都会取消挂起重试；
   * - 与手动 /start 并发安全：start 入口 isReady 幂等 + retryPending 状态位防重入。
   */
  public scheduleAutoRetry(): void {
    if (this.isReady() || this.retryPending || this.retryAttempt >= RETRY_DELAYS_MS.length) return;
    const delay = RETRY_DELAYS_MS[this.retryAttempt];
    this.retryAttempt += 1;
    this.retryPending = true;
    this.retryTimer = setTimeout(() => {
      this.retryPending = false;
      this.retryTimer = undefined;
      if (this.isReady()) return;
      void this.start(this.lastEnvOverrides).catch(() => {
        // start 内部已把失败落到 reason/detail；继续按剩余次数递归调度
        this.scheduleAutoRetry();
      });
    }, delay);
  }

  private cancelAutoRetry(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.retryPending = false;
    this.retryAttempt = 0;
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
    return this.sendRequest(
      "tools/call",
      {
        name,
        arguments: args,
      },
      30_000,
    );
  }

  private extractContent(result: any): string {
    if (!result) return "";
    if (typeof result === "string") return result;
    if (Array.isArray(result.content)) {
      return result.content
        .map((c: any) =>
          typeof c === "object" && c !== null && typeof c.text === "string" ? c.text : "",
        )
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
      // 忽略非 JSON 调试输出
    }
  }
}
