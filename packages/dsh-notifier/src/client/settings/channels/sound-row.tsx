/**
 * 单通道声音行：开关 + 音色下拉 + 试听。
 *
 * 音频出口（audioEngine）、频道字段写入口（chPatch）、文案函数（t）与「声音是否开」都由调用方
 * 传入：音频解锁与播放节流窗口是全页一份的闭包状态，原子层不得自取。
 */
import * as React from "react";
import { SOUND_IDS, channelIdOf, isSoundId } from "../../../shared/interface.ts";
import type { SoundId } from "../../../shared/interface.ts";
import type { AudioEngine } from "../../notify/audio.ts";
import type { Translate } from "../../locale.ts";
import { switchToggle } from "../parts/controls.tsx";

/** 内置音色选项（label 字典键）。刻意留在客户端而不搬进 shared：这是「音色 → UI 文案 key」，
 *  文案属客户端面。类型锚在 shared 的 `SoundId` 上，键集因此与 SOUND_IDS 逐项对齐——
 *  新增音色漏配文案是编译错误，而不是下拉框里渲染出 `t(undefined)`。 */
const SOUND_OPTION_KEYS: Record<SoundId, string> = {
  ding: "toneDing",
  bell: "toneBell",
  chime: "toneChime",
  pop: "tonePop",
};

/** 单通道声音行：开关（false/true 切换）+ 展开音色下拉 + ▶试听。
 *  开关语义：off=false（静音）；on=true（跟随系统默认）；on 后选择音色 =
 *  SoundId（显式音色）。交互全部显式 audioEngine.unlock() 兜底（autoplay 策略下
 *  纯后台页面自播需此前任意手势解锁；试听点击本身即手势）。 */
export function soundRow(
  index: number,
  ch: any,
  channelLabel: string,
  soundOn: boolean,
  t: Translate,
  chPatch: (idx: number, part: Record<string, unknown>) => void,
  audioEngine: AudioEngine,
) {
  const soundVal = ch.sound;
  const toneValue = isSoundId(soundVal) ? soundVal : "";
  const toneOpts: any[] = [
    <option value="" key="sys">
      {t("chSoundFollow")}
    </option>,
  ].concat(
    SOUND_IDS.map(function (id) {
      return (
        <option value={id} key={id}>
          {t(SOUND_OPTION_KEYS[id])}
        </option>
      );
    }),
  );
  return (
    <div className="dn-ch-row" key={"sound-" + channelIdOf(ch)}>
      <span className="dn-ch-cap">{t("chSound")}</span>
      <span className="dn-ch-ctl">
        {switchToggle(
          soundOn,
          function (v: boolean) {
            // 用户手势：解锁音频（开启声音后隐藏页面自播才可能发声）
            audioEngine.unlock();
            chPatch(index, { sound: v }); // false / true
          },
          t("chSound") + " " + channelLabel,
        )}
        {soundOn ? (
          <select
            className="dn-set-input dn-set-select"
            value={toneValue}
            aria-label={t("chSoundTone")}
            onChange={function (e: any) {
              audioEngine.unlock();
              chPatch(index, { sound: e.target.value === "" ? true : e.target.value });
            }}
          >
            {toneOpts}
          </select>
        ) : null}
        {soundOn ? (
          <button
            type="button"
            className="dn-set-btn dn-set-btnSmall dn-tonePreview"
            aria-label={t("chSoundPreview")}
            onClick={function () {
              audioEngine.playPreview(toneValue || undefined);
            }}
          >
            ▶ {t("chSoundPreview")}
          </button>
        ) : null}
        {toneValue === "" && soundOn ? (
          <span className="dn-ch-hint">{t("chSoundFollowHint")}</span>
        ) : null}
      </span>
    </div>
  );
}
