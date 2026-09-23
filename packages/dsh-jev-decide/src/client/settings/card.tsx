/**
 * dsh-jev-decide — 设置独立页卡片（React，宿主 settings.section 插槽渲染）。
 *
 * 三 tab（连接/模板库/历史，一 tab 一主焦点）+ 健康徽标。样式独立 style.css。
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

export function JevCard(): React.ReactElement {
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
    <section className="dj-card" data-plugin="dsh-jev-decide">
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
