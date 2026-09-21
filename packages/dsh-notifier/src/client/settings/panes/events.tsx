/**
 * 通知事件 tab 内容片：事件开关卡 + 动态 kind 待确认/已确认区 + 资源上限折叠区 + 免打扰卡。
 *
 * 普通函数返回 JSX 数组（与搬走前的 eventsPane 变量同形）：卡片对三个 pane 做**条件调用**
 * （非 active tab 根本不调用），改成组件会引入挂载/卸载语义。卡片状态（settings / kindsList /
 * patch / confirmOne / routeChipsRow / severityOf / t）一律显式传参——本模块零 state、零 ref、
 * 零定时器、零模块级可变状态；依赖不从 SettingsCard 闭包取值。
 */
import * as React from "react";
import { KIND_SWITCHES, QUIET_WINDOWS_LIMIT, inWindowMinutes } from "../../../shared/interface.ts";
import type { KindSwitchKey, NotifySeverity } from "../../../shared/interface.ts";
import { KIND_KEYS } from "../../locales.ts";
import type { NotifierLocaleKey } from "../../locales.ts";
import type { Translate } from "../../locale.ts";
import { switchControl, switchToggle } from "../parts/controls.tsx";
import { kindIcon, sevIcon, tabIcon } from "../parts/kind-icons.tsx";
import { advRow } from "../parts/rows.tsx";
import type { QuietHoursView, RegisteredKindView, SettingsPatch, SettingsView } from "../types.ts";

// i18n：label 列存字典 key（渲染期 t 求值，模块加载时 t 尚未装配）。
// 两列各自锚在 shared 的 KindSwitchKey 与本文案字典 key 上：任一侧改名或漏配都是编译错误，
// 而不是运行期读到 undefined 的开关 / 文案。
const EVENT_KEYS = [
  ["notifyAsk", "evtAsk"],
  ["notifyQuestion", "evtQuestion"],
  ["notifyTaskDone", "evtTaskDone"],
  ["notifySubagentDone", "evtSubagentDone"],
  ["notifyTaskError", "evtTaskError"],
  ["notifyTurnEnd", "evtTurnEnd"],
] satisfies [KindSwitchKey, NotifierLocaleKey][];

/** 事件开关键 → 通知 kind：由 shared 的 kind → 开关键表**反转**得到（单一事实源，
 *  免打扰豁免候选/「跟随已启用」由此派生；收口前这里是一份两端各写的副本）。 */
const EVENT_KIND_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(KIND_SWITCHES).map(function (entry): [string, string] {
    return [entry[1], entry[0]];
  }),
);

/**
 * 事件 tab 内容片：内置事件卡（sev 色点 + kind 码 + switch + 路由 chips）+ 动态 kind
 * 清单（待确认 = 允许/拒绝；已确认 = 撤销 + 路由 chips）+ 资源上限折叠区 + 免打扰卡。
 *
 * routeChipsRow 与 severityOf 都留在卡片（前者是路由闭包，后者为事件/历史两个 pane 共用），
 * 由调用方显式传入。
 */
export function eventsPane(
  settings: SettingsView,
  kindsList: RegisteredKindView[],
  patch: (p: SettingsPatch) => void,
  confirmOne: (kind: string, confirmed: boolean) => void,
  routeChipsRow: (kind: string) => React.ReactNode,
  severityOf: (kind: string) => NotifySeverity,
  t: Translate,
) {
  // 事件区：内置事件卡（sev 色点 + kind 码 + switch + 路由 chips）
  const eventChildren: React.ReactNode[] = [];
  EVENT_KEYS.forEach(function (kv) {
    const key = kv[0],
      labelKey = kv[1];
    const kindId = EVENT_KIND_MAP[key];
    const sev = severityOf(kindId);
    eventChildren.push(
      <div className="dn-evt" key={"ev-" + key}>
        <div className="dn-evt-head">
          {kindIcon(kindId)}
          <span className="dn-evt-name">{t(labelKey)}</span>
          <span className="dn-evt-kind">{kindId}</span>
          <span
            className={"dn-sev" + (sev !== "info" ? " dn-sev-" + sev : "")}
            title={"severity: " + sev}
          />
          {switchControl(key, t("evtSwitch", { name: t(labelKey) }), settings, patch)}
        </div>
        {routeChipsRow(kindId)}
      </div>,
    );
  });
  // 动态 kind（插件提议的通知类型）：待确认 = 允许/拒绝 + 路由提示；已允许 = 同款
  // 路由 chips（动态 kind 也支持配置投递频道——kindRoutes 天然支持动态
  // kind id 作 key，与服务端 resolveRoutes 的 kind 无关路由解析一致）。
  const kindRows: React.ReactNode[] = kindsList.map(function (k) {
    const nameText = k.label && k.label !== k.id ? k.label : k.id;
    if (k.confirmed) {
      return (
        <div className="dn-kinds dn-kinds-ok" key={k.id}>
          <div className="dn-kinds-head">
            {kindIcon(k.id)}
            <span className="dn-kinds-name">{nameText}</span>
            <span className="dn-evt-kind">{k.id}</span>
            <span className="dn-kinds-actions">
              <button
                type="button"
                className="dn-set-btn dn-set-btnSmall"
                onClick={function () {
                  confirmOne(k.id, false);
                }}
              >
                {t("kindRevoke")}
              </button>
            </span>
          </div>
          {routeChipsRow(k.id)}
        </div>
      );
    }
    return (
      <div className="dn-kinds" key={k.id}>
        <div className="dn-kinds-head">
          {kindIcon(k.id)}
          <span className="dn-kinds-name">{nameText}</span>
          <span className="dn-evt-kind">{k.id}</span>
          <span className="dn-kinds-actions">
            <button
              type="button"
              className="dn-set-btn dn-set-btnSmall dn-set-btnPrimary"
              onClick={function () {
                confirmOne(k.id, true);
              }}
            >
              {t("kindAllow")}
            </button>
            <button
              type="button"
              className="dn-set-btn dn-set-btnSmall dn-set-btnGhostDanger"
              onClick={function () {
                confirmOne(k.id, false);
              }}
            >
              {t("kindDeny")}
            </button>
          </span>
        </div>
        <div className="dn-kind-routeHint">{t("kindRouteHint")}</div>
      </div>
    );
  });
  eventChildren.push(
    <div key="kinds">
      <div className="dn-sec" style={{ marginTop: "14px" }}>
        <span className="dn-sec-title">{t("kindsTitle")}</span>
        <span className="dn-sec-hint">{t("kindsHint")}</span>
      </div>
      {kindsList.length === 0 ? <div className="dn-set-note">{t("kindsEmpty")}</div> : kindRows}
    </div>,
  );

  // 资源上限折叠区（统一 dn-ch-adv 折叠形态 + dn-adv-row 行）
  const dedupFold = (
    <details className="dn-ch-adv dn-sec-adv" key="adv-params">
      <summary>{t("secDedup")}</summary>
      <div className="dn-ch-adv-body">
        {advRow(
          t("historyRetention"),
          <input
            type="number"
            min={0}
            step={1}
            className="dn-set-input dn-set-numInput"
            aria-label={t("historyRetention")}
            value={settings.historyMaxAgeDays}
            onChange={function (e: React.ChangeEvent<HTMLInputElement>) {
              patch({ historyMaxAgeDays: Number(e.target.value) });
            }}
          />,
        )}
      </div>
    </details>
  );

  const qh: QuietHoursView = settings.quietHours || {};
  const allows = qh.allowKinds || [];
  function setAllowKinds(next: string[]) {
    patch({ quietHours: Object.assign({}, qh, { allowKinds: next }) });
  }
  /** 跟随已启用事件：一键把当前 notifyXxx=true 的对应 kind 全选为豁免（函数式更新读最新
   *  快照，避免连点/同帧先改开关后旧闭包漏勾最新态）。
   *  必须走 patch 而不是裸 setSettings：patch 在 updater 内同步 settingsRef.current，而
   *  diffPayload() 读的正是那个 ref——绕过它这次改动就进不了 diff，用户在未做其它编辑时
   *  点保存会看到「未修改」，改动被静默丢弃。 */
  function allowFollowEnabled() {
    patch(function (prev) {
      const nextQh: QuietHoursView = prev.quietHours || {};
      const next = EVENT_KEYS.filter(function (kv) {
        return prev[kv[0]] === true;
      }).map(function (kv) {
        return EVENT_KIND_MAP[kv[0]];
      });
      return Object.assign({}, prev, {
        quietHours: Object.assign({}, nextQh, { allowKinds: next }),
      });
    });
  }
  /** 恢复默认豁免（ask/question/error——高频阻塞型，卡着的任务需要叫醒）。 */
  function allowResetDefault() {
    setAllowKinds(["ask", "question", "error"]);
  }
  // 免打扰豁免候选（覆盖全部 6 个内置事件 kind，label 复用事件文案
  // KIND_KEYS 字典；由 EVENT_KEYS + EVENT_KIND_MAP 派生，不新建平行表。
  // chips 直点形态——未启用事件弱化沿用 dn-set-allowDim 锚点，勾选态保留照常
  // 写入（服务端判定只看 quietHours.allowKinds.includes(kind)，不看开关）。
  const quietAllowChoices = EVENT_KEYS.map(function (kv) {
    const notifyKey = kv[0];
    const kind = EVENT_KIND_MAP[notifyKey];
    const enabled = settings[notifyKey] === true;
    return {
      kind: kind,
      notifyKey: notifyKey,
      enabled: enabled,
      labelKey: KIND_KEYS[kind] || "k" + kind,
    };
  });
  const allowChips = quietAllowChoices.map(function (c) {
    const checked = allows.indexOf(c.kind) !== -1;
    // 未启用事件：置灰禁点——事件开关关闭则不产生通知，豁免勾选无意义；
    // 保留已勾选显示（不自动改配置），启用事件后恢复可点。禁点用原生 disabled。
    return (
      <button
        type="button"
        key={c.kind}
        className={
          "dn-route-chip" + (checked ? " is-on" : "") + (c.enabled ? "" : " dn-set-allowDim")
        }
        aria-pressed={checked ? "true" : "false"}
        disabled={!c.enabled}
        title={c.enabled ? undefined : t("allowDisabledHint")}
        onClick={function () {
          const next = allows.slice();
          if (!checked && next.indexOf(c.kind) === -1) next.push(c.kind);
          else if (checked && next.indexOf(c.kind) !== -1) next.splice(next.indexOf(c.kind), 1);
          setAllowKinds(next);
        }}
      >
        {t(c.labelKey)}
        {c.enabled ? null : <span className="dn-set-allowHint">{t("allowDisabledHint")}</span>}
      </button>
    );
  });
  // 免打扰时间窗（多段，#936）：windows 在场即用（含空数组），显式忽略旧形 start/end
  // （与服务端 asQuietHours 同语义：显式 [] = 未命中，不是缺了要补）；windows 缺席才把
  // 旧形 start/end 看成单项（读面兼容），都没给则空列表。上限读共享面 QUIET_WINDOWS_LIMIT
  //（与服务端写面同源，改动只改共享处）。
  type WindowRow = { start: string; end: string };
  const windowRows: WindowRow[] = (function () {
    if (Array.isArray(qh.windows)) {
      return qh.windows.map(function (w) {
        return {
          start: typeof w.start === "string" ? w.start : "",
          end: typeof w.end === "string" ? w.end : "",
        };
      });
    }
    if (typeof qh.start === "string" || typeof qh.end === "string") {
      return [
        {
          start: typeof qh.start === "string" ? qh.start : "",
          end: typeof qh.end === "string" ? qh.end : "",
        },
      ];
    }
    return [];
  })();
  // 写面一律提交 windows，并清掉旧形 start/end（升级步清的是磁盘文件，这里清的是新提交，
  // 否则旧键会借着每一次保存重新长回来）。
  function setWindows(next: WindowRow[]) {
    const qhNext: QuietHoursView = Object.assign({}, qh, { windows: next });
    delete qhNext.start;
    delete qhNext.end;
    patch({ quietHours: qhNext });
  }
  function setWindowAt(index: number, key: "start" | "end", value: string) {
    setWindows(
      windowRows.map(function (w, i) {
        return i === index ? Object.assign({}, w, { [key]: value }) : w;
      }),
    );
  }
  function addWindow() {
    if (windowRows.length >= QUIET_WINDOWS_LIMIT) return;
    setWindows(windowRows.concat([{ start: "12:00", end: "13:00" }]));
  }
  function removeWindowAt(index: number) {
    setWindows(
      windowRows.filter(function (_w, i) {
        return i !== index;
      }),
    );
  }
  // 本机回显：按本机时间逐窗口推算命中与否，只做回显（权威裁决在服务端 judge），故配免责文案。
  // 命中口径读共享面 inWindowMinutes（与服务端裁决同源，改动只改共享处）。
  function pad2(n: number): string {
    return n < 10 ? "0" + n : "" + n;
  }
  const nowDate = new Date();
  const nowText = pad2(nowDate.getHours()) + ":" + pad2(nowDate.getMinutes());
  const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
  const hitRow = windowRows.find(function (w) {
    return inWindowMinutes(nowMinutes, w.start, w.end);
  });
  const dndPreview =
    qh.enabled !== true
      ? t("dndPreviewOff")
      : hitRow !== undefined
        ? t("dndPreviewHit", { now: nowText, start: hitRow.start, end: hitRow.end })
        : t("dndPreviewMiss", { now: nowText });

  // 免打扰卡（开关 + 多时段 + 豁免 chips + 快捷按钮）
  const dndCard = (
    <div className="dn-dnd" key="dnd">
      <div className="dn-dnd-head">
        {sevIcon("warning", "dn-sev-warning")}
        <span className="dn-evt-name">{t("dndEnable")}</span>
        {switchToggle(
          qh.enabled === true,
          function (v: boolean) {
            patch({ quietHours: Object.assign({}, qh, { enabled: v }) });
          },
          t("dndEnable"),
        )}
      </div>
      {qh.enabled === true ? (
        <div>
          {windowRows.map(function (w, i) {
            return (
              <div className="dn-dnd-row" key={"win-" + i}>
                {tabIcon("history")}
                <span className="dn-dnd-cap">{t("dndWindow", { n: i + 1 })}</span>
                <input
                  type="time"
                  className="dn-set-input"
                  aria-label={t("dndStart")}
                  value={w.start}
                  onChange={function (e: React.ChangeEvent<HTMLInputElement>) {
                    setWindowAt(i, "start", e.target.value);
                  }}
                />
                <span className="dn-dnd-cap">{t("dndEnd")}</span>
                <input
                  type="time"
                  className="dn-set-input"
                  aria-label={t("dndEnd")}
                  value={w.end}
                  onChange={function (e: React.ChangeEvent<HTMLInputElement>) {
                    setWindowAt(i, "end", e.target.value);
                  }}
                />
                <button
                  type="button"
                  className="dn-set-btn dn-set-btnSmall"
                  aria-label={t("dndRemoveWindow")}
                  onClick={function () {
                    removeWindowAt(i);
                  }}
                >
                  {t("dndRemoveWindow")}
                </button>
              </div>
            );
          })}
          {windowRows.length === 0 ? <div className="dn-set-note">{t("dndEmptyHint")}</div> : null}
          <div className="dn-dnd-row">
            <button
              type="button"
              className="dn-set-btn dn-set-btnSmall"
              onClick={addWindow}
              disabled={windowRows.length >= QUIET_WINDOWS_LIMIT}
              title={t("dndLimitHint")}
            >
              {t("dndAddWindow")}
            </button>
            <span className="dn-sec-hint">{t("dndLimitHint")}</span>
          </div>
          <div className="dn-set-note">{dndPreview}</div>
          <div className="dn-set-note">{t("dndPreviewNote")}</div>
          <div className="dn-dnd-row" style={{ display: "block" }}>
            <span className="dn-dnd-cap">{t("dndStillLabel") + "："}</span>
            <div className="dn-set-allows">{allowChips}</div>
            <div className="dn-set-allowActions">
              <button
                type="button"
                className="dn-set-btn dn-set-btnSmall"
                onClick={allowFollowEnabled}
              >
                {t("allowFollowEnabled")}
              </button>
              <button
                type="button"
                className="dn-set-btn dn-set-btnSmall"
                onClick={allowResetDefault}
              >
                {t("allowResetDefault")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  return [eventChildren, dedupFold, dndCard];
}
