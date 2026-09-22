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
  trendDelta,
  seriesColor,
} from "../trend-math.js";

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

/** /trend 日桶最小形状（本页只读 key/total/parts/summary）。 */
interface TrendDayBucket {
  key: string;
  total: number | null;
  parts: Array<{ provider: string; model: string | null; value: number | null }>;
}
interface TrendDayResponse {
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

/** 状态 → 文案（i18n：渲染期求值）。 */
function statusLabel(status: string | undefined): string {
  if (status === "fresh") return t("statusFresh");
  if (status === "cached") return t("statusCached");
  if (status === "stale") return t("statusStale");
  return t("statusUnconfigured");
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

/** 用量可视化区：今日概览（/trend 日面）+ 各启用 provider 状态点（既有）。 */
export function UsageSection({
  statsByProvider,
}: {
  statsByProvider: Record<string, StatsView | null>;
}): React.ReactElement {
  const providers = Object.keys(statsByProvider);
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
  const delta =
    overview === null
      ? null
      : trendDelta(
          overview.summary.total,
          overview.summary.prevTotal,
          overview.summary.prevComplete,
        );
  const peakVal =
    overview === null || overview.summary.peakKey === null
      ? null
      : (series.find((p) => p.key === overview.summary.peakKey)?.total ?? null);
  const ioVals = [ioDay?.input ?? 0, ioDay?.output ?? 0, ioDay?.cache ?? 0];
  const ioReady = ioDay !== null && ioVals.some((v) => v > 0);
  const dayTotal = ioVals[0] + ioVals[1] + ioVals[2];
  const topShare =
    windowTotal > 0 && sums.length > 0
      ? `${((sums[0].value / windowTotal) * 100).toFixed(0)}%`
      : "-";

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
          <div className="dou-donutRow">
            <DonutCard
              title={t("usageDonutIO")}
              centerTop={ioReady ? fmtCompact(dayTotal) : "-"}
              centerSub={t("usageTodayTokens")}
              segs={[
                { label: t("usageIOLabelInput"), value: ioVals[0], color: IO_COLORS.input },
                { label: t("usageIOLabelOutput"), value: ioVals[1], color: IO_COLORS.output },
                { label: t("usageIOLabelCache"), value: ioVals[2], color: IO_COLORS.cache },
              ]}
              legend={[
                {
                  label: t("usageIOLabelInput"),
                  text: ioReady ? fmtCompact(ioVals[0]) : "-",
                  color: IO_COLORS.input,
                },
                {
                  label: t("usageIOLabelOutput"),
                  text: ioReady ? fmtCompact(ioVals[1]) : "-",
                  color: IO_COLORS.output,
                },
                {
                  label: t("usageIOLabelCache"),
                  text: ioReady ? fmtCompact(ioVals[2]) : "-",
                  color: IO_COLORS.cache,
                },
              ]}
            />
            <DonutCard
              title={t("usageDonutModels")}
              centerTop={sums.length > 0 ? topShare : "-"}
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
          {/* 指标小卡独立行（一图一栏后另起一行，不再嵌 donut 行） */}
          <div className="dou-miniRow">
            <MiniCard
              label={t("trendCardTotal")}
              value={ov.summary.total === null ? "-" : fmtCompact(ov.summary.total)}
              hint={delta === null ? null : delta.text}
            />
            <MiniCard label={t("trendCardCalls")} value={fmtCompact(ov.summary.calls)} />
            <MiniCard label={t("usageActiveLabel")} value={`${activeDays}/${series.length}`} />
            <MiniCard
              label={`${t("trendCardPeak")} · ${ov.summary.peakKey === null ? "-" : ov.summary.peakKey.slice(5)}`}
              value={peakVal === null ? "-" : fmtCompact(peakVal)}
            />
          </div>
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
      {providers.length === 0 ? (
        <div style={{ color: "var(--dsw-alias-label-tertiary,#9aa0ab)" }}>{t("noProviders")}</div>
      ) : (
        providers.map((provider) => {
          const s = statsByProvider[provider];
          const dot = (
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
          );
          // 适配器名与 provider 同名时省略，避免「rjkrjk」式连读
          const adapterPart =
            s?.adapterName && s.adapterName !== provider ? `${s.adapterName} · ` : "";
          const meta = `${adapterPart}${statusLabel(s?.status)}${
            typeof s?.fetchedAt === "number"
              ? ` · ${t("updatedAt", { t: new Date(s.fetchedAt).toLocaleTimeString("zh-CN", { hour12: false }) })}`
              : ""
          }`;
          return (
            <div key={provider} style={{ marginBottom: 10 }}>
              <div style={{ marginBottom: 4 }}>
                {dot}
                <span style={{ fontWeight: 600 }}>{provider}</span>
                <span
                  style={{
                    color: "var(--dsw-alias-label-tertiary,#9aa0ab)",
                    marginLeft: 8,
                    fontSize: 11,
                  }}
                >
                  {meta}
                </span>
              </div>
              {s?.capsuleHtml ? (
                <div dangerouslySetInnerHTML={{ __html: s.capsuleHtml }} />
              ) : s?.error ? (
                <div style={{ color: "var(--dsw-alias-state-error-primary,#d64545)" }}>
                  {String(s.error)}
                </div>
              ) : (
                <div style={{ color: "var(--dsw-alias-label-tertiary,#9aa0ab)" }}>
                  {t("noData")}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
