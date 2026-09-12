/**
 * dsh-notifier channels 域 —— 系统通知的音色平台映射（数据表）。
 * 表是数据不是决策：键用 string，本域只按名字找文件，不认识「用户能选哪些音色」。
 */
import { posix as pathPosix, win32 as pathWin } from "node:path";

/** macOS 系统内置声音名（osascript `sound name` 取值；同名 .aiff 为历代 macOS 内置）。 */
export const MAC_SOUND_NAMES: Readonly<Record<string, string>> = {
  ding: "Glass",
  bell: "Tink",
  chime: "Sosumi",
  pop: "Pop",
};

/** Linux freedesktop 声音事件文件候选（sound-theme-freedesktop 基线包内；首存在者胜）。 */
const LINUX_TONE_FILES: Readonly<Record<string, readonly string[]>> = {
  ding: ["message-new-instant.oga"],
  bell: ["bell.oga"],
  chime: ["complete.oga", "dialog-information.oga"],
  pop: ["message.oga", "dialog-information.oga"],
};

/** Linux「跟随系统默认」的自播事件文件（基线包确定存在）。 */
const LINUX_DEFAULT_TONE_FILE = "message-new-instant.oga";

/** Windows 系统媒体 wav 白名单候选（C:\Windows\Media 出厂自带；缺失静默）。 */
const WIN_TONE_FILES: Readonly<Record<string, readonly string[]>> = {
  ding: ["Windows Ding.wav"],
  bell: ["Windows Chimes.wav"],
  chime: ["Windows Chord.wav", "Windows Notify System Generic.wav"],
  pop: ["Windows Balloon.wav", "Windows Notify System Generic.wav"],
};

/** 平台声音文件基目录（命令只在此目录内拼绝对路径）。 */
const TONE_BASE_DIRS: Readonly<Record<string, string>> = {
  linux: "/usr/share/sounds/freedesktop/stereo",
  darwin: "/System/Library/Sounds",
  win32: "C:\\Windows\\Media",
};

/** 平台 × 音色 → 候选文件绝对路径（首存在者胜；default 走各平台的跟随系统默认音）。 */
export function toneFileCandidates(platform: string, tone: string): readonly string[] {
  const base = TONE_BASE_DIRS[platform];
  if (base === undefined) return [];
  // win32 按 win32 语义拼：反斜杠是那条命令骨架的一部分
  const join = platform === "win32" ? pathWin.join : pathPosix.join;
  return candidateNames(platform, tone).map((name) => join(base, name));
}

/** 未知音色给不出候选（跨边界值不受编译期约束）：不猜一个默认音顶替。 */
function candidateNames(platform: string, tone: string): readonly string[] {
  if (tone === "default") {
    if (platform === "linux") return [LINUX_DEFAULT_TONE_FILE];
    if (platform === "darwin") return ["Glass.aiff"];
    if (platform === "win32") return ["Windows Notify System Generic.wav", "Windows Ding.wav"];
    return [];
  }
  if (platform === "linux") {
    const files = LINUX_TONE_FILES[tone];
    return Array.isArray(files) ? files : [];
  }
  if (platform === "darwin") {
    const name = MAC_SOUND_NAMES[tone];
    return typeof name === "string" ? [`${name}.aiff`] : [];
  }
  if (platform === "win32") {
    const files = WIN_TONE_FILES[tone];
    return Array.isArray(files) ? files : [];
  }
  return [];
}
