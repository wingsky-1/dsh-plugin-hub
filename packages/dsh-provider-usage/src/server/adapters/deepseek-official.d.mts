/**
 * dsh-provider-usage — 内置 DeepSeek 官方余额适配器类型声明（.mjs 权威实现的声明层）。
 *
 * 说明：内置适配器以 .mjs 为权威实现（供 adapter-guide 引导 agent 参照编写），
 * 本文件手写导出声明，与实现保持同步；经 index.ts re-export 后供 TS 消费。
 */
import type {
  UsageStatsAdapter,
  FetchContext,
  CapsuleInput,
  PanelInput,
} from "../../shared/interface.ts";
import type { AdapterUtils } from "../../shared/interface.ts";

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

/** 前瞻天数：nextPeakTransition 向未来扫描的最大偏移天数（须覆盖全年最长连续谷段）。 */
export declare const PEAK_LOOKAHEAD_DAYS: number;

/** 中国法定节假日表（UTC 日期 key 集合；默认集已冻结，勿变异）。 */
export declare const CHINA_PUBLIC_HOLIDAYS_UTC: ReadonlySet<string>;

/** UTC 日期 key（YYYY-MM-DD）。 */
export declare function utcDateKey(t: number): string;

/** 节假日判定：UTC 日期落在节假日集内即全天谷。 */
export declare function isHolidayUtc(t: number, holidays?: ReadonlySet<string>): boolean;

/** 峰值窗口表（UTC 分钟数，[start,end) 半开区间；仅非节假日的周一至周五生效，周末与中国法定节假日全天谷）。 */
export declare const PEAK_WINDOWS_UTC: Array<readonly [number, number]>;

/** 单时刻峰谷判定（纯函数）。 */
export declare function isPeakUtc(t: number, holidays?: ReadonlySet<string>): boolean;

/** 下一次峰谷转换点（纯函数）。 */
export declare function nextPeakTransition(
  t: number,
  holidays?: ReadonlySet<string>,
): { toPeak: boolean; at: number };

/** 峰谷倒计时徽标 HTML。 */
export declare function peakBadgeHtml(nowTs: number, holidays?: ReadonlySet<string>): string;

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
): {
  type: "unavailable" | "gap" | "disturbed" | "clean";
  drop: number;
  topup: number;
  grantDelta: number;
};

/** 单日柱悬浮文案纯函数（从 dailyBarsSvg 拆出）。运行时导出，声明面补齐以保持 lib re-export 完整。 */
export declare function dailyBarTitle(r: DayRecord, i: number, total: number): string;

/**
 * 每日用量聚合（v2.3 区间记账法）。第 4 参 utils 可选：dayKey 优先消费注入实现。
 */
export declare function aggregateDaily(
  pts: SamplePoint[],
  keys: string[],
  truncated?: boolean,
  utils?: AdapterUtils,
): DayRecord[];

/* ---------------------------------------------------------------- #732 抽出的纯面
 * 以下声明对应格式面板与日聚合里拆出的纯函数（解析 / 归一 / 渲染三段），
 * 与 .mjs 权威实现保持同步，供单测直接打纯面。 */

/** 抽出的区间分类累加器形状（day 粒度）。 */
export interface DaySlot {
  sum: number;
  topIn: number;
  grantParts: string[];
  mixed: boolean;
  gapSegs: number;
  unavail: boolean;
}

/** 相邻采样区间的分类结果（classifyIntervalDs 的返回形状）。 */
export interface IntervalClass {
  type: "unavailable" | "gap" | "disturbed" | "clean";
  drop: number;
  topup: number;
  grantDelta: number;
}

/** 只保留 CNY 币种条目；无 CNY 条目返回 undefined。 */
export declare function cnyBalanceInfo(body: unknown): unknown;

/** 各目标日的取样帧数（区分 empty 与 insufficient）。 */
export declare function framesByDayOf(
  pts: SamplePoint[],
  dayKey: (t: number) => string,
  keysSet: Set<string>,
): Map<string, number>;

/** 区间分类 → 累加器（纯函数；原地改写传入槽位）。 */
export declare function applyIntervalToSlot(slot: DaySlot, cls: IntervalClass): DaySlot;

/** 各目标日的区间记账累加。 */
export declare function accumulateIntervals(
  pts: SamplePoint[],
  dayKey: (t: number) => string,
  keysSet: Set<string>,
): Map<string, DaySlot>;

/** 未计入项文案（充值 / 赠款变动 / 中断 / 不可用，顺序即呈现顺序）。 */
export declare function dailyExclusionNotes(slot: DaySlot): string[];

/** 单日记录渲染：无累加槽位时按帧数分 empty / insufficient。 */
export declare function renderDailyRow(
  key: string,
  frames: number,
  slot: DaySlot | undefined,
): DayRecord;

/** 余额走势图时间轴刻度（xOf 取时刻，xOfMid 取区间中点）。 */
export declare function balanceXScale(
  t0: number,
  spanMs: number,
): { of: (t: number) => number; ofMid: (ta: number, tb: number) => number };

/** 充值事件归集（atIdx 表示事件发生在 values[atIdx-1] → values[atIdx] 区间）。 */
export declare function topUpEvents(
  values: SamplePoint[],
  xScale: { ofMid: (ta: number, tb: number) => number },
): Array<{ atIdx: number; amt: number; xMid: number }>;

/** 每点累计下移量 = 该点之前发生的充值合计。 */
export declare function cumulativeShifts(
  values: SamplePoint[],
  events: Array<{ atIdx: number; amt: number; xMid: number }>,
): number[];

/** 校准水位 y 域；无可比水位返回 null。 */
export declare function calibratedDomain(
  values: SamplePoint[],
  shifts: number[],
): { lo: number; hi: number } | null;

/** 段内下标序列（>300 点时降采样并补回末点）。 */
export declare function segmentIndexes(from: number, to: number): number[];

/** 单条历史条目 → 采样代表点（字段缺失降级为 NaN / null）。 */
export declare function samplePointOf(en: unknown): SamplePoint;

/** 采样序列归一（过滤无效点、剔除未来时间戳、稳定排序）。 */
export declare function samplePointsOf(entries: unknown[], now: number): SamplePoint[];

/** 近 24h 区间记账汇总。 */
export declare function trendLedgerOf(values: SamplePoint[]): {
  spent: number;
  topIn: number;
  skipped: boolean;
  counted: number;
};

/** 近 24h 消费徽标三态（有落账消费 / 无可计区间 / 消费≈0）。 */
export declare function trendBadgeHtml(
  values: SamplePoint[],
  fin: (v: number) => number | null,
  ea: (s: string) => string,
): string;

/** 卡1 副标题断轴提示。 */
export declare function rechargeHintOf(values: SamplePoint[]): string;

/** 面板注入面归一（优先宿主注入，缺失回退文件内兜底副本）。 */
export declare function panelUtils(input: PanelInput): {
  esc: (s: string) => string;
  escAttr: (s: string) => string;
  fin: (v: number) => number | null;
  utils: AdapterUtils;
};

/** 柱形图 y 轴上限取整到 1/2/5×10^k 的好看步长。 */
export declare function niceCeil(v: number): number;

/** 本地时区日期 key（YYYY-MM-DD；与 charts.ts 同源，formatPanel 内优先注入 utils）。 */
export declare function dayKey(t: number): string;

/** 近 n 个自然日 key 列表（含今日；与 charts.ts 同源）。 */
export declare function lastNDayKeys(n: number, now: number): string[];

/** 内置 DeepSeek 官方适配器（v2 契约，行为与原型一致；name 加 -builtin 后缀）。 */
export declare const deepSeekOfficialAdapter: UsageStatsAdapter;

export type { UsageStatsAdapter, FetchContext, CapsuleInput, PanelInput, AdapterUtils };
