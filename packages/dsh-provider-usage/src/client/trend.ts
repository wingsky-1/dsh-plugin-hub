/**
 * dsh-provider-usage — 设置面板「使用趋势」区块（#503 M2）。
 *
 * 三维切换（粒度 日/周/月 × 指标 × 适配器维度）+ 堆叠柱状 SVG + 汇总卡 +
 * 空态与「统计自挂载时点起算」提示。数据源 GET /trend（宿主端聚合 JSON）。
 *
 * 堆叠柱状渲染函数 stackedBarsSvg 为新写（charts.ts 现无堆叠能力，方案 §2.2
 * 结论），视觉风格对齐 miniAreaSvg：网格线 --dsw-alias-border-l2、轴文字
 * --dsw-alias-label-tertiary、9~9.5px、SVG viewBox 自适应。配色零新增自建
 * 调色板：前四段复用宿主状态色变量（浅/暗自动跟随），溢出段用稳定哈希轮转
 * 离散色（图表系列色是数据可视必需，非 UI 装饰色）。
 */
import * as React from "react";
import { TREND_URL, fetchTimeout } from "./core.ts";
import { escHtml } from "../charts.ts";
import { t } from "../../../../shared/client/i18n.js";

// ---------------------------------------------------------------- 类型

/** /trend 响应（宿主端聚合）。 */
interface TrendResponse {
  ok: boolean;
  granularity: "day" | "week" | "month";
  metric: string;
  provider: string | null;
  byModel: boolean;
  series: Array<{ key: string; total: number | null; parts: Array<{ provider: string; model: string | null; value: number | null }> }>;
  providers: Array<{ provider: string; model: string | null }>;
  summary: {
    total: number | null;
    calls: number;
    turns: number;
    toolCalls: number;
    peakKey: string | null;
    top: { provider: string; model: string | null; value: number } | null;
    prevTotal: number | null;
  };
  firstDay: string | null;
}

// ---------------------------------------------------------------- 纯函数（导出供单测）

/** token 数紧凑格式化（1,234 / 12.3K / 4.56M / 1.2B）。 */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

/** 环比符号与方向（无基准 null）。 */
export function trendDelta(cur: number | null, prev: number | null): { text: string; up: boolean; down: boolean } | null {
  if (cur === null || prev === null || prev === 0) return null;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const sign = pct >= 0 ? "+" : "";
  return { text: `${sign}${pct.toFixed(1)}%`, up: pct > 0, down: pct < 0 };
}

/** 段 id（byModel 时细到 provider+model）。 */
function partId(provider: string, model: string | null, byModel: boolean): string {
  return byModel ? `${provider}/${model ?? "-"}` : provider;
}

/** 图表系列离散色：前四复用宿主状态色变量（浅/暗跟随），溢出轮转稳定离散色。 */
const CHART_COLORS: string[] = [
  "var(--dsw-alias-state-info-primary,#4a7dde)",
  "var(--dsw-alias-state-success-primary,#3f9d63)",
  "var(--dsw-alias-state-warn-primary,#d9a13c)",
  "var(--dsw-alias-state-error-primary,#d64545)",
  "#8a63d2",
  "#2fa3b8",
  "#c76a8f",
  "#6b7f99",
];

/** 稳定字符串哈希（段 → 色槽，跨渲染稳定）。 */
function hashSlot(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/** 段取色（命中前四变量色的段按哈希全距取，保持分配稳定）。 */
export function seriesColor(id: string): string {
  return CHART_COLORS[hashSlot(id) % CHART_COLORS.length];
}

/**
 * 堆叠柱状 SVG（新写；风格对齐 charts.ts miniAreaSvg——网格/轴文字/变量色）。
 * bars 与 parts 均为宿主聚合 JSON（provider 名不受信），标签一律 escHtml 转义。
 */
export function stackedBarsSvg(opts: {
  bars: Array<{ key: string; total: number | null; parts: Array<{ provider: string; model: string | null; value: number | null }> }>;
  byModel: boolean;
  metric: string;
}): string {
  const { bars, byModel, metric } = opts;
  // 注意：bars/parts 内的 provider/model/键均为宿主聚合数据（provider 名来自事件
  // 不受信），凡进入 SVG 文本上下文一律 escHtml；数值经 fmtCompact 无注入面。
  const W = 560;
  const H = 190;
  const PL = 44;
  const PR = 8;
  const PT = 12;
  const PB = 30; // 两行轴标签（日粒度日期 + 周/月键）
  const plotH = H - PT - PB;
  const xw = W - PL - PR;
  if (bars.length === 0 || xw <= 0) return "";
  const barW = Math.max(2, Math.min(18, (xw / bars.length) * 0.62));
  const gap = xw / bars.length;

  // Y 域：0 → nice 上界（取最大柱总量的 1.05 倍向上取整到 1/2/5×10^k）
  let maxV = 0;
  for (const b of bars) {
    for (const p of b.parts) {
      if (p.value !== null && p.value > maxV) maxV = p.value;
    }
  }
  if (maxV <= 0) maxV = 1;
  const rawMax = maxV * 1.05;
  const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const niceMax = [1, 2, 5, 10].map((k) => k * mag).find((v) => v >= rawMax) ?? 10 * mag;
  const yOf = (v: number): number => PT + (1 - v / niceMax) * plotH;

  const parts: string[] = [];
  // 网格（0/½/max）+ 轴刻度值
  for (const gv of [0, niceMax / 2, niceMax]) {
    const gy = yOf(gv);
    parts.push(`<line x1="${PL}" y1="${gy.toFixed(1)}" x2="${W - PR}" y2="${gy.toFixed(1)}" style="stroke:var(--dsw-alias-border-l2,#e8eaf0);stroke-width:1;${gv === 0 ? "" : "stroke-dasharray:3 3;"}"/>`);
    parts.push(`<text x="${PL - 4}" y="${(gy + 3).toFixed(1)}" text-anchor="end" style="font-size:9.5px;fill:var(--dsw-alias-label-tertiary,#9aa0ab)">${escHtml(fmtCompact(gv))}</text>`);
  }
  // 柱（自底向上堆叠）+ 悬停整柱明细
  bars.forEach((b, i) => {
    const cx = PL + gap * i + gap / 2;
    const x = cx - barW / 2;
    let acc = 0; // 累计底（自 0 向上）
    const segs: string[] = [];
    for (const p of b.parts) {
      if (p.value === null || p.value <= 0) continue;
      const y1 = yOf(acc);
      acc += p.value;
      const y2 = yOf(acc);
      const id = partId(p.provider, p.model, byModel);
      segs.push(
        `<rect x="${x.toFixed(1)}" y="${y2.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, y1 - y2).toFixed(1)}" rx="1" style="fill:${seriesColor(id)};fill-opacity:.9"><title>${escHtml(`${b.key} · ${id} · ${metric}: ${fmtCompact(p.value)}`)}</title></rect>`,
      );
    }
    const title = escHtml(`${b.key} · 合计 ${b.total === null ? "-" : fmtCompact(b.total)}`);
    parts.push(`<g>${segs.join("")}<rect x="${x.toFixed(1)}" y="${PT}" width="${barW.toFixed(1)}" height="${plotH}" style="fill:transparent"><title>${title}</title></rect></g>`);
  });
  // X 轴标签：均匀抽稀（首尾必显，中段最多 ~8 个）
  const labelStep = Math.max(1, Math.ceil(bars.length / 8));
  bars.forEach((b, i) => {
    if (i % labelStep !== 0 && i !== bars.length - 1) return;
    const cx = PL + gap * i + gap / 2;
    const anchor = i === 0 ? "start" : i === bars.length - 1 ? "end" : "middle";
    const label = b.key.slice(5); // "MM-DD"
    parts.push(`<text x="${cx.toFixed(1)}" y="${H - 16}" text-anchor="${anchor}" style="font-size:9.5px;fill:var(--dsw-alias-label-tertiary,#9aa0ab)">${escHtml(label)}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">${parts.join("")}</svg>`;
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

const selectStyle: Object = {
  fontSize: 12,
  padding: "3px 6px",
  borderRadius: 6,
  border: "1px solid var(--dsw-alias-border-l2,#e8eaf0)",
  background: "var(--dsw-alias-bg-base,#fdfdfd)",
  color: "inherit",
};

/** 汇总卡（值 + 标签 + 可选环比角标）。 */
function SummaryCard(props: { label: string; value: string; delta?: string | null; up?: boolean }): React.ReactElement {
  const { label, value, delta, up } = props;
  return React.createElement(
    "div",
    { style: cardStyle },
    React.createElement("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary,#9aa0ab)" } }, label),
    React.createElement(
      "div",
      { style: { fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums", display: "flex", alignItems: "baseline", gap: 6 } },
      value,
      delta !== undefined && delta !== null
        ? React.createElement(
            "span",
            { style: { fontSize: 11, fontWeight: 600, color: up ? "var(--dsw-alias-state-warn-primary,#d9a13c)" : "var(--dsw-alias-state-success-primary,#3f9d63)" } },
            delta,
          )
        : null,
    ),
  );
}

/** 「使用趋势」区块（SettingsPage 顶部）。 */
export function TrendSection(): React.ReactElement {
  const [granularity, setGranularity] = React.useState<"day" | "week" | "month">("day");
  const [metric, setMetric] = React.useState("total");
  const [provider, setProvider] = React.useState("");
  const [byModel, setByModel] = React.useState(false);
  const [data, setData] = React.useState<TrendResponse | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    setFailed(false);
    const params = new URLSearchParams({ granularity, metric });
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
      });
    return () => {
      alive = false;
    };
  }, [granularity, metric, provider, byModel]);

  const hasData = data !== null && data.series.some((p) => p.total !== null);
  const granLabel = granularity === "day" ? t("trendGranDay") : granularity === "week" ? t("trendGranWeek") : t("trendGranMonth");

  // 汇总卡值（窗口摘要）
  const summary = data?.summary ?? null;
  const delta = trendDelta(summary?.total ?? null, summary?.prevTotal ?? null);

  return React.createElement(
    "section",
    { className: "dou-trend", style: { marginBottom: 16 } },
    // 标题行
    React.createElement("h2", { style: { fontSize: 13, fontWeight: 600, margin: "0 0 8px" } }, t("trendTitle")),
    // 三维切换控件行
    React.createElement(
      "div",
      { style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 } },
      React.createElement(
        "div",
        { role: "group", "aria-label": t("trendGranularity"), style: { display: "inline-flex", gap: 4 } },
        (["day", "week", "month"] as const).map((g) =>
          React.createElement(
            "button",
            {
              key: g,
              type: "button",
              style: controlBtnStyle(granularity === g),
              "aria-pressed": granularity === g,
              onClick: () => setGranularity(g),
            },
            g === "day" ? t("trendGranDay") : g === "week" ? t("trendGranWeek") : t("trendGranMonth"),
          ),
        ),
      ),
      React.createElement(
        "select",
        { style: selectStyle, value: metric, "aria-label": t("trendMetricLabel"), onChange: (e: unknown) => setMetric((e as { target: { value: string } }).target.value) },
        (
          [
            ["total", t("trendMetricTotal")],
            ["input", t("trendMetricInput")],
            ["output", t("trendMetricOutput")],
            ["cacheRead", t("trendMetricCacheRead")],
            ["cacheWrite", t("trendMetricCacheWrite")],
            ["calls", t("trendMetricCalls")],
          ] as Array<[string, string]>
        ).map(([v, label]) => React.createElement("option", { key: v, value: v }, label)),
      ),
      React.createElement(
        "select",
        {
          style: selectStyle,
          value: provider,
          "aria-label": t("trendAdapterLabel"),
          onChange: (e: unknown) => {
            const value = (e as { target: { value: string } }).target.value;
            setProvider(value);
            if (value === "") setByModel(false);
          },
        },
        React.createElement("option", { value: "" }, t("trendAdapterAll")),
        (data?.providers ?? []).map((p) =>
          // option children 是文本节点：React 自动转义，provider 名无需手工 escHtml
          React.createElement("option", { key: p.provider + "/" + (p.model ?? ""), value: p.provider }, p.provider),
        ),
      ),
      provider !== ""
        ? React.createElement(
            "label",
            { style: { fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 } },
            React.createElement("input", { type: "checkbox", checked: byModel, onChange: (e: unknown) => setByModel((e as { target: { checked: boolean } }).target.checked) }),
            t("trendByModel"),
          )
        : null,
      React.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary,#9aa0ab)", marginLeft: "auto" } }, granLabel),
    ),
    // 汇总卡（有数据才显；空态聚焦行动邀请）
    hasData && summary !== null
      ? React.createElement(
          "div",
          { style: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 } },
          React.createElement(SummaryCard, { label: t("trendCardTotal"), value: summary.total === null ? "-" : fmtCompact(summary.total), delta: delta?.text ?? null, up: delta?.up ?? false }),
          React.createElement(SummaryCard, { label: t("trendCardCalls"), value: fmtCompact(summary.calls) }),
          React.createElement(SummaryCard, { label: t("trendCardPeak"), value: summary.peakKey ?? "-" }),
          React.createElement(SummaryCard, { label: t("trendCardTop"), value: summary.top === null ? "-" : partId(summary.top.provider, summary.top.model, false) }),
        )
      : null,
    // 图例（providers 为窗口内出现过的段并集；byModel 时细到 provider+model）
    hasData && data !== null && data.providers.length > 0
      ? React.createElement(
          "div",
          {
            className: "dou-trend-legend",
            style: { display: "flex", flexWrap: "wrap", gap: "4px 12px", fontSize: 11, color: "var(--dsw-alias-label-tertiary,#9aa0ab)", marginBottom: 8 },
          },
          data.providers.map((p) => {
            const id = partId(p.provider, p.model, data.byModel);
            return React.createElement(
              "span",
              { key: id, style: { display: "inline-flex", alignItems: "center", gap: 4 } },
              React.createElement("span", {
                className: "dou-trend-legendDot",
                style: { width: 8, height: 8, borderRadius: "50%", flex: "none", background: seriesColor(id) },
              }),
              id,
            );
          }),
        )
      : null,
    // 图表 / 空态 / 错误
    failed
      ? React.createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary,#d64545)", padding: "12px 0" } }, t("trendFetchFail"))
      : hasData && data !== null
        ? React.createElement("div", {
            className: "dou-trend-chart",
            // 数据源为本插件宿主端聚合 JSON；SVG 内 provider 名/键均经 escHtml 转义
            dangerouslySetInnerHTML: { __html: stackedBarsSvg({ bars: data.series, byModel: data.byModel, metric: data.metric }) },
          })
        : React.createElement(
            "div",
            {
              style: {
                padding: "22px 14px",
                textAlign: "center",
                border: "1px dashed var(--dsw-alias-border-l2,#e8eaf0)",
                borderRadius: 8,
                fontSize: 12,
                color: "var(--dsw-alias-label-tertiary,#9aa0ab)",
              },
            },
            React.createElement("div", { style: { marginBottom: 4 } }, t("trendEmptyTitle")),
            React.createElement("div", null, t("trendEmptyHint")),
          ),
    // 起算提示（常驻，防误读为全量统计）：有起算日给出具体日期；无数据时不带日期段
    React.createElement(
      "p",
      {
        className: "dou-trend-mountHint",
        style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary,#9aa0ab)", margin: "8px 0 0" },
      },
      data?.firstDay != null && data.firstDay !== ""
        ? t("trendMountedHintDay", { day: data.firstDay })
        : t("trendMountedHint"),
    ),
  );
}
