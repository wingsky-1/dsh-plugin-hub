/**
 * dsh-provider-usage — 用量统计插件（宿主端入口，v2 重构版）。
 *
 * 路由（loopback 围栏）：
 * - GET /api/dsh-provider-usage/stats  用量统计 + 胶囊 HTML
 * - GET /api/dsh-provider-usage/history 历史数据 + 面板 HTML
 * - GET /api/dsh-provider-usage/health  健康检查
 * - GET /api/dsh-provider-usage/adapter.mjs 暴露适配器文件给浏览器
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson, readJsonBody } from "../../../shared/host-utils.js";
import { installSettingsNamespace } from "../../../shared/settings-namespace.js";
import { Mutex } from "async-mutex";
import z from "schemastery";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { UsageStatsAdapter } from "./contracts.js";
import { isUsageStatsAdapter, describeUsageStatsAdapterShape, ADAPTER_CONTRACT_VERSION } from "./contracts.js";
import { makeV2Registry } from "./registry.js";
import { openCodeGoAdapter, OPENCODE_GO_PROVIDER, OPENCODE_GO_ADAPTER_ID, DEFAULT_BASE_URL } from "./adapters/opencode-go.js";
import { runV2Pipeline, runV2PanelPipeline, type V2PipelineResult } from "./pipeline/v2.js";
import { HistoryStore } from "./core/history.js";
import { resolveProviderConfig } from "./provider-config.js";
import { HotReloadableAdapter } from "./hotreload.js";
import { fetchWithTimeout } from "./core/guards.js";
import { resolvePath, pluginHome } from "./path-resolve.js";

// ------------------------------------------------------------------ 对外 re-export
// 注意：bundle-host 会把 tsc 产物中的子模块全部内联进 lib/index.js 并清理游离 .js，
// smoke/lint 只能从 lib/index.js 导入，故契约与核心模块一律在此 re-export。
export * from "./contracts.js";
export * from "./registry.js";
export * from "./adapters/opencode-go.js";
export * from "./provider-config.js";
export { HistoryStore, parseJsonl, startOfDay } from "./core/history.js";
export type { HistoryEntry } from "./core/history.js";
export { safeFetchData, safeFormat, fetchWithTimeout } from "./core/guards.js";
export { sanitizeHtml } from "./sanitize.js";
export { runV2Pipeline, runV2PanelPipeline } from "./pipeline/v2.js";
export { HotReloadableAdapter, loadAndValidateAdapter, readStamp, stampEqual } from "./hotreload.js";

// ------------------------------------------------------------------ 类型

export const name = "provider-usage";
export const inject: string[] = ["webServer", "llm"];

export const ROUTES: Record<string, string> = {
  stats: "/api/dsh-provider-usage/stats",
  history: "/api/dsh-provider-usage/history",
  health: "/api/dsh-provider-usage/health",
  adapter: "/api/dsh-provider-usage/adapter.mjs",
};

export const DEFAULT_CONFIG = {
  adapter: "",
  staticPath: "",
  provider: OPENCODE_GO_PROVIDER,
  apiEndpoint: "",
  apiKey: "",
  historyDir: "",
  warmupIntervalMs: 300000,
  cacheDurationMs: 60000,
  fetchTimeoutMs: 2000,
  autoReload: false,
  maxDetailRows: 5000,
  maxAgeDays: 30,
  maxSizeMB: 20,
};

export interface NormalizedConfig {
  adapter: string;
  staticPath: string;
  provider: string;
  apiEndpoint: string;
  apiKey: string;
  historyDir: string;
  warmupIntervalMs: number;
  cacheDurationMs: number;
  fetchTimeoutMs: number;
  autoReload: boolean;
  maxDetailRows: number;
  maxAgeDays: number;
  maxSizeMB: number;
}

export const Config: z<{
  adapter: string;
  staticPath: string;
  provider: string;
  apiEndpoint: string;
  warmupIntervalMs: number;
  cacheDurationMs: number;
  fetchTimeoutMs: number;
  autoReload: boolean;
  maxDetailRows: number;
  maxAgeDays: number;
  maxSizeMB: number;
}> = z.object({
  adapter: z.string().default("").description("用户适配器 mjs 文件路径（可选，缺省使用内置 opencode-go）"),
  staticPath: z.string().default("").description("API 路径（如 /v1/usage，由用户定义）"),
  provider: z.string().default(OPENCODE_GO_PROVIDER).description("关联的模型 provider 名"),
  apiEndpoint: z.string().default("").description("API 基础地址（可选，不填使用内置默认或模型配置链）").disabled(true),
  warmupIntervalMs: z.number().default(DEFAULT_CONFIG.warmupIntervalMs).description("后台预热间隔毫秒").disabled(true),
  cacheDurationMs: z.number().default(DEFAULT_CONFIG.cacheDurationMs).description("缓存新鲜度毫秒").disabled(true),
  fetchTimeoutMs: z.number().default(DEFAULT_CONFIG.fetchTimeoutMs).description("取数超时毫秒").disabled(true),
  autoReload: z.boolean().default(false).description("热更新开关（编辑适配器文件后自动加载）"),
  maxDetailRows: z.number().default(DEFAULT_CONFIG.maxDetailRows).description("历史查询行数上限").disabled(true),
  maxAgeDays: z.number().default(DEFAULT_CONFIG.maxAgeDays).description("历史数据保留天数").disabled(true),
  maxSizeMB: z.number().default(DEFAULT_CONFIG.maxSizeMB).description("历史数据大小上限（MB）").disabled(true),
});

export function normalizeConfig(input: unknown): NormalizedConfig {
  const base = { ...DEFAULT_CONFIG };
  if (typeof input !== "object" || input === null) return base;
  const cfg = input as Record<string, unknown>;
  if (typeof cfg.adapter === "string") base.adapter = cfg.adapter;
  if (typeof cfg.staticPath === "string") base.staticPath = cfg.staticPath;
  if (typeof cfg.provider === "string") base.provider = cfg.provider;
  if (typeof cfg.apiEndpoint === "string") base.apiEndpoint = cfg.apiEndpoint;
  if (typeof cfg.apiKey === "string") base.apiKey = cfg.apiKey;
  if (typeof cfg.historyDir === "string") base.historyDir = cfg.historyDir;
  if (Number.isFinite(cfg.warmupIntervalMs)) base.warmupIntervalMs = Math.max(60000, cfg.warmupIntervalMs as number);
  if (Number.isFinite(cfg.cacheDurationMs)) base.cacheDurationMs = Math.max(5000, cfg.cacheDurationMs as number);
  if (Number.isFinite(cfg.fetchTimeoutMs)) base.fetchTimeoutMs = Math.min(Math.max(500, cfg.fetchTimeoutMs as number), 30000);
  if (typeof cfg.autoReload === "boolean") base.autoReload = cfg.autoReload;
  if (Number.isFinite(cfg.maxDetailRows)) base.maxDetailRows = Math.min(50000, cfg.maxDetailRows as number);
  if (Number.isFinite(cfg.maxAgeDays)) base.maxAgeDays = Math.min(365, cfg.maxAgeDays as number);
  if (Number.isFinite(cfg.maxSizeMB)) base.maxSizeMB = Math.min(500, cfg.maxSizeMB as number);
  return base;
}

// ------------------------------------------------------------------ 插件入口

export async function apply(ctx: Context, rawConfig: Record<string, unknown> = {}): Promise<void> {
  if (rawConfig.enabled === false) return; // 显式禁用：不注册任何路由
  const config = normalizeConfig(rawConfig);
  const registry = makeV2Registry();

  // 1. 注册内置 opencode-go 适配器
  registry.register(openCodeGoAdapter, "builtin");

  // 2. 加载用户适配器（如果配置了）
  let userAdapter: UsageStatsAdapter | null = null;
  let hotReloader: HotReloadableAdapter | null = null;
  if (config.adapter !== "") {
    const resolved = resolvePath(config.adapter);
    if (resolved === undefined) {
      registry.recordError(`file:${basename(config.adapter)}`, "load", "文件不存在或不可读");
    } else {
      try {
        const url = pathToFileURL(resolved).href;
        const mod = (await import(url)) as Record<string, unknown>;
        const candidate = (mod.default ?? mod) as unknown;
        if (!isUsageStatsAdapter(candidate)) {
          const detail = describeUsageStatsAdapterShape(candidate) ?? "未知形状";
          registry.recordError(`file:${basename(resolved)}`, "load", `契约校验失败（${detail}）`);
        } else {
          userAdapter = candidate;
          registry.register(userAdapter, "user-file", resolved);

          // 热更新
          if (config.autoReload) {
            hotReloader = new HotReloadableAdapter(resolved, 2000, (info) => {
              if (info.ok) {
                registry.recordError(`file:${basename(resolved)}`, "load", "热更新成功");
                // 有新适配器后重新注册
                if (hotReloader?.current) {
                  registry.register(hotReloader.current, "user-file", resolved);
                }
              } else {
                registry.recordError(`file:${basename(resolved)}`, "load", `热更新失败：${info.error}`);
              }
            });
            const startResult = await hotReloader.start();
            if (!startResult.ok) {
              registry.recordError(`file:${basename(resolved)}`, "load", `热更新启动失败：${startResult.error}`);
            }
          }
        }
      } catch (e: unknown) {
        registry.recordError(`file:${basename(resolved)}`, "load", e instanceof Error ? e.message : String(e));
      }
    }
  }

  // 3. 确定 provider 和适配器
  const provider = config.provider;
  const effectiveAdapter = userAdapter ?? registry.get(provider) ?? openCodeGoAdapter;

  // 4. 历史存储
  const historyRoot = config.historyDir || join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-provider-usage");
  const history = new HistoryStore({
    root: historyRoot,
    maxAgeMs: config.maxAgeDays * 86400000,
    maxSizeBytes: config.maxSizeMB * 1024 * 1024,
  });

  // 5. 缓存 + 互斥锁
  const cache = new Map<string, V2PipelineResult>();
  const mutex = new Mutex();

  // 6. 缓存过期检查
  function cacheFresh(provider: string): V2PipelineResult | undefined {
    const entry = cache.get(provider);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.fetchedAt > config.cacheDurationMs) {
      cache.delete(provider);
      return undefined;
    }
    return entry;
  }

  // 7. 数据获取核心
  async function getStats(provider: string): Promise<V2PipelineResult> {
    // 缓存命中
    const cached = cacheFresh(provider);
    if (cached !== undefined) return { ...cached, status: 'cached' };

    // 锁忙 → 不阻塞，返回上次缓存（如果有）
    if (mutex.isLocked()) {
      const last = cache.get(provider);
      if (last !== undefined) return { ...last, status: 'cached' };
      return {
        ok: false, configured: false, reason: 'busy', error: null,
        fetchedAt: Date.now(), provider, adapterName: effectiveAdapter.name,
        status: 'stale',
      };
    }

    return mutex.runExclusive(async () => {
      const providerConfig = await resolveProviderConfig(provider, {
        apiEndpoint: config.apiEndpoint || undefined,
        apiKey: config.apiKey || undefined,
      });

      const adapter = userAdapter ?? registry.get(provider) ?? openCodeGoAdapter;
      const result = await runV2Pipeline({
        adapter,
        provider,
        config: { apiEndpoint: providerConfig.apiEndpoint, apiKey: providerConfig.apiKey },
        staticPath: config.staticPath,
        timeoutMs: config.fetchTimeoutMs,
      });

      // 落盘历史（成功时，每 5 分钟一次，避免高频写入）
      if (result.ok && result.status === 'fresh' && result.rawData !== undefined) {
        const entry = { time: result.fetchedAt, data: result.rawData };
        await history.append(provider, effectiveAdapter.name, entry).catch(() => {});
      }

      cache.set(provider, result);
      return result;
    });
  }

  // 8. 路由注册
  const statsRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.stats,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const url = new URL(req.url ?? "/", "http://localhost");
      const prov = url.searchParams.get("provider") ?? provider;
      const result = await getStats(prov);
      const adapterVersion = hotReloader ? (await import("node:fs/promises").then((m) => m.stat(hotReloader["file"] as string).catch(() => ({ mtimeMs: 0 })))).mtimeMs : 0;
      writeJson(res, 200, {
        plugin: "dsh-provider-usage",
        version: ADAPTER_CONTRACT_VERSION,
        provider: result.provider,
        adapterName: result.adapterName,
        status: result.status,
        capsuleHtml: result.capsuleHtml,
        ok: result.ok,
        configured: result.configured,
        error: result.error,
        fetchedAt: result.fetchedAt,
        adapterVersion: Math.floor(adapterVersion),
      });
    },
  };

  const historyRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.history,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const url = new URL(req.url ?? "/", "http://localhost");
      const prov = url.searchParams.get("provider") ?? provider;
      // 使用 adapter mjs 中的 name 作为历史目录名
      const adapterName = effectiveAdapter.name;
      const days = Number(url.searchParams.get("days"));
      const end = Date.now();
      const start = Number.isFinite(days) && days > 0
        ? end - Math.min(Math.round(days), config.maxAgeDays) * 86400000
        : end - 86400000;
      const adapter = userAdapter ?? registry.get(prov) ?? openCodeGoAdapter;
      const result = await runV2PanelPipeline({
        adapter,
        provider: prov,
        history,
        range: { start, end },
        limit: config.maxDetailRows,
        timeoutMs: config.fetchTimeoutMs,
      });
      writeJson(res, 200, {
        ok: result.error === undefined,
        plugin: "dsh-provider-usage",
        version: ADAPTER_CONTRACT_VERSION,
        provider: prov,
        adapterName,
        panelHtml: result.panelHtml,
        error: result.error ?? null,
        truncated: result.truncated,
        range: { start, end },
      });
    },
  };

  const healthRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.health,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const snap = registry.snapshot();
      writeJson(res, 200, {
        ok: true,
        plugin: "dsh-provider-usage",
        version: ADAPTER_CONTRACT_VERSION,
        provider,
        adapterName: effectiveAdapter.name,
        cacheSize: cache.size,
        adapters: snap.infos.map((i) => ({ name: i.name, label: i.label, source: i.source, enabled: i.enabled })),
        errors: snap.errors,
        historyDir: historyRoot,
      });
    },
  };

  const adapterRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.adapter,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const file = config.adapter ? resolvePath(config.adapter) : undefined;
      if (file === undefined) return writeJson(res, 404, { error: "no adapter configured" });
      try {
        const content = await readFile(file, "utf8");
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(content);
      } catch {
        writeJson(res, 500, { error: "read error" });
      }
    },
  };

  const routeDisposers = [statsRoute, historyRoute, healthRoute, adapterRoute].map((r) =>
    ctx.webServer.register(r),
  );

  // 9. 后台预热定时器
  let warmupTimer: ReturnType<typeof setInterval> | null = null;
  if (config.warmupIntervalMs > 0) {
    const warmupFn = () => {
      void getStats(provider).catch(() => {});
    };
    warmupTimer = setInterval(warmupFn, config.warmupIntervalMs);
    (warmupTimer as { unref?: () => void }).unref?.();
    // 启动时立即预热一次
    warmupFn();
  }

  // 10. 设置面板命名空间（只读镜像）
  installSettingsNamespace(ctx, "dsh-provider-usage", Config, rawConfig, {
    setSource: () => {},
    onChange: () => {},
  });

  // 11. 卸载清理
  ctx.effect(
    () => () => {
      for (const d of routeDisposers) { try { d(); } catch { /* 忽略 */ } }
      if (warmupTimer !== null) clearInterval(warmupTimer);
      if (hotReloader !== null) hotReloader.stop();
      cache.clear();
      mutex.cancel(); // 取消所有等待的锁
    },
    "dsh-provider-usage",
  );
}