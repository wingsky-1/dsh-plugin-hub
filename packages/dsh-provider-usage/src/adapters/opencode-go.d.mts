/**
 * dsh-provider-usage — 内置 OpenCode Go 适配器类型声明（.mjs 权威实现的声明层）。
 *
 * 说明：内置适配器以 .mjs 为权威实现（供 adapter-guide 引导 agent 参照编写），
 * 本文件手写导出声明，与实现保持同步；经 index.ts re-export 后供 TS 消费
 * （lib/index.d.ts 的 `export * from "./adapters/opencode-go.js"` 指向本声明）。
 */
import type { UsageStatsAdapter, FetchContext, CapsuleInput, PanelInput } from "../contracts.js";

/** 内置适配器的 provider 名（如 "opencode-go"）。 */
export declare const OPENCODE_GO_PROVIDER: string;

/** 内置适配器 id（设置面板候选名，历史割接目标桶）。 */
export declare const OPENCODE_GO_ADAPTER_ID: string;

/** 官方用量接口默认地址（OpenCode Go，Anthropic 兼容 key）。 */
export declare const DEFAULT_BASE_URL: string;

/** 三窗口配置（供 fetchData 解析与 format 对齐）。 */
export declare const OPENCODE_GO_WINDOWS: Array<{
  key: string;
  name: string;
  short: string;
  limit: number;
  resetPeriodMs: number;
}>;

/** 防御式窗口解析：任意输入 → 归一化窗口数据（percent 可为 null）。 */
export declare function pickWindow(
  w: unknown,
  key: string,
  name: string,
  limit: number,
): { key: string; name: string; percent: number | null; raw?: string; limit: number; resetsAt?: string } | null;

/** 解析用量响应体（兼容 {usage:{...}} 与直接三键两种形状）。 */
export declare function parseUsageResponse(
  body: unknown,
): Record<string, { key: string; name: string; percent: number | null; raw?: string; limit: number; resetsAt?: string }> | null;

/** 调用官方用量接口（fetch 可注入，便于单测）。 */
export declare function fetchOpenCodeGoV2(
  ctx: FetchContext,
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown>>;

/**
 * miniChartSvgMarkup 兼容导出（#150 测试导入面保留）：等同于注入 utils 的
 * miniAreaSvg（resetsAt 支持 ISO 字符串 / epochMs）。新代码请使用注入的
 * `input.utils.miniAreaSvg`（#215）。
 */
export declare function miniChartSvgMarkup(opts: {
  samples: Array<{ x: number; y: number }>;
  color: string;
  lo: number;
  hi: number;
  resetsAt: string | number | undefined | null;
  resetPeriodMs: number;
  dateOnly: boolean;
}): string;

/** 内置 OpenCode Go 适配器（v2 新契约，展示逻辑与 v1 一致）。 */
export declare const openCodeGoAdapter: UsageStatsAdapter;

export type { UsageStatsAdapter, FetchContext, CapsuleInput, PanelInput };
