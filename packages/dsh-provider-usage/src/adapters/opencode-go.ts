/**
 * dsh-provider-usage — 内置 OpenCode Go 宿主适配器（M1 迁移 + R1 升级）。
 *
 * 把「loadApiKey + fetchUsage + parseUsageResponse」逻辑迁移为契约化宿主适配器，
 * 经 `defineUsageAdapter` 工厂构造（R1：自动派生 summarize 胶囊文案 +
 * samplePoint 历史采样列），id = "opencode-go-builtin"（设置面板候选展示、历史
 * 割接目标桶）。
 *
 * 行为保持：TTL 缓存、同分钟去重采样、落盘等**编排层**逻辑保留在插件主体
 * （src/index.ts），适配器只做「取一份归一化数据」，不搬编排。
 */
import type {
  FetchLike,
  HostFetchContext,
  HostProviderAdapter,
  ProviderUsage,
  UsageWindow,
} from "../contracts.js";
import { defineUsageAdapter, usageError, usageOk, summarizeTextFromWindows } from "../contracts.js";

/** 内置适配器的 provider 名（如 "opencode-go"）。 */
export const OPENCODE_GO_PROVIDER = "opencode-go";

/** 内置适配器 id（设置面板候选名，历史割接目标桶）。 */
export const OPENCODE_GO_ADAPTER_ID = "opencode-go-builtin";

/** 官方用量接口默认地址（OpenCode Go，Anthropic 兼容 key）。 */
export const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1/usage";

/** 三窗口展示名（客户端渲染器可覆盖，本处为归一化元数据）。 */
export const OPENCODE_GO_WINDOWS: Array<{
  key: string;
  name: string;
  limit: number;
  resetPeriodMs: number;
}> = [
  { key: "rolling", name: "5h 滚动", limit: 12, resetPeriodMs: 5 * 3600000 },
  { key: "weekly", name: "每周", limit: 30, resetPeriodMs: 7 * 86400000 },
  { key: "monthly", name: "每月", limit: 60, resetPeriodMs: 30 * 86400000 },
];

/** 默认启用状态（内置默认启，除非配置显式 enabled:false）。 */
export const OPENCODE_GO_DEFAULT_ENABLED = true;

/** 防御式窗口解析：任意输入 → { key, name, percent, raw?, resetsAt?, limit? }。 */
export function pickWindow(w: unknown, key: string, name: string, limit: number): UsageWindow | null {
  if (typeof w !== "object" || w === null) return null;
  const rec = w as Record<string, unknown>;
  const percent = typeof rec.percent === "number" ? rec.percent : Number(rec.percent);
  return {
    key,
    name,
    percent: Number.isFinite(percent) ? percent : null,
    resetsAt: typeof rec.resetsAt === "string" ? rec.resetsAt : undefined,
    limit,
    raw: typeof rec.raw === "string" ? rec.raw : undefined,
  };
}

/** 解析用量响应体（兼容 {usage:{...}} 与直接三键两种形状）。 */
export function parseUsageResponse(body: unknown): { rolling: UsageWindow | null; weekly: UsageWindow | null; monthly: UsageWindow | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const rec = body as Record<string, unknown>;
  const usage = rec.usage && typeof rec.usage === "object" ? (rec.usage as Record<string, unknown>) : rec;
  const [rolling, weekly, monthly] = OPENCODE_GO_WINDOWS;
  return {
    rolling: pickWindow(usage.rolling, rolling.key, rolling.name, rolling.limit),
    weekly: pickWindow(usage.weekly, weekly.key, weekly.name, weekly.limit),
    monthly: pickWindow(usage.monthly, monthly.key, monthly.name, monthly.limit),
  };
}

/** 请求成功结果。 */
export interface FetchedUsage {
  ok: true;
  windows: UsageWindow[];
}
/** 请求失败结果（error 为错误码）。 */
export interface FetchedFailure {
  ok: false;
  error: string;
}

/**
 * 调用官方用量接口（fetch 可注入，便于单测）。
 * @returns 成功返回 { ok: true, windows }；失败返回 { ok: false, error }。
 */
export async function fetchOpenCodeGo({
  baseUrl,
  apiKey,
  timeoutMs = 15000,
  fetchImpl,
  signal,
}: {
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<FetchedUsage | FetchedFailure> {
  if (typeof apiKey !== "string" || apiKey === "") return { ok: false, error: "no-api-key" };
  const fetcher: FetchLike = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const finish = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
  let res: Response;
  try {
    res = await fetcher(baseUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch {
    finish();
    return { ok: false, error: "network" };
  }
  if (res.status === 401 || res.status === 403) {
    finish();
    return { ok: false, error: "unauthorized" };
  }
  if (!res.ok) {
    finish();
    return { ok: false, error: `http-${res.status}` };
  }
  // 响应体读取仍受同一超时约束（abort 会中断 body 流，慢响应体不再无限挂起）
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "bad-json" };
  } finally {
    finish();
  }
  const parsed = parseUsageResponse(body);
  if (parsed === null) return { ok: false, error: "bad-json" };
  const windows: UsageWindow[] = OPENCODE_GO_WINDOWS.map((w) => parsed[w.key as "rolling" | "weekly" | "monthly"] ?? null).filter(
    (w): w is UsageWindow => w !== null,
  );
  return { ok: true, windows };
}

/** 内置 OpenCode Go 宿主适配器（R1：defineUsageAdapter 工厂 + id/label + 自动 summarize/samplePoint）。 */
export const openCodeGoHostAdapter: HostProviderAdapter = defineUsageAdapter({
  id: OPENCODE_GO_ADAPTER_ID,
  label: "OpenCode Go 官方",
  providers: [OPENCODE_GO_PROVIDER],
  windows: OPENCODE_GO_WINDOWS,
  // 保持旧胶囊文案形态（"5h 3% · 周 1% · 月 0%"），工厂缺省用窗口名，内置重申短名
  summarizeText: (windows) =>
    summarizeTextFromWindows(windows)
      .replace(/5h 滚动/g, "5h")
      .replace(/每周/g, "周")
      .replace(/每月/g, "月"),
  async fetchUsage(ctx: HostFetchContext): Promise<ProviderUsage> {
    const fetched = await fetchOpenCodeGo({
      baseUrl: ctx.baseUrl ?? DEFAULT_BASE_URL,
      apiKey: ctx.apiKey,
      fetchImpl: ctx.fetch,
      signal: ctx.signal,
    });
    const fetchedAt = Date.now();
    if (!fetched.ok) {
      return usageError(OPENCODE_GO_PROVIDER, fetched.error, "OpenCode Go", fetchedAt);
    }
    return usageOk(OPENCODE_GO_PROVIDER, "OpenCode Go", fetchedAt, { windows: fetched.windows });
  },
});