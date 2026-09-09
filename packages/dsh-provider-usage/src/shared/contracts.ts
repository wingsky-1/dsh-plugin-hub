/**
 * dsh-provider-usage — 适配器契约（v2 重构版）。
 *
 * 版本策略：v1 旧契约（HostProviderAdapter / ClientProviderRenderer）在本版本中
 * 标记为 deprecated，保留引用兼容。v2 新契约（UsageStatsAdapter）为推荐标准。
 * 下一主要版本删除 v1 类型。
 *
 * #215 注入面（additive）：FetchContext/PanelInput 新增 optional `utils` 字段——
 * 宿主注入的适配器共享工具（图表/转义/日界等，见 charts.ts）。mjs 鸭子类型下
 * 字段可选，适配器 `const U = input.utils` 后优先消费，缺失时回退文件内私有副本。
 */
import type { AdapterUtils } from "./charts.ts";

// ------------------------------------------------------------------ 契约版本

/** 旧契约版本（v1，deprecated）。 */
export const ADAPTER_CONTRACT_VERSION_V1 = 1;
/** 新契约版本（v2）。 */
export const ADAPTER_CONTRACT_VERSION = 2;

// ------------------------------------------------------------------ 错误码

export const ERROR_CODES = [
  "no-provider",
  "no-adapter",
  "no-enabled-adapter",
  "no-api-key",
  "unauthorized",
  "timeout",
  "network",
  "bad-data",
  "bad-json",
  "adapter-load-failed",
  "adapter-crash",
  "adapter-timeout",
] as const;

export type AdapterErrorCode = (typeof ERROR_CODES)[number] | `http-${number}`;

// ==================================================================
// v2 新契约（UsageStatsAdapter）
// ==================================================================

/** fetchData 的入参上下文（由插件注入）。 */
export interface FetchContext {
  /** API 基础地址（来自插件配置或模型配置链）。 */
  apiEndpoint: string;
  /** 用户定义的 API 路径。 */
  staticPath: string;
  /** 密钥（从配置链解析，可能为空）。 */
  apiKey?: string;
  /** 当前调用的 provider 名。 */
  provider: string;
  /** 当前会话模型 id（可选）。 */
  model?: string;
  /** 当前选中会话 id（可选）。 */
  sessionId?: string;
  /** 超时配置（固定 5000ms，不可配置，由宿主端注入）。 */
  timeoutMs: number;
  /** 超时/卸载取消信号。 */
  signal?: AbortSignal;
  /** 宿主注入的适配器共享工具（图表/转义/日界等；mjs 鸭子类型下可选）。 */
  utils?: AdapterUtils;
}

/** formatCapsule 的入参。 */
export interface CapsuleInput {
  /** 数据时间戳。 */
  time: number;
  /** fetchData 返回的原始数据。 */
  data: Record<string, unknown>;
  /** 数据状态：fresh=新取，cached=缓存命中，stale=降级陈旧。 */
  status: 'fresh' | 'cached' | 'stale';
  /** status=stale 时的错误信息。 */
  error?: string;
  /** HTML 转义助手：将字符串中的 & < > " ' 转义为实体。 */
  esc: (s: unknown) => string;
}

/** formatPanel 的入参。 */
export interface PanelInput {
  /** 历史条目列表。 */
  entries: Array<{ time: number; data: Record<string, unknown> }>;
  /** 查询时间范围。 */
  range: { start: number; end: number };
  /** 是否被服务端截断（超出 limit）。 */
  truncated: boolean;
  /** HTML 转义助手。 */
  esc: (s: unknown) => string;
  /** 宿主注入的适配器共享工具（图表/转义/日界等；mjs 鸭子类型下可选）。 */
  utils?: AdapterUtils;
}

/**
 * v2 适配器契约（UsageStatsAdapter）。
 * 用户 mjs 默认导出该形状，同时支持具名导出（version/name/label/providers/...）。
 */
export interface UsageStatsAdapter {
  /** 契约版本，必须 === ADAPTER_CONTRACT_VERSION（2）。 */
  version: number;
  /** 适配器唯一标识（白名单 ^[A-Za-z0-9_-]{2,64}$，用于日志/历史目录名）。 */
  name: string;
  /** 展示名（可选，默认取 name）。 */
  label?: string;
  /** 认领的 provider 列表。 */
  providers: string[];
  /** 可选：数据留存策略。 */
  retention?: { maxAge?: number; maxSize?: number };
  /** 获取原始数据（宿主端执行）。 */
  fetchData(ctx: FetchContext): Promise<Record<string, unknown>>;
  /** 格式化胶囊展示内容（宿主端执行，返回 HTML）。 */
  formatCapsule(input: CapsuleInput): string;
  /** 格式化面板展示内容（宿主端执行，返回 HTML）。 */
  formatPanel(input: PanelInput): string;
}

// ------------------------------------------------------------------ HTML 转义助手

/** 将字符串中的 & < > " ' 转义为 HTML 实体。 */
export function esc(s: unknown): string {
  if (s === null || s === undefined) return '';
  const str = typeof s === 'string' ? s : String(s);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ------------------------------------------------------------------ 校验

/** 校验 v2 适配器结构。 */
export function isUsageStatsAdapter(v: unknown): v is UsageStatsAdapter {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    a.version === ADAPTER_CONTRACT_VERSION &&
    typeof a.name === 'string' && (a.name as string).length >= 2 &&
    /^[A-Za-z0-9_-]{2,64}$/.test(a.name as string) &&
    Array.isArray(a.providers) &&
    a.providers.length > 0 &&
    a.providers.every((p: unknown) => typeof p === 'string' && p.length > 0) &&
    typeof a.fetchData === 'function' &&
    typeof a.formatCapsule === 'function' &&
    typeof a.formatPanel === 'function'
  );
}

/** v2 适配器形状问题明细（通过校验返回 null）。 */
export function describeUsageStatsAdapterShape(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return `导出不是对象（${v === null ? 'null' : typeof v}）`;
  const a = v as Record<string, unknown>;
  const missing: string[] = [];
  if (a.version !== ADAPTER_CONTRACT_VERSION) missing.push(`version 必须 === ${ADAPTER_CONTRACT_VERSION}（实际 ${String(a.version)}）`);
  if (typeof a.name !== 'string' || !/^[A-Za-z0-9_-]{2,64}$/.test(a.name as string)) missing.push('name（2-64 位字母数字下划线连字符）');
  if (!Array.isArray(a.providers) || a.providers.length === 0) missing.push('providers（非空字符串数组）');
  if (typeof a.fetchData !== 'function') missing.push('fetchData（函数）');
  if (typeof a.formatCapsule !== 'function') missing.push('formatCapsule（函数）');
  if (typeof a.formatPanel !== 'function') missing.push('formatPanel（函数）');
  return missing.length > 0 ? missing.join('、') : null;
}

/** 路径安全段：只保留字母数字下划线连字符，防目录穿越。 */
export function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
}

// ==================================================================
// v1 旧契约（deprecated，保留引用兼容）
// ==================================================================

/** @deprecated 使用 v2 UsageStatsAdapter */
export interface UsageWindow {
  key: string;
  name: string;
  percent: number | null;
  raw?: string;
  limit?: number;
  resetsAt?: string;
  resetPeriodMs?: number;
}

/** @deprecated 使用 v2 UsageStatsAdapter */
export interface ProviderUsage {
  ok: boolean;
  provider: string;
  label: string;
  fetchedAt: number;
  windows?: UsageWindow[];
  data?: unknown;
  error?: string | null;
  meta?: Record<string, unknown>;
}

/** @deprecated 使用 v2 formatCapsule 返回的 HTML */
export type SummaryLevel = 'ok' | 'warn' | 'err' | 'off';

/** @deprecated 使用 v2 formatCapsule */
export interface ProviderSummary {
  ok: boolean;
  provider: string;
  label: string;
  text: string;
  level: SummaryLevel;
  hint?: string;
  derived?: boolean;
  hasAdapter: boolean;
  fetchedAt: number;
  error?: string | null;
}

/** @deprecated */
export interface SampleColumn {
  key: string;
  name: string;
  limit?: number;
  resetPeriodMs?: number;
}

/** @deprecated */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** @deprecated 使用 v2 FetchContext */
export interface HostFetchContext {
  provider: string;
  model?: string;
  sessionId?: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch: FetchLike;
  signal?: AbortSignal;
  usage?: ProviderUsage | null;
}

/** @deprecated */
export interface SamplePointData {
  cols: SampleColumn[];
  values: (number | null)[];
}

/** @deprecated 使用 v2 UsageStatsAdapter */
export interface HostProviderAdapter {
  version: number;
  id: string;
  label: string;
  providers: string[];
  fetchUsage(ctx: HostFetchContext): Promise<ProviderUsage>;
  summarize?(ctx: HostFetchContext): Promise<ProviderSummary>;
  samplePoint?(usage: ProviderUsage): SamplePointData | null;
  retryPolicy?: { maxRetries?: number; backoffMs?: number };
  clientFile?: string;
}

/** @deprecated 使用 v2 formatPanel */
export interface ClientProviderRenderer {
  version: number;
  providers: string[];
  adapterId?: string;
  pill?(summary: ProviderSummary): { text: string; level: SummaryLevel; hint?: string } | null;
  render(ctx: RenderContext): void | (() => void);
}

/** @deprecated */
export interface RenderContext {
  provider: string;
  adapterId?: string;
  data?: ProviderUsage | null;
  history?: { samples?: unknown[][]; columns?: SampleColumn[] };
  mount: HTMLElement;
  api?: unknown;
  dispose?: () => void;
}

/** @deprecated */
export interface DshUsageGlobal {
  version: number;
  registerRenderer(renderer: ClientProviderRenderer): boolean;
  unregisterRenderer?(providers: string[]): void;
}

/** @deprecated */
export const USAGE_GLOBAL_KEY = '__DSH_USAGE__';

// ------------------------------------------------------------------ v1 校验（deprecated）

/** @deprecated */
export function isHostProviderAdapter(v: unknown): v is HostProviderAdapter {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    a.version === ADAPTER_CONTRACT_VERSION_V1 &&
    typeof a.id === 'string' && (a.id as string).length > 0 &&
    typeof a.label === 'string' && (a.label as string).length > 0 &&
    Array.isArray(a.providers) &&
    a.providers.length > 0 &&
    a.providers.every((p: unknown) => typeof p === 'string' && p.length > 0) &&
    typeof a.fetchUsage === 'function'
  );
}

/** @deprecated */
export function describeAdapterShape(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return `导出不是对象（${v === null ? 'null' : typeof v}）`;
  const a = v as Record<string, unknown>;
  const missing: string[] = [];
  if (a.version !== ADAPTER_CONTRACT_VERSION_V1) missing.push(`version 必须 === ${ADAPTER_CONTRACT_VERSION_V1}（实际 ${String(a.version)}）`);
  if (typeof a.id !== 'string' || (a.id as string).length === 0) missing.push('id（非空字符串）');
  if (typeof a.label !== 'string' || (a.label as string).length === 0) missing.push('label（非空字符串）');
  if (!Array.isArray(a.providers) || a.providers.length === 0 || !a.providers.every((p: unknown) => typeof p === 'string' && p.length > 0)) {
    missing.push('providers（非空字符串数组）');
  }
  if (typeof a.fetchUsage !== 'function') missing.push('fetchUsage（函数）');
  return missing.length > 0 ? missing.join('、') : null;
}

/** @deprecated */
export function isClientProviderRenderer(v: unknown): v is ClientProviderRenderer {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    a.version === ADAPTER_CONTRACT_VERSION_V1 &&
    Array.isArray(a.providers) &&
    a.providers.length > 0 &&
    a.providers.every((p: unknown) => typeof p === 'string' && p.length > 0) &&
    typeof a.render === 'function'
  );
}

// ------------------------------------------------------------------ v1 辅助（deprecated）

/** @deprecated */
export function usageError(
  provider: string,
  error: string | null,
  label = '未知提供商',
  fetchedAt = Date.now(),
): ProviderUsage {
  return { ok: false, provider, label, fetchedAt, error };
}

/** @deprecated */
export function usageOk(
  provider: string,
  label: string,
  fetchedAt: number,
  extra: Partial<ProviderUsage> = {},
): ProviderUsage {
  return { ok: true, provider, label, fetchedAt, ...extra };
}

/** @deprecated */
export function summarizeTextFromWindows(windows: UsageWindow[] | undefined): string {
  if (!Array.isArray(windows) || windows.length === 0) return '';
  return windows
    .map((w) => `${w.name} ${typeof w.percent === 'number' ? `${w.percent}%` : '--'}`)
    .join(' · ');
}

/** @deprecated */
export function levelFromWindows(windows: UsageWindow[] | undefined): SummaryLevel {
  if (!Array.isArray(windows)) return 'off';
  let worst: number | null = null;
  for (const w of windows) {
    if (typeof w.percent === 'number' && (worst === null || w.percent > worst)) worst = w.percent;
  }
  if (worst === null) return 'off';
  if (worst >= 95) return 'err';
  if (worst >= 80) return 'warn';
  return 'ok';
}

/** @deprecated */
export interface UsageAdapterSpec {
  version?: number;
  id: string;
  label: string;
  providers: string[];
  windows: Array<Omit<UsageWindow, 'percent'>>;
  fetchUsage(ctx: HostFetchContext): Promise<ProviderUsage>;
  summarizeText?(windows: UsageWindow[]): string;
  retryPolicy?: HostProviderAdapter['retryPolicy'];
}

/** @deprecated 使用 v2 直接实现 UsageStatsAdapter */
export function defineUsageAdapter(spec: UsageAdapterSpec): HostProviderAdapter {
  const adapter: HostProviderAdapter = {
    version: spec.version ?? ADAPTER_CONTRACT_VERSION_V1,
    id: spec.id,
    label: spec.label,
    providers: spec.providers,
    fetchUsage: spec.fetchUsage,
    retryPolicy: spec.retryPolicy,
  };
  adapter.samplePoint = (usage: ProviderUsage): SamplePointData | null => {
    if (!Array.isArray(usage.windows) || usage.windows.length === 0) return null;
    const cols: SampleColumn[] = spec.windows.map((w) => ({
      key: w.key,
      name: w.name,
      ...(w.limit !== undefined ? { limit: w.limit } : {}),
      ...(w.resetPeriodMs !== undefined ? { resetPeriodMs: w.resetPeriodMs } : {}),
    }));
    const values = usage.windows.map((w) =>
      typeof w.percent === 'number' && Number.isFinite(w.percent) ? w.percent : null,
    );
    if (cols.length !== values.length) return null;
    return { cols, values };
  };
  adapter.summarize = async (ctx: HostFetchContext): Promise<ProviderSummary> => {
    const usage = ctx.usage ?? null;
    const windows = usage?.windows;
    const text =
      typeof spec.summarizeText === 'function'
        ? spec.summarizeText(windows ?? [])
        : summarizeTextFromWindows(windows);
    return {
      ok: true,
      provider: ctx.provider,
      label: adapter.label,
      text: text !== '' ? text : adapter.label,
      level: levelFromWindows(windows),
      hasAdapter: true,
      fetchedAt: Date.now(),
    };
  };
  return adapter;
}