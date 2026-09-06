/**
 * dsh-provider-usage — 用量统计拉取、缓存管理与互斥锁服务。
 */
import { rename, writeFile } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import { Mutex } from "async-mutex";
import { errorMessage } from "../../../shared/host-utils.js";
import type { NormalizedConfig } from "./config.ts";
import type { HistoryStore } from "./core/history.ts";
import { runV2Pipeline, type PanelCacheEntry, type V2PipelineResult } from "./pipeline/v2.ts";
import { resolveProviderConfig } from "./provider-config.ts";
import type { AdapterRegistry } from "./registry.ts";
import {
  readAdapterStateResult,
  readUserAdapters,
  userAdaptersFile,
  writeAdapterState,
  type UserAdapterRecord,
} from "./user-adapters.ts";

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

  purgePanelCacheForProvider(provider: string): void {
    const prefix = `${provider}\u0000`;
    for (const key of this.panelCache.keys()) {
      if (key.startsWith(prefix)) this.panelCache.delete(key);
    }
  }

  purgeCachesForProviders(providers: Iterable<string>): void {
    for (const p of providers) {
      this.cache.delete(p);
      this.purgePanelCacheForProvider(p);
    }
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
        this.cache.set(provider, result);
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

      this.cache.set(provider, result);
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
