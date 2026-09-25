/**
 * dsh-provider-usage — 设置面板「用量报告」区块（#940 P0）。
 *
 * SettingsPage 子区块形态（与 TrendSection 同层挂接，从简不另开顶层 tab）：
 * - 配置四区各自独立展开收起（调度 / 路由与范围 / 提示词 / 手动生成），
 *   折叠头保留摘要与脏状态（未保存），保存走 POST /report-config
 *   （宿主归一化落盘 + 调度器热更新）；历史已搬至独立 HistorySection 页；
 * - 提示词按任务目标 / 统计数据 / 撰写结构 / 硬性约束结构化编辑
 *   （report-helpers.ts 纯逻辑解析合成；红线默认折叠；变量 chip 只读；
 *   字数预算与约束计数展示；支持恢复默认；非标准结构回退整体编辑，不丢文本）；
 * - 手动生成：指定周期立即生成（POST /reports/generate；成功经 onGeneratedRow
 *   回调由壳切历史页并展开，Q4）；
 * - 历史列表归 history.tsx 所有，本文件不再持有列表/详情状态。
 * - 材质走 Liquid Glass（dou-reportGlass：半透明 +  backdrop 模糊 + 0.5px 光边，
 *   全部颜色经 --dsw-alias-*，见 style.css）。
 *
 * 客户端干净模块纪律：只 export 组件与必要常量，不写 loader；
 * fetch 走 core.ts 既有 fetchTimeout 封装；文案全部经 locales 字典。
 */
import * as React from "react";
import { fetchTimeout, REPORT_GENERATE_STATUS_URL } from "./core.ts";
import { dirDisplayLabel, dirNeedsScopeNote, dirStackId } from "./trend-math.js";
import {
  composePrompt,
  isPromptsDirty,
  isRoutingDirty,
  isScheduleDirty,
  parsePrompt,
  promptSectionStats,
  reportConfigPayload,
  reportRetryView,
  withReasoningEffort,
  type ReportRetryView,
  PROMPT_RANGE_VAR,
  PROMPT_STATS_VAR,
} from "./report-helpers.ts";
import type { ReportMetaView } from "./history.tsx";
import { t } from "../../../../shared/client/i18n.js";

/** 报告五路由经 ./shared/contract.ts 具名表（host-seams R2 收敛，字面量只留契约一份）。 */
import { REPORT_CONFIG_URL, REPORT_GENERATE_URL, REPORT_MODELS_URL } from "./shared/contract.ts";

/** 轮询退避：1s → 2s → 4s 封顶 5s；上限约 2 分钟。 */
const POLL_INITIAL_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 5_000;
const POLL_MAX_ROUNDS = 25;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询超时哨兵：超时≠失败（后端可能仍在生成），转「仍在生成」正向提示。 */
class PollInProgressError extends Error {
  constructor() {
    super("poll-timeout");
    this.name = "PollInProgressError";
  }
}

// ---------------------------------------------------------------- 类型

export type ReportPeriodView = "daily" | "weekly" | "monthly";

/** 单周期配置（与宿主端 ReportConfig 同构）。 */
export interface ReportPeriodConfigView {
  enabled: boolean;
  time: string;
}

/** 单周期提示词模板表（与宿主端 ReportPrompts 同构）。 */
export interface ReportPromptsView {
  daily: string;
  weekly: string;
  monthly: string;
}

/** 报告配置（宿主响应归一化形状）。 */
export interface ReportConfigView {
  daily: ReportPeriodConfigView;
  weekly: ReportPeriodConfigView & { weekStartsOn: 0 | 1 };
  monthly: ReportPeriodConfigView & { dayOfMonth: number };
  provider: string;
  model: string;
  /** 当前 exact model 的 opaque reasoning effort ID；缺省沿用 DSH 默认。 */
  reasoningEffort?: string;
  promptTemplate: string;
  /** 三周期独立模板（旧配置经宿主 normalize 迁移后始终存在）。 */
  prompts: ReportPromptsView;
  sanitizePaths: boolean;
  push: { enabled: boolean };
  /** 报告目录范围（空数组 = 全部目录；basename 净化值或未识别桶键）。 */
  directories: string[];
}

/** provider 候选（/report-config 响应 providers[]）。 */
export interface ReportProviderOption {
  id: string;
  name?: string;
}

/** 模型候选（/report-models 响应 models[]）。 */
export interface ReportModelOption {
  id: string;
  name?: string;
}

/** DSH exact-model reasoning 档位投影；ID 不透明，顺序保持宿主响应。 */
export interface ReportReasoningEffortView {
  id: string;
  name: string;
  description?: string;
}

/** report-models?model=<exact id> 的 selectedModel 能力投影。 */
export interface ReportSelectedModelView {
  id: string;
  name?: string;
  reasoning?: {
    efforts: ReportReasoningEffortView[];
    defaultEffort?: string;
  };
  capabilityError?: true;
}

/** retry 状态与产生它的 task/POST 状态；二者共同决定用户提示。 */
interface ReportRetryDisplay {
  view: ReportRetryView;
  status: string | null;
}

const PERIODS: ReportPeriodView[] = ["daily", "weekly", "monthly"];

const periodLabel = (period: ReportPeriodView): string =>
  period === "daily"
    ? t("reportPeriodDaily")
    : period === "weekly"
      ? t("reportPeriodWeekly")
      : t("reportPeriodMonthly");

// ---------------------------------------------------------------- P0 折叠区

/** 报告配置折叠区 id（四区各自独立展开收起；历史为独立页）。 */
export type ReportSectionId = "schedule" | "routing" | "prompts" | "generate";

/** 默认开合（#940 草图 3.4：路由与提示词展开，其余收起）。 */
export const DEFAULT_OPEN_SECTIONS: Record<ReportSectionId, boolean> = {
  schedule: false,
  routing: true,
  prompts: true,
  generate: false,
};

/** 独立收缩折叠区（折叠头保留摘要与脏状态；内容区卸载不丢 draft）。 */
function ReportCollapsibleSection(props: {
  id: ReportSectionId;
  title: string;
  summary: string;
  dirty: boolean;
  open: boolean;
  onToggle: (id: ReportSectionId) => void;
  children: React.ReactNode;
}): React.ReactElement {
  const { id, title, summary, dirty, open, onToggle, children } = props;
  return (
    <div className="dou-reportSection dou-reportGlass">
      <button
        type="button"
        className="dou-reportSectionHead"
        aria-expanded={open}
        aria-controls={"dou-report-" + id + "-body"}
        onClick={() => onToggle(id)}
      >
        <span className="dou-reportSectionArrow" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="dou-reportSectionTitle">{title}</span>
        {dirty ? <span className="dou-reportDirty">{t("reportUnsaved")}</span> : null}
        <span className="dou-reportSectionSummary">{summary}</span>
      </button>
      {open ? (
        <div className="dou-reportSectionBody" id={"dou-report-" + id + "-body"}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 结构化提示词编辑器（单周期）。
 * 标准四段结构 → 四块分开编辑（统计块为 {stats} 只读 chip；
 * 硬性约束默认折叠）；非标准结构 → 整体 textarea 回退（文本无损）。
 */
function PromptEditor(props: {
  period: ReportPeriodView;
  text: string;
  defaultText: string | null;
  redlineOpen: boolean;
  onToggleRedline: () => void;
  onChange: (next: string) => void;
}): React.ReactElement {
  const { period, text, defaultText, redlineOpen, onToggleRedline, onChange } = props;
  const parsed = parsePrompt(text);
  const stats = promptSectionStats(text);
  const budgetText = stats.budget !== null ? stats.budget + t("reportPromptWordUnit") : "—";
  const setPart = (part: "goal" | "stats" | "structure" | "constraints", value: string): void => {
    if (!parsed.ok) {
      onChange(value);
      return;
    }
    onChange(composePrompt({ ...parsed.sections, [part]: value }, period));
  };
  return (
    <div className="dou-reportPromptEditor">
      <div className="dou-reportPromptMeta">
        <span className="dou-reportPromptChip" title={t("reportStatsVarNote")}>
          {PROMPT_STATS_VAR}
        </span>
        <span className="dou-reportPromptChip" title={t("reportRangeVarNote")}>
          {PROMPT_RANGE_VAR}
        </span>
        <span className="dou-reportPromptBudget">
          {t("reportBudgetLabel")} {budgetText}
        </span>
        <span className="dou-reportPromptBudget">
          {t("reportConstraintCount", { n: stats.constraintCount })}
        </span>
        {defaultText !== null ? (
          <button
            type="button"
            className="dou-reportPromptReset"
            onClick={() => onChange(defaultText)}
          >
            {t("reportPromptReset")}
          </button>
        ) : null}
      </div>
      {parsed.ok ? (
        <React.Fragment>
          <label className="dou-reportCol">
            <span className="dou-reportLabel">{t("reportGoalLabel")}</span>
            <textarea
              className="dou-reportTextarea"
              rows={3}
              value={parsed.sections.goal}
              onChange={(e: unknown) =>
                setPart("goal", (e as { target: { value: string } }).target.value)
              }
            />
          </label>
          <div className="dou-reportCol">
            <span className="dou-reportLabel">{t("reportStatsLabel")}</span>
            <div className="dou-reportPromptStatsRow">
              <span className="dou-reportPromptChip">{PROMPT_STATS_VAR}</span>
              <span className="dou-reportPromptChip">{PROMPT_RANGE_VAR}</span>
              <span className="dou-reportHint">{t("reportStatsVarNote")}</span>
            </div>
            {parsed.sections.stats.trim() !== PROMPT_STATS_VAR ? (
              <textarea
                className="dou-reportTextarea"
                rows={2}
                aria-label={t("reportStatsLabel")}
                value={parsed.sections.stats}
                onChange={(e: unknown) =>
                  setPart("stats", (e as { target: { value: string } }).target.value)
                }
              />
            ) : null}
          </div>
          <label className="dou-reportCol">
            <span className="dou-reportLabel">{t("reportStructureLabel")}</span>
            <textarea
              className="dou-reportTextarea"
              rows={6}
              value={parsed.sections.structure}
              onChange={(e: unknown) =>
                setPart("structure", (e as { target: { value: string } }).target.value)
              }
            />
          </label>
          <div className="dou-reportCol">
            <button
              type="button"
              className="dou-reportRedlineHead"
              aria-expanded={redlineOpen}
              onClick={onToggleRedline}
            >
              <span aria-hidden="true">{redlineOpen ? "▾" : "▸"}</span>
              {t("reportConstraintsLabel")}
              <span className="dou-reportSectionSummary">
                {t("reportConstraintCount", { n: stats.constraintCount })}
              </span>
            </button>
            {redlineOpen ? (
              <textarea
                className="dou-reportTextarea"
                rows={5}
                aria-label={t("reportConstraintsLabel")}
                value={parsed.sections.constraints}
                onChange={(e: unknown) =>
                  setPart("constraints", (e as { target: { value: string } }).target.value)
                }
              />
            ) : null}
          </div>
        </React.Fragment>
      ) : (
        <React.Fragment>
          <span className="dou-reportHint">{t("reportPromptRawHint")}</span>
          <textarea
            className="dou-reportTextarea"
            rows={7}
            value={text}
            onChange={(e: unknown) => onChange((e as { target: { value: string } }).target.value)}
          />
        </React.Fragment>
      )}
      <span className="dou-reportHint">{t("reportPromptHint")}</span>
    </div>
  );
}

// ---------------------------------------------------------------- 组件

/** 「用量报告」区块（SettingsPage 子区块；历史归独立页）。
 * onGeneratedRow：生成成功后由壳切历史页并展开对应行（Q4）。 */
function getReportDirty(
  draft: ReportConfigView | null,
  baseline: ReportConfigView | null,
): { schedule: boolean; routing: boolean; prompts: boolean; any: boolean } {
  const schedule = draft !== null && baseline !== null && isScheduleDirty(draft, baseline);
  const routing =
    draft !== null &&
    baseline !== null &&
    isRoutingDirty(
      {
        provider: draft.provider,
        model: draft.model,
        reasoningEffort: draft.reasoningEffort,
        directories: draft.directories,
        push: draft.push,
      },
      {
        provider: baseline.provider,
        model: baseline.model,
        reasoningEffort: baseline.reasoningEffort,
        directories: baseline.directories,
        push: baseline.push,
      },
    );
  const prompts =
    draft !== null && baseline !== null && isPromptsDirty(draft.prompts, baseline.prompts);
  return {
    schedule: schedule,
    routing: routing,
    prompts: prompts,
    any: schedule || routing || prompts,
  };
}
function ScheduleSection(props: {
  draft: ReportConfigView;
  openSections: Record<ReportSectionId, boolean>;
  toggleSection: (id: ReportSectionId) => void;
  scheduleSummary: string;
  dirty: ReturnType<typeof getReportDirty>;
  patchPeriod: (
    period: ReportPeriodView,
    patch: Partial<ReportPeriodConfigView & { weekStartsOn: 0 | 1 } & { dayOfMonth: number }>,
  ) => void;
}): React.ReactElement {
  const { draft, openSections, toggleSection, scheduleSummary, dirty, patchPeriod } = props;
  return (
    <React.Fragment>
      {" "}
      <ReportCollapsibleSection
        id="schedule"
        title={t("reportSectionSchedule")}
        summary={scheduleSummary}
        dirty={dirty.schedule}
        open={openSections.schedule}
        onToggle={toggleSection}
      >
        <div className="dou-reportCard">
          {PERIODS.map((period) => (
            <div className="dou-reportRow" key={period}>
              <label className="dou-reportEnabled">
                <input
                  type="checkbox"
                  checked={draft[period].enabled}
                  onChange={(e: unknown) =>
                    patchPeriod(period, {
                      enabled: (e as { target: { checked: boolean } }).target.checked,
                    })
                  }
                />
                {periodLabel(period)}
              </label>
              <span className="dou-reportLabel">{t("reportTime")}</span>
              <input
                type="time"
                className="dou-reportTime"
                aria-label={`${periodLabel(period)} ${t("reportTime")}`}
                value={draft[period].time}
                disabled={!draft[period].enabled}
                onChange={(e: unknown) =>
                  patchPeriod(period, {
                    time: (e as { target: { value: string } }).target.value,
                  })
                }
              />
              {period === "weekly" ? (
                <label className="dou-reportInline">
                  {t("reportWeekStartsOn")}
                  <select
                    className="dou-reportSelect"
                    value={String(draft.weekly.weekStartsOn)}
                    disabled={!draft.weekly.enabled}
                    onChange={(e: unknown) =>
                      patchPeriod("weekly", {
                        weekStartsOn:
                          (e as { target: { value: string } }).target.value === "0" ? 0 : 1,
                      })
                    }
                  >
                    <option value="1">{t("reportWeekMonday")}</option>
                    <option value="0">{t("reportWeekSunday")}</option>
                  </select>
                </label>
              ) : null}
              {period === "monthly" ? (
                <label className="dou-reportInline">
                  {t("reportDayOfMonth")}
                  <input
                    type="number"
                    min={1}
                    max={28}
                    className="dou-reportNum"
                    value={draft.monthly.dayOfMonth}
                    disabled={!draft.monthly.enabled}
                    onChange={(e: unknown) => {
                      const n = Number((e as { target: { value: string } }).target.value);
                      patchPeriod("monthly", {
                        dayOfMonth: Number.isInteger(n) ? n : draft.monthly.dayOfMonth,
                      });
                    }}
                  />
                </label>
              ) : null}
            </div>
          ))}
        </div>
      </ReportCollapsibleSection>
    </React.Fragment>
  );
}
function RoutingModelFallback(props: {
  models: ReportModelOption[] | null | undefined;
  haveModels: boolean;
}): React.ReactElement | null {
  const { models, haveModels } = props;
  if (models === null || haveModels) return null;
  return <div className="dou-reportHint">{t("reportModelFallback")}</div>;
}
function ReasoningEffortSelect(props: {
  value: string | undefined;
  selectedModel: ReportSelectedModelView | null | undefined;
  modelSelected: boolean;
  onChange: (effort: string) => void;
}): React.ReactElement {
  const { value, selectedModel, modelSelected, onChange } = props;
  const efforts = selectedModel?.reasoning?.efforts ?? [];
  const current = value ?? "";
  const known = efforts.some((effort) => effort.id === current);
  const stale = current !== "" && !known;
  const capabilityMissing =
    selectedModel !== undefined &&
    selectedModel?.capabilityError !== true &&
    selectedModel?.reasoning === undefined;
  const capabilityFailed = selectedModel === null || selectedModel?.capabilityError === true;
  const canClearUnknown = stale;
  return (
    <React.Fragment>
      <label className="dou-reportInline">
        {t("reportReasoningEffort")}
        <select
          className="dou-reportSelect"
          value={current}
          disabled={efforts.length === 0 && !canClearUnknown}
          title={selectedModel?.name}
          onChange={(e: unknown) => onChange((e as { target: { value: string } }).target.value)}
        >
          <option value="">{t("reportReasoningUnset")}</option>
          {stale ? (
            <option value={current}>{t("reportReasoningStaleOption", { v: current })}</option>
          ) : null}
          {efforts.map((effort) => (
            <option key={effort.id} value={effort.id} title={effort.description}>
              {effort.name} ({effort.id})
              {effort.id === selectedModel?.reasoning?.defaultEffort
                ? ` · ${t("reportReasoningDefault")}`
                : ""}
            </option>
          ))}
        </select>
      </label>
      {capabilityFailed ? (
        <span className="dou-reportHint">{t("reportReasoningCapabilityError")}</span>
      ) : null}
      {capabilityMissing ? (
        <span className="dou-reportHint">{t("reportReasoningUnavailable")}</span>
      ) : null}
      {stale && (!modelSelected || selectedModel !== undefined) ? (
        <span className="dou-reportHint">{t("reportReasoningStale")}</span>
      ) : null}
    </React.Fragment>
  );
}
function RoutingSection(props: {
  draft: ReportConfigView;
  openSections: Record<ReportSectionId, boolean>;
  toggleSection: (id: ReportSectionId) => void;
  patchTop: (patch: Partial<ReportConfigView>) => void;
  setReasoningEffort: (effort: string) => void;
  routingSummary: string;
  dirty: ReturnType<typeof getReportDirty>;
  providers: ReportProviderOption[];
  models: ReportModelOption[] | null | undefined;
  haveModels: boolean;
  selectedModel: ReportSelectedModelView | null | undefined;
  dirOptions: string[];
}): React.ReactElement {
  const {
    draft,
    openSections,
    toggleSection,
    patchTop,
    setReasoningEffort,
    routingSummary,
    dirty,
    providers,
    models,
    haveModels,
    selectedModel,
    dirOptions,
  } = props;
  return (
    <React.Fragment>
      {" "}
      <ReportCollapsibleSection
        id="routing"
        title={t("reportSectionRouting")}
        summary={routingSummary}
        dirty={dirty.routing}
        open={openSections.routing}
        onToggle={toggleSection}
      >
        <div className="dou-reportCard">
          {/* provider / model 路由 */}
          <div className="dou-reportRow">
            <label className="dou-reportInline">
              {t("reportProvider")}
              <select
                className="dou-reportSelect"
                value={draft.provider}
                onChange={(e: unknown) =>
                  patchTop({ provider: (e as { target: { value: string } }).target.value })
                }
              >
                <option value="">{t("reportProviderDefault")}</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {typeof p.name === "string" && p.name.length > 0 ? `${p.name} (${p.id})` : p.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="dou-reportInline">
              {t("reportModel")}
              {/* 模型候选已加载 → 下拉（首项「跟随默认」=空串语义=注册序首个）；
                  当前配置值不在列表 → 兜底项渲染旧值，绝不隐式改写；未加载/失败 → 降级手填。 */}
              {haveModels ? (
                <select
                  className="dou-reportSelect"
                  value={draft.model}
                  onChange={(e: unknown) =>
                    patchTop({ model: (e as { target: { value: string } }).target.value })
                  }
                >
                  <option key="" value="">
                    {t("reportModelDefault")}
                  </option>
                  {draft.model !== "" && !models!.some((m) => m.id === draft.model) ? (
                    <option key="__kept" value={draft.model}>
                      {t("reportModelKept", { v: draft.model })}
                    </option>
                  ) : null}
                  {models!.map((m) => (
                    <option key={m.id} value={m.id}>
                      {typeof m.name === "string" && m.name.length > 0
                        ? `${m.name} (${m.id})`
                        : m.id}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  className="dou-reportInput"
                  placeholder={t("reportModelHint")}
                  value={draft.model}
                  onChange={(e: unknown) =>
                    patchTop({ model: (e as { target: { value: string } }).target.value })
                  }
                />
              )}
            </label>
            <ReasoningEffortSelect
              value={draft.reasoningEffort}
              selectedModel={selectedModel}
              modelSelected={draft.model !== ""}
              onChange={setReasoningEffort}
            />
          </div>
          {<RoutingModelFallback models={models} haveModels={haveModels} />}
          {/* 目录范围多选（默认全部；空数组 = 全部目录语义）。
              与 provider/model 范围控件同级同风格（dou-reportRow + dou-reportInline）；
              候选 = GET dirs（含未识别桶，恒「未识别」有标签 + 口径注释）；已保存值
              不在候选（目录数据已过留存期等）→ 兜底渲染旧值，绝不隐式改写用户配置。 */}
          <div className="dou-reportCol">
            <div className="dou-reportRow">
              <span className="dou-reportLabel">{t("reportDirectories")}</span>
              <label
                className="dou-reportInline"
                style={dirOptions.length === 0 ? { opacity: 0.55 } : undefined}
              >
                {/* 候选空时禁用（无候选可取消全选，空 = 全部语义不变；视觉弱化
                    提示不可交互，防点击无反馈） */}
                <input
                  type="checkbox"
                  disabled={dirOptions.length === 0}
                  checked={draft.directories.length === 0}
                  onChange={(e: unknown) => {
                    patchTop({
                      directories: (e as { target: { checked: boolean } }).target.checked
                        ? []
                        : draft.directories,
                    });
                  }}
                />
                {t("reportDirectoriesAll")}
              </label>
              {dirOptions.length > 0 ? (
                <>
                  <button
                    type="button"
                    className="dou-reportPromptReset"
                    onClick={() => {
                      patchTop({ directories: [...dirOptions] });
                    }}
                  >
                    {t("reportDirectoriesSelectAll")}
                  </button>
                  <button
                    type="button"
                    className="dou-reportPromptReset"
                    onClick={() => {
                      patchTop({ directories: [] });
                    }}
                  >
                    {t("reportDirectoriesClear")}
                  </button>
                </>
              ) : null}
            </div>
            {dirOptions.length > 0 ? (
              <div className="dou-reportDirList">
                {(draft.directories.some((d) => !dirOptions.includes(d))
                  ? [...dirOptions, ...draft.directories.filter((d) => !dirOptions.includes(d))]
                  : dirOptions
                ).map((dir) => {
                  const checked = draft.directories.includes(dir);
                  // 未识别桶恒「未识别」+ 口径注释；异常值已由 dirStackId 归一
                  const label = dirDisplayLabel(dir);
                  const title = dirNeedsScopeNote(dir) ? t("trendDirUnidentifiedNote") : undefined;
                  return (
                    <label className="dou-reportInline dou-reportDirItem" key={dir} title={title}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e: unknown) => {
                          const next = new Set(draft.directories);
                          if ((e as { target: { checked: boolean } }).target.checked) next.add(dir);
                          else next.delete(dir);
                          patchTop({ directories: [...next] });
                        }}
                      />
                      {label}
                    </label>
                  );
                })}
              </div>
            ) : (
              <span className="dou-reportHint">{t("reportDirectoriesEmpty")}</span>
            )}
            {/* 保存后影响报告口径的提示（沿用既有 dou-reportHint 提示模式） */}
            <span className="dou-reportHint">
              {draft.directories.length === 0
                ? t("reportDirectoriesHintAll")
                : t("reportDirectoriesHintScoped")}
            </span>
          </div>
          <div className="dou-reportRow">
            <label className="dou-reportEnabled">
              <input
                type="checkbox"
                checked={draft.push.enabled}
                onChange={(e: unknown) =>
                  patchTop({
                    push: { enabled: (e as { target: { checked: boolean } }).target.checked },
                  })
                }
              />
              {t("reportPush")}
            </label>
          </div>
        </div>
      </ReportCollapsibleSection>
    </React.Fragment>
  );
}
function PromptsSection(props: {
  draft: ReportConfigView;
  openSections: Record<ReportSectionId, boolean>;
  toggleSection: (id: ReportSectionId) => void;
  patchTop: (patch: Partial<ReportConfigView>) => void;
  promptDefaults: ReportPromptsView | null;
  promptSummary: string;
  dirty: ReturnType<typeof getReportDirty>;
  redlineOpen: Record<ReportPeriodView, boolean>;
  setRedlineOpen: React.Dispatch<React.SetStateAction<Record<ReportPeriodView, boolean>>>;
  promptTab: ReportPeriodView;
  setPromptTab: React.Dispatch<React.SetStateAction<ReportPeriodView>>;
}): React.ReactElement {
  const {
    draft,
    openSections,
    toggleSection,
    patchTop,
    promptDefaults,
    promptSummary,
    dirty,
    redlineOpen,
    setRedlineOpen,
    promptTab,
    setPromptTab,
  } = props;
  return (
    <React.Fragment>
      {" "}
      <ReportCollapsibleSection
        id="prompts"
        title={t("reportSectionPrompts")}
        summary={promptSummary}
        dirty={dirty.prompts}
        open={openSections.prompts}
        onToggle={toggleSection}
      >
        <div className="dou-reportCard">
          {/* 提示词模板（三周期结构化编辑 + 周期切换 tab；恢复默认在编辑器内） */}
          <div className="dou-reportCol">
            <div className="dou-reportPromptTabs">
              <span className="dou-reportLabel">{t("reportPrompt")}</span>
              {PERIODS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`dou-reportPromptTab${promptTab === p ? " dou-reportPromptTabActive" : ""}`}
                  aria-pressed={promptTab === p}
                  onClick={() => setPromptTab(p)}
                >
                  {periodLabel(p)}
                </button>
              ))}
            </div>
            <PromptEditor
              period={promptTab}
              text={draft.prompts[promptTab]}
              defaultText={promptDefaults !== null ? promptDefaults[promptTab] : null}
              redlineOpen={redlineOpen[promptTab]}
              onToggleRedline={() => setRedlineOpen((r) => ({ ...r, [promptTab]: !r[promptTab] }))}
              onChange={(nextText) =>
                patchTop({ prompts: { ...draft.prompts, [promptTab]: nextText } })
              }
            />
            {promptTab === "monthly" ? (
              <span className="dou-reportHint">{t("reportWeakModelNote")}</span>
            ) : null}
          </div>
        </div>
      </ReportCollapsibleSection>
    </React.Fragment>
  );
}
function retryMetric(value: number | null): string {
  return value === null ? t("reportRetryUnknown") : value.toLocaleString("en-US");
}

function retryHeadline(retry: ReportRetryDisplay): string {
  if (retry.view.terminal) {
    return t("reportRetryTerminal", {
      code: retry.view.terminalReason?.code ?? t("reportRetryUnknown"),
      kind: retry.view.terminalReason?.kind ?? t("reportRetryUnknown"),
    });
  }
  if (retry.view.nextRetryAt !== null) return t("reportRetryDeferred");
  if (retry.status === "busy") return t("reportRetryBusy");
  return t("reportRetryRunning");
}

function ReportRetryStatus(props: { retry: ReportRetryDisplay }): React.ReactElement {
  const { retry } = props;
  const { view } = retry;
  return (
    <div className="dou-reportCol" role="status" aria-live="polite" aria-atomic="true">
      <span className="dou-reportGenNotice">{retryHeadline(retry)}</span>
      <span className="dou-reportHint">
        {t("reportRetryAttempt", {
          attempt: String(view.currentAttempt),
          maxAttempts: String(view.maxAttempts),
        })}
      </span>
      {view.nextRetryAt !== null ? (
        <span className="dou-reportHint">
          {t("reportRetryNextAt", { at: new Date(view.nextRetryAt).toISOString() })}
        </span>
      ) : null}
      <span className="dou-reportHint">
        {t("reportRetryInputTokens", { value: retryMetric(view.usage.inputTokens) })}
      </span>
      <span className="dou-reportHint">
        {t("reportRetryOutputTokens", { value: retryMetric(view.usage.outputTokens) })}
      </span>
      <span className="dou-reportHint">
        {t("reportRetryReasoningTokens", { value: retryMetric(view.usage.reasoningTokens) })}
      </span>
      <span className="dou-reportHint">
        {t("reportRetryTotalTokens", { value: retryMetric(view.usage.totalTokens) })}
      </span>
      <span className="dou-reportHint">
        {t("reportRetryCacheTokens", {
          read: retryMetric(view.usage.cacheReadTokens),
          write: retryMetric(view.usage.cacheWriteTokens),
        })}
      </span>
      <span className="dou-reportHint">
        {t("reportRetryDuration", {
          value:
            view.usage.durationMs === null
              ? t("reportRetryUnknown")
              : String(view.usage.durationMs),
        })}
      </span>
    </div>
  );
}

function GenerateSection(props: {
  openSections: Record<ReportSectionId, boolean>;
  toggleSection: (id: ReportSectionId) => void;
  generateSummary: string;
  genPeriod: ReportPeriodView;
  setGenPeriod: React.Dispatch<React.SetStateAction<ReportPeriodView>>;
  genForce: boolean;
  setGenForce: React.Dispatch<React.SetStateAction<boolean>>;
  generating: boolean;
  genError: string | null;
  genNotice: string | null;
  genRetry: ReportRetryDisplay | null;
  onGenerate: () => Promise<void>;
}): React.ReactElement {
  const {
    openSections,
    toggleSection,
    generateSummary,
    genPeriod,
    setGenPeriod,
    genForce,
    setGenForce,
    generating,
    genError,
    genNotice,
    genRetry,
    onGenerate,
  } = props;
  return (
    <React.Fragment>
      {" "}
      <ReportCollapsibleSection
        id="generate"
        title={t("reportSectionGenerate")}
        summary={generateSummary}
        dirty={false}
        open={openSections.generate}
        onToggle={toggleSection}
      >
        <div className="dou-reportRow dou-reportGenRow">
          <select
            className="dou-reportSelect"
            value={genPeriod}
            aria-label={t("reportPeriodSelect")}
            onChange={(e: unknown) =>
              setGenPeriod((e as { target: { value: string } }).target.value as ReportPeriodView)
            }
          >
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {periodLabel(p)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="dou-reportGenBtn"
            disabled={generating}
            onClick={() => void onGenerate()}
          >
            {generating ? t("reportGenerating") : t("reportGenerate")}
          </button>
          <label className="dou-reportGenForce">
            <input
              type="checkbox"
              checked={genForce}
              disabled={generating}
              onChange={(e: unknown) =>
                setGenForce((e as { target: { checked: boolean } }).target.checked)
              }
            />
            {t("reportForceRegen")}
          </label>
          {genError !== null ? <span className="dou-reportGenError">{genError}</span> : null}
          {genError !== null ? (
            <span className="dou-reportHint">{t("reportRetryHint")}</span>
          ) : null}
          {genNotice !== null ? <span className="dou-reportGenNotice">{genNotice}</span> : null}
        </div>
        {genRetry !== null ? <ReportRetryStatus retry={genRetry} /> : null}
        <span className="dou-reportHint">{t("reportGenIdempotentHint")}</span>
      </ReportCollapsibleSection>
    </React.Fragment>
  );
}
function getSectionSummaries(
  draft: ReportConfigView | null,
  promptTab: ReportPeriodView,
  genPeriod: ReportPeriodView,
  genForce: boolean,
) {
  const scheduleSummary =
    draft === null
      ? ""
      : (Object.keys({ daily: 1, weekly: 1, monthly: 1 }) as ReportPeriodView[])
          .map(
            (p) =>
              periodLabel(p) + " " + (draft[p].enabled ? draft[p].time : t("reportSectionOff")),
          )
          .join(" · ");
  const routingSummary =
    draft === null
      ? ""
      : (() => {
          const providerLabel = draft.provider === "" ? t("reportProviderDefault") : draft.provider;
          const modelLabel = draft.model === "" ? t("reportModelDefault") : draft.model;
          const dirLabel =
            draft.directories.length === 0
              ? t("reportDirectoriesAll")
              : t("reportSummaryNDirs", { n: draft.directories.length });
          return [providerLabel, modelLabel, dirLabel].join(" · ");
        })();
  const promptStatsNow = draft === null ? null : promptSectionStats(draft.prompts[promptTab]);
  const promptSummary =
    draft === null || promptStatsNow === null
      ? ""
      : [
          periodLabel(promptTab),
          (promptStatsNow.budget !== null ? promptStatsNow.budget : "—") +
            t("reportPromptWordUnit"),
          t("reportConstraintCount", { n: promptStatsNow.constraintCount }),
        ].join(" · ");
  const generateSummary =
    periodLabel(genPeriod) + " · " + (genForce ? t("reportForceShort") : t("reportNoForceShort"));
  return {
    scheduleSummary: scheduleSummary,
    routingSummary: routingSummary,
    promptSummary: promptSummary,
    generateSummary: generateSummary,
  };
}
function ReportHeader(props: {
  anyDirty: boolean;
  draft: ReportConfigView | null;
  saving: boolean;
  saveState: string;
  setAllSections: (open: boolean) => void;
  onSave: () => Promise<void>;
}): React.ReactElement {
  const { anyDirty, draft, saving, saveState, setAllSections, onSave } = props;
  return (
    <React.Fragment>
      {" "}
      <div className="dou-reportHead">
        <h2 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{t("reportTitle")}</h2>
        {anyDirty ? <span className="dou-reportDirty">{t("reportUnsaved")}</span> : null}
        <span className="dou-reportHeadSpacer" />
        <button
          type="button"
          className="dou-reportPromptReset"
          onClick={() => setAllSections(false)}
        >
          {t("reportCollapseAll")}
        </button>
        <button
          type="button"
          className="dou-reportPromptReset"
          onClick={() => setAllSections(true)}
        >
          {t("reportExpandAll")}
        </button>
        {draft !== null ? (
          <button
            type="button"
            className="dou-reportSaveBtn"
            disabled={saving}
            onClick={() => void onSave()}
          >
            {t("reportSave")}
          </button>
        ) : null}
        {saveState === "saved" ? (
          <span className="dou-reportSaved">{t("reportSaved")}</span>
        ) : saveState === "fail" ? (
          <span className="dou-reportSaveFail">{t("reportSaveFail", { msg: "HTTP error" })}</span>
        ) : null}
      </div>
    </React.Fragment>
  );
}
export function ReportSection(props: {
  onGeneratedRow: (m: ReportMetaView) => void;
}): React.ReactElement {
  const { onGeneratedRow } = props;
  // 配置（编辑态 draft 与宿主归一化响应同构；载入前 null = 未就绪）
  const [draft, setDraft] = React.useState<ReportConfigView | null>(null);
  const [providers, setProviders] = React.useState<ReportProviderOption[]>([]);
  // 目录候选（GET /report-config dirs，含未识别桶；宿主 calls 降序）
  const [dirOptions, setDirOptions] = React.useState<string[]>([]);
  const [configFailed, setConfigFailed] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveState, setSaveState] = React.useState<"idle" | "saved" | "fail">("idle");
  // 手动生成
  const [genPeriod, setGenPeriod] = React.useState<ReportPeriodView>("daily");
  const [generating, setGenerating] = React.useState(false);
  const [genError, setGenError] = React.useState<string | null>(null);
  const [genRetry, setGenRetry] = React.useState<ReportRetryDisplay | null>(null);
  // 强制重新生成（默认幂等：窗口已有成功报告则复用，勾选后强制覆盖）
  const [genForce, setGenForce] = React.useState(false);
  // 轮询卸载保护：组件卸载后停止轮询，不再 setState
  const disposedRef = React.useRef(false);
  React.useEffect(
    () => () => {
      disposedRef.current = true;
    },
    [],
  );
  // 历史列表/详情状态归 history.tsx 所有（本页仅经 onGeneratedRow 回调跳转）。
  // 模型候选：按 provider 缓存（null = 已请求且失败/为空 → 降级手填；undefined = 未请求）
  const [modelsCache, setModelsCache] = React.useState<Record<string, ReportModelOption[] | null>>(
    {},
  );
  // exact-model 能力：按 provider + model 缓存；null = 已请求但失败/无 selectedModel。
  const [selectedModelsCache, setSelectedModelsCache] = React.useState<
    Record<string, ReportSelectedModelView | null>
  >({});
  // 三周期提示词：当前编辑的周期 tab + 宿主默认模板（「恢复默认」数据源）
  const [promptTab, setPromptTab] = React.useState<ReportPeriodView>("daily");
  const [promptDefaults, setPromptDefaults] = React.useState<ReportPromptsView | null>(null);
  // 四区独立开合（默认开合见 DEFAULT_OPEN_SECTIONS）+ 已保存基线（脏状态比对）
  // + 红线（硬性约束）按周期各自默认折叠
  const [openSections, setOpenSections] = React.useState<Record<ReportSectionId, boolean>>({
    ...DEFAULT_OPEN_SECTIONS,
  });
  const [baseline, setBaseline] = React.useState<ReportConfigView | null>(null);
  const [redlineOpen, setRedlineOpen] = React.useState<Record<ReportPeriodView, boolean>>({
    daily: false,
    weekly: false,
    monthly: false,
  });
  const toggleSection = React.useCallback((id: ReportSectionId): void => {
    setOpenSections((s) => ({ ...s, [id]: !s[id] }));
  }, []);
  const setAllSections = React.useCallback((open: boolean): void => {
    setOpenSections({
      schedule: open,
      routing: open,
      prompts: open,
      generate: open,
    });
  }, []);
  // 手动生成的空窗口提示（区别于错误）
  const [genNotice, setGenNotice] = React.useState<string | null>(null);

  /** 读配置与 provider 候选（失败展示错误行，不阻塞历史列表）。 */
  const loadConfig = React.useCallback(async (): Promise<void> => {
    try {
      const res = await fetchTimeout(REPORT_CONFIG_URL, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        ok?: boolean;
        config?: ReportConfigView;
        providers?: ReportProviderOption[];
        dirs?: Array<{ dir?: string | null }>;
        promptDefaults?: ReportPromptsView;
      };
      if (body.config !== undefined) {
        setDraft(body.config);
        setBaseline(body.config);
        setConfigFailed(false);
      }
      if (Array.isArray(body.providers)) setProviders(body.providers);
      // 目录候选（dirStackId 防御归一——异常值归未识别，杜绝空标签进多选）
      if (Array.isArray(body.dirs)) {
        setDirOptions([...new Set(body.dirs.map((d) => dirStackId(d.dir)))]);
      }
      if (body.promptDefaults !== null && body.promptDefaults !== undefined)
        setPromptDefaults(body.promptDefaults);
    } catch {
      setConfigFailed(true);
    }
  }, []);

  React.useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // 模型候选：provider 空串（跟随默认）按注册序首个解析（与宿主 resolveRoute 同序同源）；
  // 按需拉取 + 组件生命周期内 memo（每 provider 至多一次）；live 标志丢弃过期响应防竞态。
  const providerKey = draft?.provider ?? "";
  const effectiveProvider = providerKey === "" ? (providers[0]?.id ?? "") : providerKey;
  const models = modelsCache[effectiveProvider];
  const haveModels = Array.isArray(models) && models.length > 0;
  const selectedModelKey =
    effectiveProvider !== "" && (draft?.model ?? "") !== ""
      ? JSON.stringify([effectiveProvider, draft?.model])
      : "";
  const selectedModel = selectedModelKey === "" ? undefined : selectedModelsCache[selectedModelKey];
  React.useEffect(() => {
    if (effectiveProvider === "" || modelsCache[effectiveProvider] !== undefined) return;
    let live = true;
    fetchTimeout(`${REPORT_MODELS_URL}?provider=${encodeURIComponent(effectiveProvider)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then((res) => res.json() as Promise<{ ok?: boolean; models?: ReportModelOption[] }>)
      .then((body) => {
        if (!live) return;
        setModelsCache((c) => ({
          ...c,
          [effectiveProvider]: body?.ok === true && Array.isArray(body.models) ? body.models : null,
        }));
      })
      .catch(() => {
        if (live) setModelsCache((c) => ({ ...c, [effectiveProvider]: null }));
      });
    return () => {
      live = false;
    };
  }, [effectiveProvider, modelsCache]);

  // exact-model 能力只查询当前选中项；不遍历 models[]，避免 N+1。
  React.useEffect(() => {
    if (selectedModelKey === "" || selectedModelsCache[selectedModelKey] !== undefined) return;
    let live = true;
    const url =
      REPORT_MODELS_URL +
      "?provider=" +
      encodeURIComponent(effectiveProvider) +
      "&model=" +
      encodeURIComponent(draft?.model ?? "");
    fetchTimeout(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(
        (res) => res.json() as Promise<{ ok?: boolean; selectedModel?: ReportSelectedModelView }>,
      )
      .then((body) => {
        if (!live) return;
        setSelectedModelsCache((cache) => ({
          ...cache,
          [selectedModelKey]:
            body?.ok === true && body.selectedModel !== undefined ? body.selectedModel : null,
        }));
      })
      .catch(() => {
        if (live) setSelectedModelsCache((cache) => ({ ...cache, [selectedModelKey]: null }));
      });
    return () => {
      live = false;
    };
  }, [draft?.model, effectiveProvider, selectedModelKey, selectedModelsCache]);

  /** 单周期字段更新（draft 空时忽略——输入未就绪不可交互）。 */
  const patchPeriod = (
    period: ReportPeriodView,
    patch: Partial<ReportPeriodConfigView & { weekStartsOn: 0 | 1 } & { dayOfMonth: number }>,
  ): void => {
    setDraft((d) => (d === null ? d : { ...d, [period]: { ...d[period], ...patch } }));
    setSaveState("idle");
  };

  const patchTop = (patch: Partial<ReportConfigView>): void => {
    setDraft((d) => (d === null ? d : { ...d, ...patch }));
    setSaveState("idle");
  };

  const setReasoningEffort = (effort: string): void => {
    setDraft((d) => (d === null ? d : withReasoningEffort(d, effort)));
    setSaveState("idle");
  };

  /** 保存：POST /report-config → 以宿主归一化结果回填（防本地编辑值与落盘值漂移）。 */
  const onSave = async (): Promise<void> => {
    if (draft === null || saving) return;
    setSaving(true);
    setSaveState("idle");
    try {
      const res = await fetchTimeout(REPORT_CONFIG_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: reportConfigPayload(draft),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        config?: ReportConfigView;
        error?: string;
      };
      if (!res.ok || body.config === undefined) throw new Error(body.error ?? `HTTP ${res.status}`);
      setDraft(body.config);
      setBaseline(body.config);
      setSaveState("saved");
    } catch (e) {
      setSaveState("fail");
      setGenError(null);
      console.warn(
        `[dsh-provider-usage] 报告配置保存失败：${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSaving(false);
    }
  };

  /**
   * 轮询生成任务状态：退避 1s→5s，上限约 2 分钟。
   * done → 返回 { meta, reused }；failed → 抛错；超时/status 404（任务已被 TTL 修剪，报告
   * 大概率已生成）→ 抛 PollInProgressError（调用方转「仍在生成」正向提示，
   * 绝不误报失败）。
   * 组件卸载（disposedRef）后立即中止。
   * 单轮 abort/断网视为瞬态，退避后继续（上限内转「仍在生成」，不误报失败）。
   * reused 透传——executor 侧幂等短路复用与 200 直接复用路径提示对称。
   */
  const pollReportTask = async (
    taskId: string,
  ): Promise<{ meta: ReportMetaView; reused: boolean }> => {
    let delay = POLL_INITIAL_DELAY_MS;
    for (let i = 0; i < POLL_MAX_ROUNDS; i += 1) {
      await sleep(delay);
      if (disposedRef.current) throw new PollInProgressError();
      // 单轮瞬态网络中断（移动端切后台/半开连接 abort）不判死：继续下一轮，
      // 轮次上限兜底转「仍在生成」（服务端任务侧照常推进，不会因客户端等待丢失）
      let res: Response;
      try {
        res = await fetchTimeout(
          `${REPORT_GENERATE_STATUS_URL}?taskId=${encodeURIComponent(taskId)}`,
          { headers: { Accept: "application/json" }, cache: "no-store" },
        );
      } catch (e) {
        if (e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError")) {
          delay = Math.min(delay * 2, POLL_MAX_DELAY_MS);
          continue;
        }
        if (e instanceof TypeError) {
          delay = Math.min(delay * 2, POLL_MAX_DELAY_MS);
          continue;
        }
        throw e;
      }
      if (res.status === 404) throw new PollInProgressError(); // 任务已修剪：转「仍在生成」
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: string;
        meta?: ReportMetaView;
        reused?: boolean;
        error?: string;
        retry?: unknown;
      };
      const retry = reportRetryView(body.retry);
      if (!disposedRef.current) {
        setGenRetry(retry === null ? null : { view: retry, status: body.status ?? null });
      }
      if (body.status === "done") {
        if (body.meta === undefined) throw new Error("bad-task-result");
        return { meta: body.meta, reused: body.reused === true };
      }
      if (body.status === "failed") throw new Error(body.error ?? "生成失败");
      delay = Math.min(delay * 2, POLL_MAX_DELAY_MS);
    }
    throw new PollInProgressError();
  };

  /** 手动生成（异步任务化）：POST → 幂等复用(200+meta) 或 202+taskId 轮询 → 经壳跳转历史页展开（Q4）。 */
  const onGenerate = async (): Promise<void> => {
    if (generating) return;
    setGenerating(true);
    setGenError(null);
    setGenNotice(null);
    setGenRetry(null);
    try {
      const res = await fetchTimeout(REPORT_GENERATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ period: genPeriod, force: genForce }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        meta?: ReportMetaView;
        reused?: boolean;
        taskId?: string;
        error?: string;
        status?: string;
        retry?: unknown;
      };
      const retry = reportRetryView(body.retry);
      if (!disposedRef.current)
        setGenRetry(retry === null ? null : { view: retry, status: body.status ?? null });
      if (
        !res.ok &&
        retry !== null &&
        (body.status === "busy" || body.status === "deferred" || body.status === "terminal")
      ) {
        return;
      }
      if (!res.ok || (body.meta === undefined && typeof body.taskId !== "string")) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      if (body.meta !== undefined) {
        // 终态：幂等复用（窗口已有成功报告，未勾选强制重生成）
        if (disposedRef.current) return;
        if (body.meta.noData === true) {
          // 空窗口不调模型不落盘——正向提示，不进错误分支、不展开详情
          setGenNotice(t("reportNoData"));
          return;
        }
        if (body.reused === true) setGenNotice(t("reportReused"));
        else setGenNotice(null);
        // 复用不跳转：用户正停留在配置页，强制切页体验差；只留提示，历史页一 tap 即达
        // （上一行保持单语句形态：smoke 契约 #629 P2 用 bundle 正则锁定该行，改形状先改测试）
        if (body.reused === true) return;
        if (disposedRef.current) return;
        onGeneratedRow(body.meta); // 成功经壳切历史页并展开
      }
      // 202 + taskId：轮询直到完成
      let meta: ReportMetaView;
      let polledReused = false;
      try {
        const polled = await pollReportTask(body.taskId as string);
        meta = polled.meta;
        polledReused = polled.reused;
      } catch (e) {
        if (e instanceof PollInProgressError) {
          if (disposedRef.current) return;
          // 超时：后端可能仍在生成——正向提示，不报失败
          setGenNotice(t("reportStillGenerating"));
          return;
        }
        throw e;
      }
      if (disposedRef.current) return;
      if (meta.noData === true) {
        setGenNotice(t("reportNoData"));
        return;
      }
      // executor 侧幂等短路复用 → 与 200 直接复用路径对称：只提示，不跳转
      if (polledReused) {
        setGenNotice(t("reportReused"));
        return;
      }
      setGenNotice(null);
      if (disposedRef.current) return;
      onGeneratedRow(meta); // 成功经壳切历史页并展开
    } catch (e) {
      if (disposedRef.current) return;
      setGenError(t("reportGenerateFail", { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      if (!disposedRef.current) setGenerating(false);
    }
  };

  const failed = configFailed;

  // ---- P0 折叠摘要与脏状态（基线 null = 尚未载入已保存配置，不标脏） ----
  const dirty = getReportDirty(draft, baseline);
  const { scheduleSummary, routingSummary, promptSummary, generateSummary } = getSectionSummaries(
    draft,
    promptTab,
    genPeriod,
    genForce,
  );
  // 历史摘要归历史独立页所有。

  return (
    <section className="dou-report dou-reportGlass" style={{ marginBottom: 16 }}>
      <ReportHeader
        anyDirty={dirty.any}
        draft={draft}
        saving={saving}
        saveState={saveState}
        setAllSections={setAllSections}
        onSave={onSave}
      />
      {failed ? <div className="dou-reportFetchFail">{t("reportFetchFail")}</div> : null}
      {/* ---- 配置四区（各自独立展开收起；历史为独立页） ---- */}
      {draft !== null ? (
        <div className="dou-reportSections">
          <ScheduleSection
            draft={draft}
            openSections={openSections}
            toggleSection={toggleSection}
            scheduleSummary={scheduleSummary}
            dirty={dirty}
            patchPeriod={patchPeriod}
          />
          <RoutingSection
            draft={draft}
            openSections={openSections}
            toggleSection={toggleSection}
            patchTop={patchTop}
            setReasoningEffort={setReasoningEffort}
            routingSummary={routingSummary}
            dirty={dirty}
            providers={providers}
            models={models}
            haveModels={haveModels}
            selectedModel={selectedModel}
            dirOptions={dirOptions}
          />
          <PromptsSection
            draft={draft}
            openSections={openSections}
            toggleSection={toggleSection}
            patchTop={patchTop}
            promptDefaults={promptDefaults}
            promptSummary={promptSummary}
            dirty={dirty}
            redlineOpen={redlineOpen}
            setRedlineOpen={setRedlineOpen}
            promptTab={promptTab}
            setPromptTab={setPromptTab}
          />
        </div>
      ) : null}
      <GenerateSection
        openSections={openSections}
        toggleSection={toggleSection}
        generateSummary={generateSummary}
        genPeriod={genPeriod}
        setGenPeriod={setGenPeriod}
        genForce={genForce}
        setGenForce={setGenForce}
        generating={generating}
        genError={genError}
        genNotice={genNotice}
        genRetry={genRetry}
        onGenerate={onGenerate}
      />
    </section>
  );
}
