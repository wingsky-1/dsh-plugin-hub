/**
 * dsh-provider-usage/report — 用量报告配置（#503 M3）。
 *
 * 存储：historyRoot/reports/config.json（0600，tmp+rename 原子写，ui-config.ts 同款模式）。
 * 配置面（方案 §2.3 / §八 v1.2 定稿）：
 * - 周期与时间：日/周/月各独立开关与时刻；周起点（1=周一 ISO / 0=周日）；
 * - 模型：从 dsh 已注册适配器路由选择 provider/model（空串 = 跟随 dsh 默认 provider）；
 *   凭据由 dsh 既有 provider 配置持有，插件零凭据（ctx.llm 调用，无独立出口）；
 * - 提示词：模板可编辑，注入当期聚合统计 JSON（数值 + 匿名会话 id，注入面收敛）；
 * - 推送：可选经 dsh-notifier 渠道（kind 动态注册），默认脱敏项目路径。
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
}

/** 默认提示词模板（{stats} 注入聚合统计 JSON；叙事化年报风格）。 */
export const DEFAULT_PROMPT_TEMPLATE = [
  "你是用量分析助手。请根据以下 JSON 统计数据，写一份简明的中文用量报告（300 字以内）：",
  "概述总量与环比变化、指出峰值时段、点评使用结构。只依据数据，不要编造。",
  "",
  "统计数据：",
  "{stats}",
].join("\n");

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

/** 校验并归一化报告配置（非法值回退默认）。 */
export function normalizeReportConfig(raw: unknown): ReportConfig {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const weeklySrc = (typeof src.weekly === "object" && src.weekly !== null ? src.weekly : {}) as Record<string, unknown>;
  const monthlySrc = (typeof src.monthly === "object" && src.monthly !== null ? src.monthly : {}) as Record<string, unknown>;
  const pushSrc = (typeof src.push === "object" && src.push !== null ? src.push : {}) as Record<string, unknown>;
  const d = DEFAULT_REPORT_CONFIG;
  const dom = typeof monthlySrc.dayOfMonth === "number" && Number.isInteger(monthlySrc.dayOfMonth) && monthlySrc.dayOfMonth >= 1 && monthlySrc.dayOfMonth <= 28
    ? monthlySrc.dayOfMonth
    : d.monthly.dayOfMonth;
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
    promptTemplate: typeof src.promptTemplate === "string" && src.promptTemplate.trim().length > 0 && src.promptTemplate.length <= 20000
      ? src.promptTemplate
      : d.promptTemplate,
    sanitizePaths: typeof src.sanitizePaths === "boolean" ? src.sanitizePaths : d.sanitizePaths,
    push: { enabled: typeof pushSrc.enabled === "boolean" ? pushSrc.enabled : d.push.enabled },
  };
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
