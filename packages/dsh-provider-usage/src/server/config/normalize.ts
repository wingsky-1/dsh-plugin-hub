/**
 * dsh-provider-usage — server/config 域：归一化单答案（#768 D1）。
 *
 * 本文件只回答「什么算合法配置」：非法值回退默认、旧单模板自动迁移为三周期表、
 * 未自定义的旧三周期模板平滑升级——运行时读面与写面的唯一归一化入口。
 * 迁移域（server/upgrade/config-morph.ts）只做形态割接，不调用本文件：
 * 迁移跑在装配之前、读的是旧磁盘文本，调运行时归一化等于把读语义搬进迁移域。
 * 目录范围口径与数据层同源：TREND_DIR_MAX 经 server/shared 门面复用（#768 A波3，
 * 由 collect 下沉 shared；零依赖纯常量，与 upgrade 复用 LEGACY 词表同形——
 * 标识符常量在值层存在、类型表达不了它，故走门面复用而非注入；
 * 截断改跳过会造出永远匹配不到任何行的键）。
 */
import { TREND_DIR_MAX } from "../shared/interface.ts";
import type { ReportConfig, ReportPeriod, ReportPeriodConfig, ReportPrompts } from "./shape.ts";
import { DEFAULT_REPORT_CONFIG } from "./shape.ts";
import {
  DEFAULT_PROMPTS,
  LEGACY_DAILY_PROMPT_V1,
  LEGACY_DAILY_PROMPT_V2,
  LEGACY_DAILY_PROMPT_V3,
  LEGACY_DAILY_PROMPT_V4,
  LEGACY_MONTHLY_PROMPT_V1,
  LEGACY_MONTHLY_PROMPT_V2,
  LEGACY_MONTHLY_PROMPT_V3,
  LEGACY_MONTHLY_PROMPT_V4,
  LEGACY_PROMPT_TEMPLATE,
  LEGACY_WEEKLY_PROMPT_V1,
  LEGACY_WEEKLY_PROMPT_V2,
  LEGACY_WEEKLY_PROMPT_V3,
  LEGACY_WEEKLY_PROMPT_V4,
} from "../shared/interface.ts";

/** HH:MM 解析（#768 A波1：canonical 已下沉 server/shared/time.ts，本文件 re-export 门面保留旧址兼容）。 */
export { parseHHMM } from "../shared/interface.ts";
import { parseHHMM } from "../shared/interface.ts";

/**
 * 归一化报告目录范围（与 provider/model 范围字段同构）：
 * - 显式 all（"all" / ["all"]）= 全部目录 → 空数组；
 * - 字符串数组：逐项非空字符串、剥控制字符、basename 化（出口同 C2 脱敏口径）、
 *   超长项跳过（与数据层 isValidDirKey 的 TREND_DIR_MAX 同口径——截断会造出永远
 *   匹配不到任何行的键，过滤面静默变空）、去重、至多 32 项（防配置面滥用）；
 * - 空数组/非数组/含非法项 → 空数组（全部目录，默认语义）。
 */
export function normalizeReportDirectories(raw: unknown): string[] {
  if (raw === "all") return [];
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    // 剥 C0 + DEL + C1，与数据层 sanitizeDirName（collect/types.ts 权威定义）同口径
    const c = item.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    const cut = Math.max(c.lastIndexOf("/"), c.lastIndexOf("\\"));
    const base = cut >= 0 ? c.slice(cut + 1) : c;
    if (base.length === 0 || base === "all") continue;
    if (base.length > TREND_DIR_MAX) continue; // 与数据层同口径：超长键不可能有对应行
    out.add(base);
    if (out.size >= 32) break;
  }
  return [...out];
}

/**
 * 嵌套子源判定（承担类型收窄）：与顶层判定**刻意不同**——历史口径是
 * `typeof x === "object" && x !== null`，数组也算对象源（污染形态的子对象按缺字段
 * 回落默认）。收窄这一支会改写该边缘形态的行为，故两条判定分开钉死。
 */
function isObjectSource(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 子源取用：非对象源（含缺键/null/原始值）一律回落空对象（逐字段走默认）。 */
function objectSource(value: unknown): Record<string, unknown> {
  return isObjectSource(value) ? value : {};
}

/** 可选子源取用：非对象源返回 null（区别于「空对象」——调用方据此走旧格式分支）。 */
function optionalObjectSource(value: unknown): Record<string, unknown> | null {
  return isObjectSource(value) ? value : null;
}

/** HH:MM 文本判定（承担类型收窄：parseHHMM 已拒非字符串，这里把字符串形态一并钉死）。 */
function isHHMMText(value: unknown): value is string {
  return typeof value === "string" && parseHHMM(value) !== null;
}

/** 归一化单周期配置。 */
function normalizePeriod(raw: unknown, dflt: ReportPeriodConfig): ReportPeriodConfig {
  const src = objectSource(raw);
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : dflt.enabled,
    time: isHHMMText(src.time) ? src.time.trim() : dflt.time,
  };
}

/** 有界字符串字段（超长/非字符串回落默认；不截断——截断会造出匹配不到任何行的键）。 */
function boundedString(value: unknown, max: number, dflt: string): string {
  return typeof value === "string" && value.length <= max ? value : dflt;
}

/** 月内触发日合法性（1–28 整数；覆盖上一自然月，故 29–31 不参与）。 */
function isValidDayOfMonth(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 28;
}

/** 单模板归一化（非空字符串且 ≤20000 用之；若严格等于任何旧版默认模板则自动升级新版；否则回退该周期默认）。 */
function normalizePrompt(raw: unknown, dflt: string, legacyTemplates?: readonly string[]): string {
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > 20000) return dflt;
  if (legacyTemplates !== undefined && legacyTemplates.includes(raw)) return dflt;
  return raw;
}

/**
 * 旧单模板 → 三周期迁移：
 * - 旧值 === 旧默认模板（用户从未自定义）→ 升级为三份新默认（拿得到年报体验）；
 * - 旧值为自定义文本 → 三周期均以该文本起始（用户文本不丢，自行按周期微调）。
 */
function migrateLegacyPrompt(legacy: string): ReportPrompts {
  if (
    legacy === LEGACY_PROMPT_TEMPLATE ||
    legacy === LEGACY_MONTHLY_PROMPT_V1 ||
    legacy === LEGACY_MONTHLY_PROMPT_V2
  )
    return { ...DEFAULT_PROMPTS };
  return { daily: legacy, weekly: legacy, monthly: legacy };
}

/** 从旧配置源提取旧单模板值（不存在/非法 → null）。 */
function legacyPromptOf(src: Record<string, unknown>): string | null {
  const v = src.promptTemplate;
  return typeof v === "string" && v.trim().length > 0 && v.length <= 20000 ? v : null;
}

/** 三周期各自的旧默认锁表（未自定义的旧模板平滑升级为新默认的唯一词表事实源）。 */
const LEGACY_PROMPTS_BY_PERIOD: Record<keyof ReportPrompts, readonly string[]> = {
  daily: [
    LEGACY_DAILY_PROMPT_V1,
    LEGACY_DAILY_PROMPT_V2,
    LEGACY_DAILY_PROMPT_V3,
    LEGACY_DAILY_PROMPT_V4,
  ],
  weekly: [
    LEGACY_WEEKLY_PROMPT_V1,
    LEGACY_WEEKLY_PROMPT_V2,
    LEGACY_WEEKLY_PROMPT_V3,
    LEGACY_WEEKLY_PROMPT_V4,
  ],
  monthly: [
    LEGACY_MONTHLY_PROMPT_V1,
    LEGACY_MONTHLY_PROMPT_V2,
    LEGACY_MONTHLY_PROMPT_V3,
    LEGACY_MONTHLY_PROMPT_V4,
  ],
};

/**
 * 归一化三周期提示词表：新格式 prompts{daily,weekly,monthly} 逐周期取用（未自定义的
 * 旧默认文本升级为新默认）；缺 prompts 子源 → 从旧单模板迁移。
 */
function normalizePrompts(src: Record<string, unknown>, dflt: ReportPrompts): ReportPrompts {
  const promptsSrc = optionalObjectSource(src.prompts);
  if (promptsSrc === null)
    return migrateLegacyPrompt(legacyPromptOf(src) ?? LEGACY_PROMPT_TEMPLATE);
  return {
    daily: normalizePrompt(promptsSrc.daily, dflt.daily, LEGACY_PROMPTS_BY_PERIOD.daily),
    weekly: normalizePrompt(promptsSrc.weekly, dflt.weekly, LEGACY_PROMPTS_BY_PERIOD.weekly),
    monthly: normalizePrompt(promptsSrc.monthly, dflt.monthly, LEGACY_PROMPTS_BY_PERIOD.monthly),
  };
}

/** 校验并归一化报告配置（非法值回退默认；旧单模板自动迁移为三周期表；未自定义的旧三周期模板平滑升级）。 */
export function normalizeReportConfig(raw: unknown): ReportConfig {
  const src = objectSource(raw);
  const weeklySrc = objectSource(src.weekly);
  const monthlySrc = objectSource(src.monthly);
  const pushSrc = objectSource(src.push);
  const d = DEFAULT_REPORT_CONFIG;
  const prompts = normalizePrompts(src, d.prompts);
  const reasoningEffort =
    typeof src.reasoningEffort === "string" && src.reasoningEffort.length > 0
      ? { reasoningEffort: src.reasoningEffort }
      : {};
  return {
    daily: normalizePeriod(src.daily, d.daily),
    weekly: {
      ...normalizePeriod(src.weekly, d.weekly),
      weekStartsOn: weeklySrc.weekStartsOn === 0 ? 0 : 1,
    },
    monthly: {
      ...normalizePeriod(src.monthly, d.monthly),
      dayOfMonth: isValidDayOfMonth(monthlySrc.dayOfMonth)
        ? monthlySrc.dayOfMonth
        : d.monthly.dayOfMonth,
    },
    provider: boundedString(src.provider, 128, d.provider),
    model: boundedString(src.model, 256, d.model),
    // opaque ID 原样保留；旧磁盘配置与非法值缺省时不输出该键。
    ...reasoningEffort,
    // promptTemplate 保留 = 月报模板镜像（旧消费方/外部读者兼容；写侧同步回填）
    promptTemplate: prompts.monthly,
    // sanitizePaths 已移除：恒输出 true 兼容旧读取方；新字段不再接受配置
    sanitizePaths: true,
    push: { enabled: typeof pushSrc.enabled === "boolean" ? pushSrc.enabled : d.push.enabled },
    // prompts 为嵌套字段（不得平铺——daily/weekly/monthly 键名与周期配置同名，
    // 平铺会覆盖周期配置；曾实测把 cfg.weekly 覆盖成模板字符串，调度全 NaN）
    prompts,
    // 报告目录范围（空数组 = 全部目录）
    directories: normalizeReportDirectories(src.directories),
  };
}

/** 按周期取模板（runDue/手动生成统一入口；缺周期回退月报模板镜像）。 */
export function promptFor(cfg: ReportConfig, period: ReportPeriod): string {
  const p = cfg.prompts?.[period];
  return typeof p === "string" && p.length > 0 ? p : cfg.promptTemplate;
}
