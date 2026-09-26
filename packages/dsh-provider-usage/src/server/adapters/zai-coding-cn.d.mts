/**
 * dsh-provider-usage — 内置智谱 Coding Plan (CN) 适配器类型声明（.mjs 权威实现的声明层）。
 *
 * 说明：内置适配器以 .mjs 为权威实现；本文件手写导出声明，与实现保持同步。
 */
import type {
  UsageStatsAdapter,
  FetchContext,
  CapsuleInput,
  PanelInput,
} from "../../shared/interface.ts";

/** 内置适配器认领的 provider 名（DSH 内置预设：智谱 Coding Plan (CN)）。 */
export declare const ZAI_CODING_CN_PROVIDER: string;

/** 内置适配器唯一名。 */
export declare const ZAI_CODING_CN_ADAPTER_ID: string;

/** 智谱 Coding Plan (CN) 用量接口相对路径。 */
export declare const QUOTA_PATH: string;

/**
 * 拉取配额（v2 fetchData）。返回归一化数据：
 * { level, windows: [{ key:"5h"|"week", percent, usage, currentValue, remaining, total,
 *   nextResetTime, unit }], tools? }。
 */
export declare function fetchData(ctx: FetchContext): Promise<Record<string, unknown>>;

/* ---------------------------------------------------------------- #732 抽出的纯面 */

/** 归一化后的窗口记录形状。 */
export interface QuotaWindow {
  key: string;
  percent: number | null;
  usage: number | null;
  currentValue: number | null;
  remaining: number | null;
  total: number | null;
  nextResetTime: number | undefined;
  unit: number | null;
}

/** 归一化后的工具配额记录形状。 */
export interface QuotaTools {
  percent: number | null;
  currentValue: number | null;
  total: number | null;
  usageDetails: unknown;
}

/** 主机判定：取 apiEndpoint 的 origin（支持中转/代理），缺省 / 非法回落默认主机。 */
export declare function quotaHostOf(apiEndpoint: string | undefined): string;

/** limits 数组归一（分 CREDIT_LIMIT / TIME_LIMIT 两类，忽略非对象项）。 */
export declare function normalizeLimits(limits: unknown[]): {
  level: string | undefined;
  windows: QuotaWindow[];
  tools: QuotaTools | undefined;
};

/** 业务层取数：业务码校验 + limits 归一；非法一律返回 null（调用方抛 bad-data）。 */
export declare function normalizeQuotaBody(body: unknown): {
  level: string | undefined;
  windows: QuotaWindow[];
  tools?: QuotaTools;
} | null;

/** 重置时刻外推（按周期向前，不落窗口起点之前；上限 40 步）。 */
export declare function resetMarksOf(
  resetsAt: unknown,
  resetPeriodMs: number,
  t0: number,
  t1: number,
): number[];

/** 窗口键 → 胶囊标签。 */
export declare function windowLabelOf(key: string): string;

/** 窗口百分比胶囊片段（非 number 的窗口不出片段）。 */
export declare function windowCapsuleParts(
  windows: Array<{ key: string; percent: number | null }>,
): string[];

/** 套餐等级首字母大写；非串或空串返回 null。 */
export declare function levelCapsulePart(level: unknown): string | null;

/** 胶囊文案（窗口百分比 + 等级，stale 时附缓存标记）。 */
export declare function capsuleHtml(input: CapsuleInput): string;

/** 内置智谱 Coding Plan (CN) 适配器（v2 契约）。 */
export declare const zaiCodingCnAdapter: UsageStatsAdapter;

export type { UsageStatsAdapter, FetchContext, CapsuleInput, PanelInput };
