/**
 * dsh-notifier channels 域 —— 系统通知的音色平台映射（数据表）。
 *
 * 这些表原在 text 域的 `system-commands.ts`，随「平台适配是出口的实现细节」的
 * 裁定一并收回本目录：它们只被系统出口消费，放出去域外就会长出第二份平台知识。
 *
 * 表是数据不是决策——值原样搬迁，未做改动；键用 `string` 而非配置层的音色联合，
 * 因为本域只按名字找文件，不认识「用户能选哪些音色」这件事（那是配置面语言）。
 */

/**
 * macOS 系统内置声音名（osascript `sound name` 取值；/System/Library/Sounds 下
 * 同名 .aiff 恒存在——Glass / Tink / Sosumi / Pop 均为历代 macOS 内置）。
 */
const MAC_SOUND_NAMES: Readonly<Record<string, string>> = {
  ding: "Glass",
  bell: "Tink",
  chime: "Sosumi",
  pop: "Pop",
};

/**
 * Linux freedesktop 声音事件文件候选（sound-theme-freedesktop 基线包，
 * /usr/share/sounds/freedesktop/stereo/；首存在者胜，全部缺失则静默）。
 */

import { join } from "node:path";
const LINUX_TONE_FILES: Readonly<Record<string, readonly string[]>> = {
  ding: ["message-new-instant.oga"],
  bell: ["bell.oga"],
  chime: ["complete.oga", "dialog-information.oga"],
  pop: ["message.oga", "dialog-information.oga"],
};

/** Linux「跟随系统默认」的自播事件文件（基线包确定存在）。 */
const LINUX_DEFAULT_TONE_FILE = "message-new-instant.oga";

/** Windows 系统媒体 wav 白名单候选（C:\Windows\Media，出厂自带；缺失静默）。 */
const WIN_TONE_FILES: Readonly<Record<string, readonly string[]>> = {
  ding: ["Windows Ding.wav"],
  bell: ["Windows Chimes.wav"],
  chime: ["Windows Chord.wav", "Windows Notify System Generic.wav"],
  pop: ["Windows Balloon.wav", "Windows Notify System Generic.wav"],
};

/** 平台声音文件基目录（白名单路径；命令只在此目录内拼绝对路径）。 */
const TONE_BASE_DIRS: Readonly<Record<string, string>> = {
  linux: "/usr/share/sounds/freedesktop/stereo",
  darwin: "/System/Library/Sounds",
  win32: "C:\\Windows\\Media",
};

/** 平台 × 音色 → 候选文件名（首存在者胜；`default` 走各平台的跟随系统默认音）。 */
export function toneFileCandidates(platform: string, tone: string): readonly string[] {
  const base = TONE_BASE_DIRS[platform];
  if (base === undefined) return [];
  const names =
    platform === "darwin"
      ? [MAC_SOUND_NAMES[tone]]
      : platform === "win32"
        ? WIN_TONE_FILES[tone]
        : (LINUX_TONE_FILES[tone] ?? [LINUX_DEFAULT_TONE_FILE]);
  return names.map((name) => join(base, name));
}
