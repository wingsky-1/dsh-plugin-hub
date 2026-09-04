/**
 * dsh-provider-usage — 设置面板「用量报告」区块（#503 M3）。
 *
 * SettingsPage 子区块形态（与 TrendSection 同层挂接，从简不另开顶层 tab）：
 * - 配置卡片：日/周/月各独立开关与触发时刻 + 周起点/月内日 + provider/model 路由 +
 *   提示词模板 + 推送开关，保存走 POST /report-config（宿主归一化落盘 + 调度器热更新）；
 * - 手动生成：指定周期立即生成（POST /reports/generate，成功后刷新历史列表）；
 * - 历史列表：倒序展示（GET /reports），行点击展开详情（GET /reports/detail，
 *   宿主端已双层净化——落盘 escHtml + 读侧 sanitizeHtml，此处 innerHTML 注入安全面）；
 * - 空态为行动邀请式文案。
 *
 * 客户端干净模块纪律：只 export 组件与必要常量，不写 loader；
 * fetch 走 core.ts 既有 fetchTimeout 封装；文案全部经 locales 字典。
 */
import * as React from "react";
import { fetchTimeout } from "./core.ts";
import { t } from "../../../../shared/client/i18n.js";

/** 宿主端 ROUTES（构建期经 __DSH_ROUTES__ 注入；报告五路由 #503 M3 / #532 起进入路由表）。 */
declare const __DSH_ROUTES__: Record<string, string> | undefined;
const REPORT_CONFIG_URL = __DSH_ROUTES__?.reportConfig ?? "/api/dsh-provider-usage/report-config";
const REPORT_MODELS_URL = __DSH_ROUTES__?.reportModels ?? "/api/dsh-provider-usage/report-models";
const REPORTS_URL = __DSH_ROUTES__?.reports ?? "/api/dsh-provider-usage/reports";
const REPORT_DETAIL_URL = __DSH_ROUTES__?.reportDetail ?? "/api/dsh-provider-usage/reports/detail";
const REPORT_GENERATE_URL = __DSH_ROUTES__?.reportGenerate ?? "/api/dsh-provider-usage/reports/generate";

// ---------------------------------------------------------------- 类型

export type ReportPeriodView = "daily" | "weekly" | "monthly";

/** 单周期配置（与宿主端 ReportConfig 同构）。 */
export interface ReportPeriodConfigView {
  enabled: boolean;
  time: string;
}

/** 单周期提示词模板表（#532，与宿主端 ReportPrompts 同构）。 */
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
  promptTemplate: string;
  /** 三周期独立模板（#532；旧配置经宿主 normalize 迁移后始终存在）。 */
  prompts: ReportPromptsView;
  sanitizePaths: boolean;
  push: { enabled: boolean };
}

/** provider 候选（/report-config 响应 providers[]）。 */
export interface ReportProviderOption {
  id: string;
  name?: string;
}

/** 模型候选（/report-models 响应 models[]，#532）。 */
export interface ReportModelOption {
  id: string;
  name?: string;
}

/** 报告元数据（/reports 列表行与 detail.meta）。 */
export interface ReportMetaView {
  period: ReportPeriodView;
  key: string;
  startDay: string;
  endDay: string;
  provider: string;
  model: string;
  generatedAt: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  tokens?: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
  };
  /** #532：空窗口标记（当期无任何用量，未调模型未落盘）。 */
  noData?: boolean;
  /** #532：hero 摘要（成功生成时落盘；旧报告无此字段不渲染 hero）。 */
  summary?: {
    total: number | null;
    calls: number;
    activeDays: number;
    windowDays: number;
    longestStreak: number;
    wowRatio: number | null;
    peakDay: { day: string; total: number | null } | null;
  };
}

/** #532：环比箭头胶囊（null = 上一窗口无数据，不做对比）。 */
function ratioBadge(ratio: number | null): React.ReactElement {
  if (ratio === null) return React.createElement("span", { className: "dou-heroRatio" }, "—");
  const up = ratio >= 1;
  const pct = Math.round(Math.abs(ratio - 1) * 100);
  return React.createElement(
    "span",
    { className: `dou-heroRatio ${up ? "dou-heroRatioUp" : "dou-heroRatioDown"}` },
    up ? "↑" : "↓",
    " ",
    pct === 0 ? t("reportRatioFlat") : t("reportRatioPct", { n: pct }),
  );
}

/** #532：详情页年报 hero 区（海报式渐变不随主题反转，文字恒浅色）。 */
function reportHero(s: NonNullable<ReportMetaView["summary"]>): React.ReactElement {
  const stats: Array<[string, string]> = [
    [t("reportHeroCalls"), `${s.calls.toLocaleString("en-US")}`],
    [t("reportHeroActive"), `${s.activeDays} / ${s.windowDays}`],
    [t("reportHeroStreak"), `${s.longestStreak}`],
    [t("reportHeroPeak"), s.peakDay !== null ? `${(s.peakDay.total ?? 0).toLocaleString("en-US")}` : "—"],
  ];
  return React.createElement(
    "div",
    { className: "dou-hero" },
    React.createElement(
      "div",
      { className: "dou-heroBig" },
      React.createElement("span", { className: "dou-heroNum" }, s.total !== null ? s.total.toLocaleString("en-US") : "—"),
      React.createElement("span", { className: "dou-heroNumUnit" }, t("reportHeroTotal")),
      ratioBadge(s.wowRatio),
    ),
    React.createElement(
      "div",
      { className: "dou-heroStats" },
      stats.map(([label, value]) =>
        React.createElement(
          "div",
          { className: "dou-heroStat", key: label },
          React.createElement("small", null, label),
          React.createElement("b", null, value),
        ),
      ),
    ),
  );
}

/** 历史行唯一 id（列表展开态标记用）。 */
const rowIdOf = (m: ReportMetaView): string => `${m.period}:${m.key}`;

const PERIODS: ReportPeriodView[] = ["daily", "weekly", "monthly"];

const periodLabel = (period: ReportPeriodView): string =>
  period === "daily" ? t("reportPeriodDaily") : period === "weekly" ? t("reportPeriodWeekly") : t("reportPeriodMonthly");

// ---------------------------------------------------------------- 组件

/** 「用量报告」区块（SettingsPage 子区块）。 */
export function ReportSection(): React.ReactElement {
  // 配置（编辑态 draft 与宿主归一化响应同构；载入前 null = 未就绪）
  const [draft, setDraft] = React.useState<ReportConfigView | null>(null);
  const [providers, setProviders] = React.useState<ReportProviderOption[]>([]);
  const [configFailed, setConfigFailed] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveState, setSaveState] = React.useState<"idle" | "saved" | "fail">("idle");
  // 手动生成
  const [genPeriod, setGenPeriod] = React.useState<ReportPeriodView>("daily");
  const [generating, setGenerating] = React.useState(false);
  const [genError, setGenError] = React.useState<string | null>(null);  // 历史列表与详情展开
  const [list, setList] = React.useState<ReportMetaView[] | null>(null);
  const [listFailed, setListFailed] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<{ id: string; html: string; meta: ReportMetaView } | null>(null);
  // #532 模型候选：按 provider 缓存（null = 已请求且失败/为空 → 降级手填；undefined = 未请求）
  const [modelsCache, setModelsCache] = React.useState<Record<string, ReportModelOption[] | null>>({});
  // #532 三周期提示词：当前编辑的周期 tab + 宿主默认模板（「恢复默认」数据源）
  const [promptTab, setPromptTab] = React.useState<ReportPeriodView>("daily");
  const [promptDefaults, setPromptDefaults] = React.useState<ReportPromptsView | null>(null);
  // #532 手动生成的空窗口提示（区别于错误）
  const [genNotice, setGenNotice] = React.useState<string | null>(null);

  /** 读配置与 provider 候选（失败展示错误行，不阻塞历史列表）。 */
  const loadConfig = React.useCallback(async (): Promise<void> => {
    try {
      const res = await fetchTimeout(REPORT_CONFIG_URL, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { ok?: boolean; config?: ReportConfigView; providers?: ReportProviderOption[]; promptDefaults?: ReportPromptsView };
      if (body.config !== undefined) {
        setDraft(body.config);
        setConfigFailed(false);
      }
      if (Array.isArray(body.providers)) setProviders(body.providers);
      if (body.promptDefaults !== null && body.promptDefaults !== undefined) setPromptDefaults(body.promptDefaults);
    } catch {
      setConfigFailed(true);
    }
  }, []);

  /** 读历史索引（倒序）。 */
  const loadReports = React.useCallback(async (): Promise<void> => {
    try {
      const res = await fetchTimeout(REPORTS_URL, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { ok?: boolean; reports?: ReportMetaView[] };
      setList(Array.isArray(body.reports) ? body.reports : []);
      setListFailed(false);
    } catch {
      setListFailed(true);
    }
  }, []);

  React.useEffect(() => {
    void loadConfig();
    void loadReports();
  }, [loadConfig, loadReports]);

  // #532 模型候选：provider 空串（跟随默认）按注册序首个解析（与宿主 resolveRoute 同序同源）；
  // 按需拉取 + 组件生命周期内 memo（每 provider 至多一次）；live 标志丢弃过期响应防竞态。
  const providerKey = draft?.provider ?? "";
  const effectiveProvider = providerKey === "" ? (providers[0]?.id ?? "") : providerKey;
  const models = modelsCache[effectiveProvider];
  const haveModels = Array.isArray(models) && models.length > 0;
  React.useEffect(() => {
    if (effectiveProvider === "" || modelsCache[effectiveProvider] !== undefined) return;
    let live = true;
    fetchTimeout(`${REPORT_MODELS_URL}?provider=${encodeURIComponent(effectiveProvider)}`, { headers: { Accept: "application/json" }, cache: "no-store" })
      .then((res) => res.json() as Promise<{ ok?: boolean; models?: ReportModelOption[] }>)
      .then((body) => {
        if (!live) return;
        setModelsCache((c) => ({ ...c, [effectiveProvider]: body?.ok === true && Array.isArray(body.models) ? body.models : null }));
      })
      .catch(() => {
        if (live) setModelsCache((c) => ({ ...c, [effectiveProvider]: null }));
      });
    return () => {
      live = false;
    };
  }, [effectiveProvider, modelsCache]);

  /** 单周期字段更新（draft 空时忽略——输入未就绪不可交互）。 */
  const patchPeriod = (period: ReportPeriodView, patch: Partial<ReportPeriodConfigView & { weekStartsOn: 0 | 1 } & { dayOfMonth: number }>): void => {
    setDraft((d) => (d === null ? d : { ...d, [period]: { ...d[period], ...patch } }));
    setSaveState("idle");
  };

  const patchTop = (patch: Partial<ReportConfigView>): void => {
    setDraft((d) => (d === null ? d : { ...d, ...patch }));
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
        body: JSON.stringify(draft),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; config?: ReportConfigView; error?: string };
      if (!res.ok || body.config === undefined) throw new Error(body.error ?? `HTTP ${res.status}`);
      setDraft(body.config);
      setSaveState("saved");
    } catch (e) {
      setSaveState("fail");
      setGenError(null);
      console.warn(`[dsh-provider-usage] 报告配置保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  /** 手动生成：POST /reports/generate → 成功刷新列表并展开新报告。 */
  const onGenerate = async (): Promise<void> => {
    if (generating) return;
    setGenerating(true);
    setGenError(null);
    setGenNotice(null);
    try {
      const res = await fetchTimeout(REPORT_GENERATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ period: genPeriod }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; meta?: ReportMetaView; error?: string };
      if (!res.ok || body.meta === undefined) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (body.meta.noData === true) {
        // #532：空窗口不调模型不落盘——正向提示，不进错误分支、不展开详情
        setGenNotice(t("reportNoData"));
        return;
      }
      setGenNotice(null);
      await loadReports();
      setOpenId(rowIdOf(body.meta)); // 生成成功后展开详情
    } catch (e) {
      setGenError(t("reportGenerateFail", { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setGenerating(false);
    }
  };

  /** 行点击展开/收起详情（HTML 已由宿主双层净化）。 */
  const toggleDetail = async (m: ReportMetaView): Promise<void> => {
    const id = rowIdOf(m);
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    try {
      const params = new URLSearchParams({ period: m.period, key: m.key });
      const res = await fetchTimeout(`${REPORT_DETAIL_URL}?${params.toString()}`, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { ok?: boolean; html?: string; meta?: ReportMetaView };
      if (typeof body.html !== "string" || body.meta === undefined) throw new Error("bad-detail");
      setDetail({ id, html: body.html, meta: body.meta });
    } catch {
      setDetail({ id, html: "", meta: m });
    }
  };

  const failed = configFailed || listFailed;

  return React.createElement(
    "section",
    { className: "dou-report", style: { marginBottom: 16 } },
    React.createElement("h2", { style: { fontSize: 13, fontWeight: 600, margin: "0 0 8px" } }, t("reportTitle")),
    failed
      ? React.createElement("div", { className: "dou-reportFetchFail" }, t("reportFetchFail"))
      : null,
    // ---- 配置卡片 ----
    draft !== null
      ? React.createElement(
          "div",
          { className: "dou-reportCard" },
          PERIODS.map((period) =>
            React.createElement(
              "div",
              { className: "dou-reportRow", key: period },
              React.createElement(
                "label",
                { className: "dou-reportEnabled" },
                React.createElement("input", {
                  type: "checkbox",
                  checked: draft[period].enabled,
                  onChange: (e: unknown) => patchPeriod(period, { enabled: (e as { target: { checked: boolean } }).target.checked }),
                }),
                periodLabel(period),
              ),
              React.createElement("span", { className: "dou-reportLabel" }, t("reportTime")),
              React.createElement("input", {
                type: "time",
                className: "dou-reportTime",
                "aria-label": `${periodLabel(period)} ${t("reportTime")}`,
                value: draft[period].time,
                onChange: (e: unknown) => patchPeriod(period, { time: (e as { target: { value: string } }).target.value }),
              }),
              period === "weekly"
                ? React.createElement(
                    "label",
                    { className: "dou-reportInline" },
                    t("reportWeekStartsOn"),
                    React.createElement(
                      "select",
                      {
                        className: "dou-reportSelect",
                        value: String(draft.weekly.weekStartsOn),
                        onChange: (e: unknown) => patchPeriod("weekly", { weekStartsOn: (e as { target: { value: string } }).target.value === "0" ? 0 : 1 }),
                      },
                      React.createElement("option", { value: "1" }, t("reportWeekMonday")),
                      React.createElement("option", { value: "0" }, t("reportWeekSunday")),
                    ),
                  )
                : null,
              period === "monthly"
                ? React.createElement(
                    "label",
                    { className: "dou-reportInline" },
                    t("reportDayOfMonth"),
                    React.createElement("input", {
                      type: "number",
                      min: 1,
                      max: 28,
                      className: "dou-reportNum",
                      value: draft.monthly.dayOfMonth,
                      onChange: (e: unknown) => {
                        const n = Number((e as { target: { value: string } }).target.value);
                        patchPeriod("monthly", { dayOfMonth: Number.isInteger(n) ? n : draft.monthly.dayOfMonth });
                      },
                    }),
                  )
                : null,
            ),
          ),
          // provider / model 路由
          React.createElement(
            "div",
            { className: "dou-reportRow" },
            React.createElement(
              "label",
              { className: "dou-reportInline" },
              t("reportProvider"),
              React.createElement(
                "select",
                {
                  className: "dou-reportSelect",
                  value: draft.provider,
                  onChange: (e: unknown) => patchTop({ provider: (e as { target: { value: string } }).target.value }),
                },
                React.createElement("option", { value: "" }, t("reportProviderDefault")),
                providers.map((p) =>
                  React.createElement("option", { key: p.id, value: p.id }, typeof p.name === "string" && p.name.length > 0 ? `${p.name} (${p.id})` : p.id),
                ),
              ),
            ),
            React.createElement(
              "label",
              { className: "dou-reportInline" },
              t("reportModel"),
              // #532：模型候选已加载 → 下拉（首项「跟随默认」=空串语义=注册序首个）；
              // 当前配置值不在列表 → 兜底项渲染旧值，绝不隐式改写；未加载/失败 → 降级手填。
              haveModels
                ? React.createElement(
                    "select",
                    {
                      className: "dou-reportSelect",
                      value: draft.model,
                      onChange: (e: unknown) => patchTop({ model: (e as { target: { value: string } }).target.value }),
                    },
                    React.createElement("option", { key: "", value: "" }, t("reportModelDefault")),
                    draft.model !== "" && !models!.some((m) => m.id === draft.model)
                      ? React.createElement("option", { key: "__kept", value: draft.model }, t("reportModelKept", { v: draft.model }))
                      : null,
                    models!.map((m) =>
                      React.createElement("option", { key: m.id, value: m.id }, typeof m.name === "string" && m.name.length > 0 ? `${m.name} (${m.id})` : m.id),
                    ),
                  )
                : React.createElement("input", {
                    type: "text",
                    className: "dou-reportInput",
                    placeholder: t("reportModelHint"),
                    value: draft.model,
                    onChange: (e: unknown) => patchTop({ model: (e as { target: { value: string } }).target.value }),
                  }),
            ),
          ),
          models !== null && !haveModels
            ? React.createElement("div", { className: "dou-reportHint" }, t("reportModelFallback"))
            : null,
          // 提示词模板（#532：三周期各自独立模板 + 周期切换 tab + 恢复默认）
          React.createElement(
            "div",
            { className: "dou-reportCol" },
            React.createElement(
              "div",
              { className: "dou-reportPromptTabs" },
              React.createElement("span", { className: "dou-reportLabel" }, t("reportPrompt")),
              PERIODS.map((p) =>
                React.createElement(
                  "button",
                  {
                    key: p,
                    type: "button",
                    className: `dou-reportPromptTab${promptTab === p ? " dou-reportPromptTabActive" : ""}`,
                    "aria-pressed": promptTab === p,
                    onClick: () => setPromptTab(p),
                  },
                  periodLabel(p),
                ),
              ),
              promptDefaults !== null
                ? React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "dou-reportPromptReset",
                      onClick: () => patchTop({ prompts: { ...draft.prompts, [promptTab]: promptDefaults[promptTab] } }),
                    },
                    t("reportPromptReset"),
                  )
                : null,
            ),
            React.createElement("textarea", {
              className: "dou-reportTextarea",
              rows: 7,
              value: draft.prompts[promptTab],
              onChange: (e: unknown) => patchTop({ prompts: { ...draft.prompts, [promptTab]: (e as { target: { value: string } }).target.value } }),
            }),
            React.createElement("span", { className: "dou-reportHint" }, t("reportPromptHint")),
          ),
          // 推送开关 + 保存
          React.createElement(
            "div",
            { className: "dou-reportRow" },
            React.createElement(
              "label",
              { className: "dou-reportEnabled" },
              React.createElement("input", {
                type: "checkbox",
                checked: draft.push.enabled,
                onChange: (e: unknown) => patchTop({ push: { enabled: (e as { target: { checked: boolean } }).target.checked } }),
              }),
              t("reportPush"),
            ),
            React.createElement(
              "button",
              { type: "button", className: "dou-reportSaveBtn", disabled: saving, onClick: () => void onSave() },
              t("reportSave"),
            ),
            saveState === "saved"
              ? React.createElement("span", { className: "dou-reportSaved" }, t("reportSaved"))
              : saveState === "fail"
                ? React.createElement("span", { className: "dou-reportSaveFail" }, t("reportSaveFail", { msg: "HTTP error" }))
                : null,
          ),
        )
      : null,
    // ---- 手动生成 ----
    React.createElement(
      "div",
      { className: "dou-reportRow dou-reportGenRow" },
      React.createElement(
        "select",
        {
          className: "dou-reportSelect",
          value: genPeriod,
          "aria-label": t("reportPeriodSelect"),
          onChange: (e: unknown) => setGenPeriod((e as { target: { value: string } }).target.value as ReportPeriodView),
        },
        PERIODS.map((p) => React.createElement("option", { key: p, value: p }, periodLabel(p))),
      ),
      React.createElement(
        "button",
        { type: "button", className: "dou-reportGenBtn", disabled: generating, onClick: () => void onGenerate() },
        generating ? t("reportGenerating") : t("reportGenerate"),
      ),
      genError !== null ? React.createElement("span", { className: "dou-reportGenError" }, genError) : null,
      genNotice !== null ? React.createElement("span", { className: "dou-reportGenNotice" }, genNotice) : null,
    ),
    // ---- 历史列表 ----
    React.createElement("h3", { className: "dou-reportListTitle" }, t("reportHistory")),
    list === null
      ? null
      : list.length === 0
        ? React.createElement("div", { className: "dou-reportEmpty" }, t("reportEmpty"))
        : React.createElement(
            "ul",
            { className: "dou-reportList" },
            list.map((m) => {
              const id = rowIdOf(m);
              // 展开态详情（局部组装，避免深嵌套三元）：HTML 已由宿主双层净化
              let detailNode: React.ReactNode = null;
              if (openId === id) {
                const parts: React.ReactNode[] = [];
                if (detail !== null && detail.id === id) {
                  const tokens = detail.meta.tokens;
                  if (tokens !== null && tokens !== undefined && tokens.totalTokens !== null) {
                    parts.push(
                      React.createElement(
                        "div",
                        { className: "dou-reportDetailMeta", key: "meta" },
                        t("reportDetailTokens", { n: tokens.totalTokens.toLocaleString("en-US") }),
                      ),
                    );
                  }
                  // #532 年报 hero：meta.summary 存在时渲染大数字 + 环比 + 活跃统计
                  const summary = detail.meta.summary;
                  if (summary !== null && summary !== undefined) {
                    parts.push(reportHero(summary));
                  }
                  if (detail.meta.noData === true) {
                    parts.push(React.createElement("div", { className: "dou-reportGenNotice", key: "nodata" }, t("reportNoData")));
                  } else {
                    parts.push(
                      detail.html.length > 0
                        ? React.createElement("div", {
                            className: "dou-reportDetailBody",
                            key: "body",
                            // 数据源为本插件宿主端产物：落盘 escape-then-transform 白名单标签
                            // 第一层 + 读侧 sanitizeHtml 第二层（#532 管线）
                            dangerouslySetInnerHTML: { __html: detail.html },
                          })
                        : React.createElement(
                            "div",
                            { className: "dou-reportFetchFail", key: "empty" },
                            detail.meta.error ?? t("reportFetchFail"),
                          ),
                    );
                  }
                  parts.push(
                    React.createElement(
                      "button",
                      { type: "button", className: "dou-reportCollapse", key: "collapse", onClick: () => { setOpenId(null); setDetail(null); } },
                      t("reportCollapse"),
                    ),
                  );
                } else {
                  parts.push(React.createElement("div", { className: "dou-reportLoading", key: "loading" }, t("loading")));
                }
                detailNode = React.createElement("div", { className: "dou-reportDetail" }, parts);
              }
              return React.createElement(
                "li",
                { className: "dou-reportItem", key: id },
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "dou-reportItemHead",
                    "aria-expanded": openId === id,
                    onClick: () => void toggleDetail(m),
                  },
                  React.createElement("span", { className: "dou-reportItemPeriod" }, periodLabel(m.period)),
                  React.createElement("span", { className: "dou-reportItemKey" }, m.key),
                  React.createElement(
                    "span",
                    { className: m.ok ? "dou-reportBadge dou-reportBadgeOk" : "dou-reportBadge dou-reportBadgeFail" },
                    m.ok ? t("reportOk") : t("reportFailed"),
                  ),
                  React.createElement(
                    "span",
                    { className: "dou-reportItemTime" },
                    new Date(m.generatedAt).toLocaleString(),
                  ),
                ),
                detailNode,
              );
            }),
          ),
  );
}
