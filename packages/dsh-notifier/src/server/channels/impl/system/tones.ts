/**
 * dsh-notifier channels 域 —— 音色到平台素材文件的翻译。
 *
 * 表是数据不是决策：本文件只回答「这个平台上这个音色的候选文件是哪几个」，不认识
 * 「用户能选哪些音色」。音色事实本身（含三个平台的素材字段）收在 `shared/interface.ts`，
 * 本文件不再持有第二份表——两份表已实测漂移过（#783）。
 */
import { posix as pathPosix, win32 as pathWin } from "node:path";

import { TONES } from "../../../../shared/interface.ts";

/** 平台声音文件基目录（命令只在此目录内拼绝对路径）。 */
const TONE_BASE_DIRS: Readonly<Record<string, string>> = {
  linux: "/usr/share/sounds/freedesktop/stereo",
  darwin: "/System/Library/Sounds",
  win32: "C:\\Windows\\Media",
};

/** 平台 × 音色 → 候选文件绝对路径（首存在者胜）。 */
export function toneFileCandidates(platform: string, tone: string): readonly string[] {
  const base = TONE_BASE_DIRS[platform];
  if (base === undefined) return [];
  // win32 按 win32 语义拼：反斜杠是那条命令骨架的一部分
  const join = platform === "win32" ? pathWin.join : pathPosix.join;
  return candidateNames(platform, tone).map((name) => join(base, name));
}

/** 未知音色给不出候选（跨边界值不受编译期约束）：不猜一个默认音顶替。 */
function candidateNames(platform: string, tone: string): readonly string[] {
  // `constructor` / `__proto__` 这类原型链键名不是 TONES 的成员，直接取值会读到
  // Object.prototype 上的东西，于是给出一个并不存在的候选路径。`in` 有同样的坑。
  if (!Object.hasOwn(TONES, tone)) return [];
  const spec = TONES[tone];
  if (platform === "linux") return spec.linuxFile ?? [];
  if (platform === "darwin")
    return spec.darwinSound === undefined ? [] : [`${spec.darwinSound}.aiff`];
  if (platform === "win32") return spec.win32File ?? [];
  return [];
}
