/**
 * dsh-provider-usage — 内置 OpenCode Go 适配器类型声明（.mjs 权威实现的声明层）。
 *
 * 说明：内置适配器以 .mjs 为权威实现（供 adapter-guide 引导 agent 参照编写），
 * 本文件手写导出声明，与实现保持同步；经 index.ts re-export 后供 TS 消费
 * （lib/index.d.ts 的 `export * from "./adapters/opencode-go.js"` 指向本声明）。
 */
import type {
  UsageStatsAdapter,
  FetchContext,
  CapsuleInput,
  PanelInput,
} from "../../shared/interface.ts";

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
): {
  key: string;
  name: string;
  percent: number | null;
  raw?: string;
  limit: number;
  resetsAt?: string;
} | null;

/** 解析用量响应体（兼容 {usage:{...}} 与直接三键两种形状）。 */
export declare function parseUsageResponse(body: unknown): Record<
  string,
  {
    key: string;
    name: string;
    percent: number | null;
    raw?: string;
    limit: number;
    resetsAt?: string;
  }
> | null;

/** 调用官方用量接口（fetch 可注入，便于单测）。 */
export declare function fetchOpenCodeGoV2(
  ctx: FetchContext,
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown>>;

/**
 * miniChartSvgMarkup 兼容导出（测试导入面保留）：等同于注入 utils 的
 * miniAreaSvg（resetsAt 支持 ISO 字符串 / epochMs）。新代码请使用注入的
 * `input.utils.miniAreaSvg`。
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

/* ---------------------------------------------------------------- #732 抽出的纯面 */

/** 图表工具面归一（优先宿主注入 utils，缺失回退文件内兜底副本）。 */
export declare function chartUtils(input: PanelInput): {
  esc: (s: string) => string;
  miniAreaSvg: (opts: Record<string, unknown>) => string;
  niceDomain: (pcts: number[]) => [number, number];
  trendOf: (pcts: Array<number | null>) => { up: boolean; down: boolean; delta: number } | null;
};

/** 归一化数据：窗口数组（供历史落盘与 format 使用）。 */
export declare function normalizeWindows(parsed: Record<string, unknown>): Record<string, unknown>;

/** 有限数值筛出（非 number / 非有限一律不入域）。 */
export declare function finiteValuesOf(pcts: Array<number | null>): number[];

/** 取值域；无输入返回 null（调用方视作 [0,100]）。 */
export declare function valueRangeOf(vals: number[]): { dmin: number; dmax: number } | null;

/** 最小跨度兜底（纯函数）：域过窄时以中点撑开 minSpan 并重新对齐步长网格。 */
export declare function widenToMinSpan(
  lo: number,
  hi: number,
  dmin: number,
  dmax: number,
  minSpan: number,
  step: number,
): [number, number];

/** 上界收敛（纯函数）：贴顶数据必到 100%，域不越界 0–100，零跨度兜底 5 个点。 */
export declare function capDomainAt100(lo: number, hi: number, dmax: number): [number, number];

/** 窗口序列元组 → 具名字段（消除 CHART_SERIES 下标取值重复）。 */
export declare function seriesViewOf(s: readonly unknown[]): {
  key: string;
  name: string;
  short: string;
  color: string;
  limit: number;
  obsMs: number;
  period: number;
};

/** 窗口当前百分比（非 number 视作无数据）。 */
export declare function windowPercentOf(win: unknown): number | null;

/** 窗口重置文案（resetsAt 缺席或空串则不显示）。 */
export declare function resetTextOf(win: unknown): string;

/** 趋势徽标（null 无趋势；up / down / flat 三态）。 */
export declare function trendBadgeHtml(
  trend: { up: boolean; down: boolean; delta: number } | null,
): string;

/** 采样百分比序列（非有限 / 缺面记为 null，保留位置）。 */
export declare function windowPctsOf(
  entries: Array<{ time: number; data: Record<string, unknown> }>,
  key: string,
  obsMs: number,
  tail: number,
): Array<number | null>;

/** 迷你图采样点（只收有限百分比）。 */
export declare function chartPointsOf(
  entries: Array<{ time: number; data: Record<string, unknown> }>,
  key: string,
  obsMs: number,
  tail: number,
): Array<{ x: number; y: number }>;

/** 内置 OpenCode Go 适配器（v2 新契约，展示逻辑与 v1 一致）。 */
export declare const openCodeGoAdapter: UsageStatsAdapter;

export type { UsageStatsAdapter, FetchContext, CapsuleInput, PanelInput };
