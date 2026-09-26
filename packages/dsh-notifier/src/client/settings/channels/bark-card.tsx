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
import { delArmedBtn, failBadge, statusDotClass, statusText, testBtn } from "../parts/status.tsx";
import type { ChannelStatusMap } from "../parts/status.tsx";
import type { HistoryRecordView, RegisteredKindView, SettingsChannelView } from "../types.ts";
import { iconEl } from "./channel-icon.tsx";

/** levels 可选值：自动（空串）+ 四档固定枚举——下拉三处共用，故单点列出。 */
const LEVEL_VALUES: readonly string[] = ["active", "timeSensitive", "passive", "critical"];

/**
 * levels（kind→level）编辑器的入参。整块的编辑面都在这里：矩阵行、新增行、kind 建议表。
 * 依赖显式传参（levelsNew 由 SettingsCard 顶层持有），卡内不建 state/ref。
 */
interface LevelsEditorProps {
  readonly idx: number;
  readonly chId: string;
  readonly levels: Record<string, string>;
  readonly levelOpts: React.ReactElement[];
  /** kind 建议清单：内置 kind + 动态已注册 kind。 */
  readonly suggestKinds: string[];
  /** 正在编辑的新增行草稿。 */
  readonly newRow: { kind: string; level: string };
  readonly t: Translate;
  readonly chLevelsSet: (idx: number, kind: string, level: string) => void;
  readonly setNewRow: (next: { kind: string; level: string }) => void;
}

/** kind 建议清单 = 内置 kind + 动态已注册 kind（去重、保序：内置在前）。 */
function suggestKindsOf(kindsList: RegisteredKindView[]): string[] {
  const suggestKinds: string[] = Object.keys(KIND_KEYS);
  (kindsList || []).forEach(function (k) {
    if (suggestKinds.indexOf(String(k.id)) === -1) suggestKinds.push(String(k.id));
  });
  return suggestKinds;
}

/**
 * levels 矩阵编辑器：既有 kind→level 映射逐行可改可删，末尾一行新增（kind 不在建议表内时给提示）。
 * 单独立一个组件而不是留在卡内：它是卡体里唯一带「新增/删除/建议表」三套交互的子单元，
 * 与卡头的状态呈现、两处 patch 入口是三类不同的变化来源。
 */
function levelsEditor(props: LevelsEditorProps): React.ReactNode {
  const { idx, chId, levels, levelOpts, suggestKinds, newRow, t, chLevelsSet, setNewRow } = props;
  const dlId = "dn-levels-suggest-" + chId;
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
  const newKindKnown = suggestKinds.indexOf(newRow.kind) !== -1;
  return (
    <>
      <div className="dn-set-note-inline">{t("chLevelsHint")}</div>
      {levelKeys.length === 0 ? (
        <div className="dn-set-note-inline">{t("chLevelsEmpty")}</div>
      ) : (
        levelsRows
      )}
      <div className="dn-levels-add" key="lv-add">
        <input
          type="text"
          className="dn-set-input dn-set-inputText"
          list={dlId}
          placeholder={t("chLevelsKindPlaceholder")}
          value={newRow.kind}
          onChange={function (e: React.ChangeEvent<HTMLInputElement>) {
            setNewRow({ kind: e.target.value, level: newRow.level });
          }}
        />
        <select
          className="dn-set-input dn-set-select"
          value={newRow.level}
          onChange={function (e: React.ChangeEvent<HTMLSelectElement>) {
            setNewRow({ kind: newRow.kind, level: e.target.value });
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
              setNewRow({ kind: "", level: "active" });
            }
          }}
        >
          {t("chLevelsAdd")}
        </button>
        {newRow.kind && !newKindKnown ? (
          <span className="dn-set-note-inline">{t("chLevelsUnknown")}</span>
        ) : null}
      </div>
      <datalist id={dlId}>
        {suggestKinds.map(function (k) {
          return (
            <option value={k} key={k}>
              {k}
            </option>
          );
        })}
      </datalist>
    </>
  );
}

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
  history: HistoryRecordView[] | null,
  testDirty?: boolean,
) {
  const channelKey = channelIdFor(ch);
  const armed = delArmedId === ch.id;
  const deviceKeyKey = credentialFieldKey(String(ch.id), "deviceKey");
  const levelOpts: React.ReactElement[] = [
    <option value="" key="auto">
      {t("chLevelAuto")}
    </option>,
  ];
  LEVEL_VALUES.forEach(function (lv: string) {
    levelOpts.push(
      <option value={lv} key={lv}>
        {lv}
      </option>,
    );
  });
  const setNewRow = (next: { kind: string; level: string }): void => {
    setLevelsNew(Object.assign({}, levelsNew, { [String(ch.id)]: next }));
  };
  return (
    <details
      className={"dn-ch-card" + (ch.enabled ? "" : " dn-ch-off")}
      key={channelKey + ":" + (ch.enabled === true)}
      open={ch.enabled === true}
    >
      <summary>
        {iconEl("bark")}
        <span className="dn-ch-name">{ch.name || ch.id}</span>
        <span className="dn-ch-type">bark</span>
        <span className="dn-ch-stateTxt">
          {ch.enabled === true ? t("chStateOn") : t("chStateOff")}
        </span>
        <span className={"dn-ch-statusDot " + statusDotClass(channelKey, statusMap)} />
        <span className="dn-ch-statusTxt" title={statusText(channelKey, statusMap, t, history)}>
          {statusText(channelKey, statusMap, t, history)}
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
            {levelsEditor({
              idx,
              chId: String(ch.id),
              levels: ch.levels || {},
              levelOpts,
              suggestKinds: suggestKindsOf(kindsList),
              newRow: levelsNew[String(ch.id)] || { kind: "", level: "active" },
              t,
              chLevelsSet,
              setNewRow,
            })}
          </div>
        </details>
        <div className="dn-ch-actions">
          {testBtn(channelKey, sendTest, t, testDirty)}
          {delArmedBtn(
            armed,
            ch.id,
            function () {
              chRemove(idx);
            },
            setDelArmedId,
            t,
          )}
        </div>
      </div>
    </details>
  );
}
