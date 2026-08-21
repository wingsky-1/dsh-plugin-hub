/**
 * dsh-opencode-usage — 按 Provider 适配的用量悬浮框（宿主端）。
 *
 * 演进：从「OpenCode Go 单 provider」变成「按 provider 名注册适配器」通用框架。
 * 内置适配器：opencode-go（OpenCode Go 官方用量接口），行为不退化。
 * 用户可注入自定义宿主 .mjs / 客户端 .js 适配任意中转站（M2）。
 *
 * 路由（loopback 围栏）：
 * - GET /api/dsh-opencode-usage/stats[?provider=<name>]  用量统计
 * - GET /api/dsh-opencode-usage/history[?days=N]          历史采样序列
 * - GET /api/dsh-opencode-usage/adapters.json              适配器元数据（M2）
 * - GET /api/dsh-opencode-usage/health                     健康检查
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson } from "../../../shared/host-utils.js";
import type { PluginContext, DshRoute } from "../../../types/dsh.js";
import { ADAPTER_CONTRACT_VERSION } from "./contracts.js";
import { makeHostAdapterRegistry } from "./registry.js";
import type { HostAdapterRegistry } from "./registry.js";
import {
  openCodeGoHostAdapter,
  OPENCODE_GO_PROVIDER,
  DEFAULT_BASE_URL,
  OPENCODE_GO_WINDOWS,
} from "./adapters/opencode-go.js";
import type { ProviderUsage, UsageWindow, FetchLike, HostProviderAdapter, SamplePointData } from "./contracts.js";
import { resolvePath } from "./path-resolve.js";

// ------------------------------------------------------------------ 对外 re-export
// 注意：bundle-host 会把 tsc 产物中的子模块全部内联进 lib/index.js 并清理游离 .js，
// smoke/lint 只能从 lib/index.js 导入，故契约与注册表、内置适配器一律在此 re-export。
export * from "./contracts.js";
export * from "./registry.js";
export * from "./adapters/opencode-go.js";
export * from "./path-resolve.js";

// ------------------------------------------------------------------ 类型

/** normalizeConfig 的返回（净化后的完整配置）。 */
export interface NormalizedConfig {
  baseUrl: string;
  timeoutMs: number;
  cacheTtlMs: number;
  limits: Record<string, number>;
  apiKey?: string;
  maxAgeDays: number;
  sampleIntervalMs: number;
  persistFile?: string;
  adapters: {
    host: Array<{ provider: string; file: string; enabled?: boolean }>;
    client: Array<{ file: string }>;
  };
  providerHint: Record<string, string>;
  /** 可选护栏：剔除疑似密钥字段（默认开）。 */
  stripSecrets: boolean;
}

/** apply 接收的配置（宽松）。 */
export interface OpenCodePluginConfig {
  enabled?: boolean;
  fetchImpl?: FetchLike;
  credentialsFile?: string;
  authFile?: string;
  [key: string]: unknown;
}

/** collectStats 返回的用量统计快照。 */
interface StatsResult {
  ok: boolean;
  configured: boolean;
  reason: string | null;
  error: string | null;
  usage: ProviderUsage | null;
  fetchedAt: number;
  provider: string;
  label: string;
  cached: boolean;
}

/** 运行时下界守卫。 */
function isUnknownArray(v: unknown): v is readonly unknown[] {
  return Array.isArray(v);
}

// ------------------------------------------------------------------ 常量

export const name = "opencode-usage";
export const inject: string[] = ["webServer"];

export const ROUTES: Record<string, string> = {
  stats: "/api/dsh-opencode-usage/stats",
  history: "/api/dsh-opencode-usage/history",
  adapters: "/api/dsh-opencode-usage/adapters.json",
  health: "/api/dsh-opencode-usage/health",
};

export const DEFAULT_CONFIG: NormalizedConfig = {
  baseUrl: DEFAULT_BASE_URL,
  timeoutMs: 15000,
  cacheTtlMs: 30000,
  limits: { rolling: 12, weekly: 30, monthly: 60 },
  apiKey: undefined,
  maxAgeDays: 30,
  sampleIntervalMs: 300000,
  persistFile: undefined,
  adapters: { host: [], client: [] },
  providerHint: {},
  stripSecrets: true,
};

export const CONFIG_KEYS: string[] = [
  "baseUrl", "timeoutMs", "cacheTtlMs", "apiKey", "maxAgeDays",
  "sampleIntervalMs", "persistFile", "adapters", "providerHint", "stripSecrets",
];

export function defaultPersistFile(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-opencode-usage", "history.json");
}

// ------------------------------------------------------------------ 配置归一化

export function normalizeConfig(input: unknown): NormalizedConfig {
  const base: NormalizedConfig = {
    ...DEFAULT_CONFIG,
    limits: { ...DEFAULT_CONFIG.limits },
    adapters: { host: [], client: [] },
    providerHint: {},
  };
  if (typeof input !== "object" || input === null) return base;
  const cfg = input as Record<string, unknown>;
  if (typeof cfg.baseUrl === "string" && /^https?:\/\//u.test(cfg.baseUrl)) base.baseUrl = cfg.baseUrl;
  if (Number.isFinite(cfg.timeoutMs) && (cfg.timeoutMs as number) > 0)
    base.timeoutMs = Math.min(Math.round(cfg.timeoutMs as number), 120000);
  if (Number.isFinite(cfg.cacheTtlMs) && (cfg.cacheTtlMs as number) >= 0)
    base.cacheTtlMs = Math.min(Math.round(cfg.cacheTtlMs as number), 3600000);
  if (typeof cfg.apiKey === "string" && cfg.apiKey.trim() !== "") base.apiKey = cfg.apiKey.trim();
  if (Number.isFinite(cfg.maxAgeDays) && (cfg.maxAgeDays as number) > 0)
    base.maxAgeDays = Math.min(Math.round(cfg.maxAgeDays as number), 365);
  if (Number.isFinite(cfg.sampleIntervalMs) && (cfg.sampleIntervalMs as number) >= 30000)
    base.sampleIntervalMs = Math.min(Math.round(cfg.sampleIntervalMs as number), 3600000);
  if (typeof cfg.persistFile === "string" && cfg.persistFile.trim() !== "") base.persistFile = cfg.persistFile.trim();
  if (typeof cfg.stripSecrets === "boolean") base.stripSecrets = cfg.stripSecrets;
  if (typeof cfg.limits === "object" && cfg.limits !== null) {
    for (const key of Object.keys(DEFAULT_CONFIG.limits)) {
      const lim = (cfg.limits as Record<string, unknown>)[key];
      if (Number.isFinite(lim) && (lim as number) > 0) base.limits[key] = lim as number;
    }
  }
  // 适配器配置（M2 完整实现 + R1 候选/enabled）
  if (typeof cfg.adapters === "object" && cfg.adapters !== null) {
    const ad = cfg.adapters as Record<string, unknown>;
    if (Array.isArray(ad.host)) {
      base.adapters.host = (ad.host as Array<Record<string, unknown>>)
        .filter((h) => typeof h === "object" && h !== null)
        .map((h) => ({
          provider: String(h.provider ?? ""),
          file: String(h.file ?? ""),
          ...(typeof h.enabled === "boolean" ? { enabled: h.enabled as boolean } : {}),
        }))
        .filter((h) => h.provider.length > 0 && h.file.length > 0);
    }
    if (Array.isArray(ad.client)) {
      base.adapters.client = (ad.client as Array<Record<string, unknown>>)
        .filter((c) => typeof c === "object" && c !== null)
        .map((c) => ({ file: String(c.file ?? "") }))
        .filter((c) => c.file.length > 0);
    }
  }
  if (typeof cfg.providerHint === "object" && cfg.providerHint !== null) {
    const hint = cfg.providerHint as Record<string, unknown>;
    base.providerHint = {};
    for (const key of Object.keys(hint)) {
      if (typeof hint[key] === "string") base.providerHint[key] = hint[key] as string;
    }
  }
  return base;
}

// ------------------------------------------------------------------ 凭据解析（保留，与现有行为一致）

export function credentialsKeyFromYaml(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const match = text.match(/OPENCODE_GO_API_KEY\s*:\s*["']?([^"'\r\n#]+)/u);
  if (match === null) return undefined;
  const key = match[1].trim();
  return key.length > 0 ? key : undefined;
}

export function opencodeKeyFromAuth(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;
  const rec = data as Record<string, unknown>;
  const entry = (rec["opencode-go"] ?? rec["opencode"]) as Record<string, unknown> | undefined;
  if (entry && entry.type === "api" && typeof entry.key === "string" && entry.key.length > 0) {
    return entry.key;
  }
  return undefined;
}

export function resolveApiKey({
  explicit,
  env,
  credentialsYaml,
  authJson,
}: {
  explicit?: string;
  env?: string;
  credentialsYaml?: string;
  authJson?: string;
}): string | undefined {
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
  if (typeof env === "string" && env.trim() !== "") return env.trim();
  const fromYaml = credentialsKeyFromYaml(credentialsYaml);
  if (fromYaml !== undefined) return fromYaml;
  const fromAuth = opencodeKeyFromAuth(authJson);
  if (fromAuth !== undefined) return fromAuth;
  return undefined;
}

export function credentialsFile(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".credentials.yaml");
}

export function opencodeAuthFile(): string {
  return join(homedir(), ".local", "share", "opencode", "auth.json");
}

export async function loadApiKey(
  config: { apiKey?: string },
  paths: { credentialsFile?: string; authFile?: string } = {},
): Promise<string | undefined> {
  const env = process.env.OPENCODE_GO_API_KEY;
  let credentialsYaml: string | undefined;
  let authJson: string | undefined;
  const credFile = paths.credentialsFile ?? credentialsFile();
  const authFile = paths.authFile ?? opencodeAuthFile();
  try {
    if (existsSync(credFile)) credentialsYaml = await readFile(credFile, "utf8");
  } catch {
    credentialsYaml = undefined;
  }
  try {
    if (existsSync(authFile)) authJson = await readFile(authFile, "utf8");
  } catch {
    authJson = undefined;
  }
  return resolveApiKey({ explicit: config.apiKey, env, credentialsYaml, authJson });
}

// ------------------------------------------------------------------ 缓存

export function makeUsageCache<T>({ ttlMs, now = () => Date.now() }: { ttlMs: number; now?: () => number }) {
  const entries = new Map<string, { ts: number; value: T }>();
  return {
    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (now() - entry.ts >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: T): void {
      entries.set(key, { ts: now(), value });
    },
    clear(key?: string): void {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
  };
}

// ------------------------------------------------------------------ 历史采样序列（v2：多 provider 分桶）

/** 历史数据文件版本。 */
export const HISTORY_VERSION = 2;

/** 采样点 = [ts, ...colPcts]（升序紧凑数组，列语义由各 provider 声明，percent 允许 null）。 */
export type SamplePoint = (number | null)[];

export function makeHistoryStore({ maxAgeDays = 14, now = () => Date.now() }: { maxAgeDays?: number; now?: () => number } = {}) {
  /** provider → 采样点序列（升序）。 */
  const series = new Map<string, (number | null)[][]>();

  /** 获取某 provider 的采样序列（不存在则创建空序列）。 */
  function getSeries(provider: string): (number | null)[][] {
    let s = series.get(provider);
    if (s === undefined) {
      s = [];
      series.set(provider, s);
    }
    return s;
  }

  /** 追加采样点（同分钟去重）。列数由适配器声明，v1 为 4 列 [ts, r, w, m]。 */
  function append(provider: string, point: unknown): { appended: number; replaced: number } {
    if (!isUnknownArray(point) || point.length < 2) return { appended: 0, replaced: 0 };
    const ts = Number(point[0]);
    if (!Number.isFinite(ts)) return { appended: 0, replaced: 0 };
    const normalized = [ts, ...point.slice(1).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null))];
    const samples = getSeries(provider);
    let replaced = 0;
    const last = samples.length > 0 ? samples[samples.length - 1] : undefined;
    if (last !== undefined && typeof last[0] === "number" && Math.floor(last[0] / 60000) === Math.floor(ts / 60000)) {
      samples[samples.length - 1] = normalized;
      replaced = 1;
    } else {
      samples.push(normalized);
    }
    return { appended: replaced === 1 ? 0 : 1, replaced };
  }

  /** 获取某 provider 的采样序列副本。 */
  function list(provider: string): (number | null)[][] {
    return [...getSeries(provider)];
  }

  /** 所有 provider 的计数。 */
  function countAll(): number {
    let total = 0;
    for (const s of series.values()) total += s.length;
    return total;
  }

  /** 裁剪某 provider 超龄点。 */
  function trim(provider: string): number {
    const cutoff = now() - maxAgeDays * 86400000;
    const samples = getSeries(provider);
    let removed = 0;
    while (samples.length > 0 && typeof samples[0][0] === "number" && samples[0][0] < cutoff) {
      samples.shift();
      removed += 1;
    }
    return removed;
  }

  /** 裁剪所有 provider 超龄点。 */
  function trimAll(): void {
    for (const provider of series.keys()) trim(provider);
  }

  /** 从持久化文本加载（兼容 v1 单序列 + v2 分桶）。 */
  function load(raw: string | undefined): number {
    if (typeof raw !== "string" || raw === "") return 0;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return 0;
    }
    if (typeof data !== "object" || data === null) return 0;
    const rec = data as Record<string, unknown>;
    const version = rec.version === 2 ? 2 : 1;

    if (version === 1) {
      // v1 迁移：单序列 → 写入 opencode-go 桶
      const rawSamples = rec.samples;
      if (!Array.isArray(rawSamples)) return 0;
      let loaded = 0;
      for (const item of rawSamples) {
        if (!isUnknownArray(item) || item.length < 2) continue;
        const ts = Number(item[0]);
        if (!Number.isFinite(ts)) continue;
        getSeries(OPENCODE_GO_PROVIDER).push([ts, ...item.slice(1).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null))]);
        loaded += 1;
      }
      return loaded;
    }

    // v2 分桶
    const rawSeries = rec.series as Record<string, { samples: unknown[] }> | undefined;
    if (typeof rawSeries !== "object" || rawSeries === null) return 0;
    let loaded = 0;
    for (const provider of Object.keys(rawSeries)) {
      const bucket = rawSeries[provider];
      if (!Array.isArray(bucket?.samples)) continue;
      const samples = getSeries(provider);
      for (const item of bucket.samples) {
        if (!isUnknownArray(item) || item.length < 2) continue;
        const ts = Number(item[0]);
        if (!Number.isFinite(ts)) continue;
        samples.push([ts, ...item.slice(1).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null))]);
        loaded += 1;
      }
    }
    return loaded;
  }

  /** 序列化为持久化 JSON 文本（v2 格式）。 */
  function dump(): string {
    const raw: Record<string, { samples: (number | null)[][] }> = {};
    for (const [provider, samples] of series) {
      if (samples.length > 0) raw[provider] = { samples };
    }
    return JSON.stringify({ version: HISTORY_VERSION, series: raw });
  }

  function clear(): void {
    series.clear();
  }

  return { append, list, countAll, trim, trimAll, load, dump, clear, getSeries };
}

/* 原子写落盘。 */
export async function writeHistoryFile(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
}

export async function readHistoryFile(file: string): Promise<string | undefined> {
  try {
    if (!existsSync(file)) return undefined;
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ 密钥护栏（stripSecrets，默认开）

/** 疑似密钥值模式（R1 值匹配，与键名扫描互补）。命中即整值脱敏。 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /Bearer\s+\S+/u, // Authorization 头回显
  /\bsk-[A-Za-z0-9_-]{8,}\b/u, // OpenAI 风格 key
  /\bapi[_-]?key\s*[:=]\s*\S+/u, // api_key: xxx
  /\b[0-9a-fA-F]{40,}\b/u, // 40+ hex（疑似 token）
  /\b[0-9a-fA-F]{64}\b/u, // 64 hex（sha/token）
];

/** 单个字符串值是否命中疑似密钥模式。 */
function isSecretValue(s: string): boolean {
  for (const re of SECRET_VALUE_PATTERNS) {
    if (re.test(s)) return true;
  }
  return false;
}

/**
 * 递归扫描并脱敏疑似密钥（R1 扩展：键名 + 值模式双重）。
 * - 键名含 secret/token/key/apikey 且值为字符串（长度 ≥ 8）→ 脱敏；
 * - 任意字符串值命中 SECRET_VALUE_PATTERNS → 脱敏。
 * 就地修改传入对象。
 */
export function stripSensitiveKeys(obj: unknown): void {
  if (typeof obj !== "object" || obj === null) return;
  if (Array.isArray(obj)) {
    for (const item of obj) stripSensitiveKeys(item);
    return;
  }
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const val = rec[key];
    if (typeof val === "string") {
      if ((val.length >= 8 && /secret|token|key|apikey/ui.test(key)) || isSecretValue(val)) {
        rec[key] = "<redacted>";
        continue;
      }
    }
    stripSensitiveKeys(val);
  }
}

/**
 * 收集采样点（R1：数据格式放开）。
 * - 适配器实现 `samplePoint` → 用其结构化返回值（列声明 + 数值）；
 * - 无 `samplePoint` 但含 `windows` → 回落通用提取（各列 percent）；
 * - 两者都没有 → 不采样（该 provider 无历史图），返回 null。
 */
export function collectSamplePoint(adapter: HostProviderAdapter | undefined, usage: ProviderUsage): SamplePointData | null {
  if (adapter !== undefined && typeof adapter.samplePoint === "function") {
    try {
      return adapter.samplePoint(usage);
    } catch {
      // samplePoint 抛错 → 回落 windows / 不采样，不阻断
    }
  }
  if (!Array.isArray(usage.windows) || usage.windows.length === 0) return null;
  return {
    cols: usage.windows.map((w) => ({
      key: w.key,
      name: w.name,
      ...(w.limit !== undefined ? { limit: w.limit } : {}),
      ...(w.resetPeriodMs !== undefined ? { resetPeriodMs: w.resetPeriodMs } : {}),
    })),
    values: usage.windows.map((w) => (typeof w.percent === "number" && Number.isFinite(w.percent) ? w.percent : null)),
  };
}


// ------------------------------------------------------------------ 插件入口

export async function apply(ctx: PluginContext, config: OpenCodePluginConfig = {}): Promise<void> {
  if (config.enabled === false) return;
  const current = normalizeConfig(config);
  const fetchImpl: FetchLike = typeof config.fetchImpl === "function" ? config.fetchImpl as FetchLike : fetch;
  const keyPaths: { credentialsFile?: string; authFile?: string } = {
    credentialsFile: typeof config.credentialsFile === "string" ? config.credentialsFile : undefined,
    authFile: typeof config.authFile === "string" ? config.authFile : undefined,
  };

  // -------------------------------------------------------- 适配器注册表
  const registry = makeHostAdapterRegistry();
  registry.register(openCodeGoHostAdapter, "builtin");

  // M2: 加载用户宿主适配器（多个文件依序加载，单个失败不阻断）
  for (const entry of current.adapters.host) {
    const file = resolvePath(entry.file);
    if (file === undefined) {
      console.warn(`[dsh-opencode-usage] 用户宿主适配器文件不存在：${entry.file}，跳过`);
      continue;
    }
    try {
      const url = pathToFileURL(file).href;
      const mod = await import(url);
      const adapter = (mod as Record<string, unknown>).default ?? mod;
      registry.register(adapter, "user-file", file, entry.enabled);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[dsh-opencode-usage] 用户宿主适配器加载失败 ${entry.file}: ${msg}`);
    }
  }

  // 解析用户客户端文件路径（用于 serve 路由，文件不存在也纳入路径列表——加载时再报错）
  const userClientFiles: Array<{ file: string; resolvedPath: string | undefined }> = [];
  for (const entry of current.adapters.client) {
    const resolvedPath = resolvePath(entry.file);
    userClientFiles.push({ file: entry.file, resolvedPath });
  }

  const cache = makeUsageCache<StatsResult>({ ttlMs: current.cacheTtlMs });

  // -------------------------------------------------------- 历史采样
  const persistFile = current.persistFile ?? defaultPersistFile();
  const store = makeHistoryStore({ maxAgeDays: current.maxAgeDays });
  await store.load(await readHistoryFile(persistFile));

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  async function flushPersist(): Promise<void> {
    try {
      await writeHistoryFile(persistFile, store.dump());
    } catch {
      /* 落盘失败不阻断 */
    }
  }
  function schedulePersist(): void {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void flushPersist();
    }, 1000);
  }

  let lastStatus: { at: number; error: string | null; configured: boolean } = {
    at: 0, error: null, configured: false,
  };

  let inflightStats: Map<string, Promise<StatsResult>> | null = new Map();

  /** 解析某 provider 的 API Key（当前仅 opencode-go 有解析链；M2 扩展）。 */
  async function resolveKeyFor(provider: string): Promise<string | undefined> {
    if (provider === OPENCODE_GO_PROVIDER) return loadApiKey(current, keyPaths);
    // M2: 用户适配器可自持鉴权，或由配置提供 key
    return undefined;
  }

  /** 用量统计核心（路由 handler 与 health 共用）。 */
  function collectStats(provider: string = OPENCODE_GO_PROVIDER): Promise<StatsResult> {
    const cached = cache.get(provider);
    if (cached !== undefined) return Promise.resolve({ ...cached, cached: true });

    if (inflightStats === null) inflightStats = new Map();
    const inflight = inflightStats.get(provider);
    if (inflight !== undefined) return inflight;

    const promise = (async (): Promise<StatsResult> => {
      try {
        // 查当前启用适配器
        const entry = registry.getEntry(provider);
        if (entry === undefined) {
          const code = registry.hasCandidates(provider) ? "no-enabled-adapter" : "no-adapter";
          const result: StatsResult = {
            ok: true, configured: false, reason: code, error: null,
            usage: null, fetchedAt: Date.now(), provider, label: provider, cached: false,
          };
          lastStatus = { at: result.fetchedAt, error: null, configured: false };
          return result;
        }

        const apiKey = await resolveKeyFor(provider);
        const fetchCtx = {
          provider,
          apiKey,
          baseUrl: current.baseUrl,
          fetch: fetchImpl,
          signal: undefined as AbortSignal | undefined,
        };
        const usage = await registry.fetchUsage(provider, fetchCtx);

        // 密钥护栏（默认开）
        if (current.stripSecrets && usage.data !== undefined) {
          try { stripSensitiveKeys(usage.data); } catch { /* 忽略 */ }
        }
        if (current.stripSecrets && usage.meta !== undefined) {
          try { stripSensitiveKeys(usage.meta); } catch { /* 忽略 */ }
        }

        const result: StatsResult = {
          ok: true,
          configured: true,
          reason: null,
          error: usage.ok ? null : (usage.error ?? null),
          usage,
          fetchedAt: Date.now(),
          provider,
          label: usage.label,
          cached: false,
        };

        // 采样挂点（R1：优先适配器 samplePoint 结构化列，回落 windows；都在则跳过）
        const sample = collectSamplePoint(entry.adapter, usage);
        if (sample !== null) {
          store.append(result.provider, [result.fetchedAt, ...sample.values]);
          store.trimAll();
          schedulePersist();
        }
        if (usage.ok) {
          cache.set(provider, result);
        }

        lastStatus = { at: result.fetchedAt, error: result.error, configured: true };
        return result;
      } finally {
        inflightStats?.delete(provider);
      }
    })();
    inflightStats.set(provider, promise);
    return promise;
  }

  // -------------------------------------------------------- 路由注册

  const statsRoute: DshRoute = {
    kind: "exact",
    path: ROUTES.stats,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const url = new URL(req.url ?? "/", "http://localhost");
      const provider = url.searchParams.get("provider") ?? OPENCODE_GO_PROVIDER;
      const result = await collectStats(provider);
      const limits: Record<string, number> = {};
      if (result.usage?.windows) {
        for (const w of result.usage.windows) {
          if (w.limit !== undefined) limits[w.key] = w.limit;
        }
      }
      writeJson(res, 200, {
        plugin: "dsh-opencode-usage",
        limits: Object.keys(limits).length > 0 ? limits : current.limits,
        ...result,
      });
    },
  };

  // 后台采样定时器：采样所有**已启用**适配器的 provider（D10，保持历史连续）
  let backgroundTimer: ReturnType<typeof setInterval> | null = null;
  if (current.sampleIntervalMs > 0) {
    backgroundTimer = setInterval(() => {
      for (const provider of registry.enabledProviders()) {
        void collectStats(provider);
      }
    }, current.sampleIntervalMs);
    (backgroundTimer as { unref?: () => void }).unref?.();
    // 启动时立即补一次所有启用 provider
    for (const provider of registry.enabledProviders()) {
      void collectStats(provider);
    }
  }

  const historyRoute: DshRoute = {
    kind: "exact",
    path: ROUTES.history,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const url = new URL(req.url ?? "/", "http://localhost");
      const provider = url.searchParams.get("provider") ?? OPENCODE_GO_PROVIDER;
      let samples = store.list(provider);
      const days = Number(url.searchParams.get("days"));
      if (Number.isFinite(days) && days > 0) {
        const cutoff = Date.now() - Math.min(Math.round(days), current.maxAgeDays) * 86400000;
        samples = samples.filter((s) => typeof s[0] === "number" && s[0] >= cutoff);
      }
      writeJson(res, 200, {
        ok: true,
        plugin: "dsh-opencode-usage",
        version: HISTORY_VERSION,
        provider,
        count: samples.length,
        maxAgeDays: current.maxAgeDays,
        samples,
      });
    },
  };

  // M2: 适配器元数据路由（含用户客户端渲染器文件 URL）
  const adaptersRoute: DshRoute = {
    kind: "exact",
    path: ROUTES.adapters,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const snap = registry.snapshot();
      const client = userClientFiles.map((entry, i) => ({
        url: `/api/dsh-opencode-usage/user/${i}.js`,
        file: entry.file,
        resolved: entry.resolvedPath !== undefined,
      }));
      writeJson(res, 200, {
        version: ADAPTER_CONTRACT_VERSION,
        host: snap.infos.filter((i) => i.status === "active").map((i) => ({
          providers: i.providers,
          source: i.source,
          file: i.file ?? null,
        })),
        client,
      });
    },
  };

  // M2: 用户客户端 JS 静态服务路由（loopback 围栏，text/javascript content-type）
  const userRoute: DshRoute = {
    // 匹配 /api/dsh-opencode-usage/user/<n>.js
    kind: "prefix",
    path: "/api/dsh-opencode-usage/user/",
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const url = new URL(req.url ?? "/", "http://localhost");
      const match = url.pathname.match(/\/user\/(\d+)\.js$/u);
      if (match === null) return writeJson(res, 404, { error: "not found" });
      const idx = parseInt(match[1], 10);
      const entry = userClientFiles[idx];
      if (entry === undefined) return writeJson(res, 404, { error: "not found" });
      if (entry.resolvedPath === undefined) return writeJson(res, 404, { error: "file not resolved" });
      try {
        const content = await readFile(entry.resolvedPath, "utf8");
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(content);
      } catch {
        writeJson(res, 500, { error: "read error" });
      }
    },
  };

  const healthRoute: DshRoute = {
    kind: "exact",
    path: ROUTES.health,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const snap = registry.snapshot();
      writeJson(res, 200, {
        ok: true,
        plugin: "dsh-opencode-usage",
        baseUrl: current.baseUrl,
        cacheTtlMs: current.cacheTtlMs,
        limits: current.limits,
        sampleIntervalMs: current.sampleIntervalMs,
        history: { count: store.countAll(), maxAgeDays: current.maxAgeDays, persistFile },
        lastStatus,
        adapters: snap.infos,
      });
    },
  };

  const disposeRoutes = ctx.effect(
    () => {
      const routeDisposers = [statsRoute, historyRoute, adaptersRoute, userRoute, healthRoute].map((route) =>
        ctx.webServer.register(route),
      );
      return () => {
        for (const dispose of routeDisposers) {
          try { dispose(); } catch { /* 忽略 */ }
        }
      };
    },
    "dsh-opencode-usage: routes",
  );

  ctx.effect(
    () => () => {
      disposeRoutes();
      cache.clear();
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (backgroundTimer !== null) {
        clearInterval(backgroundTimer);
        backgroundTimer = null;
      }
      void flushPersist();
    },
    "dsh-opencode-usage",
  );
}