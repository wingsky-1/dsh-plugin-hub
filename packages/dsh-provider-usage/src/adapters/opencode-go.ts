/**
 * dsh-provider-usage — 内置 OpenCode Go 适配器（v2 新契约格式）。
 *
 * 新契约：fetchData + formatCapsule + formatPanel（宿主端渲染 HTML）。
 * 行为保持：官方 /v1/usage 接口、三窗口消耗百分比展示。
 */
import type {
  UsageStatsAdapter,
  FetchContext,
  CapsuleInput,
  PanelInput,
} from "../contracts.js";
import { esc } from "../contracts.js";

/** 内置适配器的 provider 名（如 "opencode-go"）。 */
export const OPENCODE_GO_PROVIDER = "opencode-go";

/** 内置适配器 id（设置面板候选名，历史割接目标桶）。 */
export const OPENCODE_GO_ADAPTER_ID = "opencode-go-builtin";

/** 官方用量接口默认地址（OpenCode Go，Anthropic 兼容 key）。 */
export const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1/usage";

/** 三窗口展示名。 */
export const OPENCODE_GO_WINDOWS: Array<{
  key: string;
  name: string;
  short: string;
  limit: number;
  resetPeriodMs: number;
}> = [
  { key: "rolling", name: "5h 滚动", short: "5h", limit: 12, resetPeriodMs: 5 * 3600000 },
  { key: "weekly", name: "每周", short: "周", limit: 30, resetPeriodMs: 7 * 86400000 },
  { key: "monthly", name: "每月", short: "月", limit: 60, resetPeriodMs: 30 * 86400000 },
];

/** 防御式窗口解析：任意输入 → { key, name, percent }。 */
export function pickWindow(w: unknown, key: string, name: string, limit: number): { key: string; name: string; percent: number | null; raw?: string } | null {
  if (typeof w !== "object" || w === null) return null;
  const rec = w as Record<string, unknown>;
  const percent = typeof rec.percent === "number" ? rec.percent : Number(rec.percent);
  return {
    key,
    name,
    percent: Number.isFinite(percent) ? percent : null,
    raw: typeof rec.raw === "string" ? rec.raw : undefined,
  };
}

/** 解析用量响应体（兼容 {usage:{...}} 与直接三键两种形状）。 */
export function parseUsageResponse(
  body: unknown,
): Record<string, { percent: number | null; raw?: string }> | null {
  if (typeof body !== "object" || body === null) return null;
  const rec = body as Record<string, unknown>;
  const usage = rec.usage && typeof rec.usage === "object" ? (rec.usage as Record<string, unknown>) : rec;
  const out: Record<string, { percent: number | null; raw?: string }> = {};
  for (const w of OPENCODE_GO_WINDOWS) {
    const picked = pickWindow(usage[w.key], w.key, w.name, w.limit);
    if (picked !== null) {
      out[w.key] = { percent: picked.percent, raw: picked.raw };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 调用官方用量接口（fetch 可注入，便于单测）。
 * 新契约 fetchData：入参由插件注入 apiEndpoint/staticPath/apiKey。
 */
export async function fetchOpenCodeGoV2(ctx: FetchContext, fetchImpl?: typeof fetch): Promise<Record<string, unknown>> {
  if (typeof ctx.apiKey !== "string" || ctx.apiKey === "") {
    throw new Error("no-api-key");
  }
  const url = (ctx.apiEndpoint || DEFAULT_BASE_URL) + ctx.staticPath;
  const fetcher: typeof fetch = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 2000);
  const onAbort = (): void => controller.abort();
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  const finish = (): void => {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onAbort);
  };
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { Authorization: `Bearer ${ctx.apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch {
    finish();
    throw new Error("network");
  }
  if (res.status === 401 || res.status === 403) {
    finish();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    finish();
    throw new Error(`http-${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    finish();
    throw new Error("bad-json");
  } finally {
    finish();
  }
  const parsed = parseUsageResponse(body);
  if (parsed === null) throw new Error("bad-data");
  // 归一化数据：原始窗口数据，供 format 函数使用
  const data: Record<string, unknown> = {};
  for (const w of OPENCODE_GO_WINDOWS) {
    const v = parsed[w.key];
    data[w.key] = v ?? { percent: null };
  }
  return data;
}

/** 内置 OpenCode Go 适配器（v2 新契约）。 */
export const openCodeGoAdapter: UsageStatsAdapter = {
  version: 2,
  name: OPENCODE_GO_ADAPTER_ID,
  label: "OpenCode Go 官方",
  providers: [OPENCODE_GO_PROVIDER],

  async fetchData(ctx: FetchContext): Promise<Record<string, unknown>> {
    return fetchOpenCodeGoV2(ctx);
  },

  formatCapsule(input: CapsuleInput & { _esc?: typeof esc }): string {
    const e = esc;
    const windows = OPENCODE_GO_WINDOWS.map((w) => {
      const v = (input.data[w.key] as { percent?: number | null } | undefined) ?? { percent: null };
      return { w, v };
    });
    const text =
      windows
        .filter(({ v }) => typeof v.percent === "number")
        .map(({ w, v }) => `${w.short} ${v.percent}%`)
        .join(" · ") || "无数据";
    return `<span style="font-weight:600">${e(text)}</span>`;
  },

  formatPanel(input: PanelInput): string {
    const e = esc;
    const last = input.entries[input.entries.length - 1];
    if (!last) return "<p>暂无历史数据</p>";
    const rows = input.entries
      .slice(-60)
      .map((en) => {
        const time = new Date(en.time).toLocaleString("zh-CN", { hour12: false });
        const vals = OPENCODE_GO_WINDOWS.map((w) => {
          const v = (en.data[w.key] as { percent?: number | null } | undefined) ?? { percent: null };
          return typeof v.percent === "number" ? `${v.percent}%` : "--";
        }).join(" · ");
        return `<tr><td>${e(time)}</td><td>${e(vals)}</td></tr>`;
      })
      .join("");
    return `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr><th style="text-align:left">时间</th><th style="text-align:left">消耗</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  },
};