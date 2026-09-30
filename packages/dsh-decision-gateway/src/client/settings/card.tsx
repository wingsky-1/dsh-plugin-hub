/**
 * dsh-decision-gateway — 设置独立页卡片（React，宿主 settings.section 插槽渲染）。
 *
 * 三 tab（连接/模板库/历史，一 tab 一主焦点）+ 健康徽标。样式独立 style.css。
 *
 * 【R3 原语层接入：只迁 Button，共 15 处（连接 3 / 模板库 9 / 历史 3）】
 * Button 原语在共享样式块里**一条规则都不出**（视觉与触控热区由调用点传入的领域类
 * 承担），故 dj-btn / dj-btnSmall / dj-btnPrimary / dj-btnDanger 原样传进 className 即
 * 像素零变化，拿到的只是 dsu-btn / data-dsu-btn 钩子与恒定的 type="button"。
 *
 * 下面四族**刻意不迁**，理由逐条钉住（防止被当成漏项「顺手补上」）：
 *   1. dj-tabs / dj-tab / dj-tabActive（本文件唯一未迁的按钮族）：语义层会变。现状是
 *      role="group" + 每项 aria-selected（页签语义）；SegmentedControl 出的是
 *      aria-pressed（开关语义）。冻结契约第 1 层不许在收敛中改读屏播报，故不迁。
 *      视觉也不同：dj-tab 是下划线式（border-bottom 激活），dsu-seg-bar 是白底卡片式。
 *   2. dj-badge*：视觉不等价（0.5px 边 + tabular-nums + 无限宽），而 dsu-badge sm 档是
 *      1px 边 + max-width 55% 省略号——换过去会让长 rootDisplay/会话名被截断；且暗色段
 *      按 .dj-badge 选择器改底，改钩子要连带改暗色段。
 *   3. dj-input / dj-select：padding 7px 11px + radius 8 + bg-layer-1，dsu-input 是
 *      margin-left 6 + padding 2px 6px + radius 4。
 *   4. dj-card：Liquid Glass 外观（0.5px 边 + backdrop-blur + 14px 圆角 + 淡入动画），
 *      dsu-surface-card 是 560px 壳宽 + box-shadow，两者是两套设计语言。
 * 另：dj-field / dj-fold* / dj-tools / dj-foot / dj-note / dj-hist* / 概率条等是本包
 * 领域件，T1 无同构原语，一律原样保留。
 */
import * as React from "react";
import { APP_ROUTES, fetchTimeout } from "../api/interface.ts";
import { t } from "../locale.ts";
import { ConnectionPane } from "./connection.tsx";
import { HistoryPane } from "./history.tsx";
import { PresetsPane } from "./presets.tsx";

type TabKey = "connection" | "presets" | "history";

const TABS: ReadonlyArray<{
  readonly key: TabKey;
  readonly textKey: "tabConnection" | "tabPresets" | "tabHistory";
}> = [
  { key: "connection", textKey: "tabConnection" },
  { key: "presets", textKey: "tabPresets" },
  { key: "history", textKey: "tabHistory" },
];

export function DecisionCard(): React.ReactElement {
  const [active, setActive] = React.useState<TabKey>("connection");
  const [healthText, setHealthText] = React.useState(t("healthChecking"));
  const [healthCls, setHealthCls] = React.useState("dj-badge");
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    void fetchTimeout(APP_ROUTES.health, { headers: { accept: "application/json" } })
      .then((res) => {
        if (!alive.current) return;
        setHealthText(res.ok ? t("healthOk") : t("healthBad") + res.status);
        setHealthCls(res.ok ? "dj-badge dj-statusOk" : "dj-badge dj-statusErr");
      })
      .catch(() => {
        if (!alive.current) return;
        setHealthText(t("healthUnreachable"));
        setHealthCls("dj-badge dj-statusErr");
      });
    return () => {
      alive.current = false;
    };
  }, []);

  return (
    <section className="dj-card" data-plugin="dsh-decision-gateway">
      <div className="dj-head">
        <span className={healthCls}>{healthText}</span>
      </div>
      <div className="dj-tabs" role="group" aria-label={t("tabsAria")}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={tab.key === active ? "dj-tab dj-tabActive" : "dj-tab"}
            aria-selected={tab.key === active ? "true" : "false"}
            onClick={() => setActive(tab.key)}
          >
            {t(tab.textKey)}
          </button>
        ))}
      </div>
      <div className="dj-body">
        {active === "connection" && <ConnectionPane />}
        {active === "presets" && <PresetsPane />}
        {active === "history" && <HistoryPane />}
      </div>
    </section>
  );
}
