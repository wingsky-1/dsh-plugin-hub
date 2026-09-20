/**
 * dsh-provider-usage — 适配器契约（v2）。
 *
 * 版本策略：v1 旧契约已随破坏性变更 #932 删除，本文件仅保留 v2 新契约。
 *
 * 注入面（additive）：FetchContext/PanelInput 新增 optional `utils` 字段——
 * 宿主注入的适配器共享工具（图表/转义/日界等，见 charts.ts）。mjs 鸭子类型下
 * 字段可选，适配器 `const U = input.utils` 后优先消费，缺失时回退文件内私有副本。
 */
import type { AdapterUtils } from "./charts.ts";

// ------------------------------------------------------------------ 契约版本

/** 契约版本（v2；v1 旧契约版本常量已随 #932 删除）。 */
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
  status: "fresh" | "cached" | "stale";
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
  if (s === null || s === undefined) return "";
  const str = typeof s === "string" ? s : String(s);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ------------------------------------------------------------------ 校验

/** 校验 v2 适配器结构。 */
export function isUsageStatsAdapter(v: unknown): v is UsageStatsAdapter {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    a.version === ADAPTER_CONTRACT_VERSION &&
    typeof a.name === "string" &&
    (a.name as string).length >= 2 &&
    /^[A-Za-z0-9_-]{2,64}$/.test(a.name as string) &&
    Array.isArray(a.providers) &&
    a.providers.length > 0 &&
    a.providers.every((p: unknown) => typeof p === "string" && p.length > 0) &&
    typeof a.fetchData === "function" &&
    typeof a.formatCapsule === "function" &&
    typeof a.formatPanel === "function"
  );
}

/** v2 适配器形状问题明细（通过校验返回 null）。 */
export function describeUsageStatsAdapterShape(v: unknown): string | null {
  if (typeof v !== "object" || v === null)
    return `导出不是对象（${v === null ? "null" : typeof v}）`;
  const a = v as Record<string, unknown>;
  const missing: string[] = [];
  if (a.version !== ADAPTER_CONTRACT_VERSION)
    missing.push(`version 必须 === ${ADAPTER_CONTRACT_VERSION}（实际 ${String(a.version)}）`);
  if (typeof a.name !== "string" || !/^[A-Za-z0-9_-]{2,64}$/.test(a.name as string))
    missing.push("name（2-64 位字母数字下划线连字符）");
  if (!Array.isArray(a.providers) || a.providers.length === 0)
    missing.push("providers（非空字符串数组）");
  if (typeof a.fetchData !== "function") missing.push("fetchData（函数）");
  if (typeof a.formatCapsule !== "function") missing.push("formatCapsule（函数）");
  if (typeof a.formatPanel !== "function") missing.push("formatPanel（函数）");
  return missing.length > 0 ? missing.join("、") : null;
}

/** 路径安全段：只保留字母数字下划线连字符，防目录穿越。 */
export function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
}
