/**
 * dsh-provider-usage — 用量统计插件（宿主端入口，v2 重构版）。
 *
 * 路由（loopback 围栏）：
 * - GET /api/dsh-provider-usage/stats  用量统计 + 胶囊 HTML
 * - GET /api/dsh-provider-usage/history 历史数据 + 面板 HTML
 * - GET /api/dsh-provider-usage/adapters.json 适配器候选元数据（设置页主列表同源）
 * - POST /api/dsh-provider-usage/adapters/select 切换/清空启用适配器
 * - POST /api/dsh-provider-usage/adapters/inspect 预览适配器文件（回显导出信息，不注册）
 * - POST /api/dsh-provider-usage/adapters/add 登记用户适配器文件（设置页承载，免手改配置）
 * - GET /api/dsh-provider-usage/health  健康检查 + 适配器快照
 */
import { readFile, writeFile, rename, unlink, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson, readJsonBody } from "../../../shared/host-utils.js";
import { installSettingsNamespace } from "../../../shared/settings-namespace.js";
import { Mutex } from "async-mutex";
import z from "schemastery";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { UsageStatsAdapter } from "./contracts.js";
import { describeUsageStatsAdapterShape, ADAPTER_CONTRACT_VERSION } from "./contracts.js";
import { makeAdapterRegistry } from "./registry.js";
import { openCodeGoAdapter, OPENCODE_GO_PROVIDER, OPENCODE_GO_ADAPTER_ID } from "./adapters/opencode-go.js";
import { runV2Pipeline, runV2PanelPipeline, type V2PipelineResult } from "./pipeline/v2.js";
import { HistoryStore, migrateLegacyV3 } from "./core/history.js";
import { resolveProviderConfig } from "./provider-config.js";
import { HotReloadableAdapter, loadAndValidateAdapter } from "./hotreload.js";
import { resolvePath, pluginHome, expandHomePath } from "./path-resolve.js";

// ------------------------------------------------------------------ 对外 re-export
// 注意：bundle-host 会把 tsc 产物中的子模块全部内联进 lib/index.js 并清理游离 .js，
// smoke/lint 只能从 lib/index.js 导入，故契约与核心模块一律在此 re-export。
export * from "./contracts.js";
export * from "./registry.js";
export * from "./adapters/opencode-go.js";
export * from "./provider-config.js";
export { HistoryStore, parseJsonl, startOfDay, migrateLegacyV3, legacySampleToData } from "./core/history.js";
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
  adapters: "/api/dsh-provider-usage/adapters.json",
  select: "/api/dsh-provider-usage/adapters/select",
  inspect: "/api/dsh-provider-usage/adapters/inspect",
  add: "/api/dsh-provider-usage/adapters/add",
  health: "/api/dsh-provider-usage/health",
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
  maxAgeDays: number;
  maxSizeMB: number;
}> = z.object({
  adapter: z.string().default("").description("用户适配器 mjs 文件路径（兼容配置声明；推荐经设置页「用量统计」添加）"),
  staticPath: z.string().default("").description("API 路径（如 /v1/usage；config.adapter 模式用）"),
  provider: z.string().default(OPENCODE_GO_PROVIDER).description("关联的模型 provider 名"),
  apiEndpoint: z.string().default("").description("API 基础地址（可选，不填使用内置默认或模型配置链）").disabled(true),
  warmupIntervalMs: z.number().default(DEFAULT_CONFIG.warmupIntervalMs).description("后台预热间隔毫秒").disabled(true),
  cacheDurationMs: z.number().default(DEFAULT_CONFIG.cacheDurationMs).description("缓存新鲜度毫秒").disabled(true),
  fetchTimeoutMs: z.number().default(DEFAULT_CONFIG.fetchTimeoutMs).description("取数超时毫秒").disabled(true),
  autoReload: z.boolean().default(false).description("热更新开关（编辑适配器 mjs 后自动重新加载）"),
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
  if (Number.isFinite(cfg.maxAgeDays)) base.maxAgeDays = Math.min(365, cfg.maxAgeDays as number);
  if (Number.isFinite(cfg.maxSizeMB)) base.maxSizeMB = Math.min(500, cfg.maxSizeMB as number);
  return base;
}

// ------------------------------------------------------------------ 用户适配器持久化（设置页 add/select 承载，免手改配置）

/** 用户适配器登记条目（add 路由写入、启动时合并加载）。 */
export interface UserAdapterRecord {
  /** 适配器唯一名（= mjs 导出的 name）。 */
  id: string;
  /** 展示名。 */
  label: string;
  /** 认领的 provider 列表。 */
  providers: string[];
  /** 文件路径（绝对路径或可解析形态）。 */
  file: string;
}

/** 用户适配器清单文件路径（历史根目录下）。 */
export function userAdaptersFile(root: string): string {
  return join(root, "user-adapters.json");
}

/** 启用选择状态文件路径（历史根目录下）。 */
export function adapterStateFile(root: string): string {
  return join(root, "adapter-state.json");
}

/** 防御式解析用户适配器清单文本（坏文件返回 []）。 */
export function parseUserAdapters(raw: string | undefined): UserAdapterRecord[] {
  if (typeof raw !== "string" || raw === "") return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null) return [];
  const list = (data as Record<string, unknown>)["adapters"];
  if (!Array.isArray(list)) return [];
  const out: UserAdapterRecord[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    const label = typeof rec.label === "string" ? rec.label : "";
    const providers = Array.isArray(rec.providers)
      ? rec.providers.filter((p): p is string => typeof p === "string" && p.length > 0)
      : [];
    const file = typeof rec.file === "string" ? rec.file : "";
    if (id.length > 0 && providers.length > 0 && file.length > 0) {
      out.push({ id, label: label || id, providers, file });
    }
  }
  return out;
}

/** 读取用户适配器清单（坏文件/不存在返回 []）。 */
export async function readUserAdapters(root: string): Promise<UserAdapterRecord[]> {
  try {
    if (!existsSync(userAdaptersFile(root))) return [];
    return parseUserAdapters(await readFile(userAdaptersFile(root), "utf8"));
  } catch {
    return [];
  }
}

/** 读取持久化的启用映射（provider → name；null 表示显式清空）。 */
export async function readAdapterState(root: string): Promise<Record<string, string | null>> {
  try {
    if (!existsSync(adapterStateFile(root))) return {};
    const data = JSON.parse(await readFile(adapterStateFile(root), "utf8")) as Record<string, unknown>;
    const out: Record<string, string | null> = {};
    for (const [provider, id] of Object.entries(data)) {
      if (typeof provider !== "string" || provider.length === 0) continue;
      if (id === null) out[provider] = null;
      else if (typeof id === "string" && id.length > 0) out[provider] = id;
    }
    return out;
  } catch {
    return {};
  }
}

/** 校验 add 入参 file 字段：文件存在可读 + 路径规整禁穿越。 */
export function resolveAddAdapterFile(
  input: unknown,
  dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh"),
): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.includes("\0")) return undefined;
  const expandedForCheck = expandHomePath(trimmed);
  if (resolve(expandedForCheck) !== expandedForCheck) return undefined; // 拒绝 a/../b、./x 未规整形态
  const resolved = resolvePath(expandedForCheck);
  if (resolved === undefined) return undefined;
  if (!isAbsolute(trimmed)) {
    // 相对路径：解析结果必须位于 DSH_HOME 或插件 home 之内
    for (const base of [dshHome, pluginHome(dshHome)]) {
      const rel = relative(base, resolved);
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return resolved;
    }
    return undefined;
  }
  return resolved;
}

// ------------------------------------------------------------------ 插件入口

export async function apply(ctx: Context, rawConfig: Record<string, unknown> = {}): Promise<void> {
  if (rawConfig.enabled === false) return; // 显式禁用：不注册任何路由
  const config = normalizeConfig(rawConfig);
  const registry = makeAdapterRegistry({
    sanitizePath: (s) => s.split(process.env.DSH_HOME ?? join(homedir(), ".dsh")).join("~/.dsh").split(homedir()).join("~"),
  });

  // -------------------------------------------------------- 历史存储与持久化根
  const historyRoot = config.historyDir || join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-provider-usage");
  const history = new HistoryStore({
    root: historyRoot,
    maxAgeMs: config.maxAgeDays * 86400000,
    maxSizeBytes: config.maxSizeMB * 1024 * 1024,
  });

  // 旧 v3 多文件桶 → 按天分片 JSONL 迁移（幂等；只迁移一次，旧文件 .bak 保留）
  try {
    const migrated = await migrateLegacyV3(historyRoot, history);
    if (migrated > 0) console.warn(`[dsh-provider-usage] 已迁移 ${migrated} 条旧 v3 历史采样到按天分片 JSONL`);
  } catch {
    /* 迁移失败不阻断启动（下次启动重试） */
  }

  // 1. 注册内置 opencode-go 适配器
  registry.register(openCodeGoAdapter, "builtin");

  // 2. 加载用户适配器（两来源：config.adapter 兼容声明 + 设置页登记的清单）
  async function loadUserHostAdapterFile(file: string): Promise<unknown> {
    const url = pathToFileURL(file).href;
    const mod = (await import(url)) as Record<string, unknown>;
    return mod.default ?? mod;
  }

  /** 加载 + 契约校验 + 注册（inspect / add / 启动加载共用）。 */
  async function loadUserAdapterChecked(
    file: string,
  ): Promise<{ ok: true; adapter: UsageStatsAdapter } | { ok: false; code: string; detail: string }> {
    let mod: unknown;
    try {
      mod = await loadUserHostAdapterFile(file);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      registry.recordError(`file:${basename(file)}`, "load", msg);
      return { ok: false, code: "adapter-load-failed", detail: msg };
    }
    const candidate = (mod ?? null) as unknown;
    const detail = describeUsageStatsAdapterShape(candidate);
    if (detail !== null) {
      registry.recordError(`file:${basename(file)}`, "load", `契约校验失败（${detail}），已拒收`);
      return { ok: false, code: "invalid-adapter", detail: `契约校验失败（${detail}）` };
    }
    return { ok: true, adapter: candidate as UsageStatsAdapter };
  }

  // config.adapter 兼容声明（可选）
  if (config.adapter !== "") {
    const resolved = resolvePath(config.adapter);
    if (resolved === undefined) {
      registry.recordError(`file:${basename(config.adapter)}`, "load", "文件不存在或不可读");
    } else {
      const loaded = await loadUserAdapterChecked(resolved);
      if (loaded.ok) registry.register(loaded.adapter, "user-file", resolved);
    }
  }

  // 设置页登记的清单（user-adapters.json）
  const userRecords = await readUserAdapters(historyRoot);
  for (const rec of userRecords) {
    const file = resolvePath(rec.file);
    if (file === undefined) {
      registry.recordError(`file:${basename(rec.file)}`, "load", "文件不存在或不可读");
      continue;
    }
    const loaded = await loadUserAdapterChecked(file);
    if (loaded.ok) registry.register(loaded.adapter, "user-file", file);
  }

  // 3. 热更新（config.adapter 声明 + 设置页登记的文件；autoReload=true 时生效）
  const hotReloaders: HotReloadableAdapter[] = [];
  if (config.autoReload) {
    const watchedFiles = new Set<string>();
    if (config.adapter !== "") {
      const cfgFile = resolvePath(config.adapter);
      if (cfgFile !== undefined) watchedFiles.add(cfgFile);
    }
    for (const rec of userRecords) {
      const f = resolvePath(rec.file);
      if (f !== undefined) watchedFiles.add(f);
    }
    for (const file of watchedFiles) {
      const hr = new HotReloadableAdapter(file, 2000, (info) => {
        const key = `file:${basename(file)}`;
        if (!info.ok) {
          registry.recordError(key, "load", `热更新失败：${info.error ?? "未知错误"}`);
          return;
        }
        if (hr.current !== null) {
          // 原子替换：先移除旧文件注册，再注册新版本（改名场景不误报重复）
          registry.removeByFile(file);
          registry.register(hr.current, "user-file", file);
          cache.clear();
          registry.recordError(key, "load", `热更新成功：${hr.current.name}`);
        }
      });
      const started = await hr.start();
      if (!started.ok && started.error !== undefined) {
        registry.recordError(`file:${basename(file)}`, "load", `热更新启动失败：${started.error}`);
      }
      hotReloaders.push(hr);
    }
  }

  // 4. 恢复持久化的启用选择（adapter-state.json；null = 显式清空）
  const savedEnabled = await readAdapterState(historyRoot);
  for (const [provider, name] of Object.entries(savedEnabled)) {
    if (name === null) registry.select(provider, null);
    else registry.select(provider, name);
  }

  // 5. 缓存 + 互斥锁
  const cache = new Map<string, V2PipelineResult>();
  const mutex = new Mutex();

  function cacheFresh(provider: string): V2PipelineResult | undefined {
    const entry = cache.get(provider);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.fetchedAt > config.cacheDurationMs) {
      cache.delete(provider);
      return undefined;
    }
    return entry;
  }

  /** 当前 provider 的启用适配器静态路径（config.staticPath 兜底）。 */
  function staticPathOf(provider: string): string {
    return config.staticPath;
  }

  // 5. 数据获取核心
  async function getStats(provider: string): Promise<V2PipelineResult> {
    const cached = cacheFresh(provider);
    if (cached !== undefined) return { ...cached, status: 'cached' };

    if (mutex.isLocked()) {
      const last = cache.get(provider);
      if (last !== undefined) return { ...last, status: 'cached' };
      // busy ≠ 未配置：适配器已就绪，仅上一次取数仍在进行（不报红，客户端按 stale 处理）
      const entryName = registry.getEntry(provider)?.name ?? "unknown";
      return {
        ok: true, configured: true, reason: 'busy', error: null,
        fetchedAt: Date.now(), provider, adapterName: entryName,
        status: 'stale',
      };
    }

    return mutex.runExclusive(async () => {
      const entry = registry.getEntry(provider);
      if (entry === undefined) {
        const code = registry.hasCandidates(provider) ? "no-enabled-adapter" : "no-adapter";
        const result: V2PipelineResult = {
          ok: false, configured: false, reason: code, error: null,
          fetchedAt: Date.now(), provider, adapterName: provider, status: 'stale',
        };
        cache.set(provider, result);
        return result;
      }

      const providerConfig = await resolveProviderConfig(provider, {
        apiEndpoint: config.apiEndpoint || undefined,
        apiKey: config.apiKey || undefined,
      });

      const result = await runV2Pipeline({
        adapter: entry.adapter,
        provider,
        config: { apiEndpoint: providerConfig.apiEndpoint, apiKey: providerConfig.apiKey },
        staticPath: staticPathOf(provider),
        timeoutMs: config.fetchTimeoutMs,
      });

      // 落盘历史（成功时）
      if (result.ok && result.status === 'fresh' && result.rawData !== undefined) {
        const historyEntry = { time: result.fetchedAt, data: result.rawData };
        await history.append(provider, entry.name, historyEntry).catch(() => {});
      }

      cache.set(provider, result);
      return result;
    });
  }

  // 6. 启用选择落盘串行链 + 清单落盘串行链（连续写的完成顺序不依赖 IO 时序）
  let stateChain: Promise<void> = Promise.resolve();
  function scheduleWriteAdapterState(enabled: Record<string, string | null>): void {
    stateChain = stateChain.then(() => writeFile(adapterStateFile(historyRoot), JSON.stringify(enabled)).catch(() => {}));
  }
  async function persistUserAdapter(rec: UserAdapterRecord): Promise<void> {
    const write = async (): Promise<void> => {
      const list = await readUserAdapters(historyRoot);
      if (list.some((r) => r.id === rec.id)) return; // 幂等：已登记不再追加
      list.push(rec);
      const tmp = `${userAdaptersFile(historyRoot)}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, adapters: list }), { mode: 0o600 });
      await rename(tmp, userAdaptersFile(historyRoot));
    };
    try {
      await (stateChain = stateChain.then(write));
    } catch (e: unknown) {
      registry.recordError("user-adapters", "load", `清单落盘失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 7. 路由注册
  const statsRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.stats,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const url = new URL(req.url ?? "/", "http://localhost");
      const prov = url.searchParams.get("provider") ?? config.provider;
      const result = await getStats(prov);
      writeJson(res, 200, {
        plugin: "dsh-provider-usage",
        version: ADAPTER_CONTRACT_VERSION,
        provider: result.provider,
        adapterName: result.adapterName,
        status: result.status,
        capsuleHtml: result.capsuleHtml,
        ok: result.ok,
        configured: result.configured,
        reason: result.reason,
        error: result.error,
        fetchedAt: result.fetchedAt,
        adapterVersion: 0,
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
      const prov = url.searchParams.get("provider") ?? config.provider;
      const entry = registry.getEntry(prov);
      if (entry === undefined) return writeJson(res, 200, { ok: true, plugin: "dsh-provider-usage", version: ADAPTER_CONTRACT_VERSION, provider: prov, adapterName: null, panelHtml: "<p>暂无启用的适配器</p>", error: null, range: { start: 0, end: 0 } });
      const days = Number(url.searchParams.get("days"));
      const end = Date.now();
      const start = Number.isFinite(days) && days > 0
        ? end - Math.min(Math.round(days), config.maxAgeDays) * 86400000
        : end - 86400000;
      const result = await runV2PanelPipeline({
        adapter: entry.adapter,
        provider: prov,
        history,
        range: { start, end },
        timeoutMs: config.fetchTimeoutMs,
      });
      writeJson(res, 200, {
        ok: result.error === undefined,
        plugin: "dsh-provider-usage",
        version: ADAPTER_CONTRACT_VERSION,
        provider: prov,
        adapterName: entry.name,
        panelHtml: result.panelHtml,
        error: result.error ?? null,
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
        provider: config.provider,
        cacheSize: cache.size,
        adapters: snap.infos.map((i) => ({ name: i.name, label: i.label, providers: i.providers, source: i.source, enabled: i.enabled, file: i.file !== undefined ? basename(i.file) : undefined })),
        enabled: snap.enabled,
        errors: snap.errors,
        historyDir: historyRoot,
      });
    },
  };

  /** 适配器元数据路由（设置页主列表同源）。 */
  const adaptersRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.adapters,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const snap = registry.snapshot();
      // 模型配置页提供商路由（设置页主列表同源）
      let modelProviders: string[] = [];
      try {
        const llm = (ctx as { llm?: { listProviders?: () => unknown } }).llm;
        if (typeof llm?.listProviders === "function") {
          const listed = llm.listProviders();
          if (Array.isArray(listed)) {
            modelProviders = listed
              .map((i) => (i as { id?: unknown } | null)?.id)
              .filter((id): id is string => typeof id === "string" && id !== "");
          }
        }
      } catch { /* 回落空数组 */ }
      writeJson(res, 200, {
        version: ADAPTER_CONTRACT_VERSION,
        host: snap.infos.map((i) => ({
          name: i.name,
          label: i.label,
          providers: i.providers,
          source: i.source,
          file: i.file !== undefined ? basename(i.file) : null,
          enabled: i.enabled,
        })),
        enabled: snap.enabled,
        errors: snap.errors.map((e) => ({ key: e.key, at: e.at, kind: e.kind, message: e.message })),
        modelProviders,
      });
    },
  };

  /** 切换启用适配器（POST）。adapterName 显式 null = 清空该 provider 启用项。 */
  const selectRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.select,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "POST") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      let body: Record<string, unknown>;
      try {
        const raw = await readJsonBody(req);
        if (typeof raw !== "object" || raw === null) return writeJson(res, 400, { error: "bad-json" });
        body = raw as Record<string, unknown>;
      } catch {
        return writeJson(res, 400, { error: "bad-json" });
      }
      const provider = typeof body.provider === "string" ? body.provider : "";
      const clearing = body.adapterName === null;
      const adapterName = typeof body.adapterName === "string" ? body.adapterName : "";
      if (!clearing && (provider.length === 0 || adapterName.length === 0 || provider.length > 128 || adapterName.length > 128)) {
        return writeJson(res, 400, { error: "invalid provider/adapterName" });
      }
      const ok = registry.select(provider, clearing ? null : adapterName);
      if (!ok) return writeJson(res, 404, { error: "adapter not found" });
      cache.clear();
      scheduleWriteAdapterState(clearing ? { ...registry.snapshot().enabled, [provider]: null } : registry.snapshot().enabled);
      writeJson(res, 200, { ok: true, provider, adapterName: clearing ? null : adapterName });
    },
  };

  /** 预览适配器文件（POST）：加载 + 契约校验，回显导出信息（name/label/providers），不注册。 */
  const inspectRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.inspect,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "POST") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      let body: Record<string, unknown>;
      try {
        const raw = await readJsonBody(req);
        if (typeof raw !== "object" || raw === null) return writeJson(res, 400, { error: "bad-json" });
        body = raw as Record<string, unknown>;
      } catch {
        return writeJson(res, 400, { error: "bad-json" });
      }
      const file = resolveAddAdapterFile(body.file);
      if (file === undefined) {
        return writeJson(res, 400, { error: "invalid-file", detail: "文件不存在/不可读，或路径未规整（禁穿越）" });
      }
      const loaded = await loadUserAdapterChecked(file);
      if (!loaded.ok) {
        return writeJson(res, 422, { error: loaded.code, detail: loaded.detail });
      }
      const { adapter } = loaded;
      writeJson(res, 200, {
        ok: true,
        adapter: { name: adapter.name, label: adapter.label ?? adapter.name, providers: adapter.providers, version: adapter.version },
        file: basename(file),
      });
    },
  };

  /** 登记用户适配器（POST）：设置为页承载，免手改配置文件。 */
  const addRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.add,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "POST") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      let body: Record<string, unknown>;
      try {
        const raw = await readJsonBody(req);
        if (typeof raw !== "object" || raw === null) return writeJson(res, 400, { error: "bad-json" });
        body = raw as Record<string, unknown>;
      } catch {
        return writeJson(res, 400, { error: "bad-json" });
      }
      const file = resolveAddAdapterFile(body.file);
      if (file === undefined) {
        return writeJson(res, 400, { error: "invalid-file", detail: "文件不存在/不可读，或路径未规整（禁穿越）" });
      }
      const loaded = await loadUserAdapterChecked(file);
      if (!loaded.ok) {
        return writeJson(res, 422, { error: loaded.code, detail: loaded.detail });
      }
      const { adapter } = loaded;
      if (registry.hasName(adapter.name)) {
        return writeJson(res, 409, { error: "duplicate-name", detail: `适配器 name 已存在：${adapter.name}` });
      }
      if (!registry.register(adapter, "user-file", file)) {
        return writeJson(res, 422, { error: "invalid-adapter", detail: "契约校验失败（version/name/providers/fetchData/formatCapsule/formatPanel）" });
      }
      // 持久化清单 + 热注册默认成为该 provider 启用者
      const rec: UserAdapterRecord = {
        id: adapter.name,
        label: adapter.label ?? adapter.name,
        providers: adapter.providers,
        file,
      };
      await persistUserAdapter(rec);
      cache.clear();
      scheduleWriteAdapterState(registry.snapshot().enabled);
      writeJson(res, 200, {
        ok: true,
        adapter: { name: adapter.name, label: adapter.label ?? adapter.name, providers: adapter.providers, file: basename(file) },
        enabled: registry.snapshot().enabled,
      });
    },
  };

  const disposeRoutes = ctx.effect(
    () => {
      const routeDisposers = [statsRoute, historyRoute, healthRoute, adaptersRoute, selectRoute, inspectRoute, addRoute].map((route) =>
        ctx.webServer.register(route),
      );
      return () => {
        for (const dispose of routeDisposers) {
          try { dispose(); } catch { /* 忽略 */ }
        }
      };
    },
    "dsh-provider-usage: routes",
  );

  // 8. 后台预热定时器（保持历史连续；无客户端访问时兜底）
  let warmupTimer: ReturnType<typeof setInterval> | null = null;
  if (config.warmupIntervalMs > 0) {
    const warmupFn = () => {
      for (const provider of registry.enabledProviders()) {
        void getStats(provider).catch(() => {});
      }
    };
    warmupTimer = setInterval(warmupFn, config.warmupIntervalMs);
    (warmupTimer as { unref?: () => void }).unref?.();
    // 启动时立即预热一次（所有启用 provider）
    warmupFn();
  }

  // 9. 设置面板命名空间（只读镜像；apiKey 不进 schema 避免回显）
  installSettingsNamespace(ctx, "dsh-provider-usage", Config, rawConfig, {
    setSource: () => {},
    onChange: () => {},
  });

  // 10. 卸载清理
  ctx.effect(
    () => () => {
      disposeRoutes();
      if (warmupTimer !== null) clearInterval(warmupTimer);
      for (const hr of hotReloaders) hr.stop();
      cache.clear();
      mutex.cancel();
    },
    "dsh-provider-usage",
  );
}
