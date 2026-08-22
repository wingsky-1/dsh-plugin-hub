/**
 * dsh-provider-usage — 客户端核心层（渲染器注册表 + provider 检测 + 数据拉取）。
 *
 * 与宿主端适配器框架对称：宿主按 provider 分派取数，客户端按 provider 分派渲染。
 * - RendererRegistry：内置 opencode-go 渲染器先注册；M2 起用户注入渲染器经
 *   window.__DSH_USAGE__ 桥接自注册（D4 契约版本化）。
 * - provider 检测：ctx.sessions.currentProvideInfo → 当前会话 id →
 *   ctx.connection.api.sessions.models({ sessionId }) → SessionModels.current.provider
 *   （M0 探针①结论：成立，经 session.models RPC 取权威 provider）。
 * - 数据拉取：/stats?provider=X 与 /history[?days=N]（loopback，宿主权威源）。
 */
import type {
  ClientProviderRenderer,
  ProviderUsage,
  ProviderSummary,
  RenderContext,
  DshUsageGlobal,
} from "../contracts.js";
import { USAGE_GLOBAL_KEY, ADAPTER_CONTRACT_VERSION } from "../contracts.js";
import { rendererLookupKeys } from "../client-logic.js";

/** 与 host 端 ROUTES 一致（单一来源，smoke 校验；构建期经 __DSH_ROUTES__ 注入）。 */
declare const __DSH_ROUTES__: Record<string, string> | undefined;
export const STATS_URL = __DSH_ROUTES__?.stats ?? "/api/dsh-provider-usage/stats";
export const HISTORY_URL = __DSH_ROUTES__?.history ?? "/api/dsh-provider-usage/history";
export const ADAPTERS_URL = __DSH_ROUTES__?.adapters ?? "/api/dsh-provider-usage/adapters.json";
export const SELECT_URL = __DSH_ROUTES__?.select ?? "/api/dsh-provider-usage/adapters/select";

/** 会话提供信息（sessions.currentProvideInfo 的读面，宽松类型）。 */
export interface SessionMaybeProvide {
  sessionId?: string;
  hooks?: Record<string, unknown>;
  props?: Record<string, unknown>;
}

/** 客户端连接句柄的宽松读面（仅取用 session.models RPC）。 */
export interface ConnectionHandleLike {
  api?: {
    sessions?: {
      models?(req: { sessionId: string }): Promise<{
        result?: {
          ok?: boolean;
          value?: { current?: { provider?: string; model?: string } };
        };
      }>;
    };
  };
}

/** sessions 服务的宽松读面。 */
export interface SessionsServiceLike {
  currentProvideInfo?: {
    getSnapshot(): SessionMaybeProvide;
    subscribe?(fn: () => void): () => void;
  };
  list?: { getSnapshot?(): { current?: string }; subscribe?(fn: () => void): () => void };
}

// ---------------------------------------------------------------- 渲染器注册表

/**
 * 客户端渲染器注册表（按 provider 分派）。
 * @param opts.diag - 诊断输出（缺省 console.warn）。
 */
export function makeRendererRegistry(opts: { diag?: (msg: string) => void } = {}) {
  const diag = opts.diag ?? ((m: string): void => console.warn("[dsh-provider-usage]", m));
  const byProvider = new Map<string, ClientProviderRenderer>();
  const entries: Array<{ providers: string[]; source: "builtin" | "user-file"; file?: string }> = [];

  /** 注册渲染器；契约校验失败只告警。 */
  function register(renderer: ClientProviderRenderer, source: "builtin" | "user-file", file?: string): void {
    const valid =
      renderer &&
      typeof renderer === "object" &&
      renderer.version === ADAPTER_CONTRACT_VERSION &&
      Array.isArray(renderer.providers) &&
      renderer.providers.length > 0 &&
      renderer.providers.every((p) => typeof p === "string" && p.length > 0) &&
      typeof renderer.render === "function";
    if (!valid) {
      diag(`${file ?? "渲染器"} 契约校验失败（version/providers/render），不注册`);
      return;
    }
    for (const provider of renderer.providers) {
      const key = renderer.adapterId ? `${provider}/${renderer.adapterId}` : provider;
      byProvider.set(key, renderer);
    }
    entries.push({ providers: [...renderer.providers], source, file });
  }

  /** 按 provider 查渲染器（配对键优先级：provider/adapterId 专用 → provider 默认）。 */
  function get(provider: string, adapterId?: string): ClientProviderRenderer | undefined {
    for (const key of rendererLookupKeys(provider, adapterId)) {
      const hit = byProvider.get(key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  /** 撤销某 provider 的渲染器（卸载用户注入时回落内置）。 */
  function unregister(providers: string[], removed: ClientProviderRenderer): void {
    for (const p of providers) {
      if (byProvider.get(p) === removed) byProvider.delete(p);
    }
  }

  /** 快照（设置面板适配器管理区展示用）。 */
  function snapshot(): Array<{ providers: string[]; source: "builtin" | "user-file"; file?: string }> {
    return [...entries];
  }

  return { register, get, unregister, snapshot };
}

export type RendererRegistry = ReturnType<typeof makeRendererRegistry>;

// ---------------------------------------------------------------- 全局桥接（D4）

/**
 * 建立 window.__DSH_USAGE__ 全局桥接（插件主动加载用户 js 的自注册入口）。
 * @param getRegistry - 取当前生效渲染器注册表的句柄函数：热重载重建 apply 后，
 *   新 registry 经此句柄立即生效，旧桥接闭包不再捕获过期注册表。
 */
export function installGlobalBridge(getRegistry: () => RendererRegistry | undefined): { dispose(): void } {
  const win = window as unknown as Record<string, unknown>;
  const existing = win[USAGE_GLOBAL_KEY] as DshUsageGlobal | undefined;
  if (existing !== undefined && typeof existing === "object") {
    // 已有桥接（热重载）：沿用实例；其内部经 getRegistry() 句柄取当前注册表
    return { dispose: () => {} };
  }
  const bridge: DshUsageGlobal = {
    version: ADAPTER_CONTRACT_VERSION,
    registerRenderer(renderer) {
      const valid =
        renderer &&
        typeof renderer === "object" &&
        renderer.version === ADAPTER_CONTRACT_VERSION &&
        Array.isArray(renderer.providers) &&
        renderer.providers.length > 0 &&
        renderer.providers.every((p) => typeof p === "string" && p.length > 0) &&
        typeof renderer.render === "function";
      if (!valid) {
        console.warn("[dsh-provider-usage] 用户渲染器契约校验失败，不注册");
        return false;
      }
      const registry = getRegistry();
      if (registry === undefined) {
        console.warn("[dsh-provider-usage] 插件未就绪或已卸载，用户渲染器暂不注册");
        return false;
      }
      registry.register(renderer, "user-file", "window bridge");
      return true;
    },
    unregisterRenderer(providers) {
      // 宽松处理：仅提示，注册表条目保留（插件卸载时整体清空）
      console.warn("[dsh-provider-usage] unregisterRenderer 收到", providers);
    },
  };
  try {
    win[USAGE_GLOBAL_KEY] = bridge;
  } catch {
    /* 桥接安装失败不阻断（罕见受限环境） */
  }
  return { dispose: () => {} };
}

// ---------------------------------------------------------------- provider 检测（M0 探针①路径）

/** 当前会话 id（来自 sessions.currentProvideInfo；缺服务或无会话返回 undefined）。 */
export function currentSessionId(sessions: SessionsServiceLike | undefined): string | undefined {
  if (!sessions) return undefined;
  const info = sessions.currentProvideInfo?.getSnapshot?.();
  if (info && typeof info.sessionId === "string" && info.sessionId.length > 0) return info.sessionId;
  // 回落：list.current
  if (typeof sessions.list?.getSnapshot === "function") {
    const cur = sessions.list.getSnapshot()?.current;
    if (typeof cur === "string" && cur.length > 0) return cur;
  }
  return undefined;
}

/** 经 session.models RPC 解析当前会话 provider（M0 结论成立路径）。失败返回 undefined。 */
export async function resolveProviderFromSession(
  sessions: SessionsServiceLike | undefined,
  connection: ConnectionHandleLike | undefined,
): Promise<string | undefined> {
  const sessionId = currentSessionId(sessions);
  if (sessionId === undefined) return undefined;
  const models = connection?.api?.sessions?.models;
  if (typeof models !== "function") return undefined;
  try {
    const res = await models({ sessionId });
    const value = res?.result?.value;
    if (res?.result?.ok !== true || !value || typeof value.current?.provider !== "string") return undefined;
    return value.current.provider;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- 数据拉取

/** 拉取某 provider 用量（宿主权威源）。返回归一化数据 + summary 子树 + adapterId/hasAdapter。 */
export async function fetchStats(
  provider: string,
): Promise<{
  usage: ProviderUsage | null;
  summary: ProviderSummary | null;
  adapterId: string | null;
  hasAdapter: boolean;
  cached?: boolean;
}> {
  const res = await fetch(`${STATS_URL}?provider=${encodeURIComponent(provider)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  const usage = (data.usage as ProviderUsage) ?? null;
  const summary = (data.summary as ProviderSummary) ?? null;
  return {
    usage,
    summary,
    adapterId: typeof data.adapterId === "string" ? data.adapterId : null,
    hasAdapter: data.hasAdapter === true,
    cached: data.cached === true,
  };
}

/** 拉取历史采样（v3 多文件，按 (provider, adapterId) 分桶；?provider&adapterId 过滤，days 缺省全量）。 */
export async function fetchHistory(
  provider: string,
  adapterId: string,
  days?: number,
): Promise<{ samples?: number[][]; columns?: import("../contracts.js").SampleColumn[]; provider?: string; adapterId?: string }> {
  const base = `${HISTORY_URL}?provider=${encodeURIComponent(provider)}&adapterId=${encodeURIComponent(adapterId)}`;
  const url = days === undefined ? base : `${base}&days=${days}`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { samples?: number[][]; columns?: import("../contracts.js").SampleColumn[]; provider?: string; adapterId?: string };
}

/** 拉取适配器元数据（M2：用户客户端渲染器清单）。 */
export async function fetchAdapterMeta(): Promise<{
  version?: number;
  client?: Array<{ file?: string | null; url?: string; resolved?: boolean }>;
}> {
  const res = await fetch(ADAPTERS_URL, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) return {};
  return (await res.json()) as { version?: number; client?: Array<{ file?: string | null; url?: string; resolved?: boolean }> };
}

/** 加载并执行用户客户端渲染器 js（自注册到 window.__DSH_USAGE__ 桥接）。
 *  使用 blob import 路径（ESM 语义，模块体执行即自注册）。返回加载成功数。 */
export async function loadUserRenderers(registry: RendererRegistry): Promise<number> {
  const meta = await fetchAdapterMeta();
  if (!Array.isArray(meta.client) || meta.client.length === 0) return 0;
  let loaded = 0;
  for (const entry of meta.client) {
    if (!entry.url) continue;
    try {
      const res = await fetch(entry.url, { headers: { Accept: "application/javascript" }, cache: "no-store" });
      if (!res.ok) {
        console.warn(`[dsh-provider-usage] 用户渲染器 ${entry.url} 加载失败（HTTP ${res.status}）`);
        continue;
      }
      const code = await res.text();
      // 通道 A: blob import（ESM 语义，模块体执行即自注册）
      const blob = new Blob([code], { type: "text/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      try {
        await import(/* @vite-ignore */ blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      loaded += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[dsh-provider-usage] 用户渲染器执行失败 ${entry.file ?? entry.url}: ${msg}`);
    }
  }
  return loaded;
}