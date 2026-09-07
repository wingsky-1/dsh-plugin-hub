/**
 * dsh-mcp-manager — MCP 调用统计收集器（纯模块，单例管理）。
 *
 * 核心特性：
 * 1. 内存聚合：按 server/tool 维护聚合指标，同时维护渐进式披露漏斗（search/list/detail）；
 * 2. 防抖原子写盘（debounce 1000ms）：使用临时文件 + rename 保证落盘不损坏；
 * 3. 零侵入：未开启时直接短路，零 I/O、零内存分配；
 * 4. 退出刷新：支持 dispose/flush 同步或异步刷盘；
 * 5. Metadata-Only：不记录任何业务 arguments 或结果 content，防隐私泄露。
 */

import { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { dshHome } from "../../../shared/dsh-home.js";
import type {
  McpStatsSnapshot,
  ServerStats,
  ToolCallMetric,
  ProgressiveDisclosureStats,
} from "./call-stats-types.ts";

export function defaultStatsPath(): string {
  return resolve(dshHome(), "mcp-stats.json");
}

export class McpStatsCollector {
  private enabled: boolean = false;
  private filePath: string = defaultStatsPath();
  private logger?: { info?: (msg: string) => void; debug?: (msg: string) => void };
  private startedAt: string = new Date().toISOString();
  private updatedAt: string = new Date().toISOString();
  private servers: Map<string, {
    totalCalls: number;
    successCalls: number;
    failedCalls: number;
    tools: Map<string, ToolCallMetric>;
  }> = new Map();
  private disclosure: ProgressiveDisclosureStats = {
    searches: {},
    lists: {},
    details: {},
  };
  private flushTimer?: NodeJS.Timeout;
  private isDirty: boolean = false;

  constructor(options?: {
    enabled?: boolean;
    filePath?: string;
    logger?: { info?: (msg: string) => void; debug?: (msg: string) => void };
  }) {
    if (options?.enabled !== undefined) this.enabled = options.enabled;
    if (options?.filePath) this.filePath = resolve(options.filePath);
    this.logger = options?.logger;
    if (this.enabled) {
      this.loadExisting();
    }
  }

  /** 更新运行配置（热重载 / 设置同步）。 */
  configure(options: { enabled?: boolean; filePath?: string; logger?: { info?: (msg: string) => void } }): void {
    const prevEnabled = this.enabled;
    if (options.enabled !== undefined) this.enabled = options.enabled;
    if (options.filePath) this.filePath = resolve(options.filePath);
    if (options.logger) this.logger = options.logger;

    if (!prevEnabled && this.enabled) {
      this.loadExisting();
    } else if (prevEnabled && !this.enabled) {
      this.flushSync();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 从现有磁盘文件加载既有计数（避免进程重启后归零）。 */
  private loadExisting(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as Partial<McpStatsSnapshot>;
      if (data && typeof data === "object") {
        if (data.startedAt) this.startedAt = data.startedAt;
        if (data.servers && typeof data.servers === "object") {
          for (const [sName, sVal] of Object.entries(data.servers)) {
            const toolsMap = new Map<string, ToolCallMetric>();
            if (sVal.tools && typeof sVal.tools === "object") {
              for (const [tName, tVal] of Object.entries(sVal.tools)) {
                toolsMap.set(tName, { ...tVal });
              }
            }
            this.servers.set(sName, {
              totalCalls: sVal.totalCalls ?? 0,
              successCalls: sVal.successCalls ?? 0,
              failedCalls: sVal.failedCalls ?? 0,
              tools: toolsMap,
            });
          }
        }
        if (data.disclosure && typeof data.disclosure === "object") {
          this.disclosure.searches = { ...data.disclosure.searches };
          this.disclosure.lists = { ...data.disclosure.lists };
          this.disclosure.details = { ...data.disclosure.details };
        }
      }
    } catch {
      // 损坏文件忽略，重新开始统计
    }
  }

  /** 记录工具调用（ws_mcp_call 或直呼工具）。 */
  recordCall(server: string, tool: string, durationMs: number, success: boolean, errorMsg?: string): void {
    if (!this.enabled) return;

    this.updatedAt = new Date().toISOString();
    let s = this.servers.get(server);
    if (!s) {
      s = { totalCalls: 0, successCalls: 0, failedCalls: 0, tools: new Map() };
      this.servers.set(server, s);
    }
    s.totalCalls += 1;
    if (success) {
      s.successCalls += 1;
    } else {
      s.failedCalls += 1;
    }

    let t = s.tools.get(tool);
    if (!t) {
      t = {
        calls: 0,
        success: 0,
        errors: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        maxDurationMs: 0,
      };
      s.tools.set(tool, t);
    }
    t.calls += 1;
    if (success) {
      t.success += 1;
    } else {
      t.errors += 1;
      if (errorMsg) t.lastError = errorMsg.slice(0, 200); // 截断错误，防止溢出
    }
    t.totalDurationMs += durationMs;
    t.avgDurationMs = Math.round(t.totalDurationMs / t.calls);
    if (durationMs > t.maxDurationMs) t.maxDurationMs = durationMs;
    t.lastCalledAt = this.updatedAt;

    // debug 控制台单行输出
    const status = success ? "ok" : "fail";
    this.logger?.info?.(
      `[mcp:stats] ${server}/${tool} - ${durationMs}ms - ${status} (total: ${t.calls})`
    );

    this.scheduleFlush();
  }

  /** 记录渐进式披露漏斗：ws_mcp_search 搜索词。 */
  recordSearch(query: string): void {
    if (!this.enabled) return;
    const q = query.trim() === "" ? "<empty>" : query.trim().slice(0, 100);
    this.disclosure.searches[q] = (this.disclosure.searches[q] ?? 0) + 1;
    this.updatedAt = new Date().toISOString();
    this.scheduleFlush();
  }

  /** 记录渐进式披露漏斗：ws_mcp_list 查询过滤项。 */
  recordList(serverFilter?: string): void {
    if (!this.enabled) return;
    const f = (serverFilter ?? "").trim() === "" ? "<all>" : (serverFilter ?? "").trim().slice(0, 100);
    this.disclosure.lists[f] = (this.disclosure.lists[f] ?? 0) + 1;
    this.updatedAt = new Date().toISOString();
    this.scheduleFlush();
  }

  /** 记录渐进式披露漏斗：ws_mcp_detail 查询。 */
  recordDetail(server: string, tool: string): void {
    if (!this.enabled) return;
    const key = `${server}/${tool}`;
    this.disclosure.details[key] = (this.disclosure.details[key] ?? 0) + 1;
    this.updatedAt = new Date().toISOString();
    this.scheduleFlush();
  }

  /** 导出当前快照（只读数据对象）。 */
  snapshot(): McpStatsSnapshot {
    const serversObj: Record<string, ServerStats> = {};
    for (const [sName, sVal] of this.servers) {
      const toolsObj: Record<string, ToolCallMetric> = {};
      for (const [tName, tVal] of sVal.tools) {
        toolsObj[tName] = { ...tVal };
      }
      serversObj[sName] = {
        totalCalls: sVal.totalCalls,
        successCalls: sVal.successCalls,
        failedCalls: sVal.failedCalls,
        tools: toolsObj,
      };
    }
    return {
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      servers: serversObj,
      disclosure: {
        searches: { ...this.disclosure.searches },
        lists: { ...this.disclosure.lists },
        details: { ...this.disclosure.details },
      },
    };
  }

  private scheduleFlush(): void {
    this.isDirty = true;
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushSync();
    }, 1000);
    this.flushTimer.unref?.();
  }

  /** 同步原子落盘（临时文件 + 重命名）。 */
  flushSync(): void {
    if (!this.isDirty || !this.enabled) return;
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = JSON.stringify(this.snapshot(), null, 2);
      const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmpPath, data, "utf8");
      renameSync(tmpPath, this.filePath);
      this.isDirty = false;
    } catch (err) {
      this.logger?.info?.(`[mcp:stats] flush to ${this.filePath} failed: ${String(err)}`);
    }
  }

  /** 销毁清理。 */
  dispose(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flushSync();
  }
}
