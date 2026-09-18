/**
 * Bark 实例卡：卡头 = 图标 + 名称 + 类型徽标 + 状态点/摘要 + 失败徽标 + 启用 switch；
 * 卡体 = 基本行 + 高级参数折叠（含 levels 矩阵）+ 测试/删除。
 *
 * 依赖一律显式传参（瞬态草稿 delArmedId / levelsNew / secretEdited 仍由 SettingsCard 顶层持有）：
 * 卡体不持有 state/ref/定时器，删除二次确认的 3 秒定时器也照搬原形态留在卡内 onClick 闭包里。
 */
import * as React from "react";
import { channelIdFor } from "../../../shared/interface.ts";
import { KIND_KEYS } from "../../locales.ts";
import type { Translate } from "../../locale.ts";
import { credentialFieldKey, credentialFieldView } from "../mask.ts";
import { advRow, chRow } from "../parts/rows.tsx";
import { numInput, switchToggle, textInput } from "../parts/controls.tsx";
import { failBadge, statusDotClass, statusText, testBtn } from "../parts/status.tsx";
import type { ChannelStatusMap } from "../parts/status.tsx";
import type { RegisteredKindView, SettingsChannelView } from "../types.ts";
import { iconEl } from "./channel-icon.tsx";

/**
 * Bark 实例卡：卡头 = 图标 + 名称 + 类型徽标 + 状态点/摘要 +
 * 失败徽标 + 启用 switch；卡体 = 基本行 + 高级参数折叠（含 levels 矩阵）+ 测试/删除。
 * 整卡 details 可折叠（非受控 + key remount），未启用默认收起。
 */
export function barkCard(
  ch: SettingsChannelView,
  idx: number,
  kindsList: RegisteredKindView[],
  delArmedId: string | null,
  setDelArmedId: (v: string | null) => void,
  levelsNew: Record<string, { kind: string; level: string }>,
  setLevelsNew: (next: Record<string, { kind: string; level: string }>) => void,
  secretEdited: Record<string, boolean>,
  markSecretEdited: (key: string) => void,
  chPatch: (idx: number, part: Record<string, unknown>) => void,
  chLevelsSet: (idx: number, kind: string, level: string) => void,
  chRemove: (idx: number) => void,
  sendTest: (id?: string) => void,
  statusMap: ChannelStatusMap,
  t: Translate,
) {
  const channelKey = channelIdFor(ch);
  const armed = delArmedId === ch.id;
  const deviceKeyKey = credentialFieldKey(String(ch.id), "deviceKey");
  const levelOpts: React.ReactElement[] = [
    <option value="" key="auto">
      {t("chLevelAuto")}
    </option>,
  ];
  ["active", "timeSensitive", "passive", "critical"].forEach(function (lv: string) {
    levelOpts.push(
      <option value={lv} key={lv}>
        {lv}
      </option>,
    );
  });
  // levels（kind→level）编辑：kind 建议 = 内置 7 kind + 动态已注册 kind；datalist id 按实例唯一
  const suggestKinds: string[] = Object.keys(KIND_KEYS);
  (kindsList || []).forEach(function (k) {
    if (suggestKinds.indexOf(String(k.id)) === -1) suggestKinds.push(String(k.id));
  });
  const dlId = "dn-levels-suggest-" + String(ch.id);
  const levels: Record<string, string> = ch.levels || {};
  const levelKeys = Object.keys(levels);
  const levelsRows: React.ReactNode[] = levelKeys.map(function (kind) {
    return (
      <div className="dn-levels-row" key={"lv-" + kind}>
        <span className="dn-levels-kind">
          {KIND_KEYS[kind] !== undefined ? t(KIND_KEYS[kind]) + " (" + kind + ")" : kind}
        </span>
        <select
          className="dn-set-input dn-set-select"
          value={levels[kind] || ""}
          onChange={function (e: React.ChangeEvent<HTMLSelectElement>) {
            chLevelsSet(idx, kind, e.target.value);
          }}
        >
          {levelOpts}
        </select>
        <button
          type="button"
          className="dn-set-btn dn-set-btnSmall"
          onClick={function () {
            chLevelsSet(idx, kind, "");
          }}
        >
          {t("chLevelsRemove")}
        </button>
      </div>
    );
  });
  const newRow = levelsNew[String(ch.id)] || { kind: "", level: "active" };
  const newKindKnown = suggestKinds.indexOf(newRow.kind) !== -1;
  const addRow = (
    <div className="dn-levels-add" key="lv-add">
      <input
        type="text"
        className="dn-set-input dn-set-inputText"
        list={dlId}
        placeholder={t("chLevelsKindPlaceholder")}
        value={newRow.kind}
        onChange={function (e: React.ChangeEvent<HTMLInputElement>) {
          setLevelsNew(
            Object.assign({}, levelsNew, {
              [String(ch.id)]: { kind: e.target.value, level: newRow.level },
            }),
          );
        }}
      />
      <select
        className="dn-set-input dn-set-select"
        value={newRow.level}
        onChange={function (e: React.ChangeEvent<HTMLSelectElement>) {
          setLevelsNew(
            Object.assign({}, levelsNew, {
              [String(ch.id)]: { kind: newRow.kind, level: e.target.value },
            }),
          );
        }}
      >
        {levelOpts}
      </select>
      <button
        type="button"
        className="dn-set-btn dn-set-btnSmall"
        onClick={function () {
          if (newRow.kind) {
            chLevelsSet(idx, newRow.kind, newRow.level);
            setLevelsNew(
              Object.assign({}, levelsNew, { [String(ch.id)]: { kind: "", level: "active" } }),
            );
          }
        }}
      >
        {t("chLevelsAdd")}
      </button>
      {newRow.kind && !newKindKnown ? (
        <span className="dn-set-note-inline">{t("chLevelsUnknown")}</span>
      ) : null}
    </div>
  );
  return (
    <details
      className={"dn-ch-card" + (ch.enabled ? " dn-ch-onEdge" : " dn-ch-off")}
      key={channelKey + ":" + (ch.enabled === true)}
      open={ch.enabled === true}
    >
      <summary>
        {iconEl("bark")}
        <span className="dn-ch-name">{ch.name || ch.id}</span>
        <span className="dn-ch-type">bark</span>
        <span className={"dn-ch-statusDot " + statusDotClass(channelKey, statusMap)} />
        <span className="dn-ch-statusTxt" title={statusText(channelKey, statusMap, t)}>
          {statusText(channelKey, statusMap, t)}
        </span>
        {failBadge(channelKey, statusMap, t)}
        <span className="dn-ch-summaryRight">
          {switchToggle(
            ch.enabled === true,
            function (v: boolean) {
              chPatch(idx, { enabled: v });
            },
            (ch.enabled ? t("chToggleOff") : t("chToggleOn")) + (ch.name || ch.id),
          )}
        </span>
      </summary>
      <div className="dn-ch-body">
        {chRow(
          t("chBarkName"),
          textInput(
            ch.name,
            function (v: string) {
              chPatch(idx, { name: v });
            },
            { placeholder: t("chBarkNamePlaceholder"), ariaLabel: t("chBarkName") },
          ),
        )}
        {chRow(
          t("chBarkBaseUrl"),
          textInput(
            ch.baseUrl,
            function (v: string) {
              chPatch(idx, { baseUrl: v });
            },
            { placeholder: "https://api.day.app", ariaLabel: t("chBarkBaseUrl") },
          ),
          t("chBarkBaseUrlHint"),
        )}
        {chRow(
          t("chBarkDeviceKey"),
          <span className="dn-secret" key="deviceKey">
            <input
              type="password"
              className="dn-set-input dn-set-inputText"
              value={
                credentialFieldView(
                  ch.deviceKey,
                  secretEdited[deviceKeyKey] === true,
                  t("chBarkDeviceKeyPlaceholder"),
                ).value
              }
              placeholder={
                credentialFieldView(
                  ch.deviceKey,
                  secretEdited[deviceKeyKey] === true,
                  t("chBarkDeviceKeyPlaceholder"),
                ).placeholder
              }
              aria-label={t("chBarkDeviceKey")}
              onChange={function (e: React.ChangeEvent<HTMLInputElement>) {
                markSecretEdited(deviceKeyKey);
                chPatch(idx, { deviceKey: e.target.value });
              }}
            />
          </span>,
          t("chBarkDeviceKeyHint"),
        )}
        <details className="dn-ch-adv" key={"adv-" + ch.id}>
          <summary>{t("chAdvanced")}</summary>
          <div className="dn-ch-adv-body">
            {advRow(
              t("chBarkSound"),
              textInput(
                ch.sound,
                function (v: string) {
                  chPatch(idx, { sound: v });
                },
                { ariaLabel: t("chBarkSound") },
              ),
            )}
            {advRow(
              t("chBarkGroup"),
              textInput(
                ch.group,
                function (v: string) {
                  chPatch(idx, { group: v });
                },
                { ariaLabel: t("chBarkGroup") },
              ),
            )}
            <div className="dn-set-note-inline">{t("chBarkGroupHint")}</div>
            {advRow(
              t("chBarkIcon"),
              textInput(
                ch.icon,
                function (v: string) {
                  chPatch(idx, { icon: v });
                },
                { ariaLabel: t("chBarkIcon") },
              ),
            )}
            <div className="dn-set-note-inline">{t("chBarkIconHint")}</div>
            {advRow(
              t("chBarkUrl"),
              textInput(
                ch.url,
                function (v: string) {
                  chPatch(idx, { url: v });
                },
                { ariaLabel: t("chBarkUrl") },
              ),
            )}
            {advRow(
              t("chBarkBadge"),
              numInput(
                ch.badge,
                function (v: number | undefined) {
                  chPatch(idx, { badge: v });
                },
                { ariaLabel: t("chBarkBadge") },
              ),
            )}
            {advRow(
              t("chBarkLevel"),
              <select
                className="dn-set-input dn-set-select"
                value={ch.level || ""}
                aria-label={t("chBarkLevel")}
                onChange={function (e: React.ChangeEvent<HTMLSelectElement>) {
                  chPatch(idx, { level: e.target.value || undefined });
                }}
              >
                {levelOpts}
              </select>,
            )}
            <div className="dn-set-note-inline">{t("chBarkLevelHint")}</div>
            <div className="dn-set-note-inline">{t("chLevelsHint")}</div>
            {levelKeys.length === 0 ? (
              <div className="dn-set-note-inline">{t("chLevelsEmpty")}</div>
            ) : (
              levelsRows
            )}
            {addRow}
            <datalist id={dlId}>
              {suggestKinds.map(function (k) {
                return (
                  <option value={k} key={k}>
                    {k}
                  </option>
                );
              })}
            </datalist>
          </div>
        </details>
        <div className="dn-ch-actions">
          {testBtn(channelKey, sendTest, t)}
          <button
            type="button"
            className={"dn-set-btn dn-set-btnSmall" + (armed ? " dn-set-btnDanger" : "")}
            onClick={function () {
              if (armed) {
                chRemove(idx);
                setDelArmedId(null);
              } else {
                setDelArmedId(ch.id);
                setTimeout(function () {
                  setDelArmedId(null);
                }, 3000);
              }
            }}
          >
            {armed ? t("chDeleteConfirm") : t("chDelete")}
          </button>
        </div>
      </div>
    </details>
  );
}
