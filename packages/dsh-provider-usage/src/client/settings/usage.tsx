/**
 * dsh-provider-usage — 设置页「用量可视化」分区（拆分自 settings.ts）。
 *
 * 上半 = 今日概览（B2-1）：Token 构成环（今日 input/output/cache）+ 模型分担环
 * （窗口 byProvider）+ 窗口指标 + 用量热力图。数据源复用 /trend provider 面
 * （granularity=day，不带 byDir；零新增宿主路由）。
 * 下半 = 各启用 provider 的状态点 + 胶囊内容（既有行为不变）。
 */
import * as React from "react";
import { TREND_URL, fetchTimeout } from "../core.ts";
import { t } from "../../../../../shared/client/i18n.js";
import { titleStyle } from "./shared.ts";
import {
  donutSvg,
  sumPartsByProvider,
  activeDayCount,
  heatCells,
  fmtCompact,
  seriesColor,
  type trendDelta,
} from "../trend-math.js";
// 纯推导单点收口在 settings-view.ts：本文件只留「取数 + 状态 + DOM 落位」。
import {
  deltaOf,
  ioTotalsOf,
  peakValueOf,
  providerStatusMeta,
  topShareOf,
} from "./settings-view.ts";

/** /stats 响应中本页消费的字段（v2）。 */
export interface StatsView {
  provider?: string;
  adapterName?: string;
  status?: "fresh" | "cached" | "stale";
  capsuleHtml?: string;
  ok?: boolean;
  configured?: boolean;
  error?: string | null;
  fetchedAt?: number;
}

/** 窗口环比投影（trendDelta 出参；未就绪为 null）。 */
export type UsageDelta = ReturnType<typeof trendDelta>;

/** /trend 日桶最小形状（本页只读 key/total/parts/summary）。 */
export interface TrendDayBucket {
  key: string;
  total: number | null;
  parts: Array<{ provider: string; model: string | null; value: number | null }>;
}
export interface TrendDayResponse {
  ok: boolean;
  series: TrendDayBucket[];
  summary: {
    total: number | null;
    calls: number;
    peakKey: string | null;
    prevTotal: number | null;
    prevComplete: boolean;
  };
}

/** Token 构成环配色（预览口径：Input/Output/Cache）。 */
const IO_COLORS = { input: "#2563eb", output: "#7aa5ff", cache: "#34d399" };

/** 热力范围档（天；默认 180，与预览一致）。 */
const HEAT_RANGES = [7, 30, 90, 180];

/** 拉 /trend 日面（provider 面：不带 byDir；失败 fail-loud 由调用方兜底）。 */
async function fetchTrendDay(metric: string, n: number): Promise<TrendDayResponse> {
  const res = await fetchTimeout(`${TREND_URL}?granularity=day&metric=${metric}&n=${n}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as Partial<TrendDayResponse>;
  if (body === null || body.ok !== true || !Array.isArray(body.series)) {
    throw new Error("bad shape");
  }
  return body as TrendDayResponse;
}

/** 状态 → 颜色（主题变量 + 浅色回退）。 */
function statusColor(status: string | undefined): string {
  if (status === "stale") return "var(--dsw-alias-state-warn-primary,#c9820b)";
  if (status === "fresh" || status === "cached")
    return "var(--dsw-alias-state-success-primary,#0f9d6e)";
  return "var(--dsw-alias-state-error-primary,#d64545)";
}

/** 指标小卡（与趋势页 SummaryCard 同语言：描边 + 小灰 label + 粗值）。 */
function MiniCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | null;
}): React.ReactElement {
  return (
    <div className="dou-miniCard">
      <div className="dou-miniCardLabel">{label}</div>
      <div className="dou-miniCardValue">{value}</div>
      {hint === null || hint === undefined || hint === "" ? null : (
        <div className="dou-miniCardHint">{hint}</div>
      )}
    </div>
  );
}

/** 环形卡（SVG 纯函数出图 + React 文本图例；数据为空时只画 track）。 */
function DonutCard({
  title,
  centerTop,
  centerSub,
  segs,
  legend,
}: {
  title: string;
  centerTop: string;
  centerSub: string;
  segs: Array<{ label: string; value: number; color: string }>;
  legend: Array<{ label: string; text: string; color: string }>;
}): React.ReactElement {
  return (
    <div className="dou-donutCard">
      <div className="dou-hint" style={{ marginBottom: 4 }}>
        {title}
      </div>
      <div className="dou-donutBody">
        {/* 环孔随 SVG 缩放，中心字必须小且可省略：14/9px + ellipsis（窄屏环缩字不缩即被环切） */}
        <div style={{ position: "relative", flex: "none", width: "100%", maxWidth: 110 }}>
          <div dangerouslySetInnerHTML={{ __html: donutSvg(segs, 120) }} />
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <div className="dou-donutCenterTop" style={{ fontWeight: 700 }}>
              {centerTop}
            </div>
            <div
              title={centerSub}
              style={{
                fontSize: 9,
                color: "var(--dsw-alias-label-tertiary,#9aa0ab)",
                maxWidth: "92%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {centerSub}
            </div>
          </div>
        </div>
        <div className="dou-legendRow">
          {legend.map((l) => (
            <div key={l.label} title={`${l.label} ${l.text}`} className="dou-legendItem">
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  flex: "none",
                  background: l.color,
                }}
              />
              <span
                style={{
                  fontWeight: 600,
                  flex: "none",
                  maxWidth: "55%",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {l.label}
              </span>
              <span
                style={{
                  color: "var(--dsw-alias-label-tertiary,#9aa0ab)",
                  whiteSpace: "nowrap",
                }}
              >
                {l.text}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** provider 状态行正文（职责：宿主 capsuleHtml / 错误文案 / 无数据 三态）。 */
function providerStatusBody(s: StatsView | null | undefined): React.ReactElement {
  if (s?.capsuleHtml) return <div dangerouslySetInnerHTML={{ __html: s.capsuleHtml }} />;
  if (s?.error) {
    return (
      <div style={{ color: "var(--dsw-alias-state-error-primary,#d64545)" }}>{String(s.error)}</div>
    );
  }
  return <div style={{ color: "var(--dsw-alias-label-tertiary,#9aa0ab)" }}>{t("noData")}</div>;
}

/** provider 状态行（职责：状态点 + 名称 + 元信息 + 正文三态）。 */
function ProviderStatusRow(props: {
  provider: string;
  s: StatsView | null | undefined;
}): React.ReactElement {
  const { provider, s } = props;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ marginBottom: 4 }}>
        <span
          key="dot"
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: statusColor(s?.status),
            marginRight: 6,
            verticalAlign: "middle",
          }}
        />
        <span style={{ fontWeight: 600 }}>{provider}</span>
        <span
          style={{
            color: "var(--dsw-alias-label-tertiary,#9aa0ab)",
            marginLeft: 8,
            fontSize: 11,
          }}
        >
          {providerStatusMeta(s, provider)}
        </span>
      </div>
      {providerStatusBody(s)}
    </div>
  );
}

/** 各启用 provider 状态列表（职责：空态提示 + 逐 provider 状态行）。 */
function ProviderStatusList(props: {
  statsByProvider: Record<string, StatsView | null>;
}): React.ReactElement {
  const providers = Object.keys(props.statsByProvider);
  if (providers.length === 0) {
    return (
      <div style={{ color: "var(--dsw-alias-label-tertiary,#9aa0ab)" }}>{t("noProviders")}</div>
    );
  }
  return (
    <React.Fragment>
      {providers.map((provider) => (
        <ProviderStatusRow
          key={provider}
          provider={provider}
          s={props.statsByProvider[provider] ?? null}
        />
      ))}
    </React.Fragment>
  );
}

/** 今日环图行（职责：IO 构成环 + provider 构成环，含图例与空态占位）。 */
function UsageDonutRow(props: {
  io: ReturnType<typeof ioTotalsOf>;
  sums: Array<{ provider: string; value: number }>;
  windowTotal: number;
}): React.ReactElement {
  const { io, sums, windowTotal } = props;
  const { vals, ready, dayTotal } = io;
  return (
    <div className="dou-donutRow">
      <DonutCard
        title={t("usageDonutIO")}
        centerTop={ready ? fmtCompact(dayTotal) : "-"}
        centerSub={t("usageTodayTokens")}
        segs={[
          { label: t("usageIOLabelInput"), value: vals[0], color: IO_COLORS.input },
          { label: t("usageIOLabelOutput"), value: vals[1], color: IO_COLORS.output },
          { label: t("usageIOLabelCache"), value: vals[2], color: IO_COLORS.cache },
        ]}
        legend={[
          {
            label: t("usageIOLabelInput"),
            text: ready ? fmtCompact(vals[0]) : "-",
            color: IO_COLORS.input,
          },
          {
            label: t("usageIOLabelOutput"),
            text: ready ? fmtCompact(vals[1]) : "-",
            color: IO_COLORS.output,
          },
          {
            label: t("usageIOLabelCache"),
            text: ready ? fmtCompact(vals[2]) : "-",
            color: IO_COLORS.cache,
          },
        ]}
      />
      <DonutCard
        title={t("usageDonutModels")}
        centerTop={sums.length > 0 ? topShareOf(sums, windowTotal) : "-"}
        centerSub={sums.length > 0 ? sums[0].provider : t("noData")}
        segs={sums.map((s) => ({
          label: s.provider,
          value: s.value,
          color: seriesColor(s.provider),
        }))}
        legend={sums.slice(0, 5).map((s) => ({
          label: s.provider,
          text:
            windowTotal > 0
              ? `${((s.value / windowTotal) * 100).toFixed(0)}% · ${fmtCompact(s.value)}`
              : "-",
          color: seriesColor(s.provider),
        }))}
      />
    </div>
  );
}

/** 指标小卡行（职责：总量 / 调用数 / 活跃天 / 峰值 四张小卡）。 */
function UsageMiniRow(props: {
  ov: TrendDayResponse;
  delta: UsageDelta;
  peakVal: number | null;
  activeDays: number;
  seriesLength: number;
}): React.ReactElement {
  const { ov, delta, peakVal, activeDays, seriesLength } = props;
  return (
    <div className="dou-miniRow">
      <MiniCard
        label={t("trendCardTotal")}
        value={ov.summary.total === null ? "-" : fmtCompact(ov.summary.total)}
        hint={delta === null ? null : delta.text}
      />
      <MiniCard label={t("trendCardCalls")} value={fmtCompact(ov.summary.calls)} />
      <MiniCard label={t("usageActiveLabel")} value={`${activeDays}/${seriesLength}`} />
      <MiniCard
        label={`${t("trendCardPeak")} · ${ov.summary.peakKey === null ? "-" : ov.summary.peakKey.slice(5)}`}
        value={peakVal === null ? "-" : fmtCompact(peakVal)}
      />
    </div>
  );
}

/** 用量可视化区：今日概览（/trend 日面）+ 各启用 provider 状态点（既有）。 */
export function UsageSection({
  statsByProvider,
}: {
  statsByProvider: Record<string, StatsView | null>;
}): React.ReactElement {
  const [heatDays, setHeatDays] = React.useState<number>(180);
  const [overview, setOverview] = React.useState<TrendDayResponse | null>(null);
  const [ioDay, setIoDay] = React.useState<{
    input: number | null;
    output: number | null;
    cache: number | null;
  } | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [totalRes, inRes, outRes, crRes, cwRes] = await Promise.all([
          fetchTrendDay("total", 180),
          fetchTrendDay("input", 7),
          fetchTrendDay("output", 7),
          fetchTrendDay("cacheRead", 7),
          fetchTrendDay("cacheWrite", 7),
        ]);
        if (!live) return;
        setOverview(totalRes);
        // 最新有数日：四指标任一非 null 的最晚桶（尾桶进行中可能全 null）
        const at = (r: TrendDayResponse, i: number): number | null =>
          r.series[i] === undefined ? null : r.series[i].total;
        let idx = Math.max(inRes.series.length, outRes.series.length) - 1;
        const hasAny = (i: number): boolean =>
          at(inRes, i) !== null ||
          at(outRes, i) !== null ||
          at(crRes, i) !== null ||
          at(cwRes, i) !== null;
        while (idx > 0 && !hasAny(idx)) idx -= 1;
        if (!hasAny(idx)) {
          setIoDay({ input: null, output: null, cache: null });
        } else {
          const cr = at(crRes, idx) ?? 0;
          const cw = at(cwRes, idx) ?? 0;
          setIoDay({ input: at(inRes, idx), output: at(outRes, idx), cache: cr + cw });
        }
      } catch (e) {
        if (live) setFailed(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const series = overview?.series ?? [];
  const sums = React.useMemo(() => sumPartsByProvider(series), [overview]);
  const windowTotal = sums.reduce((a, s) => a + s.value, 0);
  const cells = React.useMemo(() => heatCells(series, heatDays), [series, heatDays]);
  const activeDays = React.useMemo(() => activeDayCount(series), [series]);
  const delta = deltaOf(overview);
  const peakVal = peakValueOf(overview, series);
  const io = ioTotalsOf(ioDay);

  // 非空收窄别名：复合三元下 TS 无法收窄 overview，改嵌套单条件收窄
  const ov = overview;
  return (
    <div className="dou-pane">
      <h4 style={titleStyle}>{t("usageTitle")}</h4>
      {/* 今日概览（B2-1）：加载中 / 失败 / 空态均有正向反馈，不静默空白 */}
      {ov === null ? (
        failed === null ? (
          <div className="dou-hint">{t("usageLoading")}</div>
        ) : (
          <div className="dou-provErr">{t("usageLoadFail", { msg: failed })}</div>
        )
      ) : (
        <>
          <div className="dou-hint" style={{ marginBottom: 6 }}>
            {t("usageToday")}
          </div>
          <UsageDonutRow io={io} sums={sums} windowTotal={windowTotal} />
          {/* 指标小卡独立行（一图一栏后另起一行，不再嵌 donut 行） */}
          <UsageMiniRow
            ov={ov}
            delta={delta}
            peakVal={peakVal}
            activeDays={activeDays}
            seriesLength={series.length}
          />
          <div className="dou-hint" style={{ marginBottom: 4 }}>
            {t("usageHeat")}
          </div>
          <div className="dou-heatSeg" role="group" aria-label={t("usageHeat")}>
            {HEAT_RANGES.map((d) => (
              <button
                key={d}
                type="button"
                className="dou-btn"
                aria-pressed={heatDays === d}
                disabled={heatDays === d}
                onClick={() => setHeatDays(d)}
              >
                {t("usageHeatDays", { n: String(d) })}
              </button>
            ))}
          </div>
          <div className="dou-heatGrid">
            {cells.map((c) => (
              <span
                key={c.key}
                title={`${c.key} ${c.total === null ? "-" : fmtCompact(c.total)}`}
                className={c.level === 0 ? "dou-heatCell" : `dou-heatCell dou-heatL${c.level}`}
              />
            ))}
          </div>
          <div className="dou-hint">{t("usageHeatNote")}</div>
        </>
      )}
      <ProviderStatusList statsByProvider={statsByProvider} />
    </div>
  );
}
