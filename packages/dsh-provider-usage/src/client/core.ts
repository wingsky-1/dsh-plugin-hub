/**
 * dsh-provider-usage — 客户端核心层（v2 简化版）。
 *
 * 职责：数据拉取 + provider 检测。
 * 渲染由宿主端 formatCapsule/formatPanel 返回的 HTML 完成，客户端不再维护渲染器注册表。
 */
import { ADAPTER_CONTRACT_VERSION } from "../contracts.ts";
import { DEFAULT_Z_INDEX_BASE } from "../placement-math.ts";

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

/** 客户端 fetch 默认超时毫秒（#268；与 dsh-mcp-manager api() 的 #111 先例对齐取 10s）。 */
export const CLIENT_FETCH_TIMEOUT_MS = 10_000;

/**
 * 客户端 fetch 封装：带默认超时兜底（#268 修复点）。
 *
 * 两层超时的分工（勿混淆）：
 * - 宿主端 fetchData 的 fetchTimeoutMs（固定 5s）：管「服务端 → 远端 provider API」
 *   这一跳，与浏览器无关；
 * - 本超时（10s）：管「浏览器 → dsh web」这一跳——移动端切后台后 TCP 被系统静默
 *   掐断形成半开连接，回前台后在死连接上发起的请求可能挂到 TCP 重传超时（可达
 *   15 分钟），此前该层无任何兜底。此处保证客户端侧有界等待、不悬挂页面。
 *
 * 取 10s 不误杀：正常链路（浏览器 → 宿主 → 远端）最迟约 5s 由宿主端返回或中止，
 * 本兜底仅在「浏览器到 dsh web」传输层死亡时触发；此前取 2s 会先于宿主端 abort
 * 导致取数被误杀，故不可低于宿主端上限。
 *
 * init.signal 存在时不启用超时兜底（调用方信号优先，避免双取消竞争；
 * 与 dsh-mcp-manager api() 的 #111 先例同款语义）。timeoutMs 仅测试注入使用，
 * 生产调用点一律走默认值。
 */
export function fetchTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = CLIENT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  if (init?.signal !== undefined) return fetch(url, init);
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
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
        result?: {
          ok?: boolean;
          value?: { current?: { provider?: string; model?: string } };
          /** RPC 业务错误形态（{ok:false,error:{code,...}}；agent-busy 即此形态或抛错携带 code）。 */
          error?: { code?: string; message?: string } | unknown;
        };
      }>;
    };
  };
}

/** sessions.list 快照中的单行（客户端 store 形态，防御式可选字段）。 */
export interface SessionListRowLike {
  id?: string;
  /** 子代理行标记（spawn/fork 两类子代理均由宿主 store 写入）。 */
  origin?: string;
  /**
   * 父会话 id：客户端 store 归一字段（线上 wire 字段 parentSessionId 由
   * dsh-client-runtime 归一为 parentId）；防御兼容两种命名。
   */
  parentId?: string;
  parentSessionId?: string;
}

/** sessions.list 快照形态（{current, ids, byId}，与宿主 client-runtime 一致）。 */
export interface SessionListSnapshotLike {
  current?: string;
  ids?: string[];
  byId?: Record<string, SessionListRowLike>;
}

export interface SessionsServiceLike {
  currentProvideInfo?: {
    getSnapshot(): SessionMaybeProvide;
    subscribe?(fn: () => void): () => void;
  };
  list?: { getSnapshot?(): SessionListSnapshotLike; subscribe?(fn: () => void): () => void };
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

// ---------------------------------------------------------------- 会话祖先链上溯（issue #69 方案 A）

/** 上溯链深度封顶：链上最多探测的会话数（自身 + 至多 N-1 代祖先），防环与异常长链。 */
export const MAX_ANCESTRY_DEPTH = 3;

/** 行内父 id 读取：优先归一字段 parentId，防御兼容 wire 原名 parentSessionId。 */
function parentSessionIdOf(row: SessionListRowLike | undefined): string | undefined {
  const p = row?.parentId ?? row?.parentSessionId;
  return typeof p === "string" && p.length > 0 ? p : undefined;
}

/**
 * 从 startId 沿 sessions.list 快照 byId 行的 parentId 逐级上溯，产出待探测会话 id 链。
 * 封顶 MAX_ANCESTRY_DEPTH（可调），visited 集合防环；快照缺失/断链即停。
 * 设计原则（#69）：不做「是不是子代理」的正向分类——ordinary 会话无 parentId，链长即为 1。
 */
export function sessionAncestryChain(
  sessions: SessionsServiceLike | undefined,
  startId: string,
  maxDepth: number = MAX_ANCESTRY_DEPTH,
): string[] {
  if (!(maxDepth >= 1)) return [];
  const chain = [startId];
  const seen = new Set<string>([startId]);
  const byId = sessions?.list?.getSnapshot?.()?.byId;
  let cur = startId;
  while (chain.length < maxDepth) {
    const parent = byId === undefined ? undefined : parentSessionIdOf(byId[cur]);
    if (parent === undefined || seen.has(parent)) break; // 断链 / 环 → 停
    chain.push(parent);
    seen.add(parent);
    cur = parent;
  }
  return chain;
}

/** agent-busy 错误识别：抛错携带 code/message，或 RPC 错误分支对象。 */
export function isAgentBusyError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  if ((error as { code?: unknown }).code === "agent-busy") return true;
  const msg = (error as { message?: unknown }).message;
  return typeof msg === "string" && msg.includes("agent-busy");
}

/** agent-busy 诊断日志（排障信号，不影响返回值语义）。 */
function logAgentBusyDiagnosis(sessionId: string): void {
  console.warn(
    `[dsh-provider-usage] 会话 ${sessionId} 为忙着的子代理会话（agent-busy），provider 检测沿父会话上溯`,
  );
}

/**
 * 解析当前展示会话的 provider（issue #69 方案 A+B 的检测半区）：
 * 从当前会话沿 parentId 上溯（封顶深度 3、防环），首个 models() 解析成功者胜；
 * 子代理会话 models() 抛/返 agent-busy 时记一条诊断日志。全链失败返回 undefined，
 * 兜底语义（保持上次检测 / 回落默认）由调用方 decideProviderAfterDetect 决定。
 */
export async function resolveProviderFromSession(
  sessions: SessionsServiceLike | undefined,
  connection: ConnectionHandleLike | undefined,
): Promise<string | undefined> {
  const sessionId = currentSessionId(sessions);
  if (sessionId === undefined) return undefined;
  const models = connection?.api?.sessions?.models;
  if (typeof models !== "function") return undefined;
  for (const sid of sessionAncestryChain(sessions, sessionId)) {
    try {
      const res = await models({ sessionId: sid });
      const result = res?.result;
      const value = result?.value;
      if (result?.ok === true && value && typeof value.current?.provider === "string") {
        return value.current.provider;
      }
      // RPC 业务错误形态（不抛错）：agent-busy 同样记诊断后继续上溯
      if (isAgentBusyError((result as { error?: unknown } | undefined)?.error)) logAgentBusyDiagnosis(sid);
    } catch (error) {
      if (isAgentBusyError(error)) logAgentBusyDiagnosis(sid);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- 检测兜底决策（issue #69 方案 B）

/** 无任何成功检测时的回落 provider（内置默认；仅在「从未检测成功」时使用）。 */
export const FALLBACK_PROVIDER = "opencode-go";

/** 胶囊 title 未识别标注文案。 */
export const UNKNOWN_PROVIDER_HINT = "提供商未识别";

/** detect 一轮结果决策入参。 */
export interface DetectDecisionInput {
  /** 本轮 resolveProviderFromSession 的解析结果（undefined = 全链失败或无会话）。 */
  resolved: string | undefined;
  /** 本轮检测时是否存在当前会话（区分「无会话回落」与「有会话但不可解析」）。 */
  hadSession: boolean;
  /** 历史上最近一次成功检测的 provider（从未成功则为 undefined）。 */
  previousDetected: string | undefined;
}

/** detect 一轮结果决策出参。 */
export interface DetectDecision {
  /** 本轮应生效的 provider。 */
  provider: string;
  /** true = 有会话但 provider 未能确认（胶囊 title 标注「提供商未识别」）。 */
  unknown: boolean;
}

/**
 * 检测结果决策（纯函数，issue #69 方案 B）：
 * - 解析成功 → 采用；
 * - 无任何会话 → 维持原回落行为（回归防护，不算未知态）；
 * - 有会话但全链失败 → 保持上次检测结果并标注未识别；仅当从未成功检测过才回落默认。
 */
export function decideProviderAfterDetect(input: DetectDecisionInput): DetectDecision {
  if (input.resolved !== undefined) return { provider: input.resolved, unknown: false };
  if (!input.hadSession) return { provider: FALLBACK_PROVIDER, unknown: false };
  return { provider: input.previousDetected ?? FALLBACK_PROVIDER, unknown: true };
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
  /** 胶囊层级基准（clamp 1-9000；面板派生基准+30），#128。 */
  zIndexBase: number;
}

/** 默认胶囊位置配置（offsetY=48 为 #116 跨包避让契约：位于 MCP 浮窗正下方，不可回退）。 */
export const DEFAULT_CLIENT_UI_CONFIG: UiPlacementConfig = {
  placement: "top-right",
  offsetX: 0,
  offsetY: 48,
  panelOffsetY: 10,
  zIndexBase: DEFAULT_Z_INDEX_BASE,
};

/** 拉取当前胶囊位置配置（失败回退默认）。 */
export async function fetchUiConfig(): Promise<UiPlacementConfig> {
  try {
    const res = await fetchTimeout(UI_CONFIG_URL, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { ui?: UiPlacementConfig };
    if (body.ui !== undefined) return body.ui;
  } catch { /* 忽略，走默认 */ }
  return { ...DEFAULT_CLIENT_UI_CONFIG };
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