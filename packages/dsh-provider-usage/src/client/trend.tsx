/**
 * dsh-provider-usage — 设置面板「使用趋势」区块。
 *
 * M2.1（本版）相对 M2 的变化（方案 r2：docs/proposals/provider-usage-trend-view-redesign.md）：
 * - 范围档位：粒度旁迷你分段器，选项按「粒度 × retentionDays」生成（响应回传
 *   retentionDays；宿主端按同规则 clamp n，默认档 日30/周13/月6）；
 * - 双形态：堆叠柱（日/周默认）/ 堆叠面积（月默认，保留 provider 构成，禁平滑、
 *   null 桶断开为独立连续段）；同一段 series 两种渲染，切换不发请求；
 * - 触屏可用明细：SVG 桶组带 data-bucket，容器事件委托（pointerdown 全输入 /
 *   pointermove 仅鼠标）→ 卡片内绝对定位浮层（替代触屏不可用的 <title>）；
 * - 部分桶标注：尾桶「进行中」= granKeys 契约恒含当前桶 → 序列最后一项（宿主
 *   lastN*Keys 已核实的隐式约定，M2.1 客户端判定规则）；首桶「部分桶」= 桶起点早于
 *   max(firstDay, 留存下限) 且有数据（留存按天裁 × 周/月桶对齐的边缘效应）；
 * - 空桶统一「无数据」虚位：现有数据模型下挂载前/超保留期/无会话日同落 null
 *   不可区分（宿主端 days Map 只在有记录时建桶），不做三态区分；
 * - 环比完整性：summary.prevComplete=false 时环比显示「-」并注明（防基准含留存
 *   边缘空桶时静默失真）；
 * - 图例点选显隐：纯前端重渲染；Y 域保持全量（隐藏主导段时与汇总卡不脱钩）；
 *   tooltip 合计只算可见段并标注；月视图 X 轴 YY-MM（修复 M2 slice(5) 丢年份）；
 * - 形态/范围选择为会话内内存态（不做 localStorage 持久化，与设置页 tab 状态
 *   一致：宿主 shell 的路由事实源不可被插件页假设）。
 *
 * 视觉沿用 M2：网格线 --dsw-alias-border-l2、轴文字 --dsw-alias-label-tertiary、
 * 9~9.5px、SVG viewBox 自适应。配色零新增自建调色板（M2 注释约定不变）。
 */
import * as React from "react";
import { TREND_URL, fetchTimeout } from "./core.ts";
import {
  fmtCompact,
  trendDelta,
  fmtBucketHuman,
  bucketStartKey,
  trendRangeOptions,
  trendDefaultRange,
  trendYTicks,
  seriesColor,
  stackedBarsSvg,
  stackedAreasSvg,
  dirStackId,
  dirDisplayLabel,
  dirNeedsScopeNote,
  trendRequestParams,
  isDirMode,
  shouldShowDirSelect,
  shouldShowByModel,
  type RenderBar,
  type TrendGran,
} from "./trend-math.js";
import { t } from "../../../../shared/client/i18n.js";

// ---------------------------------------------------------------- 类型

/** /trend 响应（宿主端聚合；增 n/retentionDays/summary.prevComplete）。 */
interface TrendResponse {
  ok: boolean;
  granularity: "day" | "week" | "month";
  metric: string;
  provider: string | null;
  byModel: boolean;
  /** clamp 后实际返回桶数。 */
  n: number;
  /** 宿主配置的留存天数（客户端按粒度生成范围档位的依据）。 */
  retentionDays: number;
  series: Array<{
    key: string;
    total: number | null;
    parts: Array<{ provider: string; model: string | null; value: number | null }>;
  }>;
  providers: Array<{ provider: string; model: string | null }>;
  /** 目录图例（目录面携带，含未识别桶；provider 面 = 空数组）。 */
  dirs?: Array<{ dir?: string | null }>;
  /** byDir=1 全目录面回显（客户端哨兵：分布区/下拉数据源判定）。 */
  byDir?: boolean;
  summary: {
    total: number | null;
    calls: number;
    turns: number;
    toolCalls: number;
    peakKey: string | null;
    top: { provider: string; model: string | null; value: number } | null;
    prevTotal: number | null;
    /** 上一窗口数据是否完整（false 时环比不可比）。 */
    prevComplete: boolean;
  };
  firstDay: string | null;
}

type Gran = TrendGran;

/** 段 id（byModel 时细到 provider+model）。 */
function partId(provider: string, model: string | null, byModel: boolean): string {
  return byModel ? `${provider}/${model ?? "-"}` : provider;
}

// ---------------------------------------------------------------- 组件

const cardStyle = {
  flex: "1 1 120px",
  minWidth: 120,
  padding: "8px 10px",
  border: "1px solid var(--dsw-alias-border-l2,#e8eaf0)",
  borderRadius: 8,
  background: "var(--dsw-alias-bg-layer-1,#f8f9fb)",
};

const controlBtnStyle = (active: boolean) => ({
  padding: "3px 10px",
  fontSize: 12,
  borderRadius: 6,
  border: "1px solid var(--dsw-alias-border-l2,#e8eaf0)",
  background: active ? "var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))" : "transparent",
  cursor: "pointer",
  color: "inherit",
});

const miniBtnStyle = (active: boolean) => ({
  ...controlBtnStyle(active),
  padding: "2px 8px",
  fontSize: 11,
});

const selectStyle = {
  fontSize: 12,
  padding: "3px 6px",
  borderRadius: 6,
  border: "1px solid var(--dsw-alias-border-l2,#e8eaf0)",
  background: "var(--dsw-alias-bg-base,#fdfdfd)",
  color: "inherit",
};

/** 汇总卡（值 + 标签 + 可选角标 + 可选 hint）。 */
function SummaryCard(props: {
  label: string;
  value: string;
  delta?: string | null;
  up?: boolean;
  hint?: string | null;
}): React.ReactElement {
  const { label, value, delta, up, hint } = props;
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary,#9aa0ab)" }}>{label}</div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        {value}
        {delta !== undefined && delta !== null ? (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: up
                ? "var(--dsw-alias-state-warn-primary,#d9a13c)"
                : "var(--dsw-alias-state-success-primary,#3f9d63)",
            }}
          >
            {delta}
          </span>
        ) : null}
        {hint != null && hint !== "" ? (
          <span
            style={{
              fontSize: 10,
              fontWeight: 400,
              color: "var(--dsw-alias-label-tertiary,#9aa0ab)",
            }}
          >
            {hint}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** 分段器（哨兵惯例：role=group + aria-pressed）。 */
function SegGroup(props: {
  label: string;
  items: Array<[string, string]>;
  value: string;
  mini?: boolean;
  onPick: (v: string) => void;
}): React.ReactElement {
  const { label, items, value, mini, onPick } = props;
  return (
    <div role="group" aria-label={label} style={{ display: "inline-flex", gap: 4 }}>
      {items.map(([v, text]) => (
        <button
          key={v}
          type="button"
          style={mini ? miniBtnStyle(v === value) : controlBtnStyle(v === value)}
          aria-pressed={v === value}
          onClick={() => onPick(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
/** 粒度→范围单位文案键（查表替代三元链；未知粒度回落按月口径）。 */
const UNIT_KEY_BY_GRAN: Record<Gran, string> = {
  day: "trendRangeDayUnit",
  week: "trendRangeWeekUnit",
  month: "trendRangeMonthUnit",
};
const unitKeyOf = (gran: Gran): string => UNIT_KEY_BY_GRAN[gran] ?? "trendRangeMonthUnit";

/** 粒度选项表（查表替代 JSX 内联三元）。 */
const GRAN_ITEMS: Array<[string, string]> = [
  ["day", "trendGranDay"],
  ["week", "trendGranWeek"],
  ["month", "trendGranMonth"],
];
/** 形态选项表。 */
const VIEW_ITEMS: Array<[string, string]> = [
  ["bar", "trendViewBar"],
  ["area", "trendViewArea"],
];
/** 指标选项表（值→文案键）。 */
const METRIC_ITEMS: Array<[string, string]> = [
  ["total", "trendMetricTotal"],
  ["input", "trendMetricInput"],
  ["output", "trendMetricOutput"],
  ["cacheRead", "trendMetricCacheRead"],
  ["cacheWrite", "trendMetricCacheWrite"],
  ["calls", "trendMetricCalls"],
];
/** 粒度→人话文案键（查表替代 granLabel 三元链）。 */
interface TrendControlsProps {
  gran: Gran;
  retentionDays: number;
  effectiveRange: number;
  metric: string;
  provider: string;
  byModel: boolean;
  dirFilter: string;
  effectiveView: string;
  providers: Array<{ provider: string; model: string | null }>;
  dirs: Array<{ dir?: string | null }>;
  onGran: (v: Gran) => void;
  onRange: (v: number) => void;
  onMetric: (v: string) => void;
  onProvider: (v: string) => void;
  onDir: (v: string) => void;
  onByModel: (v: boolean) => void;
  onView: (v: string) => void;
}
function TrendControls(p: TrendControlsProps): React.ReactElement {
  const { provider, dirFilter } = p;
  const showDir = shouldShowDirSelect(provider);
  const showByModel = shouldShowByModel(provider, dirFilter);
  return (
    <div
      style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}
    >
      <SegGroup
        label={t("trendGranularity")}
        items={GRAN_ITEMS.map(function (it) {
          return [it[0], t(it[1])];
        })}
        value={p.gran}
        onPick={function (v) {
          p.onGran(v as Gran);
        }}
      />
      <SegGroup
        label={t("trendRangeLabel")}
        items={trendRangeOptions(p.gran, p.retentionDays).map(function (n) {
          return [String(n), t(unitKeyOf(p.gran), { n: String(n) })];
        })}
        value={String(p.effectiveRange)}
        mini={true}
        onPick={function (v) {
          p.onRange(Number(v));
        }}
      />
      <select
        style={selectStyle}
        value={p.metric}
        aria-label={t("trendMetricLabel")}
        onChange={function (e) {
          p.onMetric((e as { target: { value: string } }).target.value);
        }}
      >
        {METRIC_ITEMS.map(function (it) {
          return (
            <option key={it[0]} value={it[0]}>
              {t(it[1])}
            </option>
          );
        })}
      </select>
      <select
        style={selectStyle}
        value={p.provider}
        aria-label={t("trendAdapterLabel")}
        onChange={function (e) {
          p.onProvider((e as { target: { value: string } }).target.value);
        }}
      >
        <option value="">{t("trendAdapterAll")}</option>
        {p.providers.map(function (pr) {
          return (
            <option key={pr.provider + "/" + (pr.model ?? "")} value={pr.provider}>
              {pr.provider}
            </option>
          );
        })}
      </select>
      {showDir ? (
        <select
          style={selectStyle}
          value={p.dirFilter}
          aria-label={t("trendDirLabel")}
          onChange={function (e) {
            p.onDir((e as { target: { value: string } }).target.value);
          }}
        >
          <option value="">{t("trendDirAll")}</option>
          {p.dirs.map(function (d) {
            const key = dirStackId(d.dir);
            return (
              <option key={key} value={key}>
                {dirDisplayLabel(key)}
              </option>
            );
          })}
        </select>
      ) : null}
      {showByModel ? (
        <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}>
          <input
            type="checkbox"
            checked={p.byModel}
            onChange={function (e) {
              p.onByModel((e as { target: { checked: boolean } }).target.checked);
            }}
          />
          {t("trendByModel")}
        </label>
      ) : null}
      <SegGroup
        label={t("trendViewLabel")}
        items={VIEW_ITEMS.map(function (it) {
          return [it[0], t(it[1])];
        })}
        value={p.effectiveView}
        mini={true}
        onPick={function (v) {
          p.onView(v);
        }}
      />
      <span
        style={{
          fontSize: 11,
          color: "var(--dsw-alias-label-tertiary,#9aa0ab)",
          marginLeft: "auto",
        }}
      >
        {t(unitKeyOf(p.gran), { n: String(p.effectiveRange) })}
      </span>
    </div>
  );
}
interface TrendChartProps {
  failed: boolean;
  empty: boolean;
  loading: boolean;
  view: string;
  bars: RenderBar[];
  gran: Gran;
  ticks: number[];
  order: string[];
  tip: { idx: number; offsetX: number } | null;
  tipBar: RenderBar | null;
  tipNode: React.ReactElement | null;
  tipWidth: number;
  chartRef: React.MutableRefObject<HTMLDivElement | null>;
  onDown: (e: {
    target: EventTarget | null;
    currentTarget: HTMLDivElement;
    clientX: number;
    pointerType: string;
    type: string;
  }) => void;
  onMove: (e: { pointerType: string }) => void;
  onLeave: () => void;
  svgHtml: string;
}
function TrendChart(p: TrendChartProps): React.ReactElement {
  if (p.failed) {
    return (
      <div
        style={{
          fontSize: 12,
          color: "var(--dsw-alias-state-error-primary,#d64545)",
          padding: "12px 0",
        }}
      >
        {t("trendFetchFail")}
      </div>
    );
  }
  if (p.empty) {
    return (
      <div
        style={{
          padding: "22px 14px",
          textAlign: "center",
          border: "1px dashed var(--dsw-alias-border-l2,#e8eaf0)",
          borderRadius: 8,
          fontSize: 12,
          color: "var(--dsw-alias-label-tertiary,#9aa0ab)",
        }}
      >
        <div style={{ marginBottom: 4 }}>{t("trendEmptyTitle")}</div>
        <div>{t("trendEmptyHint")}</div>
      </div>
    );
  }
  return (
    <div
      ref={p.chartRef}
      className="dou-trend-chart"
      style={{
        position: "relative",
        opacity: p.loading ? 0.45 : 1,
        transition: "opacity .15s ease",
        pointerEvents: p.loading ? "none" : "auto",
      }}
      aria-busy={p.loading}
      onPointerDown={p.onDown}
      onPointerMove={p.onMove}
      onPointerLeave={p.onLeave}
    >
      <div className="dou-trend-svg" dangerouslySetInnerHTML={{ __html: p.svgHtml }} />
      {p.tip !== null && p.tipBar !== null ? (
        <div className="dou-trend-tip" style={tipStyle(p.tip.offsetX, p.tipWidth)}>
          {p.tipNode}
        </div>
      ) : null}
    </div>
  );
}
interface TrendLegendProps {
  order: string[];
  hidden: ReadonlySet<string>;
  dirMode: boolean;
  hiddenCount: number;
  onToggle: (id: string) => void;
}
function TrendLegend(p: TrendLegendProps): React.ReactElement {
  return (
    <div
      className="dou-trend-legend"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "4px 12px",
        fontSize: 11,
        color: "var(--dsw-alias-label-tertiary,#9aa0ab)",
        marginBottom: 8,
      }}
    >
      {p.order.map(function (id) {
        const off = p.hidden.has(id);
        const label = p.dirMode ? dirDisplayLabel(id) : id;
        const title = p.dirMode
          ? dirNeedsScopeNote(id)
            ? t("trendDirUnidentifiedNote")
            : dirDisplayLabel(id)
          : undefined;
        return (
          <span
            key={id}
            role="switch"
            aria-checked={!off}
            title={title}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              cursor: "pointer",
              borderRadius: 4,
              padding: "1px 4px",
              opacity: off ? 0.38 : 1,
              textDecoration: off ? "line-through" : "none",
            }}
            onClick={function () {
              p.onToggle(id);
            }}
          >
            <span
              className="dou-trend-legendDot"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                flex: "none",
                background: seriesColor(id),
              }}
            />
            {label}
          </span>
        );
      })}
      <span style={{ fontSize: 10, opacity: 0.8 }}>
        {p.hiddenCount > 0
          ? t("trendHiddenParts", { k: String(p.hiddenCount) })
          : t("trendLegendToggleHint")}
      </span>
    </div>
  );
}
interface TrendSummaryProps {
  total: number | null;
  calls: number;
  avg: number | null;
  buckets: number;
  gran: Gran;
  deltaText: string | null;
  deltaUp: boolean;
  hint: string | null;
  hiddenCount: number;
  peakLabel: string;
  peakValue: string;
  topLabel: string;
  topValue: string;
}
function TrendSummary(p: TrendSummaryProps): React.ReactElement {
  const callsHint = p.hiddenCount > 0 ? t("trendHiddenParts", { k: String(p.hiddenCount) }) : null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
      <SummaryCard
        label={t("trendCardTotal")}
        value={p.total === null ? "-" : fmtCompact(p.total)}
        delta={p.deltaText}
        up={p.deltaUp}
        hint={p.hint}
      />
      <SummaryCard
        label={t("trendCardAvg")}
        value={p.avg === null ? "-" : fmtCompact(p.avg)}
        hint={p.buckets + " " + granLabel(p.gran)}
      />
      <SummaryCard label={t("trendCardCalls")} value={fmtCompact(p.calls)} hint={callsHint} />
      <SummaryCard label={p.peakLabel} value={p.peakValue} hint={t("trendCaliberNote")} />
      <SummaryCard label={p.topLabel} value={p.topValue} />
    </div>
  );
}
const GRAN_LABEL_KEY_BY_GRAN: Record<Gran, string> = {
  day: "trendGranDay",
  week: "trendGranWeek",
  month: "trendGranMonth",
};
interface TrendScInput {
  data: TrendResponse | null;
  gran: Gran;
  range: number | null;
  view: string | null;
  dirFilter: string;
  hidden: ReadonlySet<string>;
  renderBars: RenderBar[];
}
function selRange(
  data: TrendResponse | null,
  range: number | null,
  view: string | null,
  gran: Gran,
) {
  const retentionDays = data !== null ? data.retentionDays : 180;
  const effectiveRange = range !== null ? range : trendDefaultRange(gran, retentionDays);
  const effectiveView = view !== null ? view : gran === "month" ? "area" : "bar";
  return {
    retentionDays: retentionDays,
    effectiveRange: effectiveRange,
    effectiveView: effectiveView,
  };
}
function selSource(data: TrendResponse | null) {
  const summary = data !== null ? data.summary : null;
  const providers = data !== null ? data.providers : [];
  const dirs = data !== null && data.dirs !== undefined ? data.dirs : [];
  return { summary: summary, providers: providers, dirs: dirs };
}
function selFlags(
  data: TrendResponse | null,
  summary: TrendResponse["summary"] | null,
  dirFilter: string,
  hidden: ReadonlySet<string>,
) {
  const hasData =
    data !== null &&
    data.series.some(function (p) {
      return p.total !== null;
    });
  const dirMode = isDirMode(data, dirFilter);
  const hiddenCount = hidden.size;
  const showSummary = hasData && summary !== null;
  return { hasData: hasData, dirMode: dirMode, hiddenCount: hiddenCount, showSummary: showSummary };
}
function selDelta(summary: TrendResponse["summary"] | null) {
  const delta = trendDelta(
    summary !== null ? summary.total : null,
    summary !== null ? summary.prevTotal : null,
    summary !== null ? summary.prevComplete : true,
  );
  const deltaText = delta !== null ? delta.text : null;
  const deltaUp = delta !== null ? delta.up : false;
  return { deltaText: deltaText, deltaUp: deltaUp };
}
function selHint(renderBars: RenderBar[], summary: TrendResponse["summary"] | null) {
  const hasPartial = renderBars.some(function (b) {
    return b.mark !== null;
  });
  const hintA = hasPartial ? t("trendPartialOngoing") : "";
  const hintB = summary !== null && summary.prevComplete ? "" : t("trendPrevIncomplete");
  const summaryHint = [hintA, hintB].filter(Boolean).join(" · ") || null;
  return { summaryHint: summaryHint };
}
function selTotals(data: TrendResponse | null, summary: TrendResponse["summary"] | null) {
  const activeBuckets =
    data !== null
      ? data.series.filter(function (p) {
          return p.total !== null;
        }).length
      : 0;
  const total = summary !== null ? summary.total : null;
  const calls = summary !== null ? summary.calls : 0;
  const avg =
    summary !== null && summary.total !== null && activeBuckets > 0
      ? summary.total / activeBuckets
      : null;
  const peakVal =
    summary !== null && summary.peakKey !== null && data !== null
      ? findPeak(data.series, summary.peakKey)
      : null;
  return { activeBuckets: activeBuckets, total: total, calls: calls, avg: avg, peakVal: peakVal };
}
function selTop(
  summary: TrendResponse["summary"] | null,
  dirMode: boolean,
  gran: Gran,
  peakVal: number | null,
) {
  const peakLabel =
    summary !== null
      ? t("trendCardPeak") +
        "  ·  " +
        (summary.peakKey === null ? "-" : fmtBucketHuman(summary.peakKey, gran))
      : "";
  const peakValue = peakVal === null ? "-" : fmtCompact(peakVal);
  const topLabel = dirMode ? t("trendCardTopDir") : t("trendCardTop");
  const topValue =
    summary !== null && summary.top !== null
      ? dirMode
        ? dirDisplayLabel(summary.top.provider)
        : summary.top.provider
      : "-";
  return { peakLabel: peakLabel, peakValue: peakValue, topLabel: topLabel, topValue: topValue };
}
function getTrendSc(v: TrendScInput): {
  retentionDays: number;
  effectiveRange: number;
  effectiveView: string;
  hasData: boolean;
  providers: Array<{ provider: string; model: string | null }>;
  dirs: Array<{ dir?: string | null }>;
  dirMode: boolean;
  hiddenCount: number;
  showSummary: boolean;
  deltaText: string | null;
  deltaUp: boolean;
  summaryHint: string | null;
  peakLabel: string;
  peakValue: string;
  topLabel: string;
  topValue: string;
  total: number | null;
  calls: number;
  activeBuckets: number;
  avg: number | null;
  peakVal: number | null;
} {
  const { retentionDays, effectiveRange, effectiveView } = selRange(
    v.data,
    v.range,
    v.view,
    v.gran,
  );
  const { summary, providers, dirs } = selSource(v.data);
  const { hasData, dirMode, hiddenCount, showSummary } = selFlags(
    v.data,
    summary,
    v.dirFilter,
    v.hidden,
  );
  const { deltaText, deltaUp } = selDelta(summary);
  const { summaryHint } = selHint(v.renderBars, summary);
  const { activeBuckets, total, calls, avg, peakVal } = selTotals(v.data, summary);
  const { peakLabel, peakValue, topLabel, topValue } = selTop(summary, dirMode, v.gran, peakVal);
  return {
    retentionDays: retentionDays,
    effectiveRange: effectiveRange,
    effectiveView: effectiveView,
    hasData: hasData,
    providers: providers,
    dirs: dirs,
    dirMode: dirMode,
    hiddenCount: hiddenCount,
    showSummary: showSummary,
    deltaText: deltaText,
    deltaUp: deltaUp,
    summaryHint: summaryHint,
    peakLabel: peakLabel,
    peakValue: peakValue,
    topLabel: topLabel,
    topValue: topValue,
    total: total,
    calls: calls,
    activeBuckets: activeBuckets,
    avg: avg,
    peakVal: peakVal,
  };
}
function findPeak(series: TrendResponse["series"], key: string): number | null {
  const hit = series.find(function (p) {
    return p.key === key;
  });
  return hit !== undefined && hit.total !== null ? hit.total : null;
}

/** 「使用趋势」区块（SettingsPage 顶部；底部附加内容已按用户反馈删除，界面保持整洁）。 */
interface TrendChInput {
  hasData: boolean;
  data: TrendResponse | null;
  viewSeries: TrendResponse["series"];
  renderBars: RenderBar[];
  ticks: number[];
  stackOrder: string[];
  hidden: ReadonlySet<string>;
  tip: { idx: number; offsetX: number } | null;
  gran: Gran;
  effectiveView: string;
  dirMode: boolean;
  chartRef: React.MutableRefObject<HTMLDivElement | null>;
}
function chartTip(
  tip: { idx: number; offsetX: number } | null,
  renderBars: RenderBar[],
  viewSeries: TrendResponse["series"],
) {
  const tipIdx = tip !== null && renderBars[tip.idx] !== undefined ? tip.idx : null;
  const tipBar = tipIdx !== null ? renderBars[tipIdx] : null;
  const tipPoint = viewSeries.length > 0 && tipIdx !== null ? viewSeries[tipIdx] : null;
  const showTip = tipBar !== null && tipPoint !== null && tip !== null;
  return { tipIdx: tipIdx, tipBar: tipBar, tipPoint: tipPoint, showTip: showTip };
}
function chartTipNode(
  tipSel: {
    showTip: boolean;
    tipBar: RenderBar | null;
    tipPoint: TrendResponse["series"][number] | null;
  },
  gran: Gran,
  data: TrendResponse | null,
  hidden: ReadonlySet<string>,
  dirMode: boolean,
) {
  const tipNode =
    tipSel.showTip && tipSel.tipBar !== null && tipSel.tipPoint !== null
      ? renderTip(
          tipSel.tipBar,
          tipSel.tipPoint,
          gran,
          data !== null && data.byModel === true ? true : false,
          hidden,
          dirMode,
        )
      : null;
  return { tipNode: tipNode };
}
function chartSvg(
  effectiveView: string,
  renderBars: RenderBar[],
  gran: Gran,
  ticks: number[],
  stackOrder: string[],
) {
  const svgHtml =
    effectiveView === "area"
      ? stackedAreasSvg({
          bars: renderBars,
          gran: gran,
          ticks: ticks,
          stackOrder: stackOrder,
        })
      : stackedBarsSvg({ bars: renderBars, gran: gran, ticks: ticks });
  return { svgHtml: svgHtml };
}
function chartChrome(
  hasData: boolean,
  data: TrendResponse | null,
  stackOrder: string[],
  chartRef: React.MutableRefObject<HTMLDivElement | null>,
) {
  const showLegend = hasData && data !== null && stackOrder.length > 0;
  const tipWidth =
    chartRef.current !== null && chartRef.current.clientWidth !== undefined
      ? chartRef.current.clientWidth
      : 0;
  return { showLegend: showLegend, tipWidth: tipWidth };
}
function getTrendChart(v: TrendChInput): {
  showLegend: boolean;
  tipBar: RenderBar | null;
  tipNode: React.ReactElement | null;
  svgHtml: string;
  tipWidth: number;
} {
  const tipSel = chartTip(v.tip, v.renderBars, v.viewSeries);
  const tipNode = chartTipNode(tipSel, v.gran, v.data, v.hidden, v.dirMode).tipNode;
  const svgHtml = chartSvg(v.effectiveView, v.renderBars, v.gran, v.ticks, v.stackOrder).svgHtml;
  const chrome = chartChrome(v.hasData, v.data, v.stackOrder, v.chartRef);
  const showLegend = chrome.showLegend;
  const tipWidth = chrome.tipWidth;
  const tipBar = tipSel.tipBar;
  return {
    showLegend: showLegend,
    tipBar: tipBar,
    tipNode: tipNode,
    svgHtml: svgHtml,
    tipWidth: tipWidth,
  };
}
export function TrendSection(): React.ReactElement {
  const [gran, setGran] = React.useState<Gran>("day");
  const [range, setRange] = React.useState<number | null>(null); // null=按粒度默认（trendDefaultRange）
  const [view, setView] = React.useState<"bar" | "area" | null>(null); // null=按粒度默认（月=面积）
  const [metric, setMetric] = React.useState("total");
  const [provider, setProvider] = React.useState("");
  const [byModel, setByModel] = React.useState(false);
  // 目录维度筛选（"" = 全部目录 → byDir=1 全目录拆段面；
  // 具体目录键 → dir=<键> 过滤面；未识别桶键同为合法过滤值）。
  const [dirFilter, setDirFilter] = React.useState("");
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(new Set());
  const [data, setData] = React.useState<TrendResponse | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [tip, setTip] = React.useState<{ idx: number; offsetX: number } | null>(null);
  const chartRef = React.useRef<HTMLDivElement | null>(null);

  const retentionDays = data?.retentionDays ?? 180;
  const effectiveRange = range ?? trendDefaultRange(gran, retentionDays);

  React.useEffect(() => {
    let alive = true;
    setFailed(false);
    setLoading(true);
    // 参数构造封装为纯函数 trendRequestParams——目录过滤面
    // （dir=<键>）、全目录拆段面（byDir=1）、纯 provider 面（零目录参数）三态互斥，
    // 杜绝「provider × 目录」交叉面请求（目录面无 provider 数据，交叉必空）。
    const params = trendRequestParams(
      gran,
      metric,
      effectiveRange,
      provider,
      byModel,
      dirFilter,
      effectiveRange,
    );
    fetchTimeout(`${TREND_URL}?${params.toString()}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<TrendResponse>;
      })
      .then((body) => {
        if (alive) setData(body);
      })
      .catch(() => {
        if (alive) setFailed(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [gran, metric, provider, byModel, dirFilter, effectiveRange]);

  // 目录维度生效判定（纯函数 isDirMode：viewSeries 归一/汇总卡/图例/tooltip 据此分面）。
  const dirMode = isDirMode(data, dirFilter);
  // 目录面归一（客户端防御）：parts[].provider（承载目录键）统一经 dirStackId
  // ——非字符串/空值归未识别桶，后续 stackOrder/renderBars/tooltip/图例零特殊分支，
  // 异常值不进 id 集合（杜绝空标签与控制字符渲染）。
  const viewSeries = React.useMemo(() => {
    if (data === null || !dirMode) return data?.series ?? [];
    return data.series.map((point) => ({
      ...point,
      parts: point.parts.map((p) => ({ ...p, provider: dirStackId(p.provider) })),
    }));
  }, [data, dirMode]);

  // 窗口内段并集（按窗口总量降序 → 堆叠大段在底、跨桶位置稳定）
  const stackOrder: string[] = React.useMemo(() => {
    if (viewSeries.length === 0) return [];
    const totals = new Map<string, number>();
    for (const point of viewSeries) {
      for (const p of point.parts) {
        if (p.value === null) continue;
        const id = partId(p.provider, p.model, data?.byModel ?? false);
        totals.set(id, (totals.get(id) ?? 0) + p.value);
      }
    }
    return [...totals.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  }, [viewSeries, data?.byModel]);

  // 渲染桶：段滤隐藏/按 stackOrder 排序 + 部分桶/无数据标记（客户端判定契约见文件头）
  const renderBars: RenderBar[] = React.useMemo(() => {
    if (viewSeries.length === 0) return [];
    // 留存下限（宿主按天裁剪，客户端同口径推边缘桶）
    const cutoffKey = dayKeyOf(Date.now() - retentionDays * 86400000);
    const lo =
      data?.firstDay !== null && data?.firstDay !== undefined && data.firstDay > cutoffKey
        ? data.firstDay
        : cutoffKey;
    const byModel = data?.byModel ?? false;
    return viewSeries.map((point, idx) => {
      const byId = new Map(
        point.parts.map((p) => [partId(p.provider, p.model, byModel), p.value ?? 0] as const),
      );
      const segs = stackOrder
        .filter((id) => !hidden.has(id) && byId.has(id))
        .map((id) => ({ id, value: byId.get(id)! }));
      const visibleTotal = segs.reduce((s, seg) => s + seg.value, 0);
      const none = point.total === null;
      const mark: RenderBar["mark"] = none
        ? null
        : idx === viewSeries.length - 1 // 尾桶 = granKeys 契约恒含的当前桶（今天/本周/本月）
          ? "ongoing"
          : bucketStartKey(point.key, data?.granularity as Gran) < lo
            ? "edge"
            : null;
      return {
        key: point.key,
        segs,
        visibleTotal: segs.length > 0 ? visibleTotal : null,
        none,
        mark,
      };
    });
  }, [viewSeries, data, hidden, stackOrder, retentionDays]);

  // Y 域 = 每桶全量段合计 point.total（堆叠视觉高度的口径；hidden 不缩轴，与汇总卡
  // 「峰值」同源）。原按单段最大值推域，多段桶堆叠顶溢出轴顶。
  const ticks = React.useMemo(() => trendYTicks(viewSeries).ticks, [viewSeries]);

  // 图表事件委托：pointerdown 全输入（触屏可用），pointermove 仅鼠标（防触屏滑动误触发）。
  // 事件类型为最小结构面（shim 无 React 合成事件类型；运行时是原生 PointerEvent 透传）。
  const onChartPointer = (e: {
    target: EventTarget | null;
    currentTarget: HTMLDivElement;
    clientX: number;
    pointerType: string;
    type: string;
  }): void => {
    const target = e.target as Element | null;
    const g = typeof target?.closest === "function" ? target.closest("[data-bucket]") : null;
    if (g === null) {
      if (e.type === "pointerdown") setTip(null);
      return;
    }
    const idx = Number(g.getAttribute("data-bucket"));
    const rect = e.currentTarget.getBoundingClientRect();
    setTip({ idx, offsetX: e.clientX - rect.left });
  };

  const sc = getTrendSc({
    data: data,
    gran: gran,
    range: range,
    view: view,
    dirFilter: dirFilter,
    hidden: hidden,
    renderBars: renderBars,
  });
  const ch = getTrendChart({
    hasData: sc.hasData,
    data: data,
    viewSeries: viewSeries,
    renderBars: renderBars,
    ticks: ticks,
    stackOrder: stackOrder,
    hidden: hidden,
    tip: tip,
    gran: gran,
    effectiveView: sc.effectiveView,
    dirMode: dirMode,
    chartRef: chartRef,
  });
  const onGran = function (v: Gran): void {
    setGran(v);
    setRange(null);
    setView(null);
    setHidden(new Set());
    setTip(null);
  };
  const onRange = function (v: number): void {
    setRange(v);
    setTip(null);
  };
  const onMetric = function (v: string): void {
    setMetric(v);
    setTip(null);
  };
  const onProvider = function (v: string): void {
    setProvider(v);
    setDirFilter("");
    if (v === "") {
      setByModel(false);
    }
    setHidden(new Set());
    setTip(null);
  };
  const onDir = function (v: string): void {
    setDirFilter(v);
    setProvider("");
    setHidden(new Set());
    setTip(null);
  };
  const onByModel = function (v: boolean): void {
    setByModel(v);
    setHidden(new Set());
    setTip(null);
  };
  const onView = function (v: string): void {
    setView(v as "bar" | "area");
    setTip(null);
  };
  const onToggleHidden = function (id: string): void {
    setHidden(function (prev) {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setTip(null);
  };
  const onTipClear = function (): void {
    setTip(null);
  };
  const onPointerMove = function (e: { pointerType: string }): void {
    if (e.pointerType === "mouse") {
      onChartPointer(e as Parameters<typeof onChartPointer>[0]);
    }
  };
  return (
    <section className="dou-trend dou-pane" style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 8px" }}>{t("trendTitle")}</h2>
      <TrendControls
        gran={gran}
        retentionDays={sc.retentionDays}
        effectiveRange={sc.effectiveRange}
        metric={metric}
        provider={provider}
        byModel={byModel}
        dirFilter={dirFilter}
        effectiveView={sc.effectiveView}
        providers={sc.providers}
        dirs={sc.dirs}
        onGran={onGran}
        onRange={onRange}
        onMetric={onMetric}
        onProvider={onProvider}
        onDir={onDir}
        onByModel={onByModel}
        onView={onView}
      />
      {sc.showSummary ? (
        <TrendSummary
          total={sc.total}
          calls={sc.calls}
          avg={sc.avg}
          buckets={sc.activeBuckets}
          gran={gran}
          deltaText={sc.deltaText}
          deltaUp={sc.deltaUp}
          hint={sc.summaryHint}
          hiddenCount={sc.hiddenCount}
          peakLabel={sc.peakLabel}
          peakValue={sc.peakValue}
          topLabel={sc.topLabel}
          topValue={sc.topValue}
        />
      ) : null}
      {ch.showLegend ? (
        <TrendLegend
          order={stackOrder}
          hidden={hidden}
          dirMode={dirMode}
          hiddenCount={sc.hiddenCount}
          onToggle={onToggleHidden}
        />
      ) : null}
      <TrendChart
        failed={failed}
        empty={!sc.hasData}
        loading={loading}
        view={sc.effectiveView}
        bars={renderBars}
        gran={gran}
        ticks={ticks}
        order={stackOrder}
        tip={tip}
        tipBar={ch.tipBar}
        tipNode={ch.tipNode}
        tipWidth={ch.tipWidth}
        chartRef={chartRef}
        onDown={onChartPointer}
        onMove={onPointerMove}
        onLeave={onTipClear}
        svgHtml={ch.svgHtml}
      />
    </section>
  );
}

/** 粒度人话（汇总卡「日均」hint 单位）。 */
function granLabel(gran: Gran): string {
  return t(GRAN_LABEL_KEY_BY_GRAN[gran] ?? "trendGranMonth");
}

/** 本地日 key（客户端侧边缘桶判定用；与宿主 dayKey 同语义——本地时区逐字段取）。 */
function dayKeyOf(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** tooltip 浮层定位（贴边翻转）。 */
function tipStyle(offsetX: number, containerWidth: number): React.CSSProperties {
  const TIP_W = 210;
  let left = offsetX + 12;
  if (left + TIP_W > containerWidth && containerWidth > 0) left = offsetX - TIP_W - 8;
  return {
    position: "absolute",
    top: 6,
    left: Math.max(4, left),
    zIndex: 30,
    pointerEvents: "none",
    background: "var(--dsw-alias-bg-base,#fff)",
    border: "1px solid var(--dsw-alias-border-l2,#d3d8df)",
    borderRadius: 8,
    boxShadow: "0 4px 16px rgba(0,0,0,.14)",
    padding: "7px 10px",
    fontSize: 11,
    minWidth: 150,
    maxWidth: 250,
  };
}

/** tooltip 内容（React 节点：provider/目录名经 React 文本节点自动转义，无注入面）。 */
function renderTip(
  bar: RenderBar,
  point: NonNullable<TrendResponse>["series"][number],
  gran: Gran,
  byModel: boolean,
  hidden: ReadonlySet<string>,
  dirMode = false,
): React.ReactElement {
  const tagText =
    bar.mark === "ongoing"
      ? t("trendPartialOngoing")
      : bar.mark === "edge"
        ? t("trendPartialEdge")
        : bar.none
          ? t("trendNoData")
          : null;
  const rows = [...point.parts].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const tagEl =
    tagText === null ? null : (
      <span
        style={{
          fontSize: 10,
          padding: "0 5px",
          borderRadius: 4,
          marginLeft: 6,
          verticalAlign: 1,
          fontWeight: 400,
          color:
            bar.mark === "ongoing"
              ? "var(--dsw-alias-state-warn-primary,#d9a13c)"
              : "var(--dsw-alias-label-tertiary,#9aa0ab)",
          border: "1px solid currentColor",
        }}
      >
        {tagText}
      </span>
    );
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 3, fontVariantNumeric: "tabular-nums" }}>
        {fmtBucketHuman(point.key, gran)}
        {tagEl}
      </div>
      {...rows.length === 0
        ? [
            <div key="none" style={{ opacity: 0.6 }}>
              {t("trendNoData")}
            </div>,
          ]
        : rows.map((p, i) => {
            const id = partId(p.provider, p.model, byModel);
            const off = hidden.has(id);
            // 目录面：未识别桶恒「未识别」+ 口径注释；异常值归未识别
            const label = dirMode ? dirDisplayLabel(p.provider) : id;
            // 目录面 title 同源净化（未识别=口径注释；具名=净化标签，省略号
            // 截断时悬停可读全名）；provider 面不携带 title（原状）
            const title = dirMode
              ? dirNeedsScopeNote(p.provider)
                ? t("trendDirUnidentifiedNote")
                : dirDisplayLabel(p.provider)
              : undefined;
            return (
              <div
                key={`${id}-${i}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 14,
                  fontVariantNumeric: "tabular-nums",
                  opacity: off ? 0.45 : 1,
                }}
              >
                <span
                  title={title}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      flex: "none",
                      background: seriesColor(id),
                      display: "inline-block",
                    }}
                  />
                  {label}
                </span>
                <span>{fmtCompact(p.value)}</span>
              </div>
            );
          })}
      {rows.length > 0 ? (
        <div
          style={{
            borderTop: "1px solid var(--dsw-alias-border-l1,#e2e5ea)",
            marginTop: 4,
            paddingTop: 3,
            fontWeight: 600,
            display: "flex",
            justifyContent: "space-between",
            gap: 14,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span>
            {hidden.size > 0 ? `${t("trendTipSum")}（${t("trendViewVisible")}）` : t("trendTipSum")}
          </span>
          <span>{fmtCompact(bar.visibleTotal)}</span>
        </div>
      ) : null}
    </div>
  );
}
