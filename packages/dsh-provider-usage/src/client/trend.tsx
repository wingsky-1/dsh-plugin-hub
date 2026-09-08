/**
 * dsh-provider-usage — 设置面板「使用趋势」区块（#503 M2 / M2.1 视图改版）。
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
 *   既有评审决策一致：宿主 shell 的路由事实源不可被插件页假设）。
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
  type RenderBar,
  type TrendGran,
} from "./trend-math.js";
import { t } from "../../../../shared/client/i18n.js";

// ---------------------------------------------------------------- 类型

/** /trend 响应（宿主端聚合；#503 M2.1 增 n/retentionDays/summary.prevComplete）。 */
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
  series: Array<{ key: string; total: number | null; parts: Array<{ provider: string; model: string | null; value: number | null }> }>;
  providers: Array<{ provider: string; model: string | null }>;
  /** 目录图例（#633 分片 b：目录面携带，含未识别桶；provider 面 = 空数组）。 */
  dirs?: Array<{ dir?: string | null }>;
  /** #633 分片 b2：byDir=1 全目录面回显（客户端哨兵：分布区/下拉数据源判定）。 */
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

const cardStyle: Object = {
  flex: "1 1 120px",
  minWidth: 120,
  padding: "8px 10px",
  border: "1px solid var(--dsw-alias-border-l2,#e8eaf0)",
  borderRadius: 8,
  background: "var(--dsw-alias-bg-layer-1,#f8f9fb)",
};

const controlBtnStyle = (active: boolean): Object => ({
  padding: "3px 10px",
  fontSize: 12,
  borderRadius: 6,
  border: "1px solid var(--dsw-alias-border-l2,#e8eaf0)",
  background: active ? "var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))" : "transparent",
  cursor: "pointer",
  color: "inherit",
});

const miniBtnStyle = (active: boolean): Object => ({ ...controlBtnStyle(active), padding: "2px 8px", fontSize: 11 });

const selectStyle: Object = {
  fontSize: 12,
  padding: "3px 6px",
  borderRadius: 6,
  border: "1px solid var(--dsw-alias-border-l2,#e8eaf0)",
  background: "var(--dsw-alias-bg-base,#fdfdfd)",
  color: "inherit",
};

/** 汇总卡（值 + 标签 + 可选角标 + 可选 hint）。 */
function SummaryCard(props: { label: string; value: string; delta?: string | null; up?: boolean; hint?: string | null }): React.ReactElement {
  const { label, value, delta, up, hint } = props;
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary,#9aa0ab)" }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums", display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
        {value}
        {delta !== undefined && delta !== null ? (
          <span style={{ fontSize: 11, fontWeight: 600, color: up ? "var(--dsw-alias-state-warn-primary,#d9a13c)" : "var(--dsw-alias-state-success-primary,#3f9d63)" }}>
            {delta}
          </span>
        ) : null}
        {hint != null && hint !== "" ? <span style={{ fontSize: 10, fontWeight: 400, color: "var(--dsw-alias-label-tertiary,#9aa0ab)" }}>{hint}</span> : null}
      </div>
    </div>
  );
}

/** 分段器（#543 哨兵惯例：role=group + aria-pressed）。 */
function SegGroup(props: { label: string; items: Array<[string, string]>; value: string; mini?: boolean; onPick: (v: string) => void }): React.ReactElement {
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
const unitKeyOf = (gran: Gran): string => (gran === "day" ? "trendRangeDayUnit" : gran === "week" ? "trendRangeWeekUnit" : "trendRangeMonthUnit");

/** 「使用趋势」区块（SettingsPage 顶部）。 */
export function TrendSection(): React.ReactElement {
  const [gran, setGran] = React.useState<Gran>("day");
  const [range, setRange] = React.useState<number | null>(null); // null=按粒度默认（trendDefaultRange）
  const [view, setView] = React.useState<"bar" | "area" | null>(null); // null=按粒度默认（月=面积）
  const [metric, setMetric] = React.useState("total");
  const [provider, setProvider] = React.useState("");
  const [byModel, setByModel] = React.useState(false);
  // #633 分片 b2（B1）：目录维度筛选（"" = 全部目录 → byDir=1 全目录拆段面；
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
  const effectiveView: "bar" | "area" = view ?? (gran === "month" ? "area" : "bar");

  React.useEffect(() => {
    let alive = true;
    setFailed(false);
    setLoading(true);
    const params = new URLSearchParams({ granularity: gran, metric, n: String(effectiveRange) });
    // #633 分片 b2（B1）：目录筛选参数——选定目录 → dir=<键>（过滤面，宿主返回该
    // 目录子集 + dirs 图例）；「全部目录」→ byDir=1（全目录拆段面，多目录可区分）。
    // 未选目录且无 dir 面参数 = 现状行为零变化（不传任何目录参数）。
    if (dirFilter !== "") params.set("dir", dirFilter);
    else params.set("byDir", "1");
    if (provider !== "") params.set("provider", provider);
    if (byModel) params.set("byModel", "1");
    fetchTimeout(`${TREND_URL}?${params.toString()}`, { headers: { Accept: "application/json" }, cache: "no-store" })
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

  const hasData = data !== null && data.series.some((p) => p.total !== null);
  const summary = data?.summary ?? null;

  // #633 分片 b2（B1）：目录维度生效判定——「全部目录」请求（byDir=1 回显）、
  // 目录过滤请求（dirFilter 非空）或宿主目录面响应（dirs 图例非空）。
  const dirMode = data !== null && (data.byDir === true || dirFilter !== "" || (data.dirs?.length ?? 0) > 0);
  // 目录面归一（B3 客户端防御）：parts[].provider（承载目录键）统一经 dirStackId
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
    const lo = data?.firstDay !== null && data?.firstDay !== undefined && data.firstDay > cutoffKey ? data.firstDay : cutoffKey;
    const byModel = data?.byModel ?? false;
    return viewSeries.map((point, idx) => {
      const byId = new Map(point.parts.map((p) => [partId(p.provider, p.model, byModel), p.value ?? 0] as const));
      const segs = stackOrder.filter((id) => !hidden.has(id) && byId.has(id)).map((id) => ({ id, value: byId.get(id)! }));
      const visibleTotal = segs.reduce((s, seg) => s + seg.value, 0);
      const none = point.total === null;
      const mark: RenderBar["mark"] = none
        ? null
        : idx === viewSeries.length - 1 // 尾桶 = granKeys 契约恒含的当前桶（今天/本周/本月）
          ? "ongoing"
          : bucketStartKey(point.key, data?.granularity as Gran) < lo
            ? "edge"
            : null;
      return { key: point.key, segs, visibleTotal: segs.length > 0 ? visibleTotal : null, none, mark };
    });
  }, [viewSeries, data, hidden, stackOrder, retentionDays]);

  // Y 域 = 每桶全量段合计 point.total（堆叠视觉高度的口径；hidden 不缩轴，与汇总卡
  // 「峰值」同源——评审 P1-5）。#589 修复：原按单段最大值推域，多段桶堆叠顶溢出轴顶。
  const ticks = React.useMemo(() => trendYTicks(viewSeries).ticks, [viewSeries]);

  // 图表事件委托：pointerdown 全输入（触屏可用），pointermove 仅鼠标（防触屏滑动误触发）。
  // 事件类型为最小结构面（shim 无 React 合成事件类型；运行时是原生 PointerEvent 透传）。
  const onChartPointer = (e: { target: EventTarget | null; currentTarget: HTMLDivElement; clientX: number; pointerType: string; type: string }): void => {
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

  const tipIdx = tip !== null && renderBars[tip.idx] !== undefined ? tip.idx : null;
  const tipBar = tipIdx !== null ? renderBars[tipIdx] : null;
  const tipPoint = viewSeries.length > 0 && tipIdx !== null ? viewSeries[tipIdx] : null;
  const hiddenCount = hidden.size;

  // 汇总卡值（窗口摘要）
  const delta = trendDelta(summary?.total ?? null, summary?.prevTotal ?? null, summary?.prevComplete ?? true);
  const hasPartial = renderBars.some((b) => b.mark !== null);
  const activeBuckets = data?.series.filter((p) => p.total !== null).length ?? 0;
  const avg = summary !== null && summary.total !== null && activeBuckets > 0 ? summary.total / activeBuckets : null;
  const peakVal = summary?.peakKey != null && data !== null ? data.series.find((p) => p.key === summary.peakKey)?.total ?? null : null;

  return (
    <section className="dou-trend" style={{ marginBottom: 16 }}>
      {/* 标题行 */}
      <h2 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 8px" }}>{t("trendTitle")}</h2>
      {/* 控件行：粒度 × 范围 × 指标 × 适配器 × byModel × 形态 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <SegGroup
          label={t("trendGranularity")}
          items={[["day", t("trendGranDay")], ["week", t("trendGranWeek")], ["month", t("trendGranMonth")]] as Array<[string, string]>}
          value={gran}
          onPick={(v: string) => {
            setGran(v as Gran);
            setRange(null); // 切粒度重置为该粒度默认（方案 §3.2）
            setView(null);
            setHidden(new Set());
            setTip(null);
          }}
        />
        <SegGroup
          label={t("trendRangeLabel")}
          items={trendRangeOptions(gran, retentionDays).map((n) => [String(n), t(unitKeyOf(gran), { n: String(n) })] as [string, string])}
          value={String(effectiveRange)}
          mini={true}
          onPick={(v: string) => {
            setRange(Number(v));
            setTip(null);
          }}
        />
        <select
          style={selectStyle}
          value={metric}
          aria-label={t("trendMetricLabel")}
          onChange={(e: unknown) => { setMetric((e as { target: { value: string } }).target.value); setTip(null); }}
        >
          {(
            [
              ["total", t("trendMetricTotal")],
              ["input", t("trendMetricInput")],
              ["output", t("trendMetricOutput")],
              ["cacheRead", t("trendMetricCacheRead")],
              ["cacheWrite", t("trendMetricCacheWrite")],
              ["calls", t("trendMetricCalls")],
            ] as Array<[string, string]>
          ).map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
        <select
          style={selectStyle}
          value={provider}
          aria-label={t("trendAdapterLabel")}
          onChange={(e: unknown) => {
            const value = (e as { target: { value: string } }).target.value;
            setProvider(value);
            if (value === "") setByModel(false);
            setHidden(new Set());
            setTip(null);
          }}
        >
          <option value="">{t("trendAdapterAll")}</option>
          {(data?.providers ?? []).map((p) => (
            // option children 是文本节点：React 自动转义，provider 名无需手工 escHtml
            <option key={p.provider + "/" + (p.model ?? "")} value={p.provider}>{p.provider}</option>
          ))}
        </select>
        {/* #633 分片 b2（B1）：目录筛选下拉——「全部目录」（byDir 全目录拆段面）+
            各目录 + 未识别桶（dirs 数据源；与既有 metric/adapter 控件同级同风格 select）。
            目录面与 provider 面互斥（dir 行无 provider 关联）：目录生效时隐藏 provider
            控件，防「目录 × provider」交叉出空面误读。 */}
        {dirMode ? null : (
          <select
            style={selectStyle}
            value={dirFilter}
            aria-label={t("trendDirLabel")}
            onChange={(e: unknown) => {
              setDirFilter((e as { target: { value: string } }).target.value);
              setHidden(new Set());
              setTip(null);
            }}
          >
            <option value="">{t("trendDirAll")}</option>
            {(data?.dirs ?? []).map((d) => {
              const key = dirStackId(d.dir);
              // 未识别桶恒为「未识别」有标签条目（B2）；异常空值归未识别不渲染空标签（B3）
              return <option key={key} value={key}>{dirDisplayLabel(key)}</option>;
            })}
          </select>
        )}
        {provider !== "" && !dirMode ? (
          <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}>
            <input
              type="checkbox"
              checked={byModel}
              onChange={(e: unknown) => { setByModel((e as { target: { checked: boolean } }).target.checked); setHidden(new Set()); setTip(null); }}
            />
            {t("trendByModel")}
          </label>
        ) : null}
        <SegGroup
          label={t("trendViewLabel")}
          items={[["bar", t("trendViewBar")], ["area", t("trendViewArea")]] as Array<[string, string]>}
          value={effectiveView}
          mini={true}
          onPick={(v: string) => {
            setView(v as "bar" | "area");
            setTip(null);
          }}
        />
        <span style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary,#9aa0ab)", marginLeft: "auto" }}>{t(unitKeyOf(gran), { n: String(effectiveRange) })}</span>
      </div>
      {/* 汇总卡（有数据才显；空态聚焦行动邀请） */}
      {hasData && summary !== null && data !== null ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          <SummaryCard
            label={t("trendCardTotal")}
            value={summary.total === null ? "-" : fmtCompact(summary.total)}
            delta={delta?.text ?? null}
            up={delta?.up ?? false}
            hint={[hasPartial ? t("trendPartialOngoing") : "", summary.prevComplete ? "" : t("trendPrevIncomplete")].filter(Boolean).join(" · ") || null}
          />
          <SummaryCard label={t("trendCardAvg")} value={avg === null ? "-" : fmtCompact(avg)} hint={`${activeBuckets} ${granLabel(gran)}`} />
          <SummaryCard label={t("trendCardCalls")} value={fmtCompact(summary.calls)} hint={hiddenCount > 0 ? t("trendHiddenParts", { k: String(hiddenCount) }) : null} />
          <SummaryCard label={`${t("trendCardPeak")} · ${summary.peakKey === null ? "-" : fmtBucketHuman(summary.peakKey, gran)}`} value={peakVal === null ? "-" : fmtCompact(peakVal)} />
          <SummaryCard label={t("trendCardTop")} value={summary.top === null ? "-" : dirMode ? dirDisplayLabel(summary.top.provider) : summary.top.provider} />
        </div>
      ) : null}
      {/* 图例（窗口总量降序；点选显隐，M2.1）。#633 分片 b2：目录面图例条目经
          dirDisplayLabel——未识别桶恒为「未识别」并 title 注明口径（B2），异常值
          不渲染空标签（B3）；具名目录 title 展示原键。 */}
      {hasData && data !== null && stackOrder.length > 0 ? (
        <div
          className="dou-trend-legend"
          style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", fontSize: 11, color: "var(--dsw-alias-label-tertiary,#9aa0ab)", marginBottom: 8 }}
        >
          {stackOrder.map((id) => {
            const off = hidden.has(id);
            // 目录面段 id = 目录键本身（dirStackId 归一后）；provider 面 id 原样展示
            const label = dirMode ? dirDisplayLabel(id) : id;
            const title = dirMode
              ? dirNeedsScopeNote(id) ? t("trendDirUnidentifiedNote") : id
              : undefined;
            return (
              <span
                key={id}
                role="switch"
                aria-checked={!off}
                title={title}
                style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", borderRadius: 4, padding: "1px 4px", opacity: off ? 0.38 : 1, textDecoration: off ? "line-through" : "none" }}
                onClick={() => {
                  setHidden((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  });
                  setTip(null);
                }}
              >
                <span
                  className="dou-trend-legendDot"
                  style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", background: seriesColor(id) }}
                />
                {label}
              </span>
            );
          })}
          <span style={{ fontSize: 10, opacity: 0.8 }}>{hiddenCount > 0 ? t("trendHiddenParts", { k: String(hiddenCount) }) : t("trendLegendToggleHint")}</span>
        </div>
      ) : null}
      {/* 图表 / 空态 / 错误 */}
      {failed ? (
        <div style={{ fontSize: 12, color: "var(--dsw-alias-state-error-primary,#d64545)", padding: "12px 0" }}>{t("trendFetchFail")}</div>
      ) : hasData && data !== null ? (
        <div
          ref={chartRef}
          className="dou-trend-chart"
          style={{ position: "relative", opacity: loading ? 0.45 : 1, transition: "opacity .15s ease", pointerEvents: loading ? "none" : "auto" }}
          aria-busy={loading}
          // 数据源为本插件宿主端聚合 JSON；SVG 字符串内 provider 名/键均经 escHtml 转义，
          // tooltip 走 React 文本节点（自动转义），provider 名不进 dangerouslySetInnerHTML
          onPointerDown={onChartPointer}
          onPointerMove={(e: { pointerType: string }) => { if (e.pointerType === "mouse") onChartPointer(e as Parameters<typeof onChartPointer>[0]); }}
          onPointerLeave={() => setTip(null)}
        >
          <div
            className="dou-trend-svg"
            dangerouslySetInnerHTML={{
              __html: effectiveView === "area"
                ? stackedAreasSvg({ bars: renderBars, gran, ticks, stackOrder })
                : stackedBarsSvg({ bars: renderBars, gran, ticks }),
            }}
          />
          {tipBar !== null && tipPoint !== null && tip !== null ? (
            <div className="dou-trend-tip" style={tipStyle(tip.offsetX, chartRef.current?.clientWidth ?? 0)}>{renderTip(tipBar, tipPoint, gran, data.byModel, hidden, dirMode)}</div>
          ) : null}
        </div>
      ) : (
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
      )}
      {/* 起算提示（常驻，防误读为全量统计）：有起算日给出具体日期 + 留存天数（M2.1） */}
      <p
        className="dou-trend-mountHint"
        style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary,#9aa0ab)", margin: "8px 0 0" }}
      >
        {data?.firstDay != null && data.firstDay !== ""
          ? `${t("trendMountedHintDay", { day: data.firstDay })}；${t("trendRetained", { days: String(data.retentionDays) })}`
          : t("trendMountedHint")}
      </p>
    </section>
  );
}

/** 粒度人话（汇总卡「日均」hint 单位）。 */
function granLabel(gran: Gran): string {
  return gran === "day" ? t("trendGranDay") : gran === "week" ? t("trendGranWeek") : t("trendGranMonth");
}

/** 本地日 key（客户端侧边缘桶判定用；与宿主 dayKey 同语义——本地时区逐字段取）。 */
function dayKeyOf(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** tooltip 浮层定位（贴边翻转）。 */
function tipStyle(offsetX: number, containerWidth: number): Object {
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
function renderTip(bar: RenderBar, point: NonNullable<TrendResponse>["series"][number], gran: Gran, byModel: boolean, hidden: ReadonlySet<string>, dirMode = false): React.ReactElement {
  const tagText = bar.mark === "ongoing" ? t("trendPartialOngoing") : bar.mark === "edge" ? t("trendPartialEdge") : bar.none ? t("trendNoData") : null;
  const rows = [...point.parts].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const tagEl = tagText === null ? null : (
    <span
      style={{
        fontSize: 10,
        padding: "0 5px",
        borderRadius: 4,
        marginLeft: 6,
        verticalAlign: 1,
        fontWeight: 400,
        color: bar.mark === "ongoing" ? "var(--dsw-alias-state-warn-primary,#d9a13c)" : "var(--dsw-alias-label-tertiary,#9aa0ab)",
        border: "1px solid currentColor",
      }}
    >
      {tagText}
    </span>
  );
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 3, fontVariantNumeric: "tabular-nums" }}>{fmtBucketHuman(point.key, gran)}{tagEl}</div>
      {...(rows.length === 0
        ? [<div key="none" style={{ opacity: 0.6 }}>{t("trendNoData")}</div>]
        : rows.map((p, i) => {
            const id = partId(p.provider, p.model, byModel);
            const off = hidden.has(id);
            // 目录面：未识别桶恒「未识别」+ 口径注释（B2）；异常值归未识别（B3）
            const label = dirMode ? dirDisplayLabel(p.provider) : id;
            const title = dirMode && dirNeedsScopeNote(p.provider) ? t("trendDirUnidentifiedNote") : undefined;
            return (
              <div key={`${id}-${i}`} style={{ display: "flex", justifyContent: "space-between", gap: 14, fontVariantNumeric: "tabular-nums", opacity: off ? 0.45 : 1 }}>
                <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", background: seriesColor(id), display: "inline-block" }} />
                  {label}
                </span>
                <span>{fmtCompact(p.value)}</span>
              </div>
            );
          }))}
      {rows.length > 0 ? (
        <div style={{ borderTop: "1px solid var(--dsw-alias-border-l1,#e2e5ea)", marginTop: 4, paddingTop: 3, fontWeight: 600, display: "flex", justifyContent: "space-between", gap: 14, fontVariantNumeric: "tabular-nums" }}>
          <span>{hidden.size > 0 ? `${t("trendTipSum")}（${t("trendViewVisible")}）` : t("trendTipSum")}</span>
          <span>{fmtCompact(bar.visibleTotal)}</span>
        </div>
      ) : null}
    </div>
  );
}
