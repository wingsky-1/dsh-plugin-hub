/**
 * dsh-provider-usage — 适配器契约本（宿主端 + 客户端共享的定义与校验）。
 *
 * 背景：本插件从「OpenCode Go 单 provider 用量悬浮框」演进为「按 provider 名注册
 * 适配器」的通用框架。宿主端适配器负责取数，客户端渲染器负责呈现，二者经契约
 * 版本化桥接（D4）。这是契约的单一事实源：
 * - 宿主端适配器导出 / 用户宿主 .mjs 默认导出 → HostProviderAdapter（R1：候选 + id/label）
 * - 客户端渲染器（内置或用户注入 .js）→ ClientProviderRenderer（R1：adapterId 配对 + pill 钩子）
 * - 归一化数据模型 ProviderUsage（D5：强制最小集 {ok, provider, label, fetchedAt}）
 * - 轻量摘要 ProviderSummary（R1：胶囊按钮内容，单端点 /stats 内嵌子树）
 *
 * 版本策略：契约版本变更走「升主版本 + 保留旧版本兼容层 ≥1 个主版本」；不匹配
 * 只 warn + 跳过，不崩溃、不静默失效。
 */

// ------------------------------------------------------------------ 契约版本

/** 适配器契约整版本号（宿主端适配器 / 客户端渲染器 / 全局桥接共用）。 */
export const ADAPTER_CONTRACT_VERSION = 1;

// ------------------------------------------------------------------ 错误码

/**
 * 跨宿主/客户端共享的错误码枚举。宿主端归一化产出（ProviderUsage.error /
 * ProviderSummary.error），客户端只负责展示 + 引导，不做业务判断。
 */
export const ERROR_CODES = [
  "no-provider", // 会话无 provider / 未识别
  "no-adapter", // provider 有，但无任何适配器候选
  "no-enabled-adapter", // 有候选但无启用
  "no-api-key", // 缺 token
  "unauthorized", // 401/403
  "timeout", // 超时
  "network", // 网络失败
  "bad-data", // 返回结构无法解释
  "bad-json", // 响应体不可解析
  "adapter-load-failed", // 用户适配器加载失败
  "adapter-crash", // 用户适配器运行抛错
  "adapter-timeout", // 用户适配器执行超时（护栏拦截，issue #38）
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
 *
 * 设计约束（R1）：
 * - 编排层**不解读** `data`/`meta`（适配器自定格式）；
 * - `windows` 为通用约定字段，编排层仅做通用汇总（如 summarize 推导），渲染细节归渲染器。
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
  /** 可选：自由形态附加数据（非用量型中转站直接塞原始结构，编排层不解读）。 */
  data?: unknown;
  /** 可选：异常态说明；ok=false 时错误码见 AdapterErrorCode。 */
  error?: string | null;
  /** 可选：扩展元数据（渲染器自有语义）。 */
  meta?: Record<string, unknown>;
}

// ------------------------------------------------------------------ 轻量摘要（胶囊按钮内容）

/** 状态等级（胶囊/状态点颜色）。 */
export type SummaryLevel = "ok" | "warn" | "err" | "off";

/** 采样点列声明（samplePoint 结构化返回值 / 历史桶 columns 用）。 */
export interface SampleColumn {
  key: string;
  name: string;
  limit?: number;
  resetPeriodMs?: number;
}

/**
 * 归一化轻量摘要（R1：胶囊/按钮内容，单端点 /stats 内嵌子树）。
 * 由适配器 `summarize` 产出；缺省服务端从 fetchUsage 结果通用推导。
 */
export interface ProviderSummary {
  /** 是否成功。 */
  ok: boolean;
  provider: string;
  /** 展示名，如 "OpenCode Go"。 */
  label: string;
  /** 按钮文案，如 "5h 2% · 周 1%"。 */
  text: string;
  /** 状态等级（状态点颜色）。 */
  level: SummaryLevel;
  /** 可选工具提示。 */
  hint?: string;
  /** 是否为服务端通用推导（非适配器 summarize 产出）；客户端可据此叠加本地推导。 */
  derived?: boolean;
  /** 当前是否有启用适配器（无则浮窗隐藏）。 */
  hasAdapter: boolean;
  fetchedAt: number;
  error?: string | null;
}

// ------------------------------------------------------------------ 宿主端适配器

/** fetch 兼容签名（fetchImpl 注入点，测试可替换）。 */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** fetchUsage/summarize 的入参上下文。 */
export interface HostFetchContext {
  /** 当前会话解析出的 provider 名。 */
  provider: string;
  /** 当前会话模型 id（可选）。 */
  model?: string;
  /** 当前选中会话 id（可选）。 */
  sessionId?: string;
  /** 该 provider 的 token（宿主进程内存，仅入参，适配器不得回传）。 */
  apiKey?: string;
  /** 该 provider 的 baseUrl（来自配置，可选——适配器可自持默认）。 */
  baseUrl?: string;
  /**
   * 取数超时（毫秒；来自插件配置 timeoutMs，可选——适配器可自持默认）。
   * 修复死配置键（issue #26）：此前 README 承诺可配但契约无通道，内置硬编码。
   */
  timeoutMs?: number;
  /** 插件注入的 fetch（可替换实现便于测试）。 */
  fetch: FetchLike;
  /** 超时/卸载取消信号。 */
  signal?: AbortSignal;
  /** 最近一次归一化详情（summarize 派生用；禁止独立网络 IO）。 */
  usage?: ProviderUsage | null;
}

/** 历史采样点提取（samplePoint 返回值：结构化列声明 + 数值）。 */
export interface SamplePointData {
  /** 列声明（length 必须 === values.length）。 */
  cols: SampleColumn[];
  /** 各列数值（0-100 百分比等）。 */
  values: (number | null)[];
}

/**
 * 宿主端适配器契约（版本化）。用户注入的宿主 .mjs / .js 默认导出（或具名导出）
 * 该形状的对象。
 *
 * R1 变更：加 `id`/`label`（适配器身份，设置面板候选展示）、可选 `summarize`
 * （胶囊轻量内容）、可选 `samplePoint`（历史采样点，结构化列声明）。
 */
export interface HostProviderAdapter {
  /** 契约版本，必须 === ADAPTER_CONTRACT_VERSION。 */
  version: number;
  /** 适配器唯一名（设置面板候选列表展示，如 "opencode-go-builtin"）。 */
  id: string;
  /** 适配器展示名（如 "OpenCode Go 官方"）。 */
  label: string;
  /** 该适配器认领的 provider 名（可多个）。 */
  providers: string[];
  /** 拉取该 provider 的用量/信息，归一化返回。失败抛错或返回 error 态。 */
  fetchUsage(ctx: HostFetchContext): Promise<ProviderUsage>;
  /**
   * 可选：轻量摘要（胶囊按钮文案/状态点）。只从 `ctx.usage` 派生，**禁止独立网络 IO**
   * （保证与详情同口径、无双缓存不一致）。缺省由服务端从 fetchUsage 结果通用推导。
   */
  summarize?(ctx: HostFetchContext): Promise<ProviderSummary>;
  /**
   * 可选：历史采样点提取（结构化列声明）。无 windows 型自定义数据用此声明列与数值；
   * 返回 null 表示不采样。
   */
  samplePoint?(usage: ProviderUsage): SamplePointData | null;
  /** 可选：自定义调解逻辑（重试/限流），缺省走插件默认策略。 */
  retryPolicy?: { maxRetries?: number; backoffMs?: number };
}

// ------------------------------------------------------------------ 客户端渲染器

/**
 * 客户端渲染器契约（版本化）。用户注入的客户端 .js 经全局桥接注册。
 * 渲染器通过 window.__DSH_USAGE__?.registerRenderer(...) 自注册。
 *
 * R1 变更：加可选 `adapterId`（渲染器与启用适配器配对）、可选 `pill` 钩子（胶囊文案）。
 */
export interface ClientProviderRenderer {
  /** 契约版本，必须 === ADAPTER_CONTRACT_VERSION。 */
  version: number;
  /** 认领的 provider 名（可多个）。 */
  providers: string[];
  /** 可选：绑定某适配器（与当前启用 adapterId 匹配）；缺省 = 该 provider 的默认渲染器。 */
  adapterId?: string;
  /**
   * 可选：自定义胶囊按钮文案。返回 null 则走通用推导。summary 为宿主 /stats 内嵌子树。
   */
  pill?(summary: ProviderSummary): { text: string; level: SummaryLevel; hint?: string } | null;
  /** 渲染卡片/面板内容；返回可选卸载函数。 */
  render(ctx: RenderContext): void | (() => void);
}

/** render 的入参上下文。 */
export interface RenderContext {
  /** 当前 provider 名。 */
  provider: string;
  /** 当前启用适配器 id。 */
  adapterId?: string;
  /** 宿主端归一化数据（可能因未配置/失败为 null）。 */
  data?: ProviderUsage | null;
  /** 历史采样（含 columns 列声明，可选）。 */
  history?: { samples?: unknown[][]; columns?: SampleColumn[] };
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

/** 校验宿主端适配器结构（R1：含 id/label）。 */
export function isHostProviderAdapter(v: unknown): v is HostProviderAdapter {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    a.version === ADAPTER_CONTRACT_VERSION &&
    typeof a.id === "string" && (a.id as string).length > 0 &&
    typeof a.label === "string" && (a.label as string).length > 0 &&
    Array.isArray(a.providers) &&
    a.providers.length > 0 &&
    a.providers.every((p) => typeof p === "string" && p.length > 0) &&
    typeof a.fetchUsage === "function"
  );
}

/**
 * 宿主端适配器形状问题明细（issue #38 注入容错：拒收时给出「缺什么」的可排障
 * 诊断，而非只报一个布尔）。通过校验返回 null。
 */
export function describeAdapterShape(v: unknown): string | null {
  if (typeof v !== "object" || v === null) return `导出不是对象（${v === null ? "null" : typeof v}）`;
  const a = v as Record<string, unknown>;
  const missing: string[] = [];
  if (a.version !== ADAPTER_CONTRACT_VERSION) missing.push(`version 必须 === ${ADAPTER_CONTRACT_VERSION}（实际 ${String(a.version)}）`);
  if (typeof a.id !== "string" || (a.id as string).length === 0) missing.push("id（非空字符串）");
  if (typeof a.label !== "string" || (a.label as string).length === 0) missing.push("label（非空字符串）");
  if (!Array.isArray(a.providers) || a.providers.length === 0 || !a.providers.every((p) => typeof p === "string" && p.length > 0)) {
    missing.push("providers（非空字符串数组）");
  }
  if (typeof a.fetchUsage !== "function") missing.push("fetchUsage（函数）");
  return missing.length > 0 ? missing.join("、") : null;
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

// ------------------------------------------------------------------ 归一化辅助

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

// ------------------------------------------------------------------ 工厂（defineUsageAdapter）

/** defineUsageAdapter 的入参（用量型适配器只需写 fetchUsage + windows 声明）。 */
export interface UsageAdapterSpec {
  version?: number;
  /** 适配器唯一名。 */
  id: string;
  /** 适配器展示名。 */
  label: string;
  /** 认领的 provider 名。 */
  providers: string[];
  /**
   * 窗口声明：用于自动派生 summarize 的 text/level 与 samplePoint 的 cols。
   * 值对象不含 percent（percent 来自 fetchUsage 结果）。
   */
  windows: Array<Omit<UsageWindow, "percent">>;
  /** 拉取该 provider 的用量，返回归一化数据（通常含 windows）。 */
  fetchUsage(ctx: HostFetchContext): Promise<ProviderUsage>;
  /** 可选：按 window.key 从 fetchUsage 结果提取 percent 的映射（缺省直接读 usage.windows）。 */
  summarizeText?(windows: UsageWindow[]): string;
  retryPolicy?: HostProviderAdapter["retryPolicy"];
}

/** 从 windows 通用推导胶囊文案（如 "5h 2% · 周 1% · 月 0%"）。 */
export function summarizeTextFromWindows(windows: UsageWindow[] | undefined): string {
  if (!Array.isArray(windows) || windows.length === 0) return "";
  return windows
    .map((w) => `${w.name} ${typeof w.percent === "number" ? `${w.percent}%` : "--"}`)
    .join(" · ");
}

/** 从 windows 通用推导状态等级（最高消耗）。 */
export function levelFromWindows(windows: UsageWindow[] | undefined): SummaryLevel {
  if (!Array.isArray(windows)) return "off";
  let worst: number | null = null;
  for (const w of windows) {
    if (typeof w.percent === "number" && (worst === null || w.percent > worst)) worst = w.percent;
  }
  if (worst === null) return "off";
  if (worst >= 95) return "err";
  if (worst >= 80) return "warn";
  return "ok";
}

/**
 * 用量型适配器工厂：典型适配器只需实现 `fetchUsage`（返回含 windows 的数据）+
 * 声明 `windows`（列/窗口静态元数据），工厂自动派生：
 * - `summarize(ctx)`：从 ctx.usage.windows 通用推导 text/level/hint；
 * - `samplePoint(usage)`：从 usage.windows 提取各列 percent。
 * 想完全自定义格式/文案的适配器直接手写完整 HostProviderAdapter（两通道并存）。
 *
 * @returns 适配器对象（自动带上 version/id/label/providers）。
 */
export function defineUsageAdapter(spec: UsageAdapterSpec): HostProviderAdapter {
  const adapter: HostProviderAdapter = {
    version: spec.version ?? ADAPTER_CONTRACT_VERSION,
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
      typeof w.percent === "number" && Number.isFinite(w.percent) ? w.percent : null,
    );
    // 契约自检（issue #26）：SamplePointData 注释约定 length 必须相等；
    // 声明的 windows 数与实际返回 windows 数不一致时跳过采样，不产出错位桶。
    if (cols.length !== values.length) return null;
    return { cols, values };
  };
  adapter.summarize = async (ctx: HostFetchContext): Promise<ProviderSummary> => {
    const usage = ctx.usage ?? null;
    const windows = usage?.windows;
    const text =
      typeof spec.summarizeText === "function"
        ? spec.summarizeText(windows ?? [])
        : summarizeTextFromWindows(windows);
    return {
      ok: true,
      provider: ctx.provider,
      label: adapter.label,
      text: text !== "" ? text : adapter.label,
      level: levelFromWindows(windows),
      hasAdapter: true,
      fetchedAt: Date.now(),
    };
  };
  return adapter;
}