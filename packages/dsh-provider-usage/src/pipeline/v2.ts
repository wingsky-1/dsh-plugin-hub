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
    return {
      ok: false,
      configured: true,
      reason: 'fetch-failed',
      error: fetched.error,
      fetchedAt,
      provider,
      adapterName: adapter.name,
      status: 'stale',
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

/** v2 面板管道：查询历史 → formatPanel → HTML。 */
export async function runV2PanelPipeline(opts: {
  adapter: UsageStatsAdapter;
  provider: string;
  history: HistoryStore;
  range: { start: number; end: number };
  limit?: number;
  timeoutMs?: number;
}): Promise<{ panelHtml?: string; error?: string; truncated: boolean }> {
  const { adapter, provider, history, range, limit = 5000, timeoutMs = 2000 } = opts;
  const { entries, truncated } = await history.query(provider, adapter.name, range, limit);
  const panelInput = {
    entries,
    range,
    truncated,
    esc,
  };
  const formatted = await safeFormat(() => adapter.formatPanel(panelInput), 'formatPanel', timeoutMs);
  if (formatted.error !== undefined) return { error: formatted.error, truncated };
  return { panelHtml: sanitizeHtml(formatted.html ?? ''), truncated };
}