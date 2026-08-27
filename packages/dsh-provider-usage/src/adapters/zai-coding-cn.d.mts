/**
 * dsh-provider-usage — 内置智谱 Coding Plan (CN) 适配器类型声明（.mjs 权威实现的声明层）。
 *
 * 说明：内置适配器以 .mjs 为权威实现；本文件手写导出声明，与实现保持同步。
 */
import type { UsageStatsAdapter, FetchContext, CapsuleInput, PanelInput } from "../contracts.js";

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

/** 内置智谱 Coding Plan (CN) 适配器（v2 契约）。 */
export declare const zaiCodingCnAdapter: UsageStatsAdapter;

export type { UsageStatsAdapter, FetchContext, CapsuleInput, PanelInput };
