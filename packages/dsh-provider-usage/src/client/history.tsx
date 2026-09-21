/**
 * dsh-provider-usage — 历史报告独立页（#940 第一批）。
 *
 * 从报告 Tab 搬出（原 report.tsx 历史区原样迁移，行为不变）＋终稿三件套：
 * period 三组可折叠（组头计数）＋状态筛选（全部/成功/失败/空窗口）＋
 * 各组内存分页（初始 HISTORY_PAGE_SIZE 行＋加载更多；服务端读侧无分页参数，
 * 一次全量拉取后渲染层切片，上限见 report-helpers.ts 注释）。
 * 详情仍点击懒加载（GET detail，宿主双层净化 HTML 此处注入安全面）。
 * 生成成功自动跳转由壳经 pendingExpandId 传入（Q4），本页消费后回调清除。
 *
 * 客户端干净模块纪律：只 export 组件与必要类型，不写 loader；
 * fetch 走 core.ts fetchTimeout；文案全部经 locales 字典。
 */
import * as React from "react";
import { fetchTimeout } from "./core.ts";
import {
  HISTORY_PAGE_SIZE,
  filterReportsByStatus,
  groupReportsByPeriod,
} from "./report-helpers.ts";
import type { HistoryStatusFilter } from "./report-helpers.ts";
import { t } from "../../../../shared/client/i18n.js";

/** 宿主端 ROUTES（构建期经 __DSH_ROUTES__ 注入）。 */
declare const __DSH_ROUTES__: Record<string, string> | undefined;
const REPORTS_URL = __DSH_ROUTES__?.reports ?? "/api/dsh-provider-usage/reports";
const REPORT_DETAIL_URL = __DSH_ROUTES__?.reportDetail ?? "/api/dsh-provider-usage/reports/detail";

export type HistoryPeriod = "daily" | "weekly" | "monthly";

export const HISTORY_PERIODS: HistoryPeriod[] = ["daily", "weekly", "monthly"];

const periodLabel = (period: HistoryPeriod): string =>
  period === "daily"
    ? t("reportPeriodDaily")
    : period === "weekly"
      ? t("reportPeriodWeekly")
      : t("reportPeriodMonthly");

/** 报告元数据（/reports 列表行与 detail.meta；与宿主 readReportIndex 投影同构）。 */
export interface ReportMetaView {
  period: HistoryPeriod;
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
  /** 空窗口标记（当期无任何用量，未调模型未落盘）。 */
  noData?: boolean;
  /** hero 摘要（成功生成时落盘；旧报告无此字段不渲染 hero）。 */
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

/** 环比箭头胶囊（null = 上一窗口无数据，不做对比）。 */
function ratioBadge(ratio: number | null): React.ReactElement {
  if (ratio === null) return <span className="dou-heroRatio">—</span>;
  const up = ratio >= 1;
  const pct = Math.round(Math.abs(ratio - 1) * 100);
  return (
    <span className={"dou-heroRatio " + (up ? "dou-heroRatioUp" : "dou-heroRatioDown")}>
      {up ? "↑" : "↓"} {pct === 0 ? t("reportRatioFlat") : t("reportRatioPct", { n: pct })}
    </span>
  );
}

/** 详情页年报 hero 区（海报式渐变不随主题反转，文字恒浅色；第二批前 hero 逻辑冻结）。 */
function reportHero(s: NonNullable<ReportMetaView["summary"]>): React.ReactElement {
  const stats: Array<[string, string]> = [
    [t("reportHeroCalls"), "" + s.calls.toLocaleString("en-US")],
    [t("reportHeroActive"), s.activeDays + " / " + s.windowDays],
    [t("reportHeroStreak"), "" + s.longestStreak],
    [
      t("reportHeroPeak"),
      s.peakDay !== null ? "" + (s.peakDay.total ?? 0).toLocaleString("en-US") : "—",
    ],
  ];
  return (
    <div className="dou-hero">
      <div className="dou-heroBig">
        <span className="dou-heroNum">
          {s.total !== null ? s.total.toLocaleString("en-US") : "—"}
        </span>
        <span className="dou-heroNumUnit">{t("reportHeroTotal")}</span>
        {ratioBadge(s.wowRatio)}
      </div>
      <div className="dou-heroStats">
        {stats.map(([label, value]) => (
          <div className="dou-heroStat" key={label}>
            <small>{label}</small>
            <b>{value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 历史行唯一 id（列表展开态标记与壳跳转目标同源）。 */
export const rowIdOf = (m: Pick<ReportMetaView, "period" | "key">): string =>
  m.period + ":" + m.key;

const FILTERS: HistoryStatusFilter[] = ["all", "ok", "failed", "nodata"];

const filterLabel = (f: HistoryStatusFilter): string =>
  f === "all"
    ? t("reportFilterAll")
    : f === "ok"
      ? t("reportOk")
      : f === "failed"
        ? t("reportFailed")
        : t("reportFilterNoData");

/** 历史报告独立页（壳第六 Tab 内容）。 */
export function HistorySection(props: {
  pendingExpandId: string | null;
  onConsumePending: () => void;
}): React.ReactElement {
  const { pendingExpandId, onConsumePending } = props;
  const [list, setList] = React.useState<ReportMetaView[] | null>(null);
  const [listFailed, setListFailed] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<{
    id: string;
    html: string;
    meta: ReportMetaView;
  } | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<HistoryStatusFilter>("all");
  const [groupOpen, setGroupOpen] = React.useState<Record<HistoryPeriod, boolean>>({
    daily: true,
    weekly: true,
    monthly: true,
  });
  const [visibleCount, setVisibleCount] = React.useState<Record<HistoryPeriod, number>>({
    daily: HISTORY_PAGE_SIZE,
    weekly: HISTORY_PAGE_SIZE,
    monthly: HISTORY_PAGE_SIZE,
  });

  /** 读历史索引（倒序；失败展示错误行）。 */
  const loadReports = React.useCallback(async (): Promise<void> => {
    try {
      const res = await fetchTimeout(REPORTS_URL, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const body = (await res.json()) as { ok?: boolean; reports?: ReportMetaView[] };
      setList(Array.isArray(body.reports) ? body.reports : []);
      setListFailed(false);
    } catch {
      setListFailed(true);
    }
  }, []);

  React.useEffect(() => {
    void loadReports();
  }, [loadReports]);

  /** 行点击展开/收起详情（HTML 已由宿主双层净化）。 */
  const openRowDetail = React.useCallback(async (m: ReportMetaView): Promise<void> => {
    const id = rowIdOf(m);
    setOpenId(id);
    setDetail(null);
    try {
      const params = new URLSearchParams({ period: m.period, key: m.key });
      const res = await fetchTimeout(REPORT_DETAIL_URL + "?" + params.toString(), {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const body = (await res.json()) as { ok?: boolean; html?: string; meta?: ReportMetaView };
      if (typeof body.html !== "string" || body.meta === undefined) throw new Error("bad-detail");
      setDetail({ id, html: body.html, meta: body.meta });
    } catch {
      setDetail({ id, html: "", meta: m });
    }
  }, []);

  const toggleDetail = async (m: ReportMetaView): Promise<void> => {
    const id = rowIdOf(m);
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    await openRowDetail(m);
  };

  // Q4 生成成功自动跳转：壳传入目标行 id，本页切筛选、放行分页、展开详情后消费。
  React.useEffect(() => {
    if (pendingExpandId === null || list === null) return;
    const target = list.find((m) => rowIdOf(m) === pendingExpandId);
    if (target === undefined) {
      onConsumePending();
      return;
    }
    setStatusFilter("all");
    setGroupOpen((g) => ({ ...g, [target.period]: true }));
    setVisibleCount((c) => {
      const idx = list
        .filter((m) => m.period === target.period)
        .findIndex((m) => rowIdOf(m) === pendingExpandId);
      const need = idx < 0 ? c[target.period] : idx + 1;
      if (need <= c[target.period]) return c;
      return { ...c, [target.period]: need };
    });
    void openRowDetail(target).then(() => onConsumePending());
  }, [pendingExpandId, list, openRowDetail, onConsumePending]);

  const filtered = list === null ? null : filterReportsByStatus(list, statusFilter);
  const groups = filtered === null ? null : groupReportsByPeriod(filtered);

  return (
    <section className="dou-report dou-reportGlass" style={{ marginBottom: 16 }}>
      <div className="dou-reportHead">
        <h2 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{t("reportSectionHistory")}</h2>
        {list !== null ? (
          <span className="dou-reportPromptBudget">
            {t("reportSummaryNReports", { n: list.length })}
          </span>
        ) : null}
      </div>
      <p className="dou-reportHint">{t("historySub")}</p>
      <div className="dou-reportPromptTabs" role="group" aria-label={t("reportFilterStatus")}>
        <span className="dou-reportLabel">{t("reportFilterStatus")}</span>
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={
              "dou-reportPromptTab" + (statusFilter === f ? " dou-reportPromptTabActive" : "")
            }
            aria-pressed={statusFilter === f}
            onClick={() => setStatusFilter(f)}
          >
            {filterLabel(f)}
          </button>
        ))}
      </div>
      {listFailed ? <div className="dou-reportFetchFail">{t("reportFetchFail")}</div> : null}
      {groups === null ? null : list !== null && list.length === 0 ? (
        <div className="dou-reportEmpty">{t("reportEmpty")}</div>
      ) : (
        <div className="dou-reportSections">
          {HISTORY_PERIODS.map((period) => {
            const rows = groups[period];
            const visible = rows.slice(0, visibleCount[period]);
            const groupId = "dou-hist-" + period;
            return (
              <div className="dou-reportSection dou-reportGlass" key={period}>
                <button
                  type="button"
                  className="dou-reportSectionHead"
                  aria-expanded={groupOpen[period]}
                  aria-controls={groupId + "-body"}
                  onClick={() => setGroupOpen((g) => ({ ...g, [period]: !g[period] }))}
                >
                  <span className="dou-reportSectionArrow" aria-hidden="true">
                    {groupOpen[period] ? "▾" : "▸"}
                  </span>
                  <span className="dou-reportSectionTitle">{periodLabel(period)}</span>
                  <span className="dou-reportSectionSummary">
                    {t("reportSummaryNReports", { n: rows.length })}
                  </span>
                </button>
                {groupOpen[period] ? (
                  <div className="dou-reportSectionBody" id={groupId + "-body"}>
                    {rows.length === 0 ? null : (
                      <ul className="dou-reportList">
                        {visible.map((m) => {
                          const id = rowIdOf(m);
                          let detailNode: React.ReactNode = null;
                          if (openId === id) {
                            const parts: React.ReactNode[] = [];
                            if (detail !== null && detail.id === id) {
                              const tokens = detail.meta.tokens;
                              if (
                                tokens !== null &&
                                tokens !== undefined &&
                                tokens.totalTokens !== null
                              ) {
                                parts.push(
                                  <div className="dou-reportDetailMeta" key="meta">
                                    {t("reportDetailTokens", {
                                      n: tokens.totalTokens.toLocaleString("en-US"),
                                    })}
                                  </div>,
                                );
                              }
                              const summary = detail.meta.summary;
                              if (summary !== null && summary !== undefined) {
                                parts.push(reportHero(summary));
                              }
                              if (detail.meta.noData === true) {
                                parts.push(
                                  <div className="dou-reportGenNotice" key="nodata">
                                    {t("reportNoData")}
                                  </div>,
                                );
                              } else {
                                parts.push(
                                  detail.html.length > 0 ? (
                                    <div
                                      className="dou-reportDetailBody"
                                      key="body"
                                      dangerouslySetInnerHTML={{ __html: detail.html }}
                                    />
                                  ) : (
                                    <div className="dou-reportFetchFail" key="empty">
                                      {detail.meta.error ?? t("reportFetchFail")}
                                    </div>
                                  ),
                                );
                              }
                              parts.push(
                                <button
                                  type="button"
                                  className="dou-reportCollapse"
                                  key="collapse"
                                  onClick={() => {
                                    setOpenId(null);
                                    setDetail(null);
                                  }}
                                >
                                  {t("reportCollapse")}
                                </button>,
                              );
                            } else {
                              parts.push(
                                <div className="dou-reportLoading" key="loading">
                                  {t("loading")}
                                </div>,
                              );
                            }
                            detailNode = <div className="dou-reportDetail">{parts}</div>;
                          }
                          return (
                            <li className="dou-reportItem" key={id}>
                              <button
                                type="button"
                                className="dou-reportItemHead"
                                aria-expanded={openId === id}
                                aria-controls={id + "-detail"}
                                onClick={() => void toggleDetail(m)}
                              >
                                <span className="dou-reportItemPeriod">
                                  {periodLabel(m.period)}
                                </span>
                                <span className="dou-reportItemKey">{m.key}</span>
                                <span
                                  className={
                                    m.ok
                                      ? "dou-reportBadge dou-reportBadgeOk"
                                      : "dou-reportBadge dou-reportBadgeFail"
                                  }
                                >
                                  {m.ok ? t("reportOk") : t("reportFailed")}
                                </span>
                                <span className="dou-reportItemTime">
                                  {new Date(m.generatedAt).toLocaleString()}
                                </span>
                              </button>
                              {detailNode !== null ? (
                                <div id={id + "-detail"}>{detailNode}</div>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {rows.length > visible.length ? (
                      <button
                        type="button"
                        className="dou-reportPromptReset"
                        onClick={() =>
                          setVisibleCount((c) => ({
                            ...c,
                            [period]: c[period] + HISTORY_PAGE_SIZE,
                          }))
                        }
                      >
                        {t("reportLoadMore")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
