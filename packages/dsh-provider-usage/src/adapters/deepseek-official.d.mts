/**
 * dsh-provider-usage — 内置 DeepSeek 官方余额适配器类型声明（.mjs 权威实现的声明层）。
 *
 * 说明：内置适配器以 .mjs 为权威实现（供 adapter-guide 引导 agent 参照编写），
 * 本文件手写导出声明，与实现保持同步；经 index.ts re-export 后供 TS 消费。
 */
import type { UsageStatsAdapter, FetchContext, CapsuleInput, PanelInput } from "../contracts.js";
import type { AdapterUtils } from "../charts.js";

/** 内置适配器认领的 provider 名（与会话模型 provider 精确匹配）。 */
export declare const DEEPSEEK_OFFICIAL_PROVIDER: string;

/** 内置适配器唯一名（有意差异 1：加 -builtin 后缀）。 */
export declare const DEEPSEEK_OFFICIAL_ADAPTER_ID: string;

/** DeepSeek 官方 API 基础地址。 */
export declare const BASE_URL: string;

/** 严格金额解析：仅接受可转为有限数字的字符串，其余返回 null（杜绝 NaN 静默落盘）。 */
export declare function parseAmount(v: unknown): number | null;

/** 构造查询余额接口 URL：官方域名剥掉 OpenAI 兼容的 /v1 前缀。 */
export declare function resolveEndpoint(apiEndpoint: string | undefined): string;

/** 相邻代表点跨度超过该值视为采样中断。 */
export declare const GAP_MS: number;
/** 金额容差（浮点噪声 + 「无消耗」判定）。 */
export declare const TOL: number;
/** 大额负向净变动的异常阈值。 */
export declare const ANOMALY_NEG: number;

/** 峰值窗口表（UTC 分钟数，[start,end) 半开区间；仅周一至周五生效，周末全天谷）。 */
export declare const PEAK_WINDOWS_UTC: Array<readonly [number, number]>;

/** 单时刻峰谷判定（纯函数）。 */
export declare function isPeakUtc(t: number): boolean;

/** 下一次峰谷转换点（纯函数）。 */
export declare function nextPeakTransition(t: number): { toPeak: boolean; at: number };

/** 峰谷倒计时徽标 HTML。 */
export declare function peakBadgeHtml(nowTs: number): string;

/** 拉取余额（v2 fetchData，fetch 可注入）。 */
export declare function fetchDeepSeekOfficialV2(
  ctx: FetchContext & { fetch?: typeof fetch },
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown>>;

/** 胶囊文案：CNY 余额 + 可用性/缓存标记 + 峰谷倒计时徽标。 */
export declare function formatCapsuleWithBadge(
  input: { data: Record<string, unknown>; status: string },
  nowTs: number,
): string;

/** 采样代表点。 */
export interface SamplePoint {
  t: number;
  balance: number;
  toppedUp: number | null;
  granted: number | null;
  available: boolean;
}

/** 单日用量记录（聚合输出，v2.3 区间记账法）。 */
export interface DayRecord {
  key: string;
  status: "empty" | "insufficient" | "gap" | "anomaly" | "unavailable" | "ok";
  /** 落账消耗（元；仅纯消费区间之和）。 */
  u: number;
  extra?: string;
  neg?: boolean;
  note?: string;
  /** 当日出现的充值入账合计（元；扰动区间提取的事件额，未计入 u）。 */
  toppedUpIn?: number;
}

/** 相邻采样区间分类（v2.3 区间记账法的判定核，不做代数相消）。 */
export declare function classifyIntervalDs(
  a: SamplePoint,
  b: SamplePoint,
): { type: "unavailable" | "gap" | "disturbed" | "clean"; drop: number; topup: number; grantDelta: number };

/**
 * 每日用量聚合（v2.3 区间记账法）。第 4 参 utils 可选：dayKey 优先消费注入实现。
 */
export declare function aggregateDaily(
  pts: SamplePoint[],
  keys: string[],
  truncated?: boolean,
  utils?: AdapterUtils,
): DayRecord[];

/** 柱形图 y 轴上限取整到 1/2/5×10^k 的好看步长。 */
export declare function niceCeil(v: number): number;

/** 本地时区日期 key（YYYY-MM-DD；与 charts.ts 同源，formatPanel 内优先注入 utils）。 */
export declare function dayKey(t: number): string;

/** 近 n 个自然日 key 列表（含今日；与 charts.ts 同源）。 */
export declare function lastNDayKeys(n: number, now: number): string[];

/** 内置 DeepSeek 官方适配器（v2 契约，行为与原型一致；name 加 -builtin 后缀）。 */
export declare const deepSeekOfficialAdapter: UsageStatsAdapter;

export type { UsageStatsAdapter, FetchContext, CapsuleInput, PanelInput, AdapterUtils };
