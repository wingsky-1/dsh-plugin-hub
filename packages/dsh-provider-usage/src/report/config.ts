/**
 * dsh-provider-usage/report — 用量报告配置（#503 M3；#532 per-period 提示词）。
 *
 * 存储：historyRoot/reports/config.json（0600，tmp+rename 原子写，ui-config.ts 同款模式）。
 * 配置面（方案 §2.3 / §八 v1.2 定稿 + #532 修订）：
 * - 周期与时间：日/周/月各独立开关与时刻；周起点（1=周一 ISO / 0=周日）；
 * - 模型：从 dsh 已注册适配器路由选择 provider/model（空串 = 跟随 dsh 默认 provider）；
 *   凭据由 dsh 既有 provider 配置持有，插件零凭据（ctx.llm 调用，无独立出口）；
 * - 提示词：三周期各自独立模板（prompts{daily,weekly,monthly}），{stats} 占位注入
 *   当期聚合统计 JSON（聚合数值，注入面收敛）。旧版单一 promptTemplate 读取时自动
 *   迁移：=== 旧默认 → 升级为三份新默认；自定义过 → 三周期均以该文本起始（不丢文本）；
 * - sanitizePaths：#532 移除（v1 注入面无路径，死开关——normalize 兼容读旧文件但
 *   不再输出该字段，UI 同步去掉勾选）；
 * - 推送：可选经 dsh-notifier 渠道（kind 动态注册）。
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";

/** 报告周期类型。 */
export type ReportPeriod = "daily" | "weekly" | "monthly";

/** 单周期配置（enabled + 触发时刻 HH:MM）。 */
export interface ReportPeriodConfig {
  enabled: boolean;
  /** 本地时区 HH:MM（24 小时制）。 */
  time: string;
}

/** 单周期提示词模板表（#532：三周期各自独立模板与默认文案）。 */
export interface ReportPrompts {
  daily: string;
  weekly: string;
  monthly: string;
}

/** 报告配置（归一化后形状）。 */
export interface ReportConfig {
  daily: ReportPeriodConfig;
  weekly: ReportPeriodConfig & { /** 周起点：1=周一（ISO，默认）/ 0=周日。 */ weekStartsOn: 0 | 1 };
  monthly: ReportPeriodConfig & { /** 月内触发日（1–28，默认 1；覆盖上一自然月）。 */ dayOfMonth: number };
  /** 报告生成所用模型路由；空串 = 跟随 dsh 默认 provider（GenerateOptions 须为已注册路由）。 */
  provider: string;
  model: string;
  /** 提示词模板（{stats} 占位注入当期聚合统计 JSON）。 */
  promptTemplate: string;
  /** 统计 JSON 脱敏开关（默认 true：项目路径脱敏为 ~ 形态）。 */
  sanitizePaths: boolean;
  /** 生成完成后经 dsh-notifier 推送摘要（缺省关闭；中心不在时不推送）。 */
  push: { enabled: boolean };
  /** #532：三周期独立提示词（嵌套字段——不得平铺：键名 daily/weekly/monthly 与周期配置同名）。 */
  prompts: ReportPrompts;
}

/** 旧版默认模板（v0.2.x 单一 promptTemplate；迁移判定基准，文本勿改动）。 */
export const LEGACY_PROMPT_TEMPLATE = [
  "你是用量分析助手。请根据以下 JSON 统计数据，写一份简明的中文用量报告（300 字以内）：",
  "概述总量与环比变化、指出峰值时段、点评使用结构。只依据数据，不要编造。",
  "",
  "统计数据：",
  "{stats}",
].join("\n");

// #532 默认提示词（三周期差异化：速览 / 三节节奏 / 年报叙事；{stats} 占位统一）。
export const DEFAULT_DAILY_PROMPT = [
  "你是用量速报员。根据 {stats} 注入的当日统计数据，用第二人称写一段 80–150 字的中文日报速览：",
  "- 一两句总体节奏（token 总量、调用次数、与上一窗口比较）",
  "- 一句当日最常用模型或工具调用亮点",
  "- 一句轻量的提醒或鼓励收尾",
  "只依据数据，禁止编造数值；标记仅可用 **加粗** 与 - 列表，不要小标题。",
].join("\n");

export const DEFAULT_WEEKLY_PROMPT = [
  "你是用量分析师。根据 {stats} 注入的本周统计数据，用第二人称写一份 200–300 字的中文周报，含三节：",
  "## 本周节奏",
  "总量、环比（wowRatio）、活跃天数（activeDays/windowDays），数值直接引用。",
  "- 数据亮点：peakDay、最常用模型（byProvider）、工具调用（用 - 列表）",
  "## 结构点评",
  "模型/适配器分工与星期节奏（byWeekday）的观察。",
  "## 下周寄语",
  "一句收尾。",
  "只依据数据，禁止编造；标记仅可用 ##、-、**；叙事时间尺度以「这一周」为准。",
].join("\n");

export const DEFAULT_MONTHLY_PROMPT = [
  "你是用量年报撰写者。根据 {stats} 注入的当月统计数据，用第二人称写一份有温度的中文月报（400–600 字），结构：",
  "- 金句开场：点出活跃天数（activeDays/windowDays）、最长连续（longestStreak）与环比（wowRatio）中最突出的一个事实",
  "## 数据亮点",
  "- peakDay（峰值日故事）、topModel 占比（byProvider）、缓存节省（cacheRead 占比）、工具调用（用 - 列表，数值直接引用）",
  "## 结构点评",
  "模型分工（byProvider）与星期节奏（byWeekday）的观察。",
  "## 结语",
  "一句寄语收尾。",
  "只依据数据，禁止编造；标记仅可用 ##、-、**；数据稀疏的月份收窄叙事，不堆砌抒情；时间尺度以「这个月」为准。",
].join("\n");

/** 默认提示词模板表。 */
export const DEFAULT_PROMPTS: ReportPrompts = {
  daily: DEFAULT_DAILY_PROMPT,
  weekly: DEFAULT_WEEKLY_PROMPT,
  monthly: DEFAULT_MONTHLY_PROMPT,
};

/**
 * 默认提示词模板（月报年报化；单模板消费方与旧字段读取兼容面——
 * ReportConfig.promptTemplate 保留为月报模板镜像，runDue 实际按周期取 prompts[period]）。
 */
export const DEFAULT_PROMPT_TEMPLATE = DEFAULT_MONTHLY_PROMPT;

/** 默认报告配置。 */
export const DEFAULT_REPORT_CONFIG: ReportConfig = {
  daily: { enabled: false, time: "22:00" },
  weekly: { enabled: false, time: "09:00", weekStartsOn: 1 },
  monthly: { enabled: false, time: "09:00", dayOfMonth: 1 },
  provider: "",
  model: "",
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  sanitizePaths: true,
  push: { enabled: false },
  prompts: DEFAULT_PROMPTS,
};

/** HH:MM 解析（非法返回 null；notifier quiet-hours 同款严格性）。 */
export function parseHHMM(v: unknown): { h: number; m: number } | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (m === null) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(mm) || h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return { h, m: mm };
}

/** 归一化单周期配置。 */
function normalizePeriod(raw: unknown, dflt: ReportPeriodConfig): ReportPeriodConfig {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : dflt.enabled,
    time: parseHHMM(src.time) !== null ? (src.time as string).trim() : dflt.time,
  };
}

/** 单模板归一化（非空字符串且 ≤20000 用之，否则回退该周期默认）。 */
function normalizePrompt(raw: unknown, dflt: string): string {
  return typeof raw === "string" && raw.trim().length > 0 && raw.length <= 20000 ? raw : dflt;
}

/**
 * 旧单模板 → 三周期迁移（#532）：
 * - 旧值 === 旧默认模板（用户从未自定义）→ 升级为三份新默认（拿得到年报体验）；
 * - 旧值为自定义文本 → 三周期均以该文本起始（用户文本不丢，自行按周期微调）。
 */
function migrateLegacyPrompt(legacy: string): ReportPrompts {
  if (legacy === LEGACY_PROMPT_TEMPLATE) return { ...DEFAULT_PROMPTS };
  return { daily: legacy, weekly: legacy, monthly: legacy };
}

/** 从旧配置源提取旧单模板值（不存在/非法 → null）。 */
function legacyPromptOf(src: Record<string, unknown>): string | null {
  const v = src.promptTemplate;
  return typeof v === "string" && v.trim().length > 0 && v.length <= 20000 ? v : null;
}

/** 校验并归一化报告配置（非法值回退默认；旧单模板自动迁移为三周期表）。 */
export function normalizeReportConfig(raw: unknown): ReportConfig {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const weeklySrc = (typeof src.weekly === "object" && src.weekly !== null ? src.weekly : {}) as Record<string, unknown>;
  const monthlySrc = (typeof src.monthly === "object" && src.monthly !== null ? src.monthly : {}) as Record<string, unknown>;
  const pushSrc = (typeof src.push === "object" && src.push !== null ? src.push : {}) as Record<string, unknown>;
  const d = DEFAULT_REPORT_CONFIG;
  const dom = typeof monthlySrc.dayOfMonth === "number" && Number.isInteger(monthlySrc.dayOfMonth) && monthlySrc.dayOfMonth >= 1 && monthlySrc.dayOfMonth <= 28
    ? monthlySrc.dayOfMonth
    : d.monthly.dayOfMonth;
  // #532 prompts：新格式 prompts{daily,weekly,monthly} 优先；否则从旧 promptTemplate 迁移
  const promptsSrc = (typeof src.prompts === "object" && src.prompts !== null ? src.prompts : null) as Record<string, unknown> | null;
  const prompts: ReportPrompts = promptsSrc !== null
    ? {
        daily: normalizePrompt(promptsSrc.daily, d.promptTemplate),
        weekly: normalizePrompt(promptsSrc.weekly, d.promptTemplate),
        monthly: normalizePrompt(promptsSrc.monthly, d.promptTemplate),
      }
    : migrateLegacyPrompt(legacyPromptOf(src) ?? LEGACY_PROMPT_TEMPLATE);
  return {
    daily: normalizePeriod(src.daily, d.daily),
    weekly: {
      ...normalizePeriod(src.weekly, d.weekly),
      weekStartsOn: weeklySrc.weekStartsOn === 0 ? 0 : 1,
    },
    monthly: {
      ...normalizePeriod(src.monthly, d.monthly),
      dayOfMonth: dom,
    },
    provider: typeof src.provider === "string" && src.provider.length <= 128 ? src.provider : d.provider,
    model: typeof src.model === "string" && src.model.length <= 256 ? src.model : d.model,
    // promptTemplate 保留 = 月报模板镜像（旧消费方/外部读者兼容；写侧同步回填）
    promptTemplate: prompts.monthly,
    // sanitizePaths 已移除（#532）：恒输出 true 兼容旧读取方；新字段不再接受配置
    sanitizePaths: true,
    push: { enabled: typeof pushSrc.enabled === "boolean" ? pushSrc.enabled : d.push.enabled },
    // #532：prompts 为嵌套字段（不得平铺——daily/weekly/monthly 键名与周期配置同名，
    // 平铺会覆盖周期配置；曾实测把 cfg.weekly 覆盖成模板字符串，调度全 NaN）
    prompts,
  };
}

/** 按周期取模板（runDue/手动生成统一入口；缺周期回退月报模板镜像）。 */
export function promptFor(cfg: ReportConfig, period: ReportPeriod): string {
  const p = cfg.prompts?.[period];
  return typeof p === "string" && p.length > 0 ? p : cfg.promptTemplate;
}

/** 报告配置持久化文件（historyRoot 下，0600）。 */
export function reportConfigFile(root: string): string {
  return `${root}/reports/config.json`;
}

// ---------------------------------------------------------------- 持久化读写（#503 M3 接线追加）
// 仅追加：读侧缺失/损坏回退默认归一化，写侧 tmp+rename 原子写 0600（ui-config.ts 同款模式）。

/** 读取报告配置（文件缺失/损坏回退默认；读后一律经 normalizeReportConfig 归一化）。 */
export async function readReportConfig(root: string): Promise<ReportConfig> {
  try {
    const text = await readFile(reportConfigFile(root), "utf8");
    return normalizeReportConfig(JSON.parse(text));
  } catch {
    return { ...DEFAULT_REPORT_CONFIG };
  }
}

/** 原子写报告配置（tmp + rename，0600；reports/ 目录缺失时先建）。 */
export async function writeReportConfig(root: string, cfg: ReportConfig): Promise<void> {
  const file = reportConfigFile(root);
  await mkdir(`${root}/reports`, { recursive: true });
  const tmp = `${file}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(normalizeReportConfig(cfg)), { mode: 0o600 });
  await rename(tmp, file);
}
