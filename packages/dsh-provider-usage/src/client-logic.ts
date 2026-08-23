/**
 * dsh-provider-usage — 客户端行为纯函数（设置页提供商列表拆分，v2 精简版）。
 *
 * 定位（issue #28）：不持有 DOM/模块状态；输入全部经参数注入，
 * smoke 经 lib/index.js 做行为级断言，client bundle 由 esbuild 内联同一实现。
 */

// ------------------------------------------------------------------ 设置页·提供商列表（issue #38 维护者意图修正）

/** 提供商列表拆分的输入（全部来自 adapters.json 响应）。 */
export interface ProviderListInput {
  /** provider → 已注册候选列表（adapters.json host[] 按 providers 分组）。 */
  candidatesByProvider: Record<string, Array<{ name: string; label: string; source: string }>>;
  /** 运行时启用映射（provider → adapterName）。 */
  enabled?: Record<string, string>;
  /** 模型配置页提供商路由（adapters.json modelProviders，主列表权威清单）。 */
  modelProviders?: string[];
}

/** 提供商列表项（设置页手风琴一行的数据面）。 */
export interface ProviderListItem {
  provider: string;
  /** 是否有已注册候选（false = 无候选，展示引导文案）。 */
  hasCandidates: boolean;
  /** 当前启用 adapterName（null = 未启用/已清空）。 */
  enabledId: string | null;
}

function toListItem(input: ProviderListInput, provider: string): ProviderListItem {
  return {
    provider,
    hasCandidates: (input.candidatesByProvider[provider]?.length ?? 0) > 0,
    enabledId: input.enabled?.[provider] ?? null,
  };
}

/**
 * 设置页提供商列表拆分：
 * - main：与模型配置页提供商列表精确一致（= modelProviders，数量与集合对齐、
 *   顺序随宿主；无候选的保留展示并给引导文案）；
 * - extra：候选或启用态指向不在 modelProviders 的 provider（用户适配器自定义
 *   路由），收进尾部独立分组避免静默消失，不计入主列表数量。
 */
export function splitProviderList(input: ProviderListInput): { main: ProviderListItem[]; extra: ProviderListItem[] } {
  const modelSet = new Set(input.modelProviders ?? []);
  const main = (input.modelProviders ?? []).map((p) => toListItem(input, p));
  const extraKeys = new Set<string>();
  for (const p of Object.keys(input.candidatesByProvider)) {
    if (!modelSet.has(p)) extraKeys.add(p);
  }
  for (const p of Object.keys(input.enabled ?? {})) {
    if (!modelSet.has(p)) extraKeys.add(p);
  }
  const extra = [...extraKeys].sort((a, b) => a.localeCompare(b)).map((p) => toListItem(input, p));
  return { main, extra };
}

/** 折叠态徽标文案（适配器级语义：显示「已启用: <adapter-name>」或「未启用适配器」）。 */
export function providerBadgeText(item: Pick<ProviderListItem, "enabledId">): string {
  return item.enabledId !== null ? `已启用: ${item.enabledId}` : "未启用适配器";
}