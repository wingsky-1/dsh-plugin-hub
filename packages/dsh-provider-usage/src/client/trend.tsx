/**
 * dsh-provider-usage — 设置面板「使用趋势」区块。
 *
 * 【A 交互重做 + C 三项 P0】本版的四条骨架（草图：.maintenance-drafts/trend-redesign-mockup.html）：
 *
 * A1 信息架构：三个平级下拉（适配器 / 目录 / 指标）→ **常驻「统计口径」三值分段器**
 *   `[目录][适配器][模型]`（复用 SegmentedControl）+ **一个**「对象」选择器（复用 SelectField）。
 *   - 三值**恒显、永不条件渲染**：控制项的可见性不得依赖请求回包（旧的 dirMode 恒真
 *     缺陷就是这么来的）。
 *   - 「模型」档 disabled 并就地说明「需宿主支持」：宿主 dirStacked 面忽略 byModel
 *     （src/server/ui-routes/trend.ts:135），点了必然落回目录面——**不许画一个点了就空的格子**。
 *   - 适配器选择能力完整保留在「对象」选择器里（维护者 PR#1059 关闭语：暂不删除提供商选择）。
 *   - 切换口径时对象筛选**不静默清零**：给出「已重置为全部…」+ 撤销。
 *
 * A2 布局：5 张 SummaryCard → **1 主数值 + 元信息行**。
 *   - 5×minWidth:120 = 632px 是 375px 横向溢出的直接责任；主数值标签随 metric 变。
 *   - 元信息按粒度正确命名（日均 / 周均 / 月均），并给出覆盖度、调用 / 轮次 / 工具调用、
 *     Top 段占比。峰值桶改为**图上标注**（peakAnnotation），不再占一张卡。
 *   - cardStyle 的 minWidth:120 硬地板随之整体删除。
 *
 * A3 图表与语义：
 *   - 图例从 `span role=switch`（无 tabindex、键盘不可达）改为**真 <button>**
 *     （Tab 可进出、Space 切换），沿用 role="group" 容器 + button[aria-pressed]。
 *   - 环比改**中性文字色 + 方向箭头**（弃 up=warn / down=success：0.0% 会被染成绿色 success）。
 *   - 口径注记（进行中 / 基准不完整 / 起算与留存）收成**单行**。
 *   - 移动端 tooltip 改**图下方详情块**，不遮挡绘图区。
 *   - **永久禁用 role="tablist" 与 role="navigation"**：宿主设置弹窗的移动端适配规则带
 *     `:not(:has([role=navigation]))` 排除条件，命中即整弹窗退回桌面 row 布局。
 *
 * C-1 图表几何：viewBox 宽度 = **实测容器宽**（ResizeObserver，1 user unit = 1 CSS px），
 *   左边距随最长 Y 标签自适应；去掉 style 的 height:auto 等比缩放依赖。
 *   详见 trend-math.ts 的 ChartGeom 段。
 *
 * C-3 窄容器兜底：容器窄于 CHART_FALLBACK_W（240px）时**不渲染图表**，改为可读摘要 +
 *   说明 + 切换粒度的建议。
 *
 * 冻结契约（四层）：①语义层 role + aria-* ②样式钩子 dsu-* / data-dsu-* 与本包 dou-*
 *   ③DOM 结构 ④props 形状。判据一律用 role/aria 查询写，不许用 className 选元素。
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
  isDirMode,
  CALIBERS,
  CHART_FALLBACK_W,
  isCaliberAvailable,
  trendRequestParamsFor,
  caliberResetsObject,
  type RenderBar,
  type TrendGran,
  type TrendCaliber,
} from "./trend-math.js";
import { t } from "../../../../shared/client/i18n.js";
import {
  FieldRow,
  SegmentedControl,
  SelectField,
  Surface,
} from "../../../../shared/client/ui/index.js";

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

/** 元信息格（取代原 5 张 SummaryCard；零 minWidth 地板，靠 grid 自适应换行）。 */
function MetaCell(props: {
  label: string;
  value: string;
  note?: string | null;
  valueClassName?: string;
}): React.ReactElement {
  return (
    <div className="dou-trend-metaCell">
      <div className="dou-trend-metaKey">{props.label}</div>
      <div className={props.valueClassName ?? "dou-trend-metaVal"}>{props.value}</div>
      {props.note !== undefined && props.note !== null && props.note !== "" ? (
        <div className="dou-trend-metaNote">{props.note}</div>
      ) : null}
    </div>
  );
}

/**
 * 主数值行（A2）：1 个主数值 + 单位 + 环比。
 * 环比走**中性文字色 + 方向箭头**：状态色只留给真异常与口径提示（0.0% 过去会被
 * up=false 判成 down 从而染成 success 绿，属误报）。
 */
function TrendHero(props: {
  label: string;
  value: string;
  unit: string | null;
  deltaText: string | null;
  deltaDir: "up" | "down" | "flat" | null;
}): React.ReactElement {
  return (
    <div className="dou-trend-hero">
      <span className="dou-trend-heroLabel">{props.label}</span>
      <span className="dou-trend-heroVal">{props.value}</span>
      {props.unit !== null ? <span className="dou-trend-heroUnit">{props.unit}</span> : null}
      {props.deltaText !== null ? (
        <span className="dou-trend-heroDelta">
          <span aria-hidden="true">
            {props.deltaDir === "up"
              ? t("trendDeltaUp")
              : props.deltaDir === "down"
                ? t("trendDeltaDown")
                : t("trendDeltaFlat")}
          </span>
          {props.deltaText}
        </span>
      ) : null}
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
/** 口径档位 → 分段器文案键（查表；「模型」档另带「需宿主支持」角标）。 */
const CALIBER_LABEL_KEY: Record<TrendCaliber, string> = {
  dir: "trendCaliberDir",
  provider: "trendCaliberProvider",
  model: "trendCaliberModel",
};

interface TrendControlsProps {
  gran: Gran;
  retentionDays: number;
  effectiveRange: number;
  metric: string;
  caliber: TrendCaliber;
  objectValue: string;
  objectOptions: ReadonlyArray<{ value: string; label: string }>;
  objectResetAll: string | null;
  effectiveView: string;
  onGran: (v: Gran) => void;
  onRange: (v: number) => void;
  onMetric: (v: string) => void;
  onCaliber: (v: TrendCaliber) => void;
  onObject: (v: string) => void;
  onUndoReset: () => void;
  onView: (v: string) => void;
}

/**
 * 控件区（A1）。
 * 结构固定为四层：统计口径三值 → 对象 → 粒度/范围/指标/形态。
 * 「对象」的候选项由口径派生（目录口径列目录、适配器口径列适配器），但**控件本身恒在**：
 * 口径切换只换候选项，不增删控件（三个下拉互斥显隐正是旧的认知负荷来源）。
 */
function TrendControls(p: TrendControlsProps): React.ReactElement {
  return (
    <div className="dou-trend-controls">
      <SegmentedControl
        variant="pill"
        label={t("trendCaliberLabel")}
        value={p.caliber}
        onChange={p.onCaliber}
        options={CALIBERS.map(function (c) {
          return {
            value: c,
            disabled: !isCaliberAvailable(c),
            label: (
              <React.Fragment>
                {t(CALIBER_LABEL_KEY[c])}
                {isCaliberAvailable(c) ? null : (
                  <span className="dou-trend-need">{t("trendCaliberModelNeed")}</span>
                )}
              </React.Fragment>
            ),
          };
        })}
      />
      {/* 就地说明「模型」档为何不可选。判据是**该档存在且不可用**，不是「该档正被选中」——
          后者在「模型」恒 disabled 的前提下永远为假，说明就成了永不显示的死文案，
          等于把「不许画一个点了就空的格子」换成「画一个永远不解释的灰格子」。
          一旦宿主支持按模型拆分、该档转为可选，此行自动消失。 */}
      {CALIBERS.some((c) => !isCaliberAvailable(c)) ? (
        <p className="dou-trend-calNote">{t("trendCaliberModelNote")}</p>
      ) : null}
      <FieldRow className="dou-trend-fields">
        <SelectField
          label={t("trendObjectLabel")}
          value={p.objectValue}
          options={p.objectOptions}
          onValue={p.onObject}
        />
        <SegmentedControl
          variant="plain"
          label={t("trendGranularity")}
          value={p.gran}
          onChange={function (v) {
            p.onGran(v as Gran);
          }}
          options={GRAN_ITEMS.map(function (it) {
            return { value: it[0], label: t(it[1]) };
          })}
          itemClassName="dou-btn"
        />
        <SegmentedControl
          variant="plain"
          label={t("trendRangeLabel")}
          value={String(p.effectiveRange)}
          onChange={function (v) {
            p.onRange(Number(v));
          }}
          options={trendRangeOptions(p.gran, p.retentionDays).map(function (n) {
            return { value: String(n), label: t(unitKeyOf(p.gran), { n: String(n) }) };
          })}
          itemClassName="dou-btn"
        />
        <SelectField
          label={t("trendMetricLabel")}
          value={p.metric}
          options={METRIC_ITEMS.map(function (it) {
            return { value: it[0], label: t(it[1]) };
          })}
          onValue={p.onMetric}
        />
        <SegmentedControl
          variant="plain"
          label={t("trendViewLabel")}
          value={p.effectiveView}
          onChange={p.onView}
          options={VIEW_ITEMS.map(function (it) {
            return { value: it[0], label: t(it[1]) };
          })}
          itemClassName="dou-btn"
        />
      </FieldRow>
      {p.objectResetAll !== null ? (
        <p className="dou-trend-reset" role="status">
          <span>{t("trendObjectResetNotice", { all: p.objectResetAll })}</span>
          <button
            type="button"
            className="dou-btn"
            onClick={function () {
              p.onUndoReset();
            }}
          >
            {t("trendObjectUndo")}
          </button>
        </p>
      ) : null}
    </div>
  );
}
interface TrendChartProps {
  failed: boolean;
  empty: boolean;
  loading: boolean;
  /** 实测内容盒宽（0 = 尚未测量 / 容器无布局，C-1 的 viewBox 宽度事实源）。 */
  width: number;
  tip: { idx: number; offsetX: number } | null;
  tipNode: React.ReactElement | null;
  tipWidth: number;
  /** 窄容器档（width < CHART_FALLBACK_W）：tooltip 改图下详情块，不遮挡绘图区。 */
  narrow: boolean;
  onGranSuggest: () => void;
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

/**
 * 布局档阈值：**容器实测内容盒宽 <= 此值走窄档**（data-dou-col="s"）。
 *
 * 与 C-3 的 240px 不是同一个数：240 是「再窄图表已不可读、干脆不画」的下限，
 * 这里管的是「控件整列排布 + 元信息两列 + tooltip 移出绘图区」的排版档。
 * 断点用 ResizeObserver 写 data-dou-col 而非 @media——理由见 TrendSection 里的
 * 宽度测量 effect（桌面内容列恒 508px，800px 平板反而 692px，按视口会判反）。
 */
const LAYOUT_NARROW_PX = 400;

/** 布局档：窄档整列排布，其余走默认横排。CSS 侧只认 [data-dou-col="s"]。 */
function layoutCol(width: number): "s" | "wide" {
  return width > 0 && width <= LAYOUT_NARROW_PX ? "s" : "wide";
}

/**
 * C-3 窄容器兜底。
 *
 * 【根因在宿主，不在插件】375px 视口下宿主设置弹窗把内容列压到 **56px**
 * （实测 dsu-surface-pane 宽 56，而子控件 159px），且 .dou-set-card 的 overflow:hidden
 * 会把溢出部分裁掉。宿主容器宽度是**宿主行为**，插件侧改不了，只能降级不能根治。
 * 故本分支不渲染图表（56px 下任何图表都是 0.5px 命中区的噪音），改给可读摘要 +
 * 说明 + 切换粒度的建议。
 */
function TrendNarrow(props: { onGranSuggest: () => void }): React.ReactElement {
  return (
    <div className="dou-trend-narrow" role="note">
      <div className="dou-trend-narrowTitle">{t("trendNarrowTitle")}</div>
      <p className="dou-trend-narrowHint">{t("trendNarrowHint")}</p>
      <p className="dou-trend-narrowSuggest">{t("trendNarrowSuggest")}</p>
      <button type="button" className="dou-btn" onClick={props.onGranSuggest}>
        {t("trendGranularity")}
      </button>
    </div>
  );
}

/** 错误态（请求失败）：与图表几何无关，独立早返回以免给主函数加分支。 */
function TrendError(): React.ReactElement {
  return <div className="dou-trend-error">{t("trendFetchFail")}</div>;
}

/** 空态（窗口内无任何有记录桶）：两行文案是引导，不并入注记行。 */
function TrendEmpty(): React.ReactElement {
  return (
    <div className="dou-trend-empty">
      <div className="dou-trend-emptyTitle">{t("trendEmptyTitle")}</div>
      <div className="dou-trend-emptyHint">{t("trendEmptyHint")}</div>
    </div>
  );
}

/**
 * 三态早返回（失败 / 空 / 窄容器降级）在此判完，下面只画有数据的图表。
 * C-3 判据：容器实测宽 > 0 且 < CHART_FALLBACK_W（根因在宿主弹窗容器，插件侧无法根治）。
 */
function trendChartState(p: TrendChartProps): "error" | "empty" | "narrow" | "chart" {
  if (p.failed) return "error";
  if (p.empty) return "empty";
  if (p.width > 0 && p.width < CHART_FALLBACK_W) return "narrow";
  return "chart";
}

/**
 * 桶明细的两种落点（A3）：宽屏 = 图上贴边浮层；窄屏 = 图下方详情块（不遮挡绘图区）。
 * 拆成独立函数是有意的：两者互斥且各有条件分支，混进 TrendChart 会把主函数的
 * 圈复杂度顶过门禁阈值。
 */
function TrendTipLayer(props: {
  narrow: boolean;
  tip: { idx: number; offsetX: number } | null;
  tipNode: React.ReactElement | null;
  tipWidth: number;
}): React.ReactElement | null {
  const { narrow, tip, tipNode, tipWidth } = props;
  if (tipNode === null) return null;
  if (narrow) {
    return (
      <div className="dou-trend-detail" aria-live="polite">
        <div className="dou-trend-detailLabel">{t("trendDetailLabel")}</div>
        {tipNode}
      </div>
    );
  }
  if (tip === null) return null;
  return (
    <div className="dou-trend-tip" style={tipStyle(tip.offsetX, tipWidth)}>
      {tipNode}
    </div>
  );
}

/** 窄屏详情块在无选中桶时给一行引导（否则详情块空白，用户不知道图上可点）。 */
function TrendDetailHint(): React.ReactElement {
  return <div className="dou-trend-detailHint">{t("trendDetailHint")}</div>;
}

function TrendChart(p: TrendChartProps): React.ReactElement {
  const state = trendChartState(p);
  if (state === "error") return <TrendError />;
  if (state === "empty") return <TrendEmpty />;
  if (state === "narrow") return <TrendNarrow onGranSuggest={p.onGranSuggest} />;
  return (
    <div
      ref={p.chartRef}
      className="dou-trend-chart"
      data-dou-narrow={p.narrow ? "true" : undefined}
      style={{
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
      {p.narrow && p.tipNode === null ? <TrendDetailHint /> : null}
      <TrendTipLayer narrow={p.narrow} tip={p.tip} tipNode={p.tipNode} tipWidth={p.tipWidth} />
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

/**
 * 图例（A3）。
 * 旧实现是 `span role=switch` 且无 tabindex → 键盘完全不可达（Tab 进不去、Space 切不了）。
 * 改为真 <button>：原生键盘可达（Tab 可进出、Space/Enter 切换），语义层保持
 * role="group" 容器 + button[aria-pressed]（与原语层 SegmentedControl 同一约定，
 * 且**不引入** role="tablist"/"navigation"——宿主 :not(:has([role=navigation])) 命中即
 * 手机内容区被压）。
 */
function TrendLegend(p: TrendLegendProps): React.ReactElement {
  return (
    <div className="dou-trend-legend" role="group" aria-label={t("trendLegendLabel")}>
      {p.order.map(function (id) {
        const off = p.hidden.has(id);
        const label = p.dirMode ? dirDisplayLabel(id) : id;
        const title = p.dirMode
          ? dirNeedsScopeNote(id)
            ? t("trendDirUnidentifiedNote")
            : dirDisplayLabel(id)
          : undefined;
        return (
          <button
            key={id}
            type="button"
            className="dou-trend-legendItem"
            aria-pressed={!off}
            title={title}
            onClick={function () {
              p.onToggle(id);
            }}
          >
            <span
              className="dou-trend-legendDot"
              style={{ background: off ? "transparent" : seriesColor(id) }}
            />
            <span className="dou-trend-legendName">{label}</span>
          </button>
        );
      })}
      <span className="dou-trend-legendHint">
        {p.hiddenCount > 0
          ? t("trendHiddenParts", { k: String(p.hiddenCount) })
          : t("trendLegendToggleHint")}
      </span>
    </div>
  );
}
interface TrendSummaryProps {
  heroLabel: string;
  heroUnit: string | null;
  total: number | null;
  calls: number;
  turns: number;
  toolCalls: number;
  avg: number | null;
  activeBuckets: number;
  totalBuckets: number;
  gran: Gran;
  deltaText: string | null;
  deltaDir: "up" | "down" | "flat" | null;
  topLabel: string;
  topValue: string;
  topShare: string | null;
  notes: string[];
}

/**
 * 汇总区（A2）：1 主数值 + 4 格元信息。
 * 原 5 张 SummaryCard 的 flex:1 1 120px + minWidth:120 是 375px 横向溢出的直接责任
 * （5×120=632px 不可压缩）；此处改 grid，零 minWidth 地板，窄屏由 CSS 两列换行兜底。
 * 均值按粒度正确命名（日均 / 周均 / 月均）——原实现恒标「日均」却除的是桶数。
 */
function TrendSummary(p: TrendSummaryProps): React.ReactElement {
  const unit = granUnit(p.gran);
  return (
    <div className="dou-trend-summary">
      <TrendHero
        label={p.heroLabel}
        value={p.total === null ? "-" : fmtCompact(p.total)}
        unit={p.heroUnit}
        deltaText={p.deltaText}
        deltaDir={p.deltaDir}
      />
      <div className="dou-trend-meta">
        <MetaCell
          label={t("trendMetaAvgLabel", { unit: unit })}
          value={p.avg === null ? "-" : fmtCompact(p.avg)}
          note={t("trendMetaAvgNote", { n: String(p.activeBuckets), unit: unit })}
        />
        <MetaCell
          label={t("trendMetaCoverage")}
          value={p.totalBuckets === 0 ? "-" : `${p.activeBuckets}/${p.totalBuckets}`}
        />
        <MetaCell
          label={t("trendMetaCalls")}
          value={fmtCompact(p.calls)}
          note={`${t("trendMetaTurns")} ${fmtCompact(p.turns)} · ${t("trendMetaToolCalls")} ${fmtCompact(p.toolCalls)}`}
        />
        <MetaCell
          label={p.topLabel}
          value={p.topValue}
          valueClassName="dou-trend-metaVal dou-trend-metaValText"
          note={p.topShare === null ? null : `${t("trendMetaTopShare")} ${p.topShare}`}
        />
      </div>
      {p.notes.length === 0 ? null : <p className="dou-trend-notes">{p.notes.join(" · ")}</p>}
    </div>
  );
}
interface TrendScInput {
  data: TrendResponse | null;
  gran: Gran;
  range: number | null;
  view: string | null;
  metric: string;
  caliber: TrendCaliber;
  objectValue: string;
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

/**
 * 环比方向（A3：中性不着色）。
 * 原实现只有 up 一个布尔且 up=pct>0，于是 pct===0 时 up=false 被下游判成 down →
 * 涂成 success 绿。此处显式给三态（up / down / flat），颜色一律中性文字色。
 */
function selDelta(summary: TrendResponse["summary"] | null) {
  const delta = trendDelta(
    summary !== null ? summary.total : null,
    summary !== null ? summary.prevTotal : null,
    summary !== null ? summary.prevComplete : true,
  );
  const deltaText = delta !== null ? delta.text : null;
  const deltaDir: "up" | "down" | "flat" | null =
    delta === null ? null : delta.up ? "up" : delta.down ? "down" : "flat";
  return { deltaText: deltaText, deltaDir: deltaDir };
}

/** 口径注记（A3：收成单行，进行中 / 基准不完整 / 起算与留存）。 */
function selNotes(
  renderBars: RenderBar[],
  summary: TrendResponse["summary"] | null,
  onset: string | null,
): string[] {
  const ongoing = renderBars.some(function (b) {
    return b.mark === "ongoing";
  });
  const out: string[] = [];
  if (ongoing) out.push(t("trendPartialOngoing"));
  if (summary !== null && !summary.prevComplete) out.push(t("trendPrevIncomplete"));
  if (onset !== null) out.push(onset);
  return out;
}
function selTotals(data: TrendResponse | null, summary: TrendResponse["summary"] | null) {
  const activeBuckets =
    data !== null
      ? data.series.filter(function (p) {
          return p.total !== null;
        }).length
      : 0;
  const totalBuckets = data !== null ? data.series.length : 0;
  const total = summary !== null ? summary.total : null;
  const calls = summary !== null ? summary.calls : 0;
  const turns = summary !== null ? summary.turns : 0;
  const toolCalls = summary !== null ? summary.toolCalls : 0;
  // 均值口径 = 窗口总量 / **有记录桶数**（旧实现除的是桶数却恒标「日均」，
  // 周/月粒度下口径错名；此处按粒度正确命名，见 granUnit）。
  const avg =
    summary !== null && summary.total !== null && activeBuckets > 0
      ? summary.total / activeBuckets
      : null;
  return {
    activeBuckets: activeBuckets,
    totalBuckets: totalBuckets,
    total: total,
    calls: calls,
    turns: turns,
    toolCalls: toolCalls,
    avg: avg,
  };
}

/**
 * Top 段（D7 口径修正）：summary.top 是「窗口内**最大单段值**所属段」
 * （aggregate-query.ts:319-323），不是窗口累计 Top——问「谁占比最高」会拿到错答案。
 * 改用客户端已算好的 stackOrder[0]（窗口内段总量降序）并给占比。
 */
function selTop(
  stackOrder: string[],
  stackTotals: Map<string, number>,
  dirMode: boolean,
  windowTotal: number | null,
) {
  const topId = stackOrder.length > 0 ? stackOrder[0] : null;
  const topValue = topId === null ? "-" : dirMode ? dirDisplayLabel(topId) : topId;
  const topRaw = topId === null ? 0 : (stackTotals.get(topId) ?? 0);
  const topShare =
    topId === null || windowTotal === null || !(windowTotal > 0)
      ? null
      : `${Math.round((topRaw / windowTotal) * 100)}%`;
  const topLabel = dirMode ? t("trendCardTopDir") : t("trendCardTop");
  return { topLabel: topLabel, topValue: topValue, topShare: topShare };
}

/** 主数值标签随 metric 变（A2）：指标决定「主数值」是什么，不是恒写「窗口总量」。 */
function selHero(metric: string): { label: string; unit: string | null } {
  const hit = METRIC_ITEMS.find(function (it) {
    return it[0] === metric;
  });
  return {
    label: t(hit !== undefined ? hit[1] : "trendMetricTotal"),
    unit: metric === "calls" ? null : t("reportHeroTotal"),
  };
}

/** 粒度 → 均值/峰值的人话单位（日 / 周 / 月；均值按此命名而非恒「日均」）。 */
function granUnit(gran: Gran): string {
  return gran === "day"
    ? t("trendUnitDay")
    : gran === "week"
      ? t("trendUnitWeek")
      : t("trendUnitMonth");
}

/** 「对象」候选项：由口径派生（目录口径列目录，适配器口径列适配器），控件本身恒在。 */
function selObjectOptions(
  caliber: TrendCaliber,
  providers: Array<{ provider: string; model: string | null }>,
  dirs: Array<{ dir?: string | null }>,
): Array<{ value: string; label: string }> {
  if (!isCaliberAvailable(caliber)) return [{ value: "", label: t("trendObjectAllProvider") }];
  if (caliber === "provider") {
    return [
      { value: "", label: t("trendObjectAllProvider") },
      ...providers.map(function (pr) {
        return { value: pr.provider, label: pr.provider };
      }),
    ];
  }
  return [
    { value: "", label: t("trendObjectAllDir") },
    ...dirs.map(function (d) {
      const key = dirStackId(d.dir);
      return { value: key, label: dirDisplayLabel(key) };
    }),
  ];
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
  deltaDir: "up" | "down" | "flat" | null;
  notes: string[];
  heroLabel: string;
  heroUnit: string | null;
  topLabel: string;
  topValue: string;
  topShare: string | null;
  total: number | null;
  calls: number;
  turns: number;
  toolCalls: number;
  activeBuckets: number;
  totalBuckets: number;
  avg: number | null;
  objectOptions: Array<{ value: string; label: string }>;
} {
  const { retentionDays, effectiveRange, effectiveView } = selRange(
    v.data,
    v.range,
    v.view,
    v.gran,
  );
  const { summary, providers, dirs } = selSource(v.data);
  // 目录面判定仍取回包（byDir / dirs）——但**不再用它决定任何控件的可见性**
  // （那是 A1 要根治的 dirMode 恒真缺陷），只用于段 id 归一与文案。
  const dirFilter = v.caliber === "dir" ? v.objectValue : "";
  const { hasData, dirMode, hiddenCount, showSummary } = selFlags(
    v.data,
    summary,
    dirFilter,
    v.hidden,
  );
  const { deltaText, deltaDir } = selDelta(summary);
  const { total, calls, turns, toolCalls, avg, activeBuckets, totalBuckets } = selTotals(
    v.data,
    summary,
  );
  const stackTotals = stackTotalsOf(v.renderBars);
  const stackOrder = [...stackTotals.keys()].sort(function (a, b) {
    return (stackTotals.get(b) ?? 0) - (stackTotals.get(a) ?? 0);
  });
  const { topLabel, topValue, topShare } = selTop(stackOrder, stackTotals, dirMode, total);
  const hero = selHero(v.metric);
  const notes = selNotes(v.renderBars, summary, onsetNote(v.data, retentionDays));
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
    deltaDir: deltaDir,
    notes: notes,
    heroLabel: hero.label,
    heroUnit: hero.unit,
    topLabel: topLabel,
    topValue: topValue,
    topShare: topShare,
    total: total,
    calls: calls,
    turns: turns,
    toolCalls: toolCalls,
    activeBuckets: activeBuckets,
    totalBuckets: totalBuckets,
    avg: avg,
    objectOptions: selObjectOptions(v.caliber, providers, dirs),
  };
}

/** 窗口内段总量（Top 段与占比的分子；键与 stackOrder 同构）。 */
function stackTotalsOf(bars: RenderBar[]): Map<string, number> {
  const acc = new Map<string, number>();
  for (const b of bars) {
    for (const s of b.segs) acc.set(s.id, (acc.get(s.id) ?? 0) + s.value);
  }
  return acc;
}

/** 起算注记：数据首日在留存窗内时说明「起算自哪天」（数据不满留存期，非异常）。 */
function onsetNote(data: TrendResponse | null, retentionDays: number): string | null {
  if (data === null || data.firstDay === null) return null;
  const cutoff = dayKeyOf(Date.now() - retentionDays * 86400000);
  return data.firstDay > cutoff ? t("trendCaliberNoteOnset", { first: data.firstDay }) : null;
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
  /** C-1：实测内容盒宽（viewBox 宽度事实源；0 = 尚未测量）。 */
  chartWidth: number;
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

/** 峰值桶在渲染桶序列中的下标（图上标注用；找不到返回 -1 = 不标注）。 */
function peakIndexOf(
  renderBars: RenderBar[],
  peakKey: string | null,
): { index: number; key: string } {
  if (peakKey === null) return { index: -1, key: "" };
  const i = renderBars.findIndex(function (b) {
    return b.key === peakKey;
  });
  return { index: i, key: peakKey };
}

/**
 * SVG 生成（C-1：宽度取实测容器宽 → viewBox 1 user unit = 1 CSS px）。
 * 峰值桶一并传入，由 trend-math 在图上画标记（不再占一张汇总卡）。
 */
function chartSvg(
  effectiveView: string,
  renderBars: RenderBar[],
  gran: Gran,
  ticks: number[],
  stackOrder: string[],
  width: number,
  peak: { index: number; key: string },
) {
  const svgHtml =
    effectiveView === "area"
      ? stackedAreasSvg({
          bars: renderBars,
          gran: gran,
          ticks: ticks,
          stackOrder: stackOrder,
          width: width,
          peakIndex: peak.index,
          peakKey: peak.index >= 0 ? peak.key : null,
        })
      : stackedBarsSvg({
          bars: renderBars,
          gran: gran,
          ticks: ticks,
          width: width,
          peakIndex: peak.index,
          peakKey: peak.index >= 0 ? peak.key : null,
        });
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
  tipNode: React.ReactElement | null;
  svgHtml: string;
  tipWidth: number;
} {
  const tipSel = chartTip(v.tip, v.renderBars, v.viewSeries);
  const tipNode = chartTipNode(tipSel, v.gran, v.data, v.hidden, v.dirMode).tipNode;
  const peak = peakIndexOf(
    v.renderBars,
    v.data !== null && v.data.summary !== undefined ? v.data.summary.peakKey : null,
  );
  const svgHtml = chartSvg(
    v.effectiveView,
    v.renderBars,
    v.gran,
    v.ticks,
    v.stackOrder,
    v.chartWidth,
    peak,
  ).svgHtml;
  const chrome = chartChrome(v.hasData, v.data, v.stackOrder, v.chartRef);
  return {
    showLegend: chrome.showLegend,
    tipNode: tipNode,
    svgHtml: svgHtml,
    tipWidth: chrome.tipWidth,
  };
}
export function TrendSection(): React.ReactElement {
  const [gran, setGran] = React.useState<Gran>("day");
  const [range, setRange] = React.useState<number | null>(null); // null=按粒度默认（trendDefaultRange）
  const [view, setView] = React.useState<"bar" | "area" | null>(null); // null=按粒度默认（月=面积）
  const [metric, setMetric] = React.useState("total");
  // A1：口径（目录/适配器/模型）+ 单一「对象」值。旧的两个互斥下拉
  // （provider / dirFilter）+ 按模型复选框收敛成一对状态。
  const [caliber, setCaliber] = React.useState<TrendCaliber>("dir");
  const [objectValue, setObjectValue] = React.useState("");
  // 切换口径导致对象筛选被重置时，记住上一组 (口径, 对象) 供「撤销」用——
  // 对象筛选不静默清零（A1 硬要求：清零必须可感知、可回退）。
  const [undo, setUndo] = React.useState<{ caliber: TrendCaliber; object: string } | null>(null);
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(new Set());
  const [data, setData] = React.useState<TrendResponse | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [tip, setTip] = React.useState<{ idx: number; offsetX: number } | null>(null);
  // C-1：图表容器实测内容盒宽（0 = 尚未测量）。viewBox 宽度由此给出，
  // 1 user unit = 1 CSS px，字号与命中区不再随容器等比缩小。
  const [chartWidth, setChartWidth] = React.useState(0);
  const chartRef = React.useRef<HTMLDivElement | null>(null);
  const measureRef = React.useRef<HTMLDivElement | null>(null);

  const retentionDays = data?.retentionDays ?? 180;
  const effectiveRange = range ?? trendDefaultRange(gran, retentionDays);

  // 目录过滤面参数（供 isDirMode 段归一与文案分面；不再决定控件可见性）。
  const dirFilter = caliber === "dir" ? objectValue : "";

  React.useEffect(() => {
    let alive = true;
    setFailed(false);
    setLoading(true);
    // 参数构造封装为纯函数 trendRequestParamsFor——目录全拆段面（byDir=1）、
    // 目录过滤面（dir=<键>）、纯 provider 面（零目录参数）三态互斥，
    // 杜绝「provider × 目录」交叉面请求（目录面无 provider 数据，交叉必空）。
    const params = trendRequestParamsFor(caliber, gran, metric, effectiveRange, objectValue);
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
  }, [gran, metric, caliber, objectValue, effectiveRange]);

  /**
   * C-1 宽度测量：ResizeObserver 观察图表容器 → 写 state → viewBox 用实测宽。
   *
   * 【为什么不用 @media】.dsu-surface-card 的 max-width: 560 使桌面内容列恒定，
   * 而 800px 平板的 column 布局内容列约 692px，比桌面**更宽**——按视口断点会判反。
   * 故断点基准 = 容器实测宽，JS 判定，不引第二套响应式机制。
   * 量的是**内容盒**（去 padding），不是 clientWidth 混着边框。
   */
  React.useEffect(() => {
    const el = measureRef.current;
    if (el === null) return;
    const read = function (): void {
      const cs = window.getComputedStyle(el);
      const inner =
        el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      setChartWidth(Math.max(0, Math.round(inner)));
    };
    read();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", read);
      return () => window.removeEventListener("resize", read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 目录维度生效判定（纯函数 isDirMode：viewSeries 归一/汇总/图例/tooltip 据此分面）。
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

  // Y 域 = 每桶全量段合计 point.total（堆叠视觉高度的口径；hidden 不缩轴，与汇总
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
    metric: metric,
    caliber: caliber,
    objectValue: objectValue,
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
    chartWidth: chartWidth,
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
  const onObject = function (v: string): void {
    setObjectValue(v);
    setUndo(null);
    setHidden(new Set());
    setTip(null);
  };
  /**
   * 切换口径：对象值跨命名空间多半落空 → 显式重置并留撤销点，
   * 而不是让筛选无声消失（旧的三个控件互斥清零正是这条硬伤的来源）。
   */
  const onCaliber = function (v: TrendCaliber): void {
    if (v === caliber || !isCaliberAvailable(v)) return;
    const willReset = caliberResetsObject(caliber, v, objectValue, function (val) {
      return selObjectOptions(v, sc.providers, sc.dirs).some(function (o) {
        return o.value === val;
      });
    });
    if (willReset) setUndo({ caliber: caliber, object: objectValue });
    else setUndo(null);
    setCaliber(v);
    setObjectValue(willReset ? "" : objectValue);
    setHidden(new Set());
    setTip(null);
  };
  const onUndoReset = function (): void {
    if (undo === null) return;
    setCaliber(undo.caliber);
    setObjectValue(undo.object);
    setUndo(null);
    setTip(null);
  };
  const onView = function (v: string): void {
    setView(v as "bar" | "area");
    setTip(null);
  };
  const onGranSuggest = function (): void {
    // C-3 兜底里的「换更粗粒度」建议：日 → 周（已是月则回日，等价于循环换档）。
    setGran(gran === "day" ? "week" : "day");
    setRange(null);
    setView(null);
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
  // 窄容器档：既用于 C-3 降级，也用于「tooltip 改图下详情块」（两者同阈）。
  const narrow = chartWidth > 0 && chartWidth < CHART_FALLBACK_W;
  return (
    <Surface variant="pane" className="dou-trend">
      <div className="dou-trend-body" data-dou-col={layoutCol(chartWidth)}>
        <h2 className="dou-trend-title">{t("trendTitle")}</h2>
        <TrendControls
          gran={gran}
          retentionDays={sc.retentionDays}
          effectiveRange={sc.effectiveRange}
          metric={metric}
          caliber={caliber}
          objectValue={objectValue}
          objectOptions={sc.objectOptions}
          objectResetAll={undo === null ? null : t("trendObjectAllProvider")}
          effectiveView={sc.effectiveView}
          onGran={onGran}
          onRange={onRange}
          onMetric={onMetric}
          onCaliber={onCaliber}
          onObject={onObject}
          onUndoReset={onUndoReset}
          onView={onView}
        />
        {sc.showSummary ? (
          <TrendSummary
            heroLabel={sc.heroLabel}
            heroUnit={sc.heroUnit}
            total={sc.total}
            calls={sc.calls}
            turns={sc.turns}
            toolCalls={sc.toolCalls}
            avg={sc.avg}
            activeBuckets={sc.activeBuckets}
            totalBuckets={sc.totalBuckets}
            gran={gran}
            deltaText={sc.deltaText}
            deltaDir={sc.deltaDir}
            topLabel={sc.topLabel}
            topValue={sc.topValue}
            topShare={sc.topShare}
            notes={sc.notes}
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
        <div className="dou-trend-plot" ref={measureRef}>
          <TrendChart
            failed={failed}
            empty={!sc.hasData}
            loading={loading}
            width={chartWidth}
            tip={tip}
            tipNode={ch.tipNode}
            tipWidth={ch.tipWidth}
            narrow={narrow}
            onGranSuggest={onGranSuggest}
            chartRef={chartRef}
            onDown={onChartPointer}
            onMove={onPointerMove}
            onLeave={onTipClear}
            svgHtml={ch.svgHtml}
          />
        </div>
      </div>
    </Surface>
  );
}
/** 本地日 key（客户端侧边缘桶判定用；与宿主 dayKey 同语义——本地时区逐字段取）。 */
function dayKeyOf(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** tooltip 浮层贴边偏移（贴右越界则翻到左侧；纯定位，外观全在 style.css）。 */
function tipStyle(offsetX: number, containerWidth: number): React.CSSProperties {
  const TIP_W = 210;
  let left = offsetX + 12;
  if (left + TIP_W > containerWidth && containerWidth > 0) left = offsetX - TIP_W - 8;
  return { left: Math.max(4, left) };
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
                </span>{" "}
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
