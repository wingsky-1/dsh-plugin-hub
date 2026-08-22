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
