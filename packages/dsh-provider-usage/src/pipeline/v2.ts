/**
 * dsh-provider-usage — v2 新契约管道（独立文件，不膨胀 collectStats）。
 *
 * 职责：
 * 1. 组装 fetchData 入参（apiEndpoint/staticPath/apiKey/provider/timeoutMs/signal）
 * 2. safeFetchData 执行（2s 超时 + 序列化校验 + 错误隔离）
 * 3. 落盘历史（按天分片 JSONL）
 * 4. safeFormat 执行 formatCapsule（宿主端渲染 HTML）
 * 5. 返回归一化结果（含 status/capsuleHtml）
 *
 * 纪律：所有用户函数调用经 safe* 包装，错误不外抛。
 */
import type { UsageStatsAdapter, FetchContext } from "../contracts.js";
import { esc } from "../contracts.js";
import type { HistoryStore } from "../core/history.js";
import { safeFetchData, safeFormat } from "../core/guards.js";
import { sanitizeHtml } from "../sanitize.js";

/** v2 管道执行结果。 */
export interface V2PipelineResult {
  ok: boolean;
  configured: boolean;
  reason: string | null;
  error: string | null;
  fetchedAt: number;
  provider: string;
  adapterName: string;
  status: 'fresh' | 'cached' | 'stale';
  capsuleHtml?: string;
  /** 拉取到的原始数据（供历史落盘）。 */
  rawData?: Record<string, unknown>;
}

/** v2 管道执行上下文。 */
export interface V2PipelineContext {
  adapter: UsageStatsAdapter;
  provider: string;
  /** 插件解析出的 provider 配置（apiEndpoint + apiKey）。 */
  config: {
    apiEndpoint?: string;
    apiKey?: string;
  };
  /** 用户定义的 API 路径。 */
  staticPath: string;
  timeoutMs: number;
  /** 附加给 fetchData 的上下文（model/sessionId）。 */
  meta?: { model?: string; sessionId?: string };
  /** 注入的 fetch 实现（测试可替换）。 */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * 执行一次 v2 管道：拉取 → 落盘 → 格式化胶囊。
 * 无外部异常抛出（全部约束在返回结构内）。
 */
export async function runV2Pipeline(ctx: V2PipelineContext): Promise<V2PipelineResult> {
  const { adapter, provider } = ctx;
  const fetchedAt = Date.now();

  // 1. 组装 fetchData 入参
  const fetchCtx: FetchContext = {
    apiEndpoint: ctx.config.apiEndpoint ?? '',
    staticPath: ctx.staticPath,
    apiKey: ctx.config.apiKey,
    provider,
    model: ctx.meta?.model,
    sessionId: ctx.meta?.sessionId,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  };

  // 2. safeFetchData（2s 超时 + 序列化 + 错误隔离）
  const fetched = await safeFetchData(async () => {
    const fetcher: typeof fetch = ctx.fetchImpl ?? fetch;
    return adapter.fetchData({ ...fetchCtx, fetch: fetcher } as unknown as FetchContext);
  }, ctx.timeoutMs);

  if (fetched.error !== undefined) {
    // #198 A 组：取数失败仍产出 stale 胶囊（空 data + status:'stale' + error），
    // 让峰谷徽标等纯本地信息在错误帧常驻；不带 rawData → 上层不落盘历史（错误帧绝不以
    // fresh 身份进历史）。formatCapsule 对该输入渲染「无数据」占位且不抛错（safeFormat 隔离）。
    const failCapsInput = {
      time: fetchedAt,
      data: {},
      status: 'stale' as const,
      error: fetched.error,
      esc,
    };
    const failFormatted = await safeFormat(() => adapter.formatCapsule(failCapsInput), 'formatCapsule', ctx.timeoutMs);
    const failCapsuleHtml = failFormatted.html !== undefined ? sanitizeHtml(failFormatted.html) : undefined;
    return {
      ok: false,
      configured: true,
      reason: 'fetch-failed',
      error: fetched.error,
      fetchedAt,
      provider,
      adapterName: adapter.name,
      status: 'stale',
      ...(failCapsuleHtml !== undefined ? { capsuleHtml: failCapsuleHtml } : {}),
    };
  }

  // 3. 落盘历史（按天分片 JSONL；失败不阻断展示，只记日志）
  const data = fetched.data ?? {};
  const capsInput = {
    time: fetchedAt,
    data,
    status: 'fresh' as const,
    esc,
  };

  // 4. safeFormat formatCapsule（宿主端渲染 HTML）+ 净化
  const formatted = await safeFormat(() => adapter.formatCapsule(capsInput), 'formatCapsule', ctx.timeoutMs);
  const capsuleHtml = formatted.html !== undefined ? sanitizeHtml(formatted.html) : undefined;

  return {
    ok: true,
    configured: true,
    reason: null,
    error: null,
    fetchedAt,
    provider,
    adapterName: adapter.name,
    status: 'fresh',
    capsuleHtml,
    rawData: data,
  };
}

/**
 * 从历史缓存路径返回胶囊内容（不重新拉取）。
 * 用于锁忙/降级场景。
 */
export async function capsuleHtmlFromHistory(
  history: HistoryStore,
  provider: string,
  adapterName: string,
  fallbackText: string,
): Promise<string | undefined> {
  const last = await history.last(provider, adapterName);
  if (last === null) return undefined;
  // 无 formatCapsule 时返回简单文本 HTML
  return `<span>${esc(fallbackText)}</span>`;
}

/** v2 面板管道：查询历史（全量）→ formatPanel → HTML。 */
export async function runV2PanelPipeline(opts: {
  adapter: UsageStatsAdapter;
  provider: string;
  history: HistoryStore;
  range: { start: number; end: number };
  timeoutMs?: number;
}): Promise<{ panelHtml?: string; error?: string }> {
  const { adapter, provider, history, range, timeoutMs = 2000 } = opts;
  const { entries } = await history.query(provider, adapter.name, range);
  const panelInput = {
    entries,
    range,
    truncated: false,
    esc,
  };
  const formatted = await safeFormat(() => adapter.formatPanel(panelInput), 'formatPanel', timeoutMs);
  if (formatted.error !== undefined) return { error: formatted.error };
  return { panelHtml: sanitizeHtml(formatted.html ?? '') };
}

// ------------------------------------------------------------------ #105① /history 渲染缓存（纯函数层）

/** 面板渲染缓存兜底 TTL：编译期常量，定界 [60s, 120s]（issue #105 正文①节）。
 *  仅作兜底而非主失效机制——主失效是 append 落盘全清；取区间中值 90s。 */
export const PANEL_CACHE_TTL_MS = 90000;

/** 面板渲染缓存条目：runV2PanelPipeline 返回值字符串层快照。
 *  绝不缓存 entries 中间层（formatPanel 是用户代码，可能变异入参）。 */
export interface PanelCacheEntry {
  panelHtml?: string;
  error?: string;
  at: number;
}

/** 自然日粒度归一化：时间戳折算到当地时区当日零点。
 *  路由的 end=Date.now() 每请求漂移，key 含精确时间戳会令缓存永不命中。 */
export function normalizeRangeDay(range: { start: number; end: number }): { start: number; end: number } {
  const dayFloor = (t: number): number => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  return { start: dayFloor(range.start), end: dayFloor(range.end) };
}

/** 缓存 key = provider + adapterName + 归一化 range。
 *  不同 days 参数归一化到不同自然日窗口 → 不同 key，互不串数据。 */
export function panelCacheKey(
  provider: string,
  adapterName: string,
  range: { start: number; end: number },
): string {
  const n = normalizeRangeDay(range);
  return `${provider}\u0000${adapterName}\u0000${n.start}\u0000${n.end}`;
}

/** TTL 兜底过期判定（严格大于；now/entry.at 分离入参便于单测注入时钟）。 */
export function isPanelCacheStale(
  entry: Pick<PanelCacheEntry, "at">,
  now: number,
  ttlMs: number = PANEL_CACHE_TTL_MS,
): boolean {
  return now - entry.at > ttlMs;
}