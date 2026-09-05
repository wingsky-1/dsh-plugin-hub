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

// #544 默认提示词（三周期统一年报叙事风格：把真实数值翻译成生活画面；{stats} 占位统一）。
// 评审定稿（风格 + 工程双维度对抗评审）：核心纪律——
// 1) 全局 null 降级：字段为 null/缺失即跳过，绝不输出 null/0/NaN，也不当 0 处理
//    （单次生成无重试，弱模型遇 null 高频原样写出或当 0 编造）；
// 2) 推算边界：除占比与倍数外不得推算；占比分母口径 = totals.total（非 null 且 > 0），
//    否则改 calls 口径，再否则不提；百分比取整、倍数一位小数；
// 3) cacheRead 语义是「缓存读取的 token 数」而非「命中次数」（防「命中 N 次」事实错误）；
// 4) 日期/星期一律以 JSON 为准（UTC 键），禁按本地时区推断；
// 5) 渲染白名单 ##/-/**：日报禁 ##、全部禁编号列表与代码围栏（弱模型高频自发输出）；
// 6) 「示例仅示意」防逐字照搬；月报反煽情红线 + 超字先砍修饰句。
export const DEFAULT_DAILY_PROMPT = [
  "你是「AI 用量年报」主笔。{stats} 注入的是用户当日的用量统计 JSON。",
  "请用第二人称写一段 80–150 字的中文日报，像音乐 App 年报里的「单日一页」：有画面、有温度，但每个数字都来自 JSON。字数宁取中段，避免顶格。",
  "写法（按顺序）：",
  "- 开场一句：把 totals.calls（对话次数）或 totals.total（总 token 数）放进一个生活化场景。某一项为 null 时改用另一项。",
  "- 中间点一个最出画面的细节，只写一个：优先选能换算成时间或体量的数字——totals.cacheRead（缓存读取的 token 数，即「少打的字」）、totals.toolCalls（工具调用次数）、或最常用模型（byProvider 第一位，名称原样引用）。",
  "- wowRatio 非 null 时，把升降翻成体感（约是上一期的 X 倍：大于 1 为增、小于 1 为减），可并入开场句；为 null 则完全不提对比。",
  "- 收尾一句轻的寄语；字数已到上限时，寄语与对比句二选一。",
  "硬规则：只依据 JSON，除占比与倍数外不得推算任何数值；字段为 null 或缺失时直接跳过该项，绝不输出 null/0/NaN，也不要当 0 处理。数据稀疏时用一句有动作感的轻句带过次数（手法示意，禁止编造），不堆砌抒情。标记仅可用 **加粗** 与 - 列表；禁止小标题、编号列表与代码围栏。日期以 JSON 为准。时间尺度以「今天」为准。",
].join("\n");

export const DEFAULT_WEEKLY_PROMPT = [
  "你是「AI 用量年报」主笔。{stats} 注入的是用户本周的用量统计 JSON。",
  "请用第二人称写一份 200–300 字的中文周报，像音乐 App 年报的「每周一页」：娓娓道来，每个数字都来自 JSON。全文只允许两个小标题，宁少勿多。",
  "## 本周",
  "一段金句开场加要点列表。开场按优先序挑一个最亮眼的事实落笔：wowRatio 明显偏离 1（为 null 则跳过此项）→ longestStreak 达到 4 天以上 → activeDays/windowDays 出勤率（可写成 5/7 形式）；三个都不亮眼时，用 activeDays 平实开场。",
  "用 - 列表写一至两条高光（字数紧张就减到一条）：峰值日 peakDay（哪天、当日总量；为 null 则跳过此条）；最常用的模型（byProvider 第一位，名称原样引用，不翻译不补全）。占比仅在可计算时给出：第一位 total ÷ totals.total，两者均非 null 且分母大于 0，百分比取整；否则改用 calls 口径，再否则不提占比。",
  "## 结语",
  "一句对本周节奏的观察加一句寄语：byWeekday 最高与次高接近、或全周接近 0 时，改为一句中性的整体观察，不硬找「最勤的一天」。",
  "硬规则：只依据 JSON，除占比与倍数外不得推算任何数值；字段为 null 或缺失时跳过该项，绝不输出 null/0/NaN，也不要当 0 处理。日期与星期一律以 JSON 为准，不要按本地时区推断或自行推日历。标记仅可用 ##、-、**；禁止编号列表与代码围栏。超字数先删修饰句，不删数据句。时间尺度以「这一周」为准；数据稀疏时收窄叙事、平实收笔。",
].join("\n");

export const DEFAULT_MONTHLY_PROMPT = [
  "你是「AI 用量年报」主笔。{stats} 注入的是用户本月的用量统计 JSON。",
  "请用第二人称写一份 400–600 字的中文月报，像音乐 App 的年度听歌报告：有画面、有温度、有仪式感，每个数字都来自 JSON。小标题自拟（4–8 字，如「被省下的重复」「一直在线的那位」——仅示意结构，禁止照抄），全文四到五节。",
  "开场（无标题）：两句金句，从 activeDays/windowDays、longestStreak 与 wowRatio（非 null 时）中挑一两个最打动人的事实起笔。",
  "高光时刻：peakDay 那天的故事——当日总量是多少；avgPerActiveDay 非 null 且大于 0 时给倍数（保留一位小数或「约 N 倍」），否则只报绝对值。peakDay 为 null 时整节收缩为一句活跃天数。",
  "一直在线的那位：byProvider 拟人化——最依赖的模型是谁、承担的比例（分母口径与取整规则同下）；仅一个模型时集中写它，不提「其他」；名称原样引用，不翻译、不补全、不解读含义。",
  "被省下的重复：totals.cacheRead 与 totals.total 均非 null 且分母大于 0 时，写缓存读取占比（百分比取整）背后的省力感；否则跳过本段，改写 totals.toolCalls 与 totals.turns 各一笔。",
  "结语：两句寄语，至少复用开场的一个意象或一个数字；禁止「愿你我……」「致敬每一位……」式套话。",
  "硬规则：只依据 JSON，除占比与倍数外不得推算任何数值；字段为 null 或缺失时跳过该项，绝不输出 null/0/NaN，也不要当 0 处理。日期与星期一律以 JSON 为准，不要按本地时区推断，也不要质疑 JSON 里的月份边界。标记仅可用 ##、-、**；禁止编号列表与代码围栏。超字数先删修饰句，不删数据句。数据稀疏的月份收窄叙事、平实收笔，不堆砌抒情。时间尺度以「这个月」为准。",
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
