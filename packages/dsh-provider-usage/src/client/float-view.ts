/**
 * dsh-provider-usage — 悬浮框纯视图推导（#732 客户端面拆解）。
 *
 * 职责边界（刻意收窄）：只放「数据 → 文案/判别」的**纯**函数——
 * 零 DOM 写、零模块态读写、零 fetch。这样 src/client/index.tsx 只剩
 * 「编排」（挂载 / 事件接线 / DOM 落位），判别逻辑可被单测直接覆盖。
 *
 * 纪律：本文件不是插件入口（build-client 只认 src/client/index.tsx），
 * 也**不新增任何包导出面**符号（见 scripts/data/dsh-provider-usage-export-faces.json）。
 */
import type { HistoryResponseV2, StatsResponseV2 } from "./core.ts";
import { t } from "../../../../shared/client/i18n.js";

/** 悬浮框样式类名前缀（胶囊与面板共用一套 dou- 类名）。 */
export const PILL_PREFIX = "dou-";

/** 相对时间文案。 */
export function fmtAge(ts: number | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  const diff = Date.now() - ts;
  if (diff < 60000) return t("justNow");
  if (diff < 3600000) return t("minutesAgo", { n: Math.floor(diff / 60000) });
  if (diff < 86400000) return t("hoursAgo", { n: Math.floor(diff / 3600000) });
  return t("daysAgo", { n: Math.floor(diff / 86400000) });
}

/**
 * stats 上的宿主 reason 降级字段读取器。
 * StatsResponseV2 未声明该字段，但 v2 降级响应（busy / no-enabled-adapter 等）会带它，
 * 故此处单点收口宿主扩展字段的读取形状，避免各调用点各写一次断言。
 */
export function statsReason(stats: StatsResponseV2 | null): string | null | undefined {
  // 无 stats 对象 → null（区别于「有对象但字段缺席」的 undefined，两者下游语义不同）
  if (stats === null) return null;
  return (stats as { reason?: string | null }).reason;
}

/** 状态点等级：fresh/cached → ok；stale → warn；未配置/错误 → err。 */
export function pillDotLevel(stats: StatsResponseV2 | null): "ok" | "warn" | "err" {
  if (stats === null) return "warn"; // 启动加载中：黄点（非错误）
  if (!stats.configured) return "err"; // 确实未配置/无启用适配器
  if (stats.status === "stale") return "warn"; // 降级陈旧（含 busy：取数进行中）
  return "ok";
}

/**
 * 胶囊 title 推导（纯，四态 + 未知标注）：
 * 未配置 → provider 名 + 提示；取数失败 → 具体错误；宿主 busy 降级 → 适配器名 + 忙；
 * 其余 → 适配器名 + 状态 + 相对更新时间。有会话但 provider 未确认时追加显式标注。
 */
export function pillTitle(
  stats: StatsResponseV2,
  provider: string,
  providerUnconfirmed: boolean,
): string {
  let title: string;
  if (!stats.configured) {
    title = `${provider} · ${t("pillNotConfigured")}`;
  } else if (stats.error !== null && stats.error !== undefined) {
    title = t("pillFetchFail", { msg: stats.error });
  } else if (statsReason(stats) === "busy") {
    title = `${stats.adapterName} · ${t("pillBusy")}`;
  } else {
    title = `${stats.adapterName} · ${stats.status === "stale" ? t("pillStale") : stats.status === "cached" ? t("pillCached") : t("pillFresh")} · ${t("pillUpdatedAt", { t: fmtAge(stats.fetchedAt) })}`;
  }
  // 有会话但 provider 未确认 → title 显式标注（不再静默展示可能不对的数据）
  if (providerUnconfirmed) title += ` · ${t("providerUnknown")}`;
  return title;
}

/** error 码 → 文案（适配器/鉴权/网络/数据类失败码；未命中交 default 分支）。 */
function errorCodeMessage(code: string): string | undefined {
  switch (code) {
    case "no-api-key":
      return t("errNoApiKey", { p: "{PROVIDER}" });
    case "unauthorized":
      return t("errUnauthorized");
    case "timeout":
      return t("errTimeout");
    case "network":
      return t("errNetwork");
    case "bad-data":
    case "bad-json":
      return t("errBadData");
    case "adapter-load-failed":
      return t("errAdapterLoadFailed");
    default:
      return undefined;
  }
}

/** reason 降级码 → 文案（error 为 null 但 ok=false 的形态；未命中返回 undefined）。 */
function reasonCodeMessage(code: string): string | undefined {
  switch (code) {
    case "busy":
      return t("errBusy");
    case "no-enabled-adapter":
      return t("errNoEnabledAdapter");
    case "no-adapter":
      return t("errNoAdapter");
    default:
      return undefined;
  }
}

/** 错误码/原因 → 面板提示文案（覆盖 error 码与 reason 降级码 + http-NNN 兜底）。 */
export function errorMessage(code: string | undefined | null): string {
  if (typeof code === "string") {
    const direct = errorCodeMessage(code) ?? reasonCodeMessage(code);
    if (direct !== undefined) return direct;
    if (code.startsWith("http-")) return t("errHttpStatus", { code: code.slice(5) });
  }
  return t("errGeneric", { code: code || t("noDataShort") });
}

/**
 * 「无启用适配器/未配置」判据（纯）：降级 reason 优先，
 * 其次「历史尚未到达且 stats 明确未配置」。
 */
export function isUnconfigured(
  stats: StatsResponseV2 | null,
  history: HistoryResponseV2 | null,
): boolean {
  const histReason = history?.reason ?? null;
  return (
    histReason === "no-enabled-adapter" ||
    histReason === "no-adapter" ||
    (history === null && stats !== null && !stats.configured)
  );
}

/**
 * 面板内容区判别（纯）：优先级 面板内容(panelHtml) > 状态/历史错误 > 加载中
 * （stats 失败但历史有图时仍展示图表——数据可用性优先于错误提示）。
 */
export type PanelBodyKind = "html" | "guide" | "history-error" | "stats-error" | "loading";

/** 内容区判别结果：五分支的取舍（无适配器引导 / 历史错误 / stats 错误 / 加载中）。 */
export function panelBodyKind(
  stats: StatsResponseV2 | null,
  history: HistoryResponseV2 | null,
): PanelBodyKind {
  if (history?.panelHtml) return "html";
  if (isUnconfigured(stats, history)) return "guide";
  if (history?.error) return "history-error";
  if (stats !== null && stats.ok === false) return "stats-error";
  return "loading";
}

/**
 * 面板 foot「更新于」两字段（纯）：未取到 fetchedAt 时两字段都为空串，
 * 取到时 text 给相对时间、title 给本地时刻。
 */
export function panelFootStamp(stats: StatsResponseV2 | null): { text: string; title: string } {
  const at = stats?.fetchedAt;
  if (!at) return { text: "", title: "" };
  return { text: `更新于 ${fmtAge(at)}`, title: new Date(at).toLocaleString("zh-CN") };
}
