/**
 * dsh-opencode-usage — OpenCode Go 套餐用量悬浮框（宿主端）。
 *
 * 数据源：OpenCode Go 官方用量接口（未公开文档，实测可用）：
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <OPENCODE_GO_API_KEY>
 *   → { "usage": { rolling: {status, percent, resetsAt},
 *                  weekly:  {status, percent, resetsAt},
 *                  monthly: {status, percent, resetsAt} } }
 * 权威数据来自服务商记账，插件不做任何本地计算/累加。
 *
 * API Key 解析顺序（config.apiKey 显式配置 > 环境变量 > DSH 凭据文件
 * ~/.dsh/.credentials.yaml 的 OPENCODE_GO_API_KEY > OpenCode 自身
 * ~/.local/share/opencode/auth.json 的 opencode-go/opencode 条目）。
 *
 * 历史采样（波浪图数据源）：官方接口只给当前快照，不提供历史；插件在每次
 * 实际 fetch 成功时把三个窗口的 percent 记为一个采样点（同分钟去重，只留
 * 最新），内存累积 + 防抖落盘 ~/.dsh/dsh-opencode-usage/history.json，
 * 启动时加载，超龄裁剪（history.maxAgeDays，默认 14 天）。
 * 采样触发：① GUI 轮询 /stats 路由（浏览器开着时约 60s 一次）；
 * ② 宿主低频后台定时器 sampleIntervalMs（默认 5 分钟）——浏览器关闭、
 * 无人访问路由时也持续采样，保证历史连续（OpenCode 使用不一定伴随 GUI
 * 开启；宿主进程关闭期间仍无法采样，属客观边界）。
 *
 * 路由（loopback 围栏）：
 * - GET /api/dsh-opencode-usage/stats   用量统计（带 TTL 缓存）
 * - GET /api/dsh-opencode-usage/history 历史采样序列（波浪图数据源）
 * - GET /api/dsh-opencode-usage/health  健康检查
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson } from "../../../shared/host-utils.js";
import type { PluginContext, DshRoute } from "../../../types/dsh.js";

// ------------------------------------------------------------------ 类型

/** fetch 兼容签名（fetchImpl 注入点）。 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** 单个窗口的用量数据（percent 允许 null）。 */
export interface UsageWindow {
  status: string | null;
  percent: number | null;
  resetsAt: string | null;
}

/** 三窗口用量。 */
export interface UsageWindows {
  rolling: UsageWindow | null;
  weekly: UsageWindow | null;
  monthly: UsageWindow | null;
}

/** 历史采样点 = [ts, rollingPct, weeklyPct, monthlyPct]（升序紧凑数组）。 */
export type SamplePoint = [number, number | null, number | null, number | null];

/** normalizeConfig 的返回（净化后的完整配置，与 DEFAULT_CONFIG 同构）。 */
export interface NormalizedConfig {
  baseUrl: string;
  timeoutMs: number;
  cacheTtlMs: number;
  limits: Record<"rolling" | "weekly" | "monthly", number>;
  apiKey?: string;
  maxAgeDays: number;
  /** 宿主后台采样间隔（毫秒；浏览器关闭时保历史连续）。 */
  sampleIntervalMs: number;
  persistFile?: string;
}

/** apply 接收的配置（宽松；业务键走 normalizeConfig 净化，另有两处只读注入点）。 */
export interface OpenCodePluginConfig {
  enabled?: boolean;
  fetchImpl?: FetchLike;
  credentialsFile?: string;
  authFile?: string;
  [key: string]: unknown;
}

/** collectStats 返回的用量统计快照。 */
interface UsageStatsResult {
  ok: boolean;
  configured: boolean;
  reason: string | null;
  error: string | null;
  usage: UsageWindows | null;
  fetchedAt: number;
}

/** 运行时下界守卫：Array.isArray 收窄为 readonly unknown[]，避开 any[]。 */
function isUnknownArray(v: unknown): v is readonly unknown[] {
  return Array.isArray(v);
}

/** 稳定的 cordis 插件名。 */
export const name = "opencode-usage";

/** 需要的服务：webServer（路由）。 */
export const inject: string[] = ["webServer"];

/** 与客户端共享的路由常量（smoke 断言两端一致）。 */
export const ROUTES: Record<"stats" | "history" | "health", string> = {
  stats: "/api/dsh-opencode-usage/stats",
  history: "/api/dsh-opencode-usage/history",
  health: "/api/dsh-opencode-usage/health",
};

/** 官方用量接口默认地址（OpenCode Go，Anthropic 兼容 key）。 */
export const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1/usage";

/** 默认配置。 */
export const DEFAULT_CONFIG: NormalizedConfig = {
  baseUrl: DEFAULT_BASE_URL,
  timeoutMs: 15000,
  /** 用量缓存 TTL（毫秒）：官方接口变化不频繁，窗口内复用，防刷屏。 */
  cacheTtlMs: 30000,
  /** 展示用限额（美元/窗口）。接口不返回限额，随套餐变化，可配置覆盖。 */
  limits: { rolling: 12, weekly: 30, monthly: 60 },
  /** 显式 API Key（可选；缺省走凭据解析链）。 */
  apiKey: undefined,
  /** 历史采样保留天数（超龄头部裁剪；波浪图时间跨度上限）。 */
  maxAgeDays: 14,
  /** 宿主后台采样间隔（默认 5 分钟；浏览器关闭时保历史连续，官方接口
   * 低频调用不构成压力，约 288 次/天）。 */
  sampleIntervalMs: 300000,
  /** 历史采样落盘路径（默认 DSH_HOME/dsh-opencode-usage/history.json）。 */
  persistFile: undefined,
};

/** 配置键白名单（单一事实源）。 */
export const CONFIG_KEYS: string[] = ["baseUrl", "timeoutMs", "cacheTtlMs", "apiKey", "maxAgeDays", "sampleIntervalMs", "persistFile"];

/** 默认历史落盘路径（DSH_HOME 优先，退 home 下 .dsh）。 */
export function defaultPersistFile(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-opencode-usage", "history.json");
}

/** 合并配置：未知键丢弃，非法值回退默认，防默认值被污染。 */
export function normalizeConfig(input: unknown): NormalizedConfig {
  const base: NormalizedConfig = {
    ...DEFAULT_CONFIG,
    limits: { ...DEFAULT_CONFIG.limits },
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
  if (typeof cfg.limits === "object" && cfg.limits !== null) {
    for (const key of ["rolling", "weekly", "monthly"] as const) {
      const lim = (cfg.limits as Record<string, unknown>)[key];
      if (Number.isFinite(lim) && (lim as number) > 0) base.limits[key] = lim as number;
    }
  }
  return base;
}

/** 防御式窗口解析：任意输入 → { status, percent, resetsAt } 或 null。 */
export function pickWindow(w: unknown): UsageWindow | null {
  if (typeof w !== "object" || w === null) return null;
  const rec = w as Record<string, unknown>;
  const percent = typeof rec.percent === "number" ? rec.percent : Number(rec.percent);
  return {
    status: typeof rec.status === "string" ? rec.status : null,
    percent: Number.isFinite(percent) ? percent : null,
    resetsAt: typeof rec.resetsAt === "string" ? rec.resetsAt : null,
  };
}

/** 解析用量响应体（兼容 {usage:{...}} 与直接三键两种形状）。 */
export function parseUsageResponse(body: unknown): UsageWindows | null {
  if (typeof body !== "object" || body === null) return null;
  const rec = body as Record<string, unknown>;
  const usage = rec.usage && typeof rec.usage === "object" ? (rec.usage as Record<string, unknown>) : rec;
  return {
    rolling: pickWindow(usage.rolling),
    weekly: pickWindow(usage.weekly),
    monthly: pickWindow(usage.monthly),
  };
}

/** 从 DSH 凭据文件文本提取 OPENCODE_GO_API_KEY（yaml 宽松解析）。 */
export function credentialsKeyFromYaml(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const match = text.match(/OPENCODE_GO_API_KEY\s*:\s*["']?([^"'\r\n#]+)/u);
  if (match === null) return undefined;
  const key = match[1].trim();
  return key.length > 0 ? key : undefined;
}

/** 从 OpenCode auth.json 文本提取 opencode-go（回退 opencode）API key。 */
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

/** 凭据解析链（纯函数，输入注入便于单测）：显式 > 环境变量 > credentials.yaml > auth.json。 */
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

/** 本机凭据文件路径（可被 config 覆盖，测试用）。DSH_HOME 优先（与 defaultPersistFile 一致）。 */
export function credentialsFile(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".credentials.yaml");
}

/** 本机 OpenCode auth.json 路径。 */
export function opencodeAuthFile(): string {
  return join(homedir(), ".local", "share", "opencode", "auth.json");
}

/**
 * 读取当前生效的 API Key（异步，文件可能不存在 → undefined）。
 * @param config - normalizeConfig 后的配置。
 * @param paths - 可选覆盖（测试注入）。
 */
export async function loadApiKey(
  config: { apiKey?: string },
  paths: { credentialsFile?: string; authFile?: string } = {}
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

/**
 * 调用官方用量接口（fetch 可注入，便于单测）。
 * @returns 成功返回 { ok: true, usage }；失败返回 { ok: false, error }，
 *   error: network | unauthorized | http-<status> | bad-json
 */
export async function fetchUsage({
  baseUrl,
  apiKey,
  timeoutMs = 15000,
  fetchImpl = fetch,
}: {
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<{ ok: true; usage: UsageWindows } | { ok: false; error: string }> {
  if (typeof apiKey !== "string" || apiKey === "") return { ok: false, error: "no-api-key" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(baseUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch {
    return { ok: false, error: "network" };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: "unauthorized" };
  if (!res.ok) return { ok: false, error: `http-${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "bad-json" };
  }
  const usage = parseUsageResponse(body);
  if (usage === null) return { ok: false, error: "bad-json" };
  return { ok: true, usage };
}

/** TTL 缓存（纯函数）：now 可注入便于单测。 */
export function makeUsageCache<T>({ ttlMs, now = () => Date.now() }: { ttlMs: number; now?: () => number }) {
  let entry: { ts: number; value: T } | undefined = undefined;
  return {
    get(): T | undefined {
      if (entry === undefined) return undefined;
      if (now() - entry.ts >= ttlMs) {
        entry = undefined;
        return undefined;
      }
      return entry.value;
    },
    set(value: T): void {
      entry = { ts: now(), value };
    },
    clear(): void {
      entry = undefined;
    },
  };
}

/**
 * 历史采样序列（纯函数，波浪图数据源）。
 * 采样点 = [ts, rollingPct, weeklyPct, monthlyPct]（升序紧凑数组，percent
 * 允许 null）。追加规则：同分钟去重（只留该分钟最新一点），追加后超龄裁剪。
 * now 可注入便于单测。
 */
export function makeHistoryStore({ maxAgeDays = 14, now = () => Date.now() }: { maxAgeDays?: number; now?: () => number } = {}) {
  let samples: SamplePoint[] = [];
  return {
    /** 追加采样点。返回 {appended, replaced}（appended 为实际新增数）。 */
    append(point: unknown): { appended: number; replaced: number } {
      if (!isUnknownArray(point) || point.length < 4) return { appended: 0, replaced: 0 };
      const ts = Number(point[0]);
      if (!Number.isFinite(ts)) return { appended: 0, replaced: 0 };
      const normalized = [
        ts,
        ...point.slice(1, 4).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null)),
      ] as SamplePoint;
      let replaced = 0;
      const last = samples.length > 0 ? samples[samples.length - 1] : undefined;
      if (last !== undefined && Math.floor(last[0] / 60000) === Math.floor(ts / 60000)) {
        samples[samples.length - 1] = normalized; // 同分钟只留最新
        replaced = 1;
      } else {
        samples.push(normalized);
      }
      return { appended: replaced === 1 ? 0 : 1, replaced };
    },
    /** 当前采样序列（升序，调用方不得修改）。 */
    list(): SamplePoint[] {
      return samples;
    },
    count(): number {
      return samples.length;
    },
    /** 裁剪早于 now - maxAgeDays 的点（升序序列从头部删）。返回裁剪数。 */
    trim(): number {
      const cutoff = now() - maxAgeDays * 86400000;
      let removed = 0;
      while (samples.length > 0 && samples[0][0] < cutoff) {
        samples.shift();
        removed += 1;
      }
      return removed;
    },
    /** 从持久化文本加载（防御式：坏 JSON/坏结构丢弃，只保留合法点）。 */
    load(raw: string | undefined): number {
      if (typeof raw !== "string" || raw === "") return 0;
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        return 0;
      }
      if (typeof data !== "object" || data === null || !Array.isArray((data as Record<string, unknown>).samples)) return 0;
      const loaded: SamplePoint[] = [];
      for (const item of (data as Record<string, unknown>).samples as unknown[]) {
        if (!isUnknownArray(item) || item.length < 4) continue;
        const ts = Number(item[0]);
        if (!Number.isFinite(ts)) continue;
        loaded.push([
          ts,
          ...item.slice(1, 4).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null)),
        ] as SamplePoint);
      }
      loaded.sort((a, b) => a[0] - b[0]);
      samples = loaded;
      this.trim();
      return samples.length;
    },
    /** 序列化为持久化 JSON 文本。 */
    dump(): string {
      return JSON.stringify({ version: 1, samples });
    },
    clear(): void {
      samples = [];
    },
  };
}

/** 原子写落盘（tmp + rename，防半截文件；0600 防他人读凭据类内容）。目录不存在则创建。 */
export async function writeHistoryFile(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
}

/** 读取历史落盘文件文本（不存在返回 undefined；读取失败返回 undefined）。 */
export async function readHistoryFile(file: string): Promise<string | undefined> {
  try {
    if (!existsSync(file)) return undefined;
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * 挂载 dsh-opencode-usage。
 * @param ctx - 宿主插件上下文。
 * @param config - 配置（enabled / baseUrl / timeoutMs / cacheTtlMs /
 *   limits / apiKey / maxAgeDays / persistFile / fetchImpl / credentialsFile / authFile）。
 */
export async function apply(ctx: PluginContext, config: OpenCodePluginConfig = {}): Promise<void> {
  if (config.enabled === false) return;
  const current = normalizeConfig(config);
  /** fetch 实现注入点（smoke 全链路测试用；默认全局 fetch）。 */
  const fetchImpl = typeof config.fetchImpl === "function" ? config.fetchImpl : fetch;
  /** 凭据文件路径覆盖（可选；缺省用本机默认位置）。 */
  const keyPaths: { credentialsFile?: string; authFile?: string } = {
    credentialsFile: typeof config.credentialsFile === "string" ? config.credentialsFile : undefined,
    authFile: typeof config.authFile === "string" ? config.authFile : undefined,
  };
  const cache = makeUsageCache<UsageStatsResult>({ ttlMs: current.cacheTtlMs });

  // ---------------------------------------------------------------- 历史采样
  /** 落盘路径：config.persistFile > DSH_HOME 默认。 */
  const persistFile = current.persistFile ?? defaultPersistFile();
  const store = makeHistoryStore({ maxAgeDays: current.maxAgeDays });
  /** 启动加载（坏文件/不存在 → 空序列，不阻断插件）。 */
  await store.load(await readHistoryFile(persistFile));

  /** 落盘防抖：采样追加后合并写入，避免高频副作用写盘。 */
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  async function flushPersist(): Promise<void> {
    try {
      await writeHistoryFile(persistFile, store.dump());
    } catch {
      // 落盘失败不阻断（内存序列仍可用，下次采样重试）
    }
  }
  function schedulePersist(): void {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void flushPersist();
    }, 1000);
  }

  /** 最近一次接口状态（health 摘要用）。 */
  let lastStatus: { at: number; error: string | null; configured: boolean } = {
    at: 0,
    error: null,
    configured: false,
  };

  /** 进行中的 collectStats（并发复用：后台定时器 + GUI 轮询 + 手动刷新同时
   * 触发时只发一次真实请求，其余等待同一结果）。 */
  let inflightStats: Promise<UsageStatsResult & { cached?: boolean }> | null = null;

  /** 用量统计核心（路由 handler 与 health 共用；并发调用复用同一进行中请求）。 */
  function collectStats(): Promise<UsageStatsResult & { cached?: boolean }> {
    const cached = cache.get();
    if (cached !== undefined) return Promise.resolve({ ...cached, cached: true });
    if (inflightStats !== null) return inflightStats;
    inflightStats = (async (): Promise<UsageStatsResult & { cached?: boolean }> => {
      try {
        const apiKey = await loadApiKey(current, keyPaths);
        if (apiKey === undefined) {
          const result: UsageStatsResult = { ok: true, configured: false, reason: "no-api-key", error: null, usage: null, fetchedAt: Date.now() };
          lastStatus = { at: result.fetchedAt, error: null, configured: false };
          return result;
        }
        const fetched = await fetchUsage({
          baseUrl: current.baseUrl,
          apiKey,
          timeoutMs: current.timeoutMs,
          fetchImpl,
        });
        const result: UsageStatsResult = {
          ok: true,
          configured: true,
          reason: null,
          error: fetched.ok ? null : fetched.error,
          usage: fetched.ok ? fetched.usage : null,
          fetchedAt: Date.now(),
        };
        if (fetched.ok) {
          // 采样挂点：只有权威 fetch 成功才累积历史（失败不污染波浪图）
          const u = fetched.usage;
          store.append([result.fetchedAt, u.rolling?.percent ?? null, u.weekly?.percent ?? null, u.monthly?.percent ?? null]);
          store.trim();
          schedulePersist();
          cache.set(result);
        }
        lastStatus = { at: result.fetchedAt, error: result.error, configured: true };
        return result;
      } finally {
        inflightStats = null;
      }
    })();
    return inflightStats;
  }

  const statsRoute: DshRoute = {
    kind: "exact",
    path: ROUTES.stats,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const result = await collectStats();
      writeJson(res, 200, { plugin: "dsh-opencode-usage", limits: current.limits, ...result });
    },
  };

  // --------------------------------------------------------- 后台采样定时器
  // 浏览器关闭、无路由访问时也持续采样（保历史连续）。与 GUI 60s 轮询共用
  // collectStats：TTL 缓存 + 同分钟去重保证不重复、不冲突。卸载时清理。
  let backgroundTimer: ReturnType<typeof setInterval> | null = null;
  if (current.sampleIntervalMs > 0) {
    backgroundTimer = setInterval(() => {
      // fire-and-forget：失败不外抛（collectStats 内部已消化为错误态）
      void collectStats();
    }, current.sampleIntervalMs);
    // unref：不阻止宿主进程退出（smoke 测试/临时进程场景）；宿主常驻时照常执行
    (backgroundTimer as { unref?: () => void }).unref?.();
    // 启动时立即补一次（插件热重载/重启后历史缺口最小化）
    void collectStats();
  }

  /** 历史路由：GET /history[?days=N]，N 钳制 1..maxAgeDays，缺省全量。 */
  const historyRoute: DshRoute = {
    kind: "exact",
    path: ROUTES.history,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      let samples = store.list();
      const url = new URL(req.url ?? "/", "http://localhost");
      const days = Number(url.searchParams.get("days"));
      if (Number.isFinite(days) && days > 0) {
        const cutoff = Date.now() - Math.min(Math.round(days), current.maxAgeDays) * 86400000;
        samples = samples.filter((s) => s[0] >= cutoff);
      }
      writeJson(res, 200, {
        ok: true,
        plugin: "dsh-opencode-usage",
        version: 1,
        count: samples.length,
        maxAgeDays: current.maxAgeDays,
        samples,
      });
    },
  };

  const healthRoute: DshRoute = {
    kind: "exact",
    path: ROUTES.health,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      writeJson(res, 200, {
        ok: true,
        plugin: "dsh-opencode-usage",
        baseUrl: current.baseUrl,
        cacheTtlMs: current.cacheTtlMs,
        limits: current.limits,
        sampleIntervalMs: current.sampleIntervalMs,
        history: { count: store.count(), maxAgeDays: current.maxAgeDays, persistFile },
        lastStatus,
      });
    },
  };

  // 路由注册必须放在 ctx.effect 内（cordis isolate 链就绪前访问服务会触发
  // "Cyclic __proto__ value"，导致插件激活失败）；返回清理函数。
  const disposeRoutes = ctx.effect(
    () => {
      const routeDisposers = [statsRoute, historyRoute, healthRoute].map((route) => ctx.webServer.register(route));
      return () => {
        for (const dispose of routeDisposers) {
          try {
            dispose();
          } catch {
            // 忽略
          }
        }
      };
    },
    "dsh-opencode-usage: routes"
  );

  // ⚠️ 清理必须写在 effect 返回的 disposer 里，不能写在 fn 主体（apply 时
  // fn 立即同步执行，写在主体 = 注册完立刻注销 → 路由 404 且无日志）。
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
      // 卸载时兜底落盘（fire-and-forget，不阻塞卸载）
      void flushPersist();
    },
    "dsh-opencode-usage"
  );
}
