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
 * - GET/POST /api/dsh-provider-usage/ui-config 胶囊位置配置（读取/保存，保存后 SSE 广播）
 * - GET /api/dsh-provider-usage/events  SSE 事件通道（ui-config-changed 等，客户端即时热更新）
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
import type { ServerResponse } from "node:http";
import type { UsageStatsAdapter } from "./contracts.js";
import { describeUsageStatsAdapterShape, ADAPTER_CONTRACT_VERSION } from "./contracts.js";
import { makeAdapterRegistry } from "./registry.js";
import { openCodeGoAdapter, OPENCODE_GO_PROVIDER, OPENCODE_GO_ADAPTER_ID } from "./adapters/opencode-go.js";
import { deepSeekOfficialAdapter, DEEPSEEK_OFFICIAL_PROVIDER, DEEPSEEK_OFFICIAL_ADAPTER_ID } from "./adapters/deepseek-official.js";
import { runV2Pipeline, runV2PanelPipeline, panelCacheKey, isPanelCacheStale, type V2PipelineResult, type PanelCacheEntry } from "./pipeline/v2.js";
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
export * from "./adapters/deepseek-official.js";
export * from "./provider-config.js";
export { HistoryStore, parseJsonl, startOfDay, migrateLegacyV3, legacySampleToData, listAdapters } from "./core/history.js";
export type { HistoryEntry } from "./core/history.js";
export { safeFetchData, safeFormat, fetchWithTimeout } from "./core/guards.js";
export { sanitizeHtml } from "./sanitize.js";
// 客户端行为纯函数（设置页列表拆分/徽标文案，经此透出供单元测试）。
export { splitProviderList, providerBadgeText } from "./client-logic.js";
export { runV2Pipeline, runV2PanelPipeline, capsuleHtmlFromHistory, panelCacheKey, normalizeRangeDay, isPanelCacheStale, PANEL_CACHE_TTL_MS } from "./pipeline/v2.js";
export type { PanelCacheEntry } from "./pipeline/v2.js";
export { HotReloadableAdapter, loadAndValidateAdapter, readStamp, stampEqual } from "./hotreload.js";
// 路径解析纯函数透出（供测试与调用方复用同一展开/解析规则，无行为变更）
export { resolvePath, pluginHome, expandHomePath } from "./path-resolve.js";

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
  uiConfig: "/api/dsh-provider-usage/ui-config",
  events: "/api/dsh-provider-usage/events",
};

export const DEFAULT_CONFIG = {
  adapter: "",
  staticPath: "",
  provider: OPENCODE_GO_PROVIDER,
  apiEndpoint: "",
  apiKey: "",
  historyDir: "",
  warmupIntervalMs: 300000,
  // #198 H1：由 60000 下调至 30000——峰谷徽标倒计时跨时段边界的展示翻转延迟
  // = 宿主缓存 + 客户端轮询（60s）+ 渲染余量，缓存减半使端到端 ≤95s 可达。
  cacheDurationMs: 30000,
  // #206 配套：2s→5s——commandcode 等三请求并行适配器在远端慢时 2s 频繁超时；
  // safeFetchData 为 Promise.race+Abort 纯异步超时，不阻塞主进程；
  // 全局 mutex 串行取数下多 provider 排队最坏 n×5s（warmup 周期 300s 内可消化）。
  fetchTimeoutMs: 5000,
  autoReload: true,
  maxAgeDays: 30,
  maxSizeMB: 20,
};

// ------------------------------------------------------------------ 胶囊位置 UI 配置

/** 胶囊/面板位置配置（设置页「胶囊位置」区维护，持久化到 historyRoot/ui.json）。 */
export interface UiPlacementConfig {
  /** 胶囊锚点：右上/左上/右下/左下（默认 top-right = 历史行为）。 */
  placement: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  /** 胶囊水平偏移 px（对 left 或 right 生效）。 */
  offsetX: number;
  /** 胶囊垂直偏移 px（对 top 或 bottom 生效）。 */
  offsetY: number;
  /** 面板相对胶囊下缘的垂直间距 px。 */
  panelOffsetY: number;
}

/** 默认胶囊/面板位置：右上角、右侧对齐（offsetX=0 贴容器右缘）；offsetY=48 让
 *  胶囊默认位于 dsh-mcp-manager 浮窗（默认 top-right、offsetY=8、高约 26px）下方，
 *  保证两胶囊默认互不重叠（issue #116，去避让后以固定默认值错开）。 */
export const DEFAULT_UI_CONFIG: UiPlacementConfig = {
  placement: "top-right",
  offsetX: 0,
  offsetY: 48,
  panelOffsetY: 10,
};

const UI_PLACEMENTS: UiPlacementConfig["placement"][] = ["top-right", "top-left", "bottom-right", "bottom-left"];

/** 校验并归一化客户端提交的 UI 配置（非法值回退默认；offset 限制 0–2000）。 */
export function normalizeUiConfig(raw: unknown): UiPlacementConfig {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const placement = UI_PLACEMENTS.includes(src.placement as UiPlacementConfig["placement"])
    ? (src.placement as UiPlacementConfig["placement"])
    : DEFAULT_UI_CONFIG.placement;
  const clamp = (v: unknown, dflt: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : Number(v);
    return Number.isFinite(n) ? Math.min(2000, Math.max(0, Math.round(n))) : dflt;
  };
  return {
    placement,
    offsetX: clamp(src.offsetX, DEFAULT_UI_CONFIG.offsetX),
    offsetY: clamp(src.offsetY, DEFAULT_UI_CONFIG.offsetY),
    panelOffsetY: clamp(src.panelOffsetY, DEFAULT_UI_CONFIG.panelOffsetY),
  };
}

/** 面板垂直锚点规则：底部锚点（bottom-*）→ 向上弹出；顶部锚点（top-*）→ 向下弹出。 */
export function panelAnchorForPlacement(placement: UiPlacementConfig["placement"] | undefined): "top" | "bottom" {
  return placement === "bottom-right" || placement === "bottom-left" ? "bottom" : "top";
}

/** 面板垂直定位纯函数（供 smoke 断言翻转分支；clamp 到视口内，不溢出）。 */
export function panelTopForAnchor(
  anchor: "top" | "bottom",
  pillTop: number,
  pillBottom: number,
  panelHeight: number,
  gap: number,
): number {
  return anchor === "bottom" ? Math.max(6, pillTop - panelHeight - gap) : Math.max(6, pillBottom + gap);
}

/** UI 配置持久化文件（historyRoot 下，0600）。 */
export function uiConfigFile(root: string): string {
  return join(root, "ui.json");
}

/** 读取 UI 配置（文件缺失/损坏回退默认）。 */
export async function readUiConfig(root: string): Promise<UiPlacementConfig> {
  try {
    const text = await readFile(uiConfigFile(root), "utf8");
    return normalizeUiConfig(JSON.parse(text));
  } catch {
    return { ...DEFAULT_UI_CONFIG };
  }
}

/** 原子写 UI 配置（tmp + rename，0600；根目录缺失时先建）。 */
export async function writeUiConfig(root: string, cfg: UiPlacementConfig): Promise<void> {
  const file = uiConfigFile(root);
  await mkdir(root, { recursive: true });
  const tmp = `${file}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(normalizeUiConfig(cfg)), { mode: 0o600 });
  await rename(tmp, file);
}

/** 序列化一帧 SSE data 行（同 dsh-mcp-manager 的 sseData 语义）。 */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

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
  autoReload: z.boolean().default(true).description("热更新开关（编辑适配器 mjs 后自动重新加载；默认开启，可显式 false 关闭）"),
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
  // fetchTimeoutMs 固定 5s（不开放配置）：远端慢时 2s 频繁超时（#206 配套）
  if (typeof cfg.autoReload === "boolean") base.autoReload = cfg.autoReload;
  // #184：maxAgeDays 仅接受正整数——<=0 会令 maybePrune 下界落在未来（历史被全量清理）、
  // 面板查询区间 start>end 永空；非正整数一律视为非法回落默认值，上界 365 维持既有 clamp
  if (Number.isInteger(cfg.maxAgeDays) && (cfg.maxAgeDays as number) > 0) {
    base.maxAgeDays = Math.min(365, cfg.maxAgeDays as number);
  }
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
    const parsed: unknown = JSON.parse(await readFile(adapterStateFile(root), "utf8"));
    // #184：顶层必须是 plain object——null / 数组 / 字符串等类数组输入一律拒绝，
    // 返回与「无有效状态」一致的空对象（调用方遍历空对象即无任何恢复动作）
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const data = parsed as Record<string, unknown>;
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

  // 1. 注册内置适配器（builtin 先注册、默认启用；user-file 清单后注册覆盖启用者）
  registry.register(openCodeGoAdapter, "builtin");
  // #198：内置 DeepSeek 官方余额适配器（name=deepseek-official-builtin，与用户已装
  // user-file 原型 deepseek-official 可共存，注册顺序覆盖语义见 F 组验收）
  registry.register(deepSeekOfficialAdapter, "builtin");

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

  // 缓存（声明提前：热更新 onReload 回调依赖 cache，须在热更新块前就绪）
  const cache = new Map<string, V2PipelineResult>();

  // #105① /history 面板渲染缓存：key=provider+adapterName+自然日粒度归一化 range，
  // 值为 runV2PanelPipeline 返回值字符串层快照 {panelHtml,error,at}（绝不缓存 entries 中间层）。
  // 主失效 = append 落盘全清；select/add/热更新三挂点同清；PANEL_CACHE_TTL_MS 仅兜底。
  // 声明提前：与 cache 同理，热更新回调须可及。
  const panelCache = new Map<string, PanelCacheEntry>();

  // 胶囊位置 UI 配置（设置页读写；SSE 广播变更）
  const uiConfig = await readUiConfig(historyRoot);
  const sseClients = new Set<ServerResponse>();
  const broadcastUiConfigChanged = (): void => {
    const frame = sseData({ type: "ui-config-changed" });
    for (const res of sseClients) {
      try { res.write(frame); } catch { /* 忽略掉线连接 */ }
    }
  };

  // 3. 热更新（config.adapter 声明 + 设置页登记的文件；autoReload=true 时生效）
  // 运行时经设置页 add 的适配器也纳入监视（issue #206）：ensureHotReload 供启动与
  // add 路由共用，watchedFiles 去重防同一文件重复监视。
  const hotReloaders: HotReloadableAdapter[] = [];
  const watchedFiles = new Set<string>();

  /** 为文件建立热更新监视（幂等：已监视/autoReload 关闭/路径不可解析则跳过）。 */
  async function ensureHotReload(file: string): Promise<void> {
    if (!config.autoReload) return;
    const resolved = resolvePath(file);
    if (resolved === undefined) return; // 文件不可读：add 已校验过，此处仅防御
    if (watchedFiles.has(resolved)) return; // 已监视，幂等跳过
    watchedFiles.add(resolved);
    const hr = new HotReloadableAdapter(resolved, 2000, (info) => {
      const key = `file:${basename(resolved)}`;
      if (!info.ok) {
        registry.recordError(key, "load", `热更新失败：${info.error ?? "未知错误"}`);
        return;
      }
      if (hr.current !== null) {
        // 原子替换：先移除旧文件注册，再注册新版本（改名场景不误报重复）
        registry.removeByFile(resolved);
        registry.register(hr.current, "user-file", resolved);
        cache.clear();
        panelCache.clear(); // #105①：新版适配器代码语义已变，面板渲染缓存同清
        registry.recordError(key, "load", `热更新成功：${hr.current.name}`);
      }
    });
    const started = await hr.start();
    if (!started.ok && started.error !== undefined) {
      registry.recordError(`file:${basename(resolved)}`, "load", `热更新启动失败：${started.error}`);
    }
    hotReloaders.push(hr);
  }

  if (config.autoReload) {
    if (config.adapter !== "") {
      const cfgFile = resolvePath(config.adapter);
      if (cfgFile !== undefined) await ensureHotReload(cfgFile);
    }
    for (const rec of userRecords) {
      const f = resolvePath(rec.file);
      if (f !== undefined) await ensureHotReload(f);
    }
  }

  // 4. 恢复持久化的启用选择（adapter-state.json；null = 显式清空）
  const savedEnabled = await readAdapterState(historyRoot);
  for (const [provider, name] of Object.entries(savedEnabled)) {
    if (name === null) registry.select(provider, null);
    else registry.select(provider, name);
  }

  // 5. 互斥锁（缓存已在上方声明）
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
      // 到这里缓存必为空：cacheFresh 同步删除了过期条目，新鲜条目已在上方返回；
      // 与持锁取数之间无 await 交错，不存在可复用的残留条目（防御性读取已删）。
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

      const providerConfig = await resolveProviderConfig(provider, ctx, {
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
        // #105① 主失效：新数据已落盘，/history 面板渲染缓存整体清除（TTL 仅兜底）。
        // 注意 stats 自身 TTL 命中期间不重跑本路径，故主失效实际由
        // warmup 周期 × stats TTL 复合门控（命中率按复合周期评估）。
        panelCache.clear();
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
      if (entry === undefined) {
        // 无启用适配器：返回结构化 reason（不带占位 HTML），客户端据此展示引导 + 复制按钮
        const code = registry.hasCandidates(prov) ? "no-enabled-adapter" : "no-adapter";
        return writeJson(res, 200, {
          ok: false, plugin: "dsh-provider-usage", version: ADAPTER_CONTRACT_VERSION,
          provider: prov, adapterName: null, panelHtml: null, error: null, reason: code,
          range: { start: 0, end: 0 },
        });
      }
      const days = Number(url.searchParams.get("days"));
      const end = Date.now();
      const start = Number.isFinite(days) && days > 0
        ? end - Math.min(Math.round(days), config.maxAgeDays) * 86400000
        : end - 86400000;
      // #105① 渲染缓存命中检查：key 不含漂移时间戳（自然日粒度归一化），
      // 同一自然日窗口内重复请求直接回放缓存快照，响应 range 仍回显真实 start/end
      const cacheKey = panelCacheKey(prov, entry.name, { start, end });
      const hitEntry = panelCache.get(cacheKey);
      if (hitEntry !== undefined && !isPanelCacheStale(hitEntry, Date.now())) {
        return writeJson(res, 200, {
          ok: hitEntry.error === undefined,
          plugin: "dsh-provider-usage",
          version: ADAPTER_CONTRACT_VERSION,
          provider: prov,
          adapterName: entry.name,
          panelHtml: hitEntry.panelHtml,
          error: hitEntry.error ?? null,
          range: { start, end },
        });
      }
      panelCache.delete(cacheKey); // TTL 过期条目顺手清除（防御性，与 stats cacheFresh 同款）
      const result = await runV2PanelPipeline({
        adapter: entry.adapter,
        provider: prov,
        history,
        range: { start, end },
        timeoutMs: config.fetchTimeoutMs,
      });
      // #105① 只缓存成功结果：错误响应不入缓存（条件消除后下一次立即重算）；
      // 无适配器分支在上方提前返回、同样不入缓存；缓存值仅为返回值字符串层
      if (result.error === undefined) {
        panelCache.set(cacheKey, { panelHtml: result.panelHtml, error: result.error, at: Date.now() });
      }
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
      panelCache.clear(); // #105①：启用关系已变，面板渲染缓存同清（切换/清空后一律重算）
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
      // issue #206：运行时 add 的适配器也纳入热更新监视（autoReload 开启时）
      await ensureHotReload(file);
      cache.clear();
      panelCache.clear(); // #105①：候选/启用面已变，面板渲染缓存同清
      scheduleWriteAdapterState(registry.snapshot().enabled);
      writeJson(res, 200, {
        ok: true,
        adapter: { name: adapter.name, label: adapter.label ?? adapter.name, providers: adapter.providers, file: basename(file) },
        enabled: registry.snapshot().enabled,
      });
    },
  };

  // 7b. 胶囊位置配置（GET 读取 / POST 保存，保存后 SSE 广播即时热更新）
  const uiConfigRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.uiConfig,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method === "GET") {
        writeJson(res, 200, { ok: true, ui: uiConfig });
        return;
      }
      if (req.method !== "POST") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      let body: Record<string, unknown>;
      try {
        const raw = await readJsonBody(req);
        if (typeof raw !== "object" || raw === null) return writeJson(res, 400, { error: "bad-json" });
        body = raw as Record<string, unknown>;
      } catch {
        return writeJson(res, 400, { error: "bad-json" });
      }
      const next = normalizeUiConfig(body);
      Object.assign(uiConfig, next);
      try {
        await writeUiConfig(historyRoot, uiConfig);
      } catch {
        return writeJson(res, 500, { error: "persist-failed" });
      }
      broadcastUiConfigChanged();
      writeJson(res, 200, { ok: true, ui: uiConfig });
    },
  };

  // 7c. SSE 事件通道（客户端 EventSource 订阅；配置变更广播 ui-config-changed，内容不随帧传输）
  const eventsRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.events,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "forbidden: loopback-only" });
        return;
      }
      if (req.method !== "GET") {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      res.on("close", () => {
        sseClients.delete(res);
      });
    },
  };

  const disposeRoutes = ctx.effect(
    () => {
      const routeDisposers = [statsRoute, historyRoute, healthRoute, adaptersRoute, selectRoute, inspectRoute, addRoute, uiConfigRoute, eventsRoute].map((route) =>
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
    // #156：必须串行 await——并发发起时全部 getStats 的同步段（cacheFresh →
    // isLocked → runExclusive）在事件循环同一轮内执行，注册序第一个 provider
    // 拿到全局互斥锁后其余全部 busy 短路，多 provider 场景下永远只有第一个
    // 能采样（夜间无 GUI 轮询时段其余 provider 断采数小时）。串行化后每个
    // provider 依次持锁取数，busy 短路语义仅保留给并发的 /stats 客户端请求。
    const warmupFn = async () => {
      for (const provider of registry.enabledProviders()) {
        try {
          await getStats(provider);
        } catch {
          // 单个 provider 失败不阻断后续 provider 的采样
        }
      }
    };
    warmupTimer = setInterval(warmupFn, config.warmupIntervalMs);
    (warmupTimer as { unref?: () => void }).unref?.();
    // 启动时立即预热一次（所有启用 provider）
    void warmupFn();
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
      for (const res of sseClients) {
        try { res.end(); } catch { /* 忽略 */ }
      }
      sseClients.clear();
      cache.clear();
      panelCache.clear(); // #105①：卸载时面板渲染缓存一并释放
      mutex.cancel();
    },
    "dsh-provider-usage",
  );
}
