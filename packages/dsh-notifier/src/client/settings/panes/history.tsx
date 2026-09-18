/**
 * 通知记录 tab 内容片：工具行（清理记录两段确认 / 发送测试 / 刷新并排）+ 历史列表
 * （severity 色点 + kind 文案 + 时间 + 免打扰标记 + 逐出口投递明细）。
 *
 * 普通函数返回 JSX（卡片对它做**条件调用**——非 active tab 根本不调用；改成组件会引入
 * 挂载/卸载语义）。history / clearArmed / confirmClear / sendTest / loadHistory / severityOf / t
 * 一律显式传参——本模块零 state、零 ref、零定时器、零模块级可变状态。
 */
import * as React from "react";
import type { NotifySeverity } from "../../../shared/interface.ts";
import { KIND_KEYS } from "../../locales.ts";
import type { Translate } from "../../locale.ts";
import { deliveryLines } from "../parts/rows.tsx";
import type { HistoryRecordView } from "../types.ts";

/**
 * 历史列表片：清理/测试/刷新工具行 + 最近记录列表。
 * deliveryLines 的调用点在本模块内（reason-text 契约断言按此读文件）。
 */
export function historyPane(
  history: HistoryRecordView[] | null,
  clearArmed: boolean,
  confirmClear: () => void,
  sendTest: (id?: string) => void,
  loadHistory: (alive: { value: boolean }) => void,
  severityOf: (kind: string) => NotifySeverity,
  t: Translate,
) {
  return (
    <div key="history">
      <div className="dn-set-historyTools">
        <button
          type="button"
          className={"dn-set-btn dn-set-btnSmall" + (clearArmed ? " dn-set-btnDanger" : "")}
          onClick={confirmClear}
        >
          {clearArmed ? t("clearConfirm") : t("clearLabel")}
        </button>
        <button
          type="button"
          className="dn-set-btn dn-set-btnSmall"
          onClick={function () {
            sendTest();
          }}
        >
          {t("sendTest")}
        </button>
        <button
          type="button"
          className="dn-set-btn dn-set-btnSmall"
          onClick={function () {
            loadHistory({ value: true });
          }}
        >
          {t("refresh")}
        </button>
        <span className="dn-set-historyCount">{t("historyTitle")}</span>
      </div>
      {!history || history.length === 0 ? (
        <div className="dn-set-note">{t("historyEmpty")}</div>
      ) : (
        <ul className="dn-set-history">
          {history.map(function (r, i: number) {
            const d = new Date(r.ts);
            const pad = function (n: number) {
              return n < 10 ? "0" + n : String(n);
            };
            const time = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
            const sev = severityOf(r.kind);
            return (
              <li className="dn-set-historyItem" key={String(r.ts) + "-" + i}>
                <span
                  className={"dn-sev" + (sev !== "info" ? " dn-sev-" + sev : "")}
                  title={"severity: " + sev}
                />
                <div className="dn-set-historyMain">
                  <div className="dn-set-historyHead">
                    <span className="dn-set-historyKind">
                      {KIND_KEYS[r.kind] !== undefined ? t(KIND_KEYS[r.kind]) : r.kind}
                    </span>
                    <span className="dn-set-historyTime">{time}</span>
                    {r.suppressed === "quiet" ? (
                      <span className="dn-set-historySuppressed">{t("historySuppressed")}</span>
                    ) : null}
                  </div>
                  <div className="dn-set-historyText">{r.title + "：" + r.message}</div>
                  {deliveryLines(r, t)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
