/**
 * dsh-provider-usage — 用量统计拉取、缓存管理与互斥锁服务。
 */
import { rename, writeFile } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import { Mutex } from "async-mutex";
import { errorMessage } from "../../../../../shared/host-utils.js";
import type { NormalizedConfig } from "../../shared/interface.ts";
import type { HistoryStore } from "../history/interface.ts";
import { runV2Pipeline, runV2PanelPipeline, panelCacheKey, isPanelCacheStale, type PanelCacheEntry, type V2PipelineResult } from "./v2.ts";
import { resolveProviderConfig } from "../registry/interface.ts";
import type { AdapterRegistry } from "../registry/interface.ts";
import type { UsageStatsAdapter } from "../../shared/interface.ts";
import {
  readAdapterStateResult,
  readUserAdapters,
  userAdaptersFile,
  writeAdapterState,
  type UserAdapterRecord,
} from "../registry/interface.ts";

export interface StatsServiceOptions {
  ctx: Context;
  config: NormalizedConfig;
  historyRoot: string;
  registry: AdapterRegistry;
  history: HistoryStore;
  sanitizeDiagnostic: (s: string) => string;
  recordAdapterStateDiagnostic: (message: string) => void;
}

export class StatsService {
  readonly ctx: Context;
  readonly config: NormalizedConfig;
  readonly historyRoot: string;
  readonly registry: AdapterRegistry;
  readonly history: HistoryStore;
  readonly sanitizeDiagnostic: (s: string) => string;
  readonly recordAdapterStateDiagnostic: (message: string) => void;

  readonly cache = new Map<string, V2PipelineResult>();
  readonly panelCache = new Map<string, PanelCacheEntry>();
  readonly providerLocks = new Map<string, Mutex>();

  // D7 阶段一（评审 M1）：缓存纪元——任何「清理缓存」入口递增 generation，
  // 在途 getStats 完成后校验纪元未变才 set，防「选择切换×在途取数」交错污染新缓存。
  private cacheGeneration = 0;
  /** 面板管道 in-flight 去重（同 key 并发 miss 共享一次执行，评审 M2）。 */
  private readonly panelInFlight = new Map<string, Promise<{ panelHtml?: string; error?: string }>>();

  private stateChain: Promise<void> = Promise.resolve();

  constructor(options: StatsServiceOptions) {
    this.ctx = options.ctx;
    this.config = options.config;
    this.historyRoot = options.historyRoot;
    this.registry = options.registry;
    this.history = options.history;
    this.sanitizeDiagnostic = options.sanitizeDiagnostic;
    this.recordAdapterStateDiagnostic = options.recordAdapterStateDiagnostic;
  }

  lockOf(provider: string): Mutex {
    let m = this.providerLocks.get(provider);
    if (m === undefined) {
      m = new Mutex();
      this.providerLocks.set(provider, m);
    }
    return m;
  }

  cacheFresh(provider: string): V2PipelineResult | undefined {
    const entry = this.cache.get(provider);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.fetchedAt > this.config.cacheDurationMs) {
      this.cache.delete(provider);
      return undefined;
    }
    return entry;
  }

  /** 只读观测口（health 响应字段名 cacheSize 保持，语义与直读 Map.size 等价）。 */
  cacheSize(): number {
    return this.cache.size;
  }

  /** 全量清理（select/add/热更等选择变更挂点）：纪元失效防在途结果写回。 */
  purgeAllCaches(): void {
    this.cacheGeneration += 1;
    this.cache.clear();
    this.panelCache.clear();
  }

  purgePanelCacheForProvider(provider: string): void {
    const prefix = `${provider}\u0000`;
    for (const key of this.panelCache.keys()) {
      if (key.startsWith(prefix)) this.panelCache.delete(key);
    }
  }

  purgeCachesForProviders(providers: Iterable<string>): void {
    this.cacheGeneration += 1;
    for (const p of providers) {
      this.cache.delete(p);
      this.purgePanelCacheForProvider(p);
    }
  }

  /**
   * D7 面板结果（深模块）：key 归一 → 命中判定 → miss 删除 → 管道执行 → 失败不写。
   * 同 key 并发 miss 共享 in-flight（不双跑 formatPanel）；错误/无结果不入缓存。
   */
  async getPanelResult(
    provider: string,
    entry: { name: string; adapter: UsageStatsAdapter },
    range: { start: number; end: number },
  ): Promise<{ panelHtml?: string; error?: string }> {
    const cacheKey = panelCacheKey(provider, entry.name, range);
    const hit = this.panelCache.get(cacheKey);
    if (hit !== undefined && !isPanelCacheStale(hit, Date.now())) {
      return { panelHtml: hit.panelHtml, error: hit.error };
    }

    const inflight = this.panelInFlight.get(cacheKey);
    if (inflight !== undefined) return inflight;

    const run = (async (): Promise<{ panelHtml?: string; error?: string }> => {
      this.panelCache.delete(cacheKey);
      const result = await runV2PanelPipeline({
        adapter: entry.adapter,
        provider,
        history: this.history,
        range,
        timeoutMs: this.config.fetchTimeoutMs,
      });
      if (result.error === undefined) {
        this.panelCache.set(cacheKey, { panelHtml: result.panelHtml, error: result.error, at: Date.now() });
      }
      return result;
    })().finally(() => {
      this.panelInFlight.delete(cacheKey);
    });
    this.panelInFlight.set(cacheKey, run);
    return run;
  }

  warmupProviders(providers: Iterable<string>): void {
    for (const p of providers) {
      if (this.registry.getEntry(p) !== undefined) {
        void this.getStats(p).catch(() => {});
      }
    }
  }

  scheduleWriteAdapterState(override?: Record<string, string | null>): void {
    this.stateChain = this.stateChain
      .catch(() => {})
      .then(async () => {
        const saved = await readAdapterStateResult(this.historyRoot, {
          diagnostic: this.recordAdapterStateDiagnostic,
        });
        if (saved.status === "unreadable") {
          throw new Error(`读取旧 adapter-state.json 失败（${saved.detail ?? "未知错误"}），为避免覆盖旧状态已取消写入`);
        }
        const merged: Record<string, string | null> = { ...saved.state };
        for (const [provider, name] of Object.entries(this.registry.snapshot().enabled)) merged[provider] = name;
        if (override !== undefined) Object.assign(merged, override);
        await writeAdapterState(
          this.historyRoot,
          merged,
          (message) => this.recordAdapterStateDiagnostic(this.sanitizeDiagnostic(message)),
        );
      })
      .catch((error: unknown) => {
        const detail = this.sanitizeDiagnostic(errorMessage(error));
        console.error(`[dsh-provider-usage] 启用选择落盘失败：${detail}`);
        this.registry.recordError("adapter-state", "load", `启用选择落盘失败：${detail}`);
      });
  }

  async persistUserAdapter(rec: UserAdapterRecord): Promise<void> {
    const write = async (): Promise<void> => {
      const list = await readUserAdapters(this.historyRoot);
      if (list.some((r) => r.id === rec.id)) return;
      list.push(rec);
      const tmp = `${userAdaptersFile(this.historyRoot)}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, adapters: list }), { mode: 0o600 });
      await rename(tmp, userAdaptersFile(this.historyRoot));
    };
    try {
      await (this.stateChain = this.stateChain.then(write));
    } catch (e: unknown) {
      this.registry.recordError("user-adapters", "load", `清单落盘失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async getStats(provider: string, signal?: AbortSignal): Promise<V2PipelineResult> {
    const cached = this.cacheFresh(provider);
    if (cached !== undefined) return { ...cached, status: "cached" };

    return this.lockOf(provider).runExclusive(async () => {
      const cachedInLock = this.cacheFresh(provider);
      if (cachedInLock !== undefined) return { ...cachedInLock, status: "cached" };

      // 纪元快照：在途期间若发生清理（select/热更/全清），完成后不再写回旧结果
      const gen = this.cacheGeneration;
      const entry = this.registry.getEntry(provider);
      if (entry === undefined) {
        const code = this.registry.hasCandidates(provider) ? "no-enabled-adapter" : "no-adapter";
        const result: V2PipelineResult = {
          ok: false,
          configured: false,
          reason: code,
          error: null,
          fetchedAt: Date.now(),
          provider,
          adapterName: provider,
          status: "stale",
        };
        if (this.cacheGeneration === gen) this.cache.set(provider, result);
        return result;
      }

      const providerConfig = await resolveProviderConfig(provider, this.ctx, {
        apiEndpoint: this.config.apiEndpoint || undefined,
        apiKey: this.config.apiKey || undefined,
      });

      const result = await runV2Pipeline({
        adapter: entry.adapter,
        provider,
        config: { apiEndpoint: providerConfig.apiEndpoint, apiKey: providerConfig.apiKey },
        staticPath: this.config.staticPath,
        timeoutMs: this.config.fetchTimeoutMs,
        signal,
        history: this.history,
      });

      if (result.ok && result.status === "fresh" && result.rawData !== undefined) {
        const historyEntry = { time: result.fetchedAt, data: result.rawData };
        await this.history.append(provider, entry.name, historyEntry).catch(() => {});
        this.purgePanelCacheForProvider(provider);
      }

      if (this.cacheGeneration === gen) this.cache.set(provider, result);
      return result;
    });
  }

  dispose(): void {
    for (const lock of this.providerLocks.values()) lock.cancel();
    this.providerLocks.clear();
    this.cache.clear();
    this.panelCache.clear();
  }
}
