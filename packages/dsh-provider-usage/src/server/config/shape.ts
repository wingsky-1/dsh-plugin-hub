/**
 * dsh-provider-usage — server/config 域：报告配置形态（#768 D1）。
 *
 * 本文件只回答「配置长什么样」：四个接口 + 缺省配置。提示词文本（现默认 +
 * LEGACY 锁表）归 prompts.ts，归一化单答案归 normalize.ts，持久化归 store.ts，
 * 双源收口服务归 service.ts——块按回答不同问题切。
 *
 * 缺省引 prompts.ts 的词表（同域实现互引）：形态缺省即「三周期新默认 + 月报镜像」。
 */
import { DEFAULT_PROMPTS, DEFAULT_PROMPT_TEMPLATE } from "../shared/interface.ts";

/** 报告周期类型。 */
export type ReportPeriod = "daily" | "weekly" | "monthly";

/** 单周期配置（enabled + 触发时刻 HH:MM）。 */
export interface ReportPeriodConfig {
  enabled: boolean;
  /** 本地时区 HH:MM（24 小时制）。 */
  time: string;
}

/** 单周期提示词模板表（三周期各自独立模板与默认文案）。 */
export interface ReportPrompts {
  daily: string;
  weekly: string;
  monthly: string;
}

/** 报告配置（归一化后形状）。 */
export interface ReportConfig {
  daily: ReportPeriodConfig;
  weekly: ReportPeriodConfig & { /** 周起点：1=周一（ISO，默认）/ 0=周日。 */ weekStartsOn: 0 | 1 };
  monthly: ReportPeriodConfig & {
    /** 月内触发日（1–28，默认 1；覆盖上一自然月）。 */ dayOfMonth: number;
  };
  /** 报告生成所用模型路由；空串 = 跟随 dsh 默认 provider（GenerateOptions 须为已注册路由）。 */
  provider: string;
  model: string;
  /** 提示词模板（{stats} 占位注入当期聚合统计 JSON）。 */
  promptTemplate: string;
  /** 统计 JSON 脱敏开关（默认 true：项目路径脱敏为 ~ 形态）。 */
  sanitizePaths: boolean;
  /** 生成完成后经 dsh-notifier 推送摘要（缺省关闭；中心不在时不推送）。 */
  push: { enabled: boolean };
  /** 三周期独立提示词（嵌套字段——不得平铺：键名 daily/weekly/monthly 与周期配置同名）。 */
  prompts: ReportPrompts;
  /**
   * 报告目录范围：空数组 = 全部目录（默认）；非空 = 只统计所选
   * 目录（basename 净化值或未识别桶键）。与 provider/model 范围字段同级同构：
   * 字符串数组白名单、长度截断、非法回退默认空数组。
   */
  directories: string[];
}

/** 默认报告配置。 */
export const DEFAULT_REPORT_CONFIG: ReportConfig = {
  daily: { enabled: false, time: "08:00" },
  weekly: { enabled: false, time: "09:00", weekStartsOn: 1 },
  monthly: { enabled: false, time: "09:00", dayOfMonth: 1 },
  provider: "",
  model: "",
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  sanitizePaths: true,
  push: { enabled: false },
  prompts: DEFAULT_PROMPTS,
  directories: [], // 默认「全部目录」
};
