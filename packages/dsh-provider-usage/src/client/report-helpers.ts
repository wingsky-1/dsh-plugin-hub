/**
 * dsh-provider-usage — 报告配置 P0 纯逻辑（#940）。
 *
 * 客户端干净模块纪律：本文件零 React / 零 DOM / 零 import（纯函数），
 * report.tsx 经相对 import 消费；单测经 esbuild 即时打包直测（trend-math 先例）。
 * 服务端默认模板文本是唯一事实源（server/shared/prompts.ts），此处只认
 * 四个中文语义块头（结构头兼容日报「（按顺序）」变体），不复述模板内容。
 */

export const PROMPT_GOAL_HEADER = "【任务目标】";
export const PROMPT_STATS_HEADER = "【统计数据】";
export const PROMPT_STRUCTURE_HEADER = "【撰写结构】";
export const PROMPT_STRUCTURE_HEADER_DAILY = "【撰写结构（按顺序）】";
export const PROMPT_CONSTRAINTS_HEADER = "【硬性约束（违背将视为严重错误）】";
export const PROMPT_STATS_VAR = "{stats}";

/** 结构化提示词四块（stats 块恒含 {stats} 注入点）。 */
export interface PromptSections {
  goal: string;
  stats: string;
  structure: string;
  /** 结构头原文变体（回写时原样保留，日/周/月默认见 defaultStructureHeader）。 */
  structureHeader: string;
  constraints: string;
}

export type ParsedPrompt = { ok: true; sections: PromptSections } | { ok: false; raw: string };

const isStructureHeader = (line: string): boolean =>
  line === PROMPT_STRUCTURE_HEADER || line === PROMPT_STRUCTURE_HEADER_DAILY;

/** 解析单周期模板 → 四块；缺块/乱序即 ok:false（调用方回退单 textarea，不丢文本）。 */
export function parsePrompt(text: string): ParsedPrompt {
  const lines = text.split("\n");
  const goalIdx = lines.findIndex((l) => l.trim() === PROMPT_GOAL_HEADER);
  const statsIdx = lines.findIndex((l) => l.trim() === PROMPT_STATS_HEADER);
  const structIdx = lines.findIndex((l) => isStructureHeader(l.trim()));
  const consIdx = lines.findIndex((l) => l.trim() === PROMPT_CONSTRAINTS_HEADER);
  if (goalIdx < 0 || statsIdx < 0 || structIdx < 0 || consIdx < 0) {
    return { ok: false, raw: text };
  }
  if (!(goalIdx < statsIdx && statsIdx < structIdx && structIdx < consIdx)) {
    return { ok: false, raw: text };
  }
  const slice = (a: number, b: number): string => lines.slice(a, b).join("\n").trim();
  return {
    ok: true,
    sections: {
      goal: slice(goalIdx + 1, statsIdx),
      stats: slice(statsIdx + 1, structIdx),
      structure: slice(structIdx + 1, consIdx),
      structureHeader: lines[structIdx].trim(),
      constraints: slice(consIdx + 1, lines.length),
    },
  };
}

/** 周/月默认结构头；日报默认带「（按顺序）」。 */
export function defaultStructureHeader(period: "daily" | "weekly" | "monthly"): string {
  return period === "daily" ? PROMPT_STRUCTURE_HEADER_DAILY : PROMPT_STRUCTURE_HEADER;
}

/** 四块合成完整模板（块间空行分隔；stats 为空时回填 {stats} 占位防注入点丢失）。 */
export function composePrompt(
  sections: Omit<PromptSections, "structureHeader"> & { structureHeader?: string },
  period: "daily" | "weekly" | "monthly",
): string {
  const header = sections.structureHeader ?? defaultStructureHeader(period);
  const stats = sections.stats.trim() === "" ? PROMPT_STATS_VAR : sections.stats.trim();
  return [
    PROMPT_GOAL_HEADER,
    sections.goal.trim(),
    "",
    PROMPT_STATS_HEADER,
    stats,
    "",
    header,
    sections.structure.trim(),
    "",
    PROMPT_CONSTRAINTS_HEADER,
    sections.constraints.trim(),
  ].join("\n");
}

/** 单周期提示词统计：字数预算（首个「N–M字」）、约束条数（约束块内「- 」行）、变量 chip。 */
export function promptSectionStats(text: string): {
  budget: string | null;
  constraintCount: number;
  hasStatsVar: boolean;
} {
  const budgetMatch = text.match(/(\d+)\s*[–—-]\s*(\d+)\s*字/);
  const parsed = parsePrompt(text);
  const scope = parsed.ok ? parsed.sections.constraints : text;
  const constraintCount = scope.split("\n").filter((l) => l.trimStart().startsWith("- ")).length;
  return {
    budget: budgetMatch !== null ? `${budgetMatch[1]}–${budgetMatch[2]}` : null,
    constraintCount,
    hasStatsVar: text.includes(PROMPT_STATS_VAR),
  };
}

/** 调度摘要数据（调用方以 t() 组装本地化串，此处只做启用/关闭判定）。 */
export function scheduleSummaryParts(cfg: {
  daily: { enabled: boolean; time: string };
  weekly: { enabled: boolean; time: string };
  monthly: { enabled: boolean; time: string };
}): Array<{ enabled: boolean; time: string }> {
  return [cfg.daily, cfg.weekly, cfg.monthly];
}

/** 路由与范围摘要数据（目录按集合语义计，不含路径原文——只传数量与全部/收窄标记）。 */
export function routingSummaryData(cfg: {
  provider: string;
  model: string;
  directories: string[];
  push: { enabled: boolean };
}): { provider: string; model: string; dirCount: number; scoped: boolean; push: boolean } {
  return {
    provider: cfg.provider,
    model: cfg.model,
    dirCount: cfg.directories.length,
    scoped: cfg.directories.length > 0,
    push: cfg.push.enabled,
  };
}

const sameStringSet = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const v of b) if (!set.has(v)) return false;
  return true;
};

/** 调度区脏检查（时间/开关/周起点/月内日任一漂移即脏）。 */
export function isScheduleDirty(
  a: {
    daily: { enabled: boolean; time: string };
    weekly: { enabled: boolean; time: string; weekStartsOn: 0 | 1 };
    monthly: { enabled: boolean; time: string; dayOfMonth: number };
  },
  b: {
    daily: { enabled: boolean; time: string };
    weekly: { enabled: boolean; time: string; weekStartsOn: 0 | 1 };
    monthly: { enabled: boolean; time: string; dayOfMonth: number };
  },
): boolean {
  return (
    a.daily.enabled !== b.daily.enabled ||
    a.daily.time !== b.daily.time ||
    a.weekly.enabled !== b.weekly.enabled ||
    a.weekly.time !== b.weekly.time ||
    a.weekly.weekStartsOn !== b.weekly.weekStartsOn ||
    a.monthly.enabled !== b.monthly.enabled ||
    a.monthly.time !== b.monthly.time ||
    a.monthly.dayOfMonth !== b.monthly.dayOfMonth
  );
}

/** 路由与范围区脏检查（目录按集合比对，顺序漂移不算脏）。 */
export function isRoutingDirty(
  a: { provider: string; model: string; directories: string[]; push: { enabled: boolean } },
  b: { provider: string; model: string; directories: string[]; push: { enabled: boolean } },
): boolean {
  return (
    a.provider !== b.provider ||
    a.model !== b.model ||
    !sameStringSet(a.directories, b.directories) ||
    a.push.enabled !== b.push.enabled
  );
}

/** 提示词区脏检查（三周期任一文本漂移即脏）。 */
export function isPromptsDirty(
  a: { daily: string; weekly: string; monthly: string },
  b: { daily: string; weekly: string; monthly: string },
): boolean {
  return a.daily !== b.daily || a.weekly !== b.weekly || a.monthly !== b.monthly;
}
/**
 * 历史独立页纯逻辑（#940 第一批：分组 + 状态筛选 + 内存分页）。
 * 服务端读侧（GET /reports）无分页参数（全量投影，一行/窗口），故分页只发生在
 * 客户端渲染层：一次全量拉取 → 分组/筛选 → 各组切片渲染 + “加载更多”。
 * 上限：三周期合计约 1.2 行/天（日 1 + 周 1/7 + 月 1/30），年增约 430 行，
 * 单行 meta 约 300B —— 十年约 4.3k 行 ≈ 1.3MB，一次 GET 可接受，无需服务端分页。
 */

/** 历史行最小形状（HistorySection 的 ReportMetaView 结构兼容）。 */
export interface HistoryRowLike {
  period: "daily" | "weekly" | "monthly";
  key: string;
  ok: boolean;
  noData?: boolean;
}

/** 历史状态筛选（周期维度由 period 分组承担，此处只筛状态）。 */
export type HistoryStatusFilter = "all" | "ok" | "failed" | "nodata";

/** 每组初始渲染行数（PM 认可的 20/组 + 加载更多；字面量锚，改值需同步验收）。 */
export const HISTORY_PAGE_SIZE = 20;

/** 按 period 分三组（组内保持输入顺序；调用方传入已是倒序）。 */
export function groupReportsByPeriod<T extends HistoryRowLike>(
  rows: T[],
): Record<"daily" | "weekly" | "monthly", T[]> {
  const groups: Record<"daily" | "weekly" | "monthly", T[]> = {
    daily: [],
    weekly: [],
    monthly: [],
  };
  for (const r of rows) groups[r.period].push(r);
  return groups;
}

/** 状态筛选（all 直通；failed 含 ok===false 全部；nodata 只取空窗口行）。 */
export function filterReportsByStatus<T extends HistoryRowLike>(
  rows: T[],
  filter: HistoryStatusFilter,
): T[] {
  if (filter === "all") return [...rows];
  if (filter === "ok") return rows.filter((r) => r.ok && r.noData !== true);
  if (filter === "failed") return rows.filter((r) => !r.ok);
  return rows.filter((r) => r.noData === true);
}

/**
 * 生成跳转目标定位（D1：Q4 自动跳转的判定点）。
 * stale 快照缺目标（新窗口刚生成）时返回 undefined——调用方必须先重拉再定位，
 * 仍缺则落用户可见 notice，禁止静默吞键。id 形如 period:key。
 */
export function locatePendingRow<T extends HistoryRowLike>(rows: T[], id: string): T | undefined {
  return rows.find((r) => r.period + ":" + r.key === id);
}
