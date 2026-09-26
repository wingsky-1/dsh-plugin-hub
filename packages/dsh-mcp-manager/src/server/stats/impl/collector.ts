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

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, renameSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { directoryMode, fileMode, statsFile } from "../../shared/interface.ts";
import type {
  McpStatsSnapshot,
  ServerStats,
  ToolCallMetric,
  ProgressiveDisclosureStats,
} from "./type.ts";

/** 默认统计落盘路径（落点单源在 server/shared/paths.ts；此处只转发）。 */
export function defaultStatsPath(): string {
  return statsFile();
}

/**
 * 目录创建参数（S2-C 同步形态）：登记目录取表内 mode，未登记（单测 tmp /
 * 用户自定义 `statsFile` 的父目录）回落既有无 mode 形状——file-io `ensureDir`
 * 自身是异步，退出刷新链上不可调，此处是它的同步拼写（store.save 的 S2-B 同式）。
 *
 * 模块函数而非私有方法：类成员会进入 .d.ts 声明块（导出面快照按块比对），
 * 纯内部分拆放模块级才能让导出面零 diff。 */
function mkdirOptionsFor(dir: string): { recursive: true; mode?: number } {
  try {
    const mode = directoryMode(dir);
    return mode === null ? { recursive: true } : { recursive: true, mode };
  } catch {
    return { recursive: true };
  }
}

/**
 * 数据文件写参数（S2-C 同步形态）：`fileMode` 取表（S2-A 口径），未登记回落
 * 既有无 mode 形状。mode 落在临时文件上，`rename` 后即目标 mode（与 file-io 同式）。
 *
 * 模块函数而非私有方法：理由同上（导出面零 diff）。 */
function writeOptionsFor(file: string): { encoding: "utf8"; mode?: number } {
  try {
    const mode = fileMode(file);
    return mode === null ? { encoding: "utf8" } : { encoding: "utf8", mode };
  } catch {
    return { encoding: "utf8" };
  }
}

/** 还原服务器聚合快照：回答「各 server/tool 的计数是多少？」——逐服务器/工具重建
 * Map 形态；披露漏斗（searches/lists/details）的还原在 loadExisting 内（不同问题）。
 *
 * 模块函数而非私有方法：类成员会进入 .d.ts 声明块（导出面快照按块比对），
 * 纯内部分拆放模块级才能让导出面零 diff。 */
function restoreServerSnapshot(
  target: McpStatsCollector["servers"],
  servers: Partial<McpStatsSnapshot>["servers"],
): void {
  if (servers === undefined || servers === null || typeof servers !== "object") return;
  for (const [sName, sVal] of Object.entries(servers)) {
    target.set(sName, {
      totalCalls: sVal.totalCalls ?? 0,
      successCalls: sVal.successCalls ?? 0,
      failedCalls: sVal.failedCalls ?? 0,
      tools: restoreToolMetrics(sVal.tools),
    });
  }
}

/** 还原单个服务器的工具明细表：tools 缺失/异形 → 空表（与原三段守卫同口径——
 *  typeof undefined !== "object"，故 undefined 由第一段即挡下，判定顺序未改）。
 *
 * 模块函数而非私有方法：理由同上（导出面零 diff）。 */
function restoreToolMetrics(tools: unknown): Map<string, ToolCallMetric> {
  const toolsMap = new Map<string, ToolCallMetric>();
  if (typeof tools !== "object" || tools === null) return toolsMap;
  for (const [tName, tVal] of Object.entries(tools)) {
    toolsMap.set(tName, { ...(tVal as ToolCallMetric) });
  }
  return toolsMap;
}

/** 单个 server 的聚合桶（与 McpStatsCollector 私有字段同形；提到模块级供取桶函数复用，
 *  私有字段的 .d.ts 形状不变——声明块里仍只出 `private servers;`）。 */
interface ServerStatsBucket {
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  tools: Map<string, ToolCallMetric>;
}

/** 取（缺则就地建）server 聚合桶：逐调用懒建，未开启时零分配。 */
function serverBucketFor(
  servers: Map<string, ServerStatsBucket>,
  server: string,
): ServerStatsBucket {
  const found = servers.get(server);
  if (found !== undefined) return found;
  const created: ServerStatsBucket = {
    totalCalls: 0,
    successCalls: 0,
    failedCalls: 0,
    tools: new Map(),
  };
  servers.set(server, created);
  return created;
}

/** 取（缺则就地建）tool 指标记录：桶内逐工具懒建。 */
function toolMetricFor(bucket: ServerStatsBucket, tool: string): ToolCallMetric {
  const found = bucket.tools.get(tool);
  if (found !== undefined) return found;
  const created: ToolCallMetric = {
    calls: 0,
    success: 0,
    errors: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    maxDurationMs: 0,
  };
  bucket.tools.set(tool, created);
  return created;
}

export class McpStatsCollector {
  private enabled: boolean = false;
  private filePath: string = defaultStatsPath();
  private logger?: { info?: (msg: string) => void; debug?: (msg: string) => void };
  private startedAt: string = new Date().toISOString();
  private updatedAt: string = new Date().toISOString();
  private servers: Map<string, ServerStatsBucket> = new Map();
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
  configure(options: {
    enabled?: boolean;
    filePath?: string;
    logger?: { info?: (msg: string) => void };
  }): void {
    const prevEnabled = this.enabled;
    const nextEnabled = options.enabled ?? prevEnabled;
    if (options.filePath) this.filePath = resolve(options.filePath);
    if (options.logger) this.logger = options.logger;

    if (prevEnabled && !nextEnabled) {
      // B2：关闭前先刷盘——flushSync 以 enabled 为闸，先置 false 会把最后一批
      // 脏数据短路丢弃（flushSync 内部同样以 isDirty 兜底，无脏数据不写盘）。
      this.flushSync();
      this.enabled = false;
    } else {
      this.enabled = nextEnabled;
      if (nextEnabled && !prevEnabled) {
        this.loadExisting();
      }
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 从现有磁盘文件加载既有计数（避免进程重启后归零）。同步读保持：构造器 +
   * `configure` 是同步契约，file-io 只有异步读（`readJsonFile`），此处不可调；
   * 语义（缺失/损坏/目录 → 忽略重计）与 `readJsonFile` 的 null 回落同族。
   */
  private loadExisting(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as Partial<McpStatsSnapshot>;
      if (data && typeof data === "object") {
        if (data.startedAt) this.startedAt = data.startedAt;
        restoreServerSnapshot(this.servers, data.servers);
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
  recordCall(
    server: string,
    tool: string,
    durationMs: number,
    success: boolean,
    errorMsg?: string,
  ): void {
    if (!this.enabled) return;

    this.updatedAt = new Date().toISOString();
    const s = serverBucketFor(this.servers, server);
    s.totalCalls += 1;
    if (success) {
      s.successCalls += 1;
    } else {
      s.failedCalls += 1;
    }

    const t = toolMetricFor(s, tool);
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
      `[mcp:stats] ${server}/${tool} - ${durationMs}ms - ${status} (total: ${t.calls})`,
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
    const f =
      (serverFilter ?? "").trim() === "" ? "<all>" : (serverFilter ?? "").trim().slice(0, 100);
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

  /**
   * 同步原子落盘（临时文件 + 重命名）。S2-C 等价接入（同步安全形态）：mode 经
   * 登记表取（`writeOptionsFor`/`mkdirOptionsFor`，S2-A 口径），未登记回落既有形状。
   * **不**改调异步 `writeFileAtomic`：同步契约（构造器/`flushSync` 直写断言/B2 关闭刷盘/
   * `manager.dispose` 的 fire-and-forget 链）要求返回时盘上已有数据；异步化会把
   * 「退出刷新」变成不可靠的后台写。序列化形状（`snapshot()` + 2 空格）逐字节不变。
   */
  flushSync(): void {
    if (!this.isDirty || !this.enabled) return;
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, mkdirOptionsFor(dir));
      }
      const data = JSON.stringify(this.snapshot(), null, 2);
      // #903 crash 残留 tmp：kill 落在 write 后 rename 前必残留——失败分支 rm 清理；
      // 随机后缀防同毫秒两次刷盘共用一名（与 file-io temporaryNameFor 同式）。
      const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        writeFileSync(tmpPath, data, writeOptionsFor(this.filePath));
        renameSync(tmpPath, this.filePath);
      } catch (writeError) {
        try {
          rmSync(tmpPath, { force: true });
        } catch {
          // 清理失败忽略，主错误优先上抛给外层日志
        }
        throw writeError;
      }
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
