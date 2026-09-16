/**
 * 内置频道卡（browser / system）：卡头三态 + 启用 switch，卡体 = 弹窗/可见时/声音行 + 诊断行 + 测试按钮。
 *
 * 与实例卡同源——它们都是 settings.channels 里的一项，只是不渲染删除入口、也没有凭据。
 * 依赖一律显式传参（statusMap / hostPlatform / diag / chPatch / sendTest / 安全上下文 / 授权回调 /
 * audioEngine / t）：卡体不持有 state/ref/定时器，也不读 SettingsCard 的闭包——搬走的函数若仍捕获旧
 * state，编译期不会有任何信号，故一律不从闭包取值。
 */
import * as React from "react";
import { channelIdOf, isSoundId } from "../../../shared/interface.ts";
import type { ClientDiagnosticsView } from "../../capabilities.ts";
import type { Translate } from "../../locale.ts";
import type { AudioEngine } from "../../notify/audio.ts";
import { switchToggle } from "../parts/controls.tsx";
import {
  browserDiagnosticsLine,
  browserPermLine,
  hostDiagnosticsBlock,
  systemPlatformHint,
} from "../parts/diagnostics.tsx";
import { chRow } from "../parts/rows.tsx";
import { failBadge, statusDotClass, statusText, testBtn } from "../parts/status.tsx";
import { iconEl } from "./channel-icon.tsx";
import { soundRow } from "./sound-row.tsx";

/** 声音设置是否处于「开」：true 与内置音色 id 都算开，false 与脏值算关。
 *  三态摘要、卡体提示、声音行开关三处共用这一条口径——各判一遍就会出现「卡片说有声、开关说没有」。 */
function soundIsOn(value: any): boolean {
  return value === true || isSoundId(value);
}

/**
 * 内置频道卡（browser/system）：三开关（启用 / 弹窗 / 声音）+ 状态行 + per-channel 测试。
 * 与实例卡同源——两者都是 `settings.channels` 里的一项，只是本卡不渲染删除入口、也没有凭据。
 *
 * 谁决定什么：**启用**决定「发不发」（关掉 = 完全不投递，声音也不发）；**弹窗 + 声音**决定
 * 「怎么发」（弹窗关而声音开 = 只响不弹；两者都关 = 本频道不会有任何提醒，卡体给出提示）。
 * 三态摘要：启用开 + 弹窗开 = 启用；启用开 + 弹窗关 + 声音开 = 仅声音；启用关 = 已停用。
 *
 * 卡头 = 类型图标 + 名称 + 内置徽标 + 状态摘要 + 状态点 + 失败徽标 + 启用 switch；卡体 =
 * 弹窗行 +（浏览器另有「页面可见时也弹」）+ 声音行（开关 + 音色下拉 + ▶试听）+（浏览器）
 * 权限状态行 + 平台提示 + 测试按钮。
 *
 * 整卡 details 可折叠——非受控 + key remount 形态（key 含 enabled，open 仅 mount 生效），
 * 未启用默认收起、启用默认展开；手动开合完全交 DOM，无受控时序坑；启停切换重挂载重置折叠态
 * （预期行为）。summary 内 enable checkbox 依赖 HTML 规范豁免（点击 interactive content
 * 不触发 summary 激活）。
 */
export function builtinCard(
  index: number,
  ch: any,
  label: string,
  statusMap: Record<string, any>,
  hostPlatform: string | null,
  diag: ClientDiagnosticsView,
  chPatch: (idx: number, part: Record<string, unknown>) => void,
  sendTest: (id?: string) => void,
  isSecureContext: () => boolean,
  requestNotificationPermission: () => void,
  audioEngine: AudioEngine,
  t: Translate,
) {
  const channelId = channelIdOf(ch);
  const enabled = ch.enabled === true;
  const popup = ch.popup === true;
  const soundOn = soundIsOn(ch.sound);
  const stateCls = !enabled ? " dn-ch-off" : !popup && soundOn ? " dn-ch-sound" : " dn-ch-onEdge";
  const summaryState = !enabled
    ? t("chStateOff")
    : !popup && soundOn
      ? t("chStateSound")
      : t("chStateOn");
  const extras: any[] = [];
  extras.push(
    chRow(
      t("chPopup"),
      switchToggle(
        popup,
        function (v: boolean) {
          chPatch(index, { popup: v });
        },
        t("chPopup") + " " + label,
      ),
    ),
  );
  if (ch.type === "browser") {
    extras.push(
      chRow(
        t("chWhenVisible"),
        switchToggle(
          ch.whenVisible === true,
          function (v: boolean) {
            chPatch(index, { whenVisible: v });
          },
          t("chWhenVisible") + " " + label,
        ),
      ),
    );
  }
  extras.push(soundRow(index, ch, label, soundOn, t, chPatch, audioEngine));
  return (
    <details
      className={"dn-ch-card" + stateCls}
      key={"ch-" + channelId + ":" + enabled + ":" + popup + ":" + soundOn}
      open={enabled}
    >
      <summary>
        {iconEl(String(ch.type))}
        <span className="dn-ch-name">{label}</span>
        <span className="dn-ch-type">{t("chTypeBuiltin")}</span>
        <span className="dn-ch-stateTxt">{summaryState}</span>
        <span className={"dn-ch-statusDot " + statusDotClass(channelId, statusMap)} />
        <span className="dn-ch-statusTxt" title={statusText(channelId, statusMap, t)}>
          {statusText(channelId, statusMap, t)}
        </span>
        {failBadge(channelId, statusMap, t)}
        <span className="dn-ch-summaryRight">
          {switchToggle(
            enabled,
            function (v: boolean) {
              chPatch(index, { enabled: v });
            },
            (enabled ? t("chToggleOff") : t("chToggleOn")) + label,
          )}
        </span>
      </summary>
      <div className="dn-ch-body">
        {extras}
        {enabled && !popup && soundOn ? (
          <div className="dn-set-note-inline dn-soundOnly">{t("chSoundOnlyNote")}</div>
        ) : null}
        {enabled && !popup && !soundOn ? (
          <div className="dn-set-note-inline dn-soundOnly">{t("chPopupSoundOffNote")}</div>
        ) : null}
        {/* 浏览器通知权限状态行归入浏览器频道卡（权限授权入口同卡就近可达） */}
        {ch.type === "browser"
          ? browserPermLine(t, isSecureContext(), requestNotificationPermission)
          : null}
        {/* 浏览器面自检行：宿主侧接口看不到本页的权限与音频解锁状态 */}
        {ch.type === "browser" ? browserDiagnosticsLine(diag) : null}
        {/* 系统卡平台提示（/health platform 消费；宿主 OS 与浏览器 OS 可异机） */}
        {ch.type === "system" ? systemPlatformHint(hostPlatform, t) : null}
        {/* 宿主能力自检（/diagnostics）：结论 + 处置建议 + 明细折叠 */}
        {ch.type === "system" ? hostDiagnosticsBlock(diag) : null}
        <div className="dn-ch-actions">{testBtn(channelId, sendTest, t)}</div>
      </div>
    </details>
  );
}
