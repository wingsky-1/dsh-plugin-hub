/**
 * dsh-provider-usage — 客户端核心层（v2 简化版）。
 *
 * 职责：数据拉取 + provider 检测。
 * 渲染由宿主端 formatCapsule/formatPanel 返回的 HTML 完成，客户端不再维护渲染器注册表。
 */
import { ADAPTER_CONTRACT_VERSION } from "../contracts.js";

/** 宿主端 ROUTES（构建期经 __DSH_ROUTES__ 注入）。 */
declare const __DSH_ROUTES__: Record<string, string> | undefined;
export const STATS_URL = __DSH_ROUTES__?.stats ?? "/api/dsh-provider-usage/stats";
export const HISTORY_URL = __DSH_ROUTES__?.history ?? "/api/dsh-provider-usage/history";
export const HEALTH_URL = __DSH_ROUTES__?.health ?? "/api/dsh-provider-usage/health";
/** @deprecated v1 适配器管理路由（设置面板兼容保留；宿主可能未注册，调用方需容错）。 */
export const ADAPTERS_URL = __DSH_ROUTES__?.adapters ?? "/api/dsh-provider-usage/adapters.json";
/** @deprecated */
export const SELECT_URL = __DSH_ROUTES__?.select ?? "/api/dsh-provider-usage/adapters/select";
/** @deprecated */
export const INSPECT_URL = __DSH_ROUTES__?.inspect ?? "/api/dsh-provider-usage/adapters/inspect";
/** @deprecated */
export const ADD_URL = __DSH_ROUTES__?.add ?? "/api/dsh-provider-usage/adapters/add";
export const UI_CONFIG_URL = __DSH_ROUTES__?.uiConfig ?? "/api/dsh-provider-usage/ui-config";
export const EVENTS_URL = __DSH_ROUTES__?.events ?? "/api/dsh-provider-usage/events";

/** 客户端请求超时。 */
const CLIENT_TIMEOUT_MS = 2000;

/** 带超时的 fetch。 */
export function fetchTimeout(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS) });
}

// ---------------------------------------------------------------- 响应类型

/** /stats 响应形状（v2）。 */
export interface StatsResponseV2 {
  plugin: string;
  version: number;
  provider: string;
  adapterName: string;
  status: 'fresh' | 'cached' | 'stale';
  capsuleHtml?: string;
  ok: boolean;
  configured: boolean;
  error?: string | null;
  fetchedAt: number;
  adapterVersion: number;
}

/** /history 响应形状（v2）。 */
export interface HistoryResponseV2 {
  ok: boolean;
  plugin: string;
  version: number;
  provider: string;
  adapterName: string;
  panelHtml?: string;
  error?: string | null;
  /** 无启用适配器等降级原因（panelHtml 为空时客户端据此展示引导）。 */
  reason?: 'busy' | 'no-enabled-adapter' | 'no-adapter' | null;
  range: { start: number; end: number };
}

// ---------------------------------------------------------------- 会话/提供者检测

export interface SessionMaybeProvide {
  sessionId?: string;
  hooks?: Record<string, unknown>;
  props?: Record<string, unknown>;
}

export interface ConnectionHandleLike {
  api?: {
    sessions?: {
      models?(req: { sessionId: string }): Promise<{
        result?: { ok?: boolean; value?: { current?: { provider?: string; model?: string } } };
      }>;
    };
  };
}

export interface SessionsServiceLike {
  currentProvideInfo?: {
    getSnapshot(): SessionMaybeProvide;
    subscribe?(fn: () => void): () => void;
  };
  list?: { getSnapshot?(): { current?: string }; subscribe?(fn: () => void): () => void };
}

export function currentSessionId(sessions: SessionsServiceLike | undefined): string | undefined {
  if (!sessions) return undefined;
  const info = sessions.currentProvideInfo?.getSnapshot?.();
  if (info && typeof info.sessionId === "string" && info.sessionId.length > 0) return info.sessionId;
  if (typeof sessions.list?.getSnapshot === "function") {
    const cur = sessions.list.getSnapshot()?.current;
    if (typeof cur === "string" && cur.length > 0) return cur;
  }
  return undefined;
}

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

// ---------------------------------------------------------------- 数据拉取（v2）

/** 拉取 /stats（v2 响应）。 */
export async function fetchStats(provider: string): Promise<StatsResponseV2> {
  const res = await fetchTimeout(`${STATS_URL}?provider=${encodeURIComponent(provider)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as StatsResponseV2;
  if (data.version !== ADAPTER_CONTRACT_VERSION) {
    console.warn("[dsh-provider-usage] 版本不匹配（响应 v" + data.version + "，预期 v" + ADAPTER_CONTRACT_VERSION + "）");
  }
  return data;
}

/** 拉取 /history（v2 响应）。 */
export async function fetchHistory(provider: string, days: number): Promise<HistoryResponseV2> {
  const res = await fetchTimeout(`${HISTORY_URL}?provider=${encodeURIComponent(provider)}&days=${days}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as HistoryResponseV2;
}

// ---------------------------------------------------------------- 胶囊位置配置

/** 胶囊/面板位置配置（与宿主端 UiPlacementConfig 同构）。 */
export interface UiPlacementConfig {
  placement: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  offsetX: number;
  offsetY: number;
  panelOffsetY: number;
}

/** 拉取当前胶囊位置配置（失败回退默认）。 */
export async function fetchUiConfig(): Promise<UiPlacementConfig> {
  try {
    const res = await fetchTimeout(UI_CONFIG_URL, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { ui?: UiPlacementConfig };
    if (body.ui !== undefined) return body.ui;
  } catch { /* 忽略，走默认 */ }
  return { placement: "top-right", offsetX: 8, offsetY: 8, panelOffsetY: 44 };
}

/** 保存胶囊位置配置（宿主校验/落盘/广播）。 */
export async function saveUiConfig(cfg: UiPlacementConfig): Promise<void> {
  const res = await fetchTimeout(UI_CONFIG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}