/**
 * 通知频道 tab 内容片：channels 逐项按类型分派（内置两卡 + bark/webhook 实例卡）+ 添加频道按钮
 * + 仅提交 channels 键的域保存行。
 *
 * 普通函数返回 JSX 数组（卡片对它做**条件调用**——非 active tab 根本不调用；改成组件会引入
 * 挂载/卸载语义）。依赖收在单一 deps 对象里显式传入：本模块零 state、零 ref、零定时器、
 * 零模块级可变状态，也不从 SettingsCard 闭包取值。
 *
 * 为什么用 deps 对象而不是位置参数：这里要转发的正是三张卡各自的依赖（builtin 12 / webhook 12 /
 * bark 15 项，并集 25 项），位置参数会退化成一张无法审阅的长表；对象形态字段名即语义，
 * 与三张卡显式传参的既有形态同源。
 */
import * as React from "react";
import type { ClientDiagnosticsView } from "../../capabilities.ts";
import type { Translate } from "../../locale.ts";
import type { AudioEngine } from "../../notify/audio.ts";
import { barkCard } from "../channels/bark-card.tsx";
import { builtinCard } from "../channels/builtin-card.tsx";
import { webhookCard } from "../channels/webhook-card.tsx";
import type { ChannelStatusMap } from "../parts/status.tsx";
import type { RegisteredKindView, SettingsChannelView, SettingsView } from "../types.ts";

/** 频道 tab 的依赖面（三张卡的并集 + 本片自用的添加/域保存入口）。 */
interface ChannelsPaneDeps {
  settings: SettingsView;
  statusMap: ChannelStatusMap;
  hostPlatform: string | null;
  diag: ClientDiagnosticsView;
  channelLabel: (c: SettingsChannelView) => string;
  chPatch: (idx: number, part: Record<string, unknown>) => void;
  chRemove: (idx: number) => void;
  chLevelsSet: (idx: number, kind: string, level: string) => void;
  chAdd: (kind: string) => void;
  sendTest: (id?: string) => void;
  isSecureContext: () => boolean;
  requestNotificationPermission: () => void;
  audioEngine: AudioEngine;
  kindsList: RegisteredKindView[];
  delArmedId: string | null;
  setDelArmedId: (v: string | null) => void;
  levelsNew: Record<string, { kind: string; level: string }>;
  setLevelsNew: (next: Record<string, { kind: string; level: string }>) => void;
  revealMap: Record<string, boolean>;
  setRevealMap: (next: Record<string, boolean>) => void;
  secretEdited: Record<string, boolean>;
  markSecretEdited: (key: string) => void;
  saving: boolean;
  saveFor: (entry: string, quietIfEmpty?: boolean) => void;
  t: Translate;
}

/**
 * 频道 tab 内容片：分派三张卡 + 添加按钮 + 域保存行。
 * 域保存：频道 tab 底部「保存频道」只提交 channels 键——与 foot 全量保存语义不同
 * （域 vs 全量），不构成此前移除的「双份全量保存」视觉重复。
 */
export function channelsPane(deps: ChannelsPaneDeps) {
  const {
    settings,
    statusMap,
    hostPlatform,
    diag,
    channelLabel,
    chPatch,
    chRemove,
    chLevelsSet,
    chAdd,
    sendTest,
    isSecureContext,
    requestNotificationPermission,
    audioEngine,
    kindsList,
    delArmedId,
    setDelArmedId,
    levelsNew,
    setLevelsNew,
    revealMap,
    setRevealMap,
    secretEdited,
    markSecretEdited,
    saving,
    saveFor,
    t,
  } = deps;

  // 频道区：`channels` 逐项按类型分派（内置两卡 + bark/webhook 实例卡）+ 添加按钮。
  // 先按**真实下标**遍历再分派：chPatch / chRemove 都按下标操作，先 filter 会让编辑打到隔壁条目。
  const channelsChildren: React.ReactNode[] = [];
  (settings.channels || []).forEach(function (c, i: number) {
    if (c.type === "browser" || c.type === "system") {
      channelsChildren.push(
        builtinCard(
          i,
          c,
          channelLabel(c),
          statusMap,
          hostPlatform,
          diag,
          chPatch,
          sendTest,
          isSecureContext,
          requestNotificationPermission,
          audioEngine,
          t,
        ),
      );
      return;
    }
    channelsChildren.push(
      String(c.type) === "webhook"
        ? webhookCard(
            c,
            i,
            delArmedId,
            setDelArmedId,
            revealMap,
            setRevealMap,
            secretEdited,
            markSecretEdited,
            chPatch,
            chRemove,
            sendTest,
            statusMap,
            t,
          )
        : barkCard(
            c,
            i,
            kindsList,
            delArmedId,
            setDelArmedId,
            levelsNew,
            setLevelsNew,
            secretEdited,
            markSecretEdited,
            chPatch,
            chLevelsSet,
            chRemove,
            sendTest,
            statusMap,
            t,
          ),
    );
  });
  channelsChildren.push(
    <div className="dn-ch-add" key="ch-add">
      <button
        type="button"
        className="dn-set-btn"
        onClick={function () {
          chAdd("bark");
        }}
      >
        {t("chAddBark")}
      </button>
      <button
        type="button"
        className="dn-set-btn dn-set-btnPrimary"
        onClick={function () {
          chAdd("webhook");
        }}
      >
        {t("chAddWebhook")}
      </button>
    </div>,
  );

  const channelsDomainSave = (
    <div className="dn-ch-domainSave" key="ch-domain-save">
      <span className="dn-ch-domainSaveHint">{t("channelsDomainHint")}</span>
      <button
        type="button"
        className="dn-set-btn dn-set-btnPrimary dn-set-save"
        disabled={saving}
        onClick={function () {
          saveFor("channels");
        }}
      >
        {saving ? t("saving") : t("saveChannels")}
      </button>
    </div>
  );

  return [channelsChildren, channelsDomainSave];
}
