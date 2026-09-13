/**
 * dsh-notifier —— 音色事实源（纯数据，无 import）。
 *
 * 为什么两端共用一份、且放在包内：音色此前有三份定义（客户端 Web Audio 的 playTone、
 * 服务端平台素材表、服务端合成表），三份各自演化已经实测出 `ding`/`bell` 性格写反这类
 * 「同一音色在试听与宿主上不是同一个音」的分叉，而人工同步三处正是它复发的原因。
 * 放进包内而不是任一端，是为了让浏览器端与宿主端都不必 import 对方的实现文件。
 *
 * `notes` 是播放语义的唯一定义：客户端试听/自播按下标逐音起振，宿主合成按同一段采样，
 * 故新增音色只改本文件一处。
 */

/** 一个音：相对音色起点的秒数 `at` 决定音符间静音，`type` 缺省为正弦。 */
export interface ToneNote {
  readonly freq: number;
  readonly at: number;
  readonly dur: number;
  readonly type?: "sine" | "triangle";
}

/**
 * 一个音色的全部事实。三个平台素材字段都可选：没有素材语义的音色（例如纯合成音）
 * 在有主题文件的宿主上应当静默，而不是随便挑一个别的文件顶替。
 */
export interface ToneSpec {
  readonly notes: readonly ToneNote[];
  /** freedesktop 主题文件候选（首存在者胜）：有主题的宿主走素材，听感更好。 */
  readonly linuxFile?: readonly string[];
  /** NSSound 名（osascript `sound name`）。 */
  readonly darwinSound?: string;
  /** C:\Windows\Media 白名单候选；缺失静默。 */
  readonly win32File?: readonly string[];
}

/**
 * 「跟随系统默认音」的伪音色 id。
 *
 * 它是设置面 `sound: true`、宿主自播与平台素材表共同指向的同一个键：此前这个字符串散在
 * 四处各写一遍，任一处漂移都会让「跟随系统」在某个平台上指向不存在的音色而静默。
 */
export const FOLLOW_SYSTEM_TONE = "default";

/**
 * 音色表。`notes` 与客户端合并前逐项一致（ding=双短高音、bell=单中高音、chime=三音上行、
 * pop=三角波短促低音、default=双音下行）；平台素材沿用合并前的服务端表。
 */
export const TONES: Readonly<Record<string, ToneSpec>> = {
  [FOLLOW_SYSTEM_TONE]: {
    notes: [
      { freq: 880, at: 0, dur: 0.16 },
      { freq: 660, at: 0.16, dur: 0.22 },
    ],
    linuxFile: ["message-new-instant.oga"],
    darwinSound: "Glass",
    win32File: ["Windows Notify System Generic.wav", "Windows Ding.wav"],
  },
  ding: {
    notes: [
      { freq: 1318, at: 0, dur: 0.14 },
      { freq: 1760, at: 0.16, dur: 0.22 },
    ],
    linuxFile: ["message-new-instant.oga"],
    darwinSound: "Glass",
    win32File: ["Windows Ding.wav"],
  },
  bell: {
    notes: [{ freq: 880, at: 0, dur: 0.5 }],
    linuxFile: ["bell.oga"],
    darwinSound: "Tink",
    win32File: ["Windows Chimes.wav"],
  },
  chime: {
    notes: [
      { freq: 660, at: 0, dur: 0.3 },
      { freq: 880, at: 0.15, dur: 0.3 },
      { freq: 1320, at: 0.3, dur: 0.5 },
    ],
    linuxFile: ["complete.oga", "dialog-information.oga"],
    darwinSound: "Sosumi",
    win32File: ["Windows Chord.wav", "Windows Notify System Generic.wav"],
  },
  pop: {
    notes: [{ freq: 392, at: 0, dur: 0.12, type: "triangle" }],
    linuxFile: ["message.oga", "dialog-information.oga"],
    darwinSound: "Pop",
    win32File: ["Windows Balloon.wav", "Windows Notify System Generic.wav"],
  },
};
