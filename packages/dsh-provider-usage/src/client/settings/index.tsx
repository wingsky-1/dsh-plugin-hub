/**
 * dsh-provider-usage — 设置页根组件（多 tab 化，样式基准 = 通知中心）。
 *
 * 形态：共用头（dou-shellTop）+ 整页一张大卡（dou-set-card）+ 顶部六分段器 tab
 * （用量可视化/使用趋势/用量报告/历史报告/适配器/悬浮窗，今日概览置首），
 * 与通知中心同语言（普通 button，不引入 role=tablist）。
 * 六个区块 keep-mounted，行为不变（历史页见 history.tsx）。
 *
 * 挂载策略：keep-mounted + CSS 显隐（pane wrapper 加 hidden 属性）——
 * 与旧「单页长滚动全挂载」请求时序完全一致（零回归），报告/悬浮窗表单编辑态切 tab 不丢；
 * 趋势图为 viewBox 自适应 SVG（无像素测量），display:none 无重测问题。
 * tab 状态纯 useState 内存态（不做 URL/存储持久化，与通知中心一致——宿主 shell
 * 的路由事实源不可被插件页假设，内存态零冲突面）。
 */
import * as React from "react";
import {
  STATS_URL,
  ADAPTERS_URL,
  SELECT_URL,
  INSPECT_URL,
  ADD_URL,
  fetchTimeout,
} from "../core.ts";
import { splitProviderList } from "../../shared/client-logic.ts";
import type { ProviderListItem } from "../../shared/client-logic.ts";
import { t } from "../../../../../shared/client/i18n.js";
// 设置页顶部「使用趋势」区块（三维切换 + 堆叠柱状 + 汇总卡）
import { TrendSection } from "../trend.tsx";
// 设置页「用量报告」区块（配置四区 + 手动生成；历史归独立页）
import { ReportSection } from "../report.tsx";
import { HistorySection, rowIdOf } from "../history.tsx";
import type { ReportMetaView } from "../history.tsx";
import { UsageSection } from "./usage.tsx";
import type { StatsView } from "./usage.tsx";
import { UiSection } from "./ui.tsx";
import { ProviderListSection } from "./providers.tsx";
import type { AdaptersMeta, InspectAdapter, InspectResult, AddResult } from "./providers.tsx";
import { jsonGet } from "./shared.ts";

/** 设置页 tab 键（与窗格一一对应；顺序即渲染顺序；usage 今日概览置首，history 紧随 report，还原生成→查看动线）。 */
export type SettingsTabKey = "usage" | "trend" | "report" | "history" | "providers" | "float";

const TABS: Array<{ key: SettingsTabKey; labelKey: string }> = [
  { key: "usage", labelKey: "pageTabUsage" },
  { key: "trend", labelKey: "pageTabTrend" },
  { key: "report", labelKey: "pageTabReport" },
  { key: "history", labelKey: "pageTabHistory" },
  { key: "providers", labelKey: "pageTabProviders" },
  { key: "float", labelKey: "pageTabFloat" },
];

/** 设置页根组件：模型配置提供商列表驱动手风琴；用量可视化对启用中的 provider 拉 /stats。 */
export function SettingsPage(): React.ReactElement {
  const [tab, setTab] = React.useState<SettingsTabKey>("usage");
  // R1 窄屏：激活 Tab 滚动可见（桌面端无视觉变化；flex:none + overflow-x:auto 见 style.css）。
  const tabsRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const active = tabsRef.current?.querySelector(".dou-set-tabActive") as
      HTMLElement | null | undefined;
    active?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tab]);
  const [statsByProvider, setStatsByProvider] = React.useState<Record<string, StatsView | null>>(
    {},
  );
  const [meta, setMeta] = React.useState<AdaptersMeta | null>(null);
  const [list, setList] = React.useState<{ main: ProviderListItem[]; extra: ProviderListItem[] }>({
    main: [],
    extra: [],
  });
  const [busy, setBusy] = React.useState(false);
  // Q4 生成成功跳转目标（行 id）；HistorySection 消费后回调清除。
  const [pendingExpand, setPendingExpand] = React.useState<string | null>(null);
  const onGeneratedRow = React.useCallback((m: ReportMetaView): void => {
    setPendingExpand(rowIdOf(m));
    setTab("history");
  }, []);
  const onConsumePending = React.useCallback((): void => {
    setPendingExpand(null);
  }, []);

  const reload = React.useCallback(async (): Promise<void> => {
    try {
      const m = (await jsonGet(ADAPTERS_URL).catch(() => null)) as AdaptersMeta | null;
      if (m !== null) {
        setMeta(m);
        // 主列表 = modelProviders（与模型配置页精确一致），额外 provider 收进独立分组
        const grouped: Record<string, Array<{ name: string; label: string; source: string }>> = {};
        for (const info of m.host ?? []) {
          for (const provider of info.providers) {
            (grouped[provider] ??= []).push({
              name: info.name,
              label: info.label,
              source: info.source,
            });
          }
        }
        setList(
          splitProviderList({
            candidatesByProvider: grouped,
            enabled: m.enabled,
            modelProviders: m.modelProviders ?? [],
          }),
        );
      }
      // 用量可视化：仅对运行时启用的 provider 并行拉 /stats
      const providers = Object.keys(m?.enabled ?? {});
      const pairs = await Promise.all(
        providers.map(async (provider) => {
          const s = (await jsonGet(`${STATS_URL}?provider=${encodeURIComponent(provider)}`).catch(
            () => null,
          )) as StatsView | null;
          return [provider, s] as const;
        }),
      );
      setStatsByProvider(Object.fromEntries(pairs));
    } catch {
      /* 面板数据拉取失败静默（保留旧值） */
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  /** 统一包装：请求期间置 busy，完成后刷新面板数据。 */
  function mutate(action: () => Promise<unknown>): void {
    setBusy(true);
    // 显式标注不等待：本包装是 fire-and-forget 语义（失败已被链内 catch 吞掉，只做复位），
    // 调用方拿不到也不该拿到这条链。
    void action()
      .catch(() => {})
      .then(() => reload())
      .finally(() => setBusy(false));
  }

  const onSwitch = React.useCallback(
    (provider: string, adapterName: string): void => {
      mutate(() =>
        fetchTimeout(SELECT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, adapterName }),
        }),
      );
    },
    [reload],
  );

  // 关闭开关 = select 清空该 provider 启用项（停用该 provider 的用量取数）
  const onDisable = React.useCallback(
    (provider: string): void => {
      mutate(() =>
        fetchTimeout(SELECT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, adapterName: null }),
        }),
      );
    },
    [reload],
  );

  /** 检测文件：仅回显导出信息，不登记。 */
  const onInspect = React.useCallback(async (file: string): Promise<InspectResult> => {
    try {
      const res = await fetchTimeout(INSPECT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        adapter?: InspectAdapter;
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        return { ok: false, detail: body.detail ?? body.error ?? `HTTP ${res.status}` };
      }
      return { ok: true, adapter: body.adapter };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }, []);

  /** 登记适配器：仅 file（身份以导出为准），add 路由热注册并持久化。 */
  const onAdd = React.useCallback(
    async (_provider: string, form: { file: string }): Promise<AddResult> => {
      try {
        const res = await fetchTimeout(ADD_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: form.file }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          detail?: string;
        };
        if (!res.ok) {
          return { ok: false, detail: body.detail ?? body.error ?? `HTTP ${res.status}` };
        }
        await reload();
        return { ok: true };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
    [reload],
  );

  // 共用头 providers pill（live 数据：启用数 + 最差健康；0 个则未配置；留存 pill 已砍，见方案 Q5）。
  const enabledIds = Object.keys(statsByProvider);
  const anyStale = enabledIds.some((p) => statsByProvider[p]?.status !== "fresh");
  const providerPill =
    enabledIds.length === 0 ? (
      <span className="dou-shellPill">{t("noProviders")}</span>
    ) : (
      <span
        className={anyStale ? "dou-shellPill dou-shellPillStale" : "dou-shellPill dou-shellPillOk"}
      >
        {anyStale
          ? t("settingsProvidersStale", { n: enabledIds.length })
          : t("settingsProvidersOk", { n: enabledIds.length })}
      </span>
    );

  // 六窗格（keep-mounted：hidden 属性切换显隐，组件实例不销毁——表单编辑态保留）
  const pane = (key: SettingsTabKey, node: React.ReactElement): React.ReactElement => (
    <div className="dou-set-pane" key={key} hidden={tab !== key}>
      {node}
    </div>
  );

  return (
    <React.Fragment>
      <div className="dou-shellTop dou-reportGlass">
        <div>
          <div className="dou-shellKicker">{t("settingsKicker")}</div>
          <h2 className="dou-shellTitle">{t("settingsTitle")}</h2>
        </div>
        <div className="dou-shellMeta">{providerPill}</div>
      </div>
      <div className="dou-set-card" style={{ maxWidth: 560 }}>
        {/* 分段器：普通 button（不用 tablist）。role 用 group——
          不可用 navigation：宿主设置弹窗的移动端适配规则带 :not(:has([role=navigation]))
          排除条件（选择器无引号形态；命中即整弹窗退回桌面 row 布局，
          手机上内容区被压至 ~106px）。 */}
        <div className="dou-set-tabs" ref={tabsRef} role="group" aria-label={t("settingsNavLabel")}>
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`dou-set-tab${tab === item.key ? " dou-set-tabActive" : ""}`}
              aria-pressed={tab === item.key}
              onClick={() => setTab(item.key)}
            >
              {t(item.labelKey as never)}
            </button>
          ))}
        </div>
        <div className="dou-set-body">
          {pane("usage", <UsageSection statsByProvider={statsByProvider} />)}
          {pane("trend", <TrendSection onGotoHeat={() => setTab("usage")} />)}
          {pane("report", <ReportSection onGeneratedRow={onGeneratedRow} />)}
          {pane(
            "history",
            <HistorySection
              pendingExpandId={pendingExpand}
              onConsumePending={onConsumePending}
              active={tab === "history"}
            />,
          )}
          {pane(
            "providers",
            <ProviderListSection
              meta={meta}
              main={list.main}
              extra={list.extra}
              busy={busy}
              onSwitch={onSwitch}
              onDisable={onDisable}
              onInspect={onInspect}
              onAdd={onAdd}
            />,
          )}
          {pane("float", <UiSection />)}
        </div>
      </div>
    </React.Fragment>
  );
}
