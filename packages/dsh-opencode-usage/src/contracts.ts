/**
 * dsh-opencode-usage — 适配器契约本（宿主端 + 客户端共享的定义与校验）。
 *
 * 背景：本插件从「OpenCode Go 单 provider 用量悬浮框」演进为「按 provider 名
 * 注册适配器」的通用框架。宿主端适配器负责取数，客户端渲染器负责呈现，二者经
 * 契约版本化桥接（D4）。这是契约的单一事实源：
 * - 宿主端适配器导出 / 用户宿主 .mjs 默认导出 → HostProviderAdapter
 * - 客户端渲染器（内置或用户注入 .js）→ ClientProviderRenderer
 * - 归一化数据模型 ProviderUsage（D5：强制最小集 {ok, provider, label, fetchedAt}）
 *
 * 版本策略：契约版本变更走「升主版本 + 保留旧版本兼容层 ≥1 个主版本」；不匹配
 * 只 warn + 跳过，不崩溃、不静默失效。
 */

// ------------------------------------------------------------------ 契约版本

/** 适配器契约整版本号（宿主端适配器 / 客户端渲染器 / 全局桥接共用）。 */
export const ADAPTER_CONTRACT_VERSION = 1;

// ------------------------------------------------------------------ 错误码

/**
 * 跨宿主/客户端共享的错误码枚举。宿主端归一化产出（ProviderUsage.error），
 * 客户端只负责展示 + 引导，不做业务判断。
 */
export const ERROR_CODES = [
  "no-provider", // 会话无 provider / 未识别
  "no-adapter", // provider 有，但无任何适配器
  "no-api-key", // 缺 token
  "unauthorized", // 401/403
  "timeout", // 超时
  "network", // 网络失败
  "bad-data", // 返回结构无法解释
  "bad-json", // 响应体不可解析
  "adapter-load-failed", // 用户适配器加载失败
  "adapter-crash", // 用户适配器运行抛错
] as const;

/** 错误码字符串类型（含 http-<status> 动态形态）。 */
export type AdapterErrorCode = (typeof ERROR_CODES)[number] | `http-${number}`;

// ------------------------------------------------------------------ 归一化数据模型

/**
 * 单个用量窗口（可选）。percent 为 0-100 数值口径，raw 仅作原文展示（权威数据、
 * 零本地计算）。
 */
export interface UsageWindow {
  key: string;
  /** 展示名，如 "5h 滚动" / "每周"。 */
  name: string;
  /** 0-100 百分比；未知/无效为 null。 */
  percent: number | null;
  /** 原文展示，如 "$3.2 / $12"。 */
  raw?: string;
  /** 展示限额（该窗口上限的展示用值，不做业务计算）。 */
  limit?: number;
  /** 下一次重置时刻（ISO）。 */
  resetsAt?: string;
  /** 窗口重置周期（毫秒），渲染器反推历史重置线用。 */
  resetPeriodMs?: number;
}

/**
 * 归一化用量数据（D5 压薄）：任何 provider 适配器都必须能返回的**最小公约数**。
 * 渲染器只在对应字段存在时消费，避免强耦合。
 */
export interface ProviderUsage {
  /** 最小强制字段组（契约校验只强制这些）。 */
  ok: boolean;
  /** 该数据所属 provider 名（与适配器认领名一致）。 */
  provider: string;
  /** 展示名，如 "OpenCode Go"。 */
  label: string;
  /** 拉取时刻（epoch ms）。 */
  fetchedAt: number;

  /** 可选：用量窗口约定（用量型适配器用它；通用渲染器可解读）。 */
  windows?: UsageWindow[];
  /** 可选：自由形态附加数据（非用量型中转站直接塞原始结构）。 */
  data?: unknown;
  /** 可选：异常态说明；ok=false 时错误码见 AdapterErrorCode。 */
  error?: string | null;
  /** 可选：扩展元数据（渲染器自有语义）。 */
  meta?: Record<string, unknown>;
}

// ------------------------------------------------------------------ 宿主端适配器

/** fetch 兼容签名（fetchImpl 注入点，测试可替换）。 */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** fetchUsage 的入参上下文。 */
export interface HostFetchContext {
  /** 当前会话解析出的 provider 名。 */
  provider: string;
  /** 当前会话模型 id（可选）。 */
  model?: string;
  /** 当前选中会话 id（可选；多会话语义见历史分桶设计）。 */
  sessionId?: string;
  /** 该 provider 的 token（宿主进程内存，仅入参，适配器不得回传）。 */
  apiKey?: string;
  /** 该 provider 的 baseUrl（来自配置，可选——适配器可自持默认）。 */
  baseUrl?: string;
  /** 插件注入的 fetch（可替换实现便于测试）。 */
  fetch: FetchLike;
  /** 超时/卸载取消信号。 */
  signal?: AbortSignal;
}

/**
 * 宿主端适配器契约（版本化）。用户注入的宿主 .mjs / .js 默认导出（或具名导出）
 * 该形状的对象。
 */
export interface HostProviderAdapter {
  /** 契约版本，必须 === ADAPTER_CONTRACT_VERSION。 */
  version: number;
  /** 该适配器认领的 provider 名（可多个）。 */
  providers: string[];
  /** 拉取该 provider 的用量/信息，归一化返回。失败抛错或返回 error 态。 */
  fetchUsage(ctx: HostFetchContext): Promise<ProviderUsage>;
  /** 可选：自定义调解逻辑（重试/限流），缺省走插件默认策略。 */
  retryPolicy?: { maxRetries?: number; backoffMs?: number };
}

// ------------------------------------------------------------------ 客户端渲染器

/**
 * 客户端渲染器契约（版本化）。用户注入的客户端 .js 经全局桥接注册。
 * 渲染器通过 window.__DSH_USAGE__?.registerRenderer(...) 自注册。
 */
export interface ClientProviderRenderer {
  /** 契约版本，必须 === ADAPTER_CONTRACT_VERSION。 */
  version: number;
  /** 认领的 provider 名（可多个）。 */
  providers: string[];
  /** 渲染卡片/面板内容；返回可选卸载函数。 */
  render(ctx: RenderContext): void | (() => void);
}

/** render 的入参上下文。 */
export interface RenderContext {
  /** 当前 provider 名。 */
  provider: string;
  /** 宿主端归一化数据（可能因未配置/失败为 null）。 */
  data?: ProviderUsage | null;
  /** 插件提供的挂载容器。 */
  mount: HTMLElement;
  /** 低嵌入可选：客户端连接 API（拿更全的会话/模型信息）；缺省不强制。 */
  api?: unknown;
  /** 插件卸载时的清理钩子（与 render 返回值合并语义）。 */
  dispose?: () => void;
}

// ------------------------------------------------------------------ 全局桥接（客户端）

/** 客户端全局桥接命名空间（插件主动拉取用户 js 后的自注册入口，D4）。 */
export interface DshUsageGlobal {
  /** 当前契版本（加载方校验用）。 */
  version: number;
  /** 渲染器自注册。返回 true 表示注册成功（版本匹配且结构合法）。 */
  registerRenderer(renderer: ClientProviderRenderer): boolean;
  /** 插件/渲染器卸载时调用（可选，通知桥接清理）。 */
  unregisterRenderer?(providers: string[]): void;
}

/** 客户端全局桥接的 window 键名。 */
export const USAGE_GLOBAL_KEY = "__DSH_USAGE__";

// ------------------------------------------------------------------ 校验

/** 校验宿主端适配器结构。 */
export function isHostProviderAdapter(v: unknown): v is HostProviderAdapter {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    a.version === ADAPTER_CONTRACT_VERSION &&
    Array.isArray(a.providers) &&
    a.providers.length > 0 &&
    a.providers.every((p) => typeof p === "string" && p.length > 0) &&
    typeof a.fetchUsage === "function"
  );
}

/** 校验客户端渲染器结构。 */
export function isClientProviderRenderer(v: unknown): v is ClientProviderRenderer {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    a.version === ADAPTER_CONTRACT_VERSION &&
    Array.isArray(a.providers) &&
    a.providers.length > 0 &&
    a.providers.every((p) => typeof p === "string" && p.length > 0) &&
    typeof a.render === "function"
  );
}

/** 归一化错误：产出统一错误态 ProviderUsage。 */
export function usageError(
  provider: string,
  error: string | null,
  label = "未知提供商",
  fetchedAt = Date.now(),
): ProviderUsage {
  return { ok: false, provider, label, fetchedAt, error };
}

/** 归一化成功：包装 provider + label。 */
export function usageOk(
  provider: string,
  label: string,
  fetchedAt: number,
  extra: Partial<ProviderUsage> = {},
): ProviderUsage {
  return { ok: true, provider, label, fetchedAt, ...extra };
}