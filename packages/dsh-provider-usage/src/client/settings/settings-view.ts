/**
 * dsh-provider-usage — 设置页纯视图推导（#732 客户端面拆解）。
 *
 * 职责边界（与 float-view.ts 同款）：只放「数据 → 文案/数值」的**纯**函数——
 * 零 React、零 DOM 写、零 fetch。settings/providers.tsx 与 settings/usage.tsx
 * 因此只留「状态 + 事件接线 + DOM 落位」，判别逻辑可被单测直接覆盖。
 *
 * 类型来源：AdaptersMeta/AdapterErrorEntry/StatsView/trend 日面形状由同目录
 * .tsx 各自声明并 export，本模块只以 `import type` 取用（编译期擦除，零运行��耦合）。
 */
import type { AdaptersMeta, AdapterErrorEntry } from "./providers.tsx";
import type { StatsView, TrendDayBucket, TrendDayResponse } from "./usage.tsx";
import { t } from "../../../../../shared/client/i18n.js";
import { trendDelta } from "../trend-math.js";

/** 候选条目形状（inspect 宿主元数据的一行；adapters.json host[] 按 provider 展开后）。 */
export type AdapterCandidate = {
  name: string;
  label: string;
  source: string;
  file?: string | null;
};

/**
 * 候选映射构建（纯）：host[] 按 providers 展开为 provider → 候选列表。
 * file 字段仅在宿主给出时带上（缺省即「无源文件」，不落 null 键）。
 */
export function candidatesByProviderOf(meta: AdaptersMeta | null): Map<string, AdapterCandidate[]> {
  const candidatesByProvider = new Map<string, AdapterCandidate[]>();
  for (const info of meta?.host ?? []) {
    for (const provider of info.providers) {
      const list = candidatesByProvider.get(provider) ?? [];
      list.push({
        name: info.name,
        label: info.label,
        source: info.source,
        ...(info.file !== undefined && info.file !== null ? { file: info.file } : {}),
      });
      candidatesByProvider.set(provider, list);
    }
  }
  return candidatesByProvider;
}

/**
 * 错误索引构建（纯）：key → 错误项。
 * 用户文件加载错误无 provider 归属（key=file:<名>），单独派生出来在列表顶部全局展示一次。
 */
export function errorIndexOf(meta: AdaptersMeta | null): {
  errorByKey: Map<string, AdapterErrorEntry>;
  fileErrors: Array<[string, AdapterErrorEntry]>;
} {
  const errorByKey = new Map<string, AdapterErrorEntry>();
  for (const e of meta?.errors ?? []) errorByKey.set(e.key, e);
  return {
    errorByKey,
    fileErrors: [...errorByKey.entries()].filter(([k]) => k.startsWith("file:")),
  };
}

/** 今日 IO 三分项的派生值（纯）：缺项补 0、就绪判定、合计。 */
export function ioTotalsOf(
  ioDay: {
    input: number | null;
    output: number | null;
    cache: number | null;
  } | null,
): { vals: [number, number, number]; ready: boolean; dayTotal: number } {
  const vals: [number, number, number] = [ioDay?.input ?? 0, ioDay?.output ?? 0, ioDay?.cache ?? 0];
  return {
    vals,
    ready: ioDay !== null && vals.some((v) => v > 0),
    dayTotal: vals[0] + vals[1] + vals[2],
  };
}

/** 窗口环比（纯）：概览未就绪时无环比（null）。 */
export function deltaOf(overview: TrendDayResponse | null): ReturnType<typeof trendDelta> {
  if (overview === null) return null;
  return trendDelta(
    overview.summary.total,
    overview.summary.prevTotal,
    overview.summary.prevComplete,
  );
}

/** 峰值 token 推导（纯）：peakKey 缺失或该桶不在窗口内皆为 null。 */
export function peakValueOf(
  overview: TrendDayResponse | null,
  series: TrendDayBucket[],
): number | null {
  if (overview === null || overview.summary.peakKey === null) return null;
  return series.find((p) => p.key === overview.summary.peakKey)?.total ?? null;
}

/** 头部 provider 占比文案（纯）：窗口总量为 0 或无分项时为 "-"。 */
export function topShareOf(
  sums: Array<{ provider: string; value: number }>,
  windowTotal: number,
): string {
  return windowTotal > 0 && sums.length > 0
    ? `${((sums[0].value / windowTotal) * 100).toFixed(0)}%`
    : "-";
}

/** 状态 → 文案（i18n：渲染期求值）。 */
export function statusLabel(status: string | undefined): string {
  if (status === "fresh") return t("statusFresh");
  if (status === "cached") return t("statusCached");
  if (status === "stale") return t("statusStale");
  return t("statusUnconfigured");
}

/**
 * provider 状态行的元信息文案（纯）：适配器名（与 provider 同名时省略）+ 状态 + 更新时间。
 * 无 stats 快照时只出状态标签，不出适配器名与时间戳。
 */
export function providerStatusMeta(s: StatsView | null | undefined, provider: string): string {
  // 适配器名与 provider 同名时省略，避免「rjkrjk」式连读
  const adapterPart = s?.adapterName && s.adapterName !== provider ? `${s.adapterName} · ` : "";
  return `${adapterPart}${statusLabel(s?.status)}${
    typeof s?.fetchedAt === "number"
      ? ` · ${t("updatedAt", { t: new Date(s.fetchedAt).toLocaleTimeString("zh-CN", { hour12: false }) })}`
      : ""
  }`;
}
