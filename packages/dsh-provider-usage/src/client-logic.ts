/**
 * dsh-provider-usage — 客户端行为纯函数（胶囊文案 / 状态等级 / 浮窗隐藏 / 渲染器配对）。
 *
 * 定位（issue #28）：把 client/index.ts 中依赖模块级单例的胶囊/隐藏/配对逻辑抽成
 * 可导入纯函数——smoke 经 lib/index.js 做行为级断言（替代对 bundle 的 includes
 * 字符串断言），client bundle 由 esbuild 内联同一份实现，无双源漂移。
 * 本文件不得持有 DOM/模块状态；输入全部经参数注入。
 */
import type {
  ClientProviderRenderer,
  ProviderSummary,
  ProviderUsage,
  SummaryLevel,
  UsageWindow,
} from "./contracts.js";

/** 窗口短名（胶囊兜底用）：rolling→5h、weekly→周、monthly→月，其余截断。 */
export function shortName(w: UsageWindow | string): string {
  const name = typeof w === "string" ? w : w.name ?? w.key;
  if (name === "rolling") return "5h";
  if (name === "weekly") return "周";
  if (name === "monthly") return "月";
  if (typeof w === "string") return w;
  if (name.length > 4) return name.slice(0, 4);
  return name;
}

/** 胶囊推导的输入（全部可选注入，缺省走回落链）。 */
export interface PillInput {
  /** 当前 provider 配对的渲染器（可选 pill 钩子）。 */
  renderer?: Pick<ClientProviderRenderer, "pill"> | null;
  /** 宿主 /stats 内嵌 summary 子树。 */
  summary?: ProviderSummary | null;
  /** 归一化用量数据（summary 缺失时从 windows 兜底推导）。 */
  data?: ProviderUsage | null;
  /** 当前 provider 名（label 全缺时兜底展示）。 */
  provider?: string;
}

/**
 * 胶囊文案：渲染器 pill 钩子 → summary.text → windows 百分比拼接 → `<label> --%`。
 */
export function derivePillLabel(input: PillInput): string {
  const { renderer, summary, data } = input;
  if (renderer && typeof renderer.pill === "function" && summary) {
    const custom = renderer.pill(summary);
    if (custom !== null && custom !== undefined && custom.text) return custom.text;
  }
  if (summary && typeof summary.text === "string" && summary.text !== "") return summary.text;
  if (data && data.ok && Array.isArray(data.windows)) {
    const parts: string[] = [];
    for (const w of data.windows) {
      if (typeof w.percent === "number") parts.push(`${shortName(w)} ${w.percent}%`);
    }
    if (parts.length > 0) return parts.join(" · ");
  }
  const label = summary?.label ?? data?.label ?? input.provider ?? "-";
  return `${shortName(label)} --%`;
}

/** 状态点等级：pill 钩子 → summary.level → off。 */
export function derivePillLevel(input: PillInput): SummaryLevel {
  const { renderer, summary } = input;
  if (renderer && typeof renderer.pill === "function" && summary) {
    const custom = renderer.pill(summary);
    if (custom !== null && custom !== undefined) return custom.level;
  }
  if (summary) return summary.level ?? "off";
  return "off";
}

/** 胶囊 title 文案（含 D11 无启用适配器提示与错误态说明）。 */
export function derivePillTitle(
  input: PillInput & { hasAdapter: boolean },
): string {
  const { summary, data, hasAdapter } = input;
  const label = summary?.label ?? data?.label ?? input.provider ?? "-";
  if (!hasAdapter) return `${label} 用量：无启用适配器`;
  if (summary) {
    const parts: string[] = [];
    if (summary.text) parts.push(summary.text);
    if (summary.hint) parts.push(summary.hint);
    return parts.length > 0 ? `${label} 用量：${parts.join(" · ")}` : `${label} 用量`;
  }
  if (data === null || data === undefined) return `${label} 用量（加载中…）`;
  if (!data.ok) return `${label} 用量获取失败：${data.error ?? "未知错误"}`;
  return `${label} 用量`;
}

/** D11 隐藏语义：无启用适配器 → 浮窗隐藏（保留轮询探测恢复）。 */
export function shouldHideFloat(hasAdapter: boolean): boolean {
  return !hasAdapter;
}

/**
 * 渲染器配对键优先级（R2）：优先 `provider/adapterId` 专用渲染器，回落该 provider
 * 默认渲染器。注册表 get 与注册写入共用本函数生成键序。
 */
export function rendererLookupKeys(provider: string, adapterId?: string): string[] {
  if (adapterId !== undefined && adapterId !== "") return [`${provider}/${adapterId}`, provider];
  return [provider];
}

// ------------------------------------------------------------------ 设置页·提供商全集（issue #38）

/** 提供商全集合并的输入（全部来自 adapters.json 响应 + 宿主已知清单）。 */
export interface ProvidersUnionInput {
  /** provider → 已注册候选列表（adapters.json host[] 按 providers 分组）。 */
  candidatesByProvider: Record<string, Array<{ id: string; label: string; source: string }>>;
  /** 运行时启用映射（provider → adapterId）。 */
  enabled?: Record<string, string>;
  /**
   * 运行时识别到的 provider（adapters.json recognizedProviders：历史采样桶 ∪
   * 启用状态文件键；issue #38 第二路来源——无候选无启用的也留在全集可见）。
   */
  recognized?: string[];
  /** 内置已知清单（宿主 knownProviders；无候选也展示并给引导）。 */
  known: string[];
}

/** 提供商列表项（设置页手风琴一行的数据面）。 */
export interface ProviderListItem {
  provider: string;
  /** 是否有已注册候选（false = 仅出现在已知清单，需展示引导文案）。 */
  hasCandidates: boolean;
  /** 当前启用 adapterId（null = 未启用/已清空）。 */
  enabledId: string | null;
}

/**
 * 提供商全集 = 已注册候选覆盖 ∪ 运行时启用映射 ∪ 运行时识别 ∪ 内置已知清单
 * （issue #38）。排序：内置已知在前（引导位），其余按字典序；逐项带候选存在性
 * 与启用态，面板直接渲染，不再自行拼装。
 */
export function unionProviders(input: ProvidersUnionInput): ProviderListItem[] {
  const providers = new Set<string>();
  for (const p of Object.keys(input.candidatesByProvider)) providers.add(p);
  for (const p of Object.keys(input.enabled ?? {})) providers.add(p);
  for (const p of input.recognized ?? []) providers.add(p);
  for (const p of input.known) providers.add(p);
  const knownSet = new Set(input.known);
  const sorted = [...providers].sort((a, b) => {
    const ka = knownSet.has(a) ? 0 : 1;
    const kb = knownSet.has(b) ? 0 : 1;
    return ka !== kb ? ka - kb : a.localeCompare(b);
  });
  return sorted.map((provider) => ({
    provider,
    hasCandidates: (input.candidatesByProvider[provider]?.length ?? 0) > 0,
    enabledId: input.enabled?.[provider] ?? null,
  }));
}

/** 折叠态徽标文案（issue #38：显示「启用中: <adapter-id>」或「未启用」）。 */
export function providerBadgeText(item: Pick<ProviderListItem, "enabledId">): string {
  return item.enabledId !== null ? `启用中: ${item.enabledId}` : "未启用";
}
