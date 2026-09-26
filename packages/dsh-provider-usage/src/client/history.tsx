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
  locatePendingRow,
} from "./report-helpers.ts";
import type { HistoryStatusFilter } from "./report-helpers.ts";
import { t } from "../../../../shared/client/i18n.js";

/** 报告两路由经 ./shared/contract.ts 具名表（host-seams R2 收敛，字面量只留契约一份）。 */
import { REPORT_DETAIL_URL, REPORTS_URL } from "./shared/contract.ts";

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
    /** 最活跃钟点（B2-3 新增落盘；旧报告缺字段，判空渲染） */
    peakHour?: { hour: number; calls: number; total: number | null } | null;
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

/**
 * 详情页年报 hero 区（海报式渐变不随主题反转，文字恒浅色）。
 * PM1 三周期差异化：日报单日窗口连续天数无意义，改show高峰钟点
 * （有值才渲染该行，覆盖不足/旧报告缺字段即跳过）；周/月报保留连续天数行。
 */
function reportHero(
  s: NonNullable<ReportMetaView["summary"]>,
  period: HistoryPeriod,
): React.ReactElement {
  const stats: Array<[string, string]> = [
    [t("reportHeroCalls"), "" + s.calls.toLocaleString("en-US")],
    [t("reportHeroActive"), s.activeDays + " / " + s.windowDays],
  ];
  if (period === "daily") {
    const peakHour = s.peakHour ?? null;
    if (peakHour !== null)
      stats.push([t("reportHeroPeakHour"), t("reportPeakHourValue", { n: peakHour.hour })]);
  } else {
    stats.push([t("reportHeroStreak"), "" + s.longestStreak]);
  }
  stats.push([
    t("reportHeroPeak"),
    s.peakDay !== null ? "" + (s.peakDay.total ?? 0).toLocaleString("en-US") : "—",
  ]);
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

/** 状态筛选按钮 class：命中当前筛选时追加 active 后缀。 */
const filterTabClass = (f: HistoryStatusFilter, active: HistoryStatusFilter): string =>
  "dou-reportPromptTab" + (active === f ? " dou-reportPromptTabActive" : "");

/** 顶部报告数徽标：行表未就绪（null，首拉之前）时不渲染。 */
function historyCountBadge(rows: ReportMetaView[] | null): React.ReactNode {
  if (rows === null) return null;
  return (
    <span className="dou-reportPromptBudget">{t("reportSummaryNReports", { n: rows.length })}</span>
  );
}

/**
 * 空态节点（只管「有没有行可渲染」这一件事）：
 * 筛选后为空才出节点，并区分「筛选前本就空」（reportEmpty）与「筛选后空但原始有行」
 * （reportFilterEmpty）；未就绪/非空返回 null，调用方回退正常列表。
 */
function historyEmptyNode(
  filtered: ReportMetaView[] | null,
  list: ReportMetaView[] | null,
): React.ReactNode {
  if (filtered === null || filtered.length > 0) return null;
  return (
    <div className="dou-reportEmpty">
      {list !== null && list.length > 0 ? t("reportFilterEmpty") : t("reportEmpty")}
    </div>
  );
}

/** 展开态详情已加载的本地快照（行 id + 宿主净化 HTML + 该行元数据）。 */
interface HistoryDetail {
  id: string;
  html: string;
  meta: ReportMetaView;
}

/** 详情 token 行：tokens 缺失/未知/无总数任一成立即不渲染该行。 */
function historyTokenNode(tokens: ReportMetaView["tokens"]): React.ReactNode {
  if (!(tokens !== null && tokens !== undefined && tokens.totalTokens !== null)) return null;
  return (
    <div className="dou-reportDetailMeta" key="meta">
      {t("reportDetailTokens", { n: tokens.totalTokens.toLocaleString("en-US") })}
    </div>
  );
}

/** 详情正文：noData 走提示行；空 HTML 走错误 + 重试提示；否则注入宿主净化 HTML。 */
function historyBodyNode(detail: HistoryDetail): React.ReactNode {
  if (detail.meta.noData === true) {
    return (
      <div className="dou-reportGenNotice" key="nodata">
        {t("reportNoData")}
      </div>
    );
  }
  if (detail.html.length > 0) {
    return (
      <div
        className="dou-reportDetailBody"
        key="body"
        dangerouslySetInnerHTML={{ __html: detail.html }}
      />
    );
  }
  return (
    <React.Fragment key="empty">
      <div className="dou-reportFetchFail">{detail.meta.error ?? t("reportFetchFail")}</div>
      <div className="dou-reportHint">{t("reportRetryHint")}</div>
    </React.Fragment>
  );
}

/** 收起按钮（唯一的状态清空入口，行为与内联版逐字一致）。 */
function historyCollapseNode(onCollapse: () => void): React.ReactNode {
  return (
    <button type="button" className="dou-reportCollapse" key="collapse" onClick={onCollapse}>
      {t("reportCollapse")}
    </button>
  );
}

/**
 * 展开态详情块序列（职责：详情内容装配；行壳在 HistoryRow）：
 * 快照尚未命中该行（懒加载中）→ loading 占位；命中 → token 行 + hero + 正文 + 收起按钮。
 */
function historyDetailParts(
  m: ReportMetaView,
  detail: HistoryDetail | null,
  onCollapse: () => void,
): React.ReactNode[] {
  if (detail === null || detail.id !== rowIdOf(m)) {
    return [
      <div className="dou-reportLoading" key="loading">
        {t("loading")}
      </div>,
    ];
  }
  const parts: React.ReactNode[] = [];
  const tokenNode = historyTokenNode(detail.meta.tokens);
  if (tokenNode !== null) parts.push(tokenNode);
  const summary = detail.meta.summary;
  if (summary !== null && summary !== undefined)
    parts.push(reportHero(summary, detail.meta.period));
  parts.push(historyBodyNode(detail));
  parts.push(historyCollapseNode(onCollapse));
  return parts;
}

interface HistoryRowProps {
  m: ReportMetaView;
  openId: string | null;
  detail: HistoryDetail | null;
  onToggle: (m: ReportMetaView) => void;
  onCollapse: () => void;
}

/** 历史列表单行（行头 + 展开详情容器）；行壳与详情装配分属两处职责，故分组件。 */
function HistoryRow(props: HistoryRowProps): React.ReactElement {
  const { m, openId, detail, onToggle, onCollapse } = props;
  const id = rowIdOf(m);
  const detailNode =
    openId === id ? (
      <div className="dou-reportDetail">{historyDetailParts(m, detail, onCollapse)}</div>
    ) : null;
  return (
    <li className="dou-reportItem" key={id}>
      <button
        type="button"
        className="dou-reportItemHead"
        aria-expanded={openId === id}
        aria-controls={id + "-detail"}
        onClick={() => void onToggle(m)}
      >
        <span className="dou-reportItemPeriod">{periodLabel(m.period)}</span>
        <span className="dou-reportItemKey">{m.key}</span>
        <span
          className={
            m.ok ? "dou-reportBadge dou-reportBadgeOk" : "dou-reportBadge dou-reportBadgeFail"
          }
        >
          {m.ok ? t("reportOk") : t("reportFailed")}
        </span>
        <span className="dou-reportItemTime">
          {new Date(m.generatedAt).toLocaleString("zh-CN", { hour12: false })}
        </span>
      </button>
      {detailNode !== null ? <div id={id + "-detail"}>{detailNode}</div> : null}
    </li>
  );
}

/** 历史报告独立页（壳第六 Tab 内容）。 */
export function HistorySection(props: {
  pendingExpandId: string | null;
  onConsumePending: () => void;
  /** 所在 Tab 是否可见（keep-mounted 下切页刷新策略见下）。 */
  active: boolean;
}): React.ReactElement {
  const { pendingExpandId, onConsumePending, active } = props;
  const [list, setList] = React.useState<ReportMetaView[] | null>(null);
  const [listFailed, setListFailed] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<HistoryDetail | null>(null);
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
  // D1 未见目标行的用户可见反馈（禁止静默吞键）+ 手动重拉入口。
  const [jumpNotice, setJumpNotice] = React.useState(false);
  const listRef = React.useRef<ReportMetaView[] | null>(null);
  listRef.current = list;
  const wasActive = React.useRef(active);

  /**
   * 读历史索引（倒序；失败展示错误行），返回行表供跳转定位复用。
   * 刷新策略（R1）：mount 拉一次 + 切到本页重拉 + pending 到达重拉；
   * 详情仍点击懒加载，不在此预取。
   */
  const fetchList = React.useCallback(async (): Promise<ReportMetaView[] | null> => {
    try {
      const res = await fetchTimeout(REPORTS_URL, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const body = (await res.json()) as { ok?: boolean; reports?: ReportMetaView[] };
      const rows = Array.isArray(body.reports) ? body.reports : [];
      setList(rows);
      setListFailed(false);
      return rows;
    } catch {
      setListFailed(true);
      return null;
    }
  }, []);

  React.useEffect(() => {
    void fetchList();
  }, [fetchList]);

  // 切到历史页时重拉（keep-mounted 下 mount 快照会 stale）。
  React.useEffect(() => {
    if (active && !wasActive.current) void fetchList();
    wasActive.current = active;
  }, [active, fetchList]);

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

  const onCollapse = (): void => {
    setOpenId(null);
    setDetail(null);
  };

  const toggleDetail = async (m: ReportMetaView): Promise<void> => {
    const id = rowIdOf(m);
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    await openRowDetail(m);
  };

  // Q4 生成成功自动跳转（D1 修法 a）：目标 id 到达时先在快照定位，
  // 缺失（新窗口）则重拉再定位；仍缺则落用户可见 notice，禁止静默吞键。
  React.useEffect(() => {
    if (pendingExpandId === null) return;
    let cancelled = false;
    setJumpNotice(false);
    const expand = (target: ReportMetaView): void => {
      setStatusFilter("all");
      setGroupOpen((g) => ({ ...g, [target.period]: true }));
      setVisibleCount((c) => {
        const rows = (listRef.current ?? []).filter((m) => m.period === target.period);
        const idx = rows.findIndex((m) => rowIdOf(m) === pendingExpandId);
        const need = idx < 0 ? c[target.period] : idx + 1;
        if (need <= c[target.period]) return c;
        return { ...c, [target.period]: need };
      });
      void openRowDetail(target).then(() => {
        if (!cancelled) onConsumePending();
      });
    };
    const first = locatePendingRow(listRef.current ?? [], pendingExpandId);
    if (first !== undefined) {
      expand(first);
      return () => {
        cancelled = true;
      };
    }
    void fetchList().then((fresh) => {
      if (cancelled) return;
      const target = fresh === null ? undefined : locatePendingRow(fresh, pendingExpandId);
      if (target === undefined) {
        setJumpNotice(true);
        onConsumePending();
        return;
      }
      expand(target);
    });
    return () => {
      cancelled = true;
    };
  }, [pendingExpandId, fetchList, openRowDetail, onConsumePending]);

  const filtered = list === null ? null : filterReportsByStatus(list, statusFilter);
  const groups = filtered === null ? null : groupReportsByPeriod(filtered);

  return (
    <section className="dou-report dou-reportGlass" style={{ marginBottom: 16 }}>
      <div className="dou-reportHead">
        <h2 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{t("reportSectionHistory")}</h2>
        {historyCountBadge(filtered ?? list)}
      </div>
      <p className="dou-reportHint">{t("historySub")}</p>
      <div className="dou-reportPromptTabs" role="group" aria-label={t("reportFilterStatus")}>
        <span className="dou-reportLabel">{t("reportFilterStatus")}</span>
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={filterTabClass(f, statusFilter)}
            aria-pressed={statusFilter === f}
            onClick={() => setStatusFilter(f)}
          >
            {filterLabel(f)}
          </button>
        ))}
      </div>
      {listFailed ? <div className="dou-reportFetchFail">{t("reportFetchFail")}</div> : null}
      {jumpNotice ? (
        <div className="dou-reportGenNotice">
          {t("reportGeneratedNotVisible")}
          <button
            type="button"
            className="dou-reportPromptReset"
            onClick={() => {
              setJumpNotice(false);
              void fetchList();
            }}
          >
            {t("reportReloadList")}
          </button>
        </div>
      ) : null}
      {groups === null
        ? null
        : (historyEmptyNode(filtered, list) ?? (
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
                            {visible.map((m) => (
                              <HistoryRow
                                key={rowIdOf(m)}
                                m={m}
                                openId={openId}
                                detail={detail}
                                onToggle={(row) => void toggleDetail(row)}
                                onCollapse={onCollapse}
                              />
                            ))}
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
          ))}
    </section>
  );
}
