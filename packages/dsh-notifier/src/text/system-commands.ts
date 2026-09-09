/**
 * dsh-notifier — 文本域：系统通知命令构造（纯函数）。
 *
 * 平台 × 音色 → 播放/弹窗命令的映射与构造（server/system-notifier 探测可用性
 * 后调用；smoke 可直接断言参数形态，实际播放器/文件存在性由 server 域探测治理）。
 * 零 shell 拼接面：白名单路径/命令骨架，参数一律数组传参。
 */
import { posix as pathPosix, win32 as pathWin } from "node:path";
import type { SoundId, SoundSetting } from "../config/interface.ts";

/** 自播目标音色（"default" = true 语义的跟随系统默认音；SoundId = 显式内置音色）。 */
export type SystemTone = SoundId | "default";

// ---------------------------------------------------------------- 音色平台映射（#640/#641）

/**
 * macOS 系统内置声音名（osascript `sound name` 取值；/System/Library/Sounds 下
 * 同名 .aiff 恒存在——Glass/Tink/Sosumi/Pop 均为历代 macOS 内置，确定可用）。
 * SoundId → NSSound 系统名近似映射（README 平台差异表声明「近似」）。
 */
export const MAC_SOUND_NAMES: Readonly<Record<SoundId, string>> = {
  ding: "Glass",
  bell: "Tink",
  chime: "Sosumi",
  pop: "Pop",
};

/**
 * Linux freedesktop 声音事件文件候选（sound-theme-freedesktop 基线包，
 * /usr/share/sounds/freedesktop/stereo/；事件名与 oga 文件已对照 Ubuntu
 * noble / Arch 官方文件清单实证确定存在——message-new-instant / bell /
 * complete / message 均在基线包内）。首存在者胜，全部缺失静默。
 * 定稿口径：ding→即时消息、bell→bell、chime→complete、pop→message；
 * 每个 id 保留一个确定存在的备选（同一基线包内）。
 */
export const LINUX_TONE_FILES: Readonly<Record<SoundId, readonly string[]>> = {
  ding: ["message-new-instant.oga"],
  bell: ["bell.oga"],
  chime: ["complete.oga", "dialog-information.oga"],
  pop: ["message.oga", "dialog-information.oga"],
};

/** Linux true（跟随系统默认）的自播事件文件（message-new-instant，基线包确定存在）。 */
export const LINUX_DEFAULT_TONE_FILE = "message-new-instant.oga";

/**
 * Windows 系统媒体 wav 白名单候选（C:\Windows\Media；Windows 10/11 出厂自带，
 * 缺失静默）。宿主 SoundPlayer 播放（弹窗开 + SoundId 与只响不弹同范式，P0-2）。
 */
export const WIN_TONE_FILES: Readonly<Record<SoundId, readonly string[]>> = {
  ding: ["Windows Ding.wav"],
  bell: ["Windows Chimes.wav"],
  chime: ["Windows Chord.wav", "Windows Notify System Generic.wav"],
  pop: ["Windows Balloon.wav", "Windows Notify System Generic.wav"],
};

/**
 * 平台声音文件基目录（白名单路径；buildSoundCommand 只在此目录内拼绝对路径）。
 * Linux: freedesktop 声音事件目录（sound-naming-spec）；macOS: 系统内置声音目录；
 * Windows: 系统媒体目录。
 */
export const TONE_BASE_DIRS: Readonly<Record<string, string>> = {
  linux: "/usr/share/sounds/freedesktop/stereo",
  darwin: "/System/Library/Sounds",
  win32: "C:\\Windows\\Media",
};

/** 平台 × 音色 → 候选文件名（首存在者胜；macOS 取系统内置名 + .aiff；
 *  win32 default = 近似默认通知音 wav——只响不弹 + true 场景无 toast 可依赖）。 */
export function toneFileCandidates(platform: string, tone: SystemTone): readonly string[] {
  if (tone === "default") {
    if (platform === "linux") return [LINUX_DEFAULT_TONE_FILE];
    if (platform === "darwin") return ["Glass.aiff"];
    if (platform === "win32") return ["Windows Notify System Generic.wav", "Windows Ding.wav"];
    return [];
  }
  if (platform === "linux") return LINUX_TONE_FILES[tone];
  if (platform === "darwin") return [`${MAC_SOUND_NAMES[tone]}.aiff`];
  if (platform === "win32") return WIN_TONE_FILES[tone];
  return [];
}

/**
 * 自播命令构造（纯函数，smoke 可断言参数形态；实际播放器/文件存在性由
 * server 域探测治理）。返回 spawn 参数数组（首元素为可执行文件），或 null
 * （该平台 × 音色无可播命令——如 Windows true 跟随系统无自播文件）。
 * - linux：播放器 argv[0] 由调用方填入（pw-play/paplay 探测结果，数组传参）；
 * - darwin：afplay + /System/Library/Sounds/<name>.aiff；
 * - win32：powershell SoundPlayer PlaySync（单引号包裹白名单路径，防引号注入）。
 */
export function buildSoundCommand(
  platform: string,
  tone: SystemTone,
  player: string | undefined,
): string[] | null {
  // 自播仅当目标平台存在确定文件（default+win32 场景见 toneFileCandidates 兜底候选；
  // 主服务端入口还会按平台判定是否真正需要自播——darwin true 走 toast 原生声）
  if (platform === "linux") {
    const files = toneFileCandidates("linux", tone);
    if (files.length === 0 || !player) return null;
    return [player, joinTonePath("linux", files[0])];
  }
  if (platform === "darwin") {
    const files = toneFileCandidates("darwin", tone);
    if (files.length === 0) return null;
    return ["afplay", joinTonePath("darwin", files[0])];
  }
  if (platform === "win32") {
    const files = toneFileCandidates("win32", tone);
    if (files.length === 0) return null;
    // 路径不拼进命令串（零 shell 拼接面）：固定命令骨架读 $args[0]，白名单
    // wav 绝对路径作为独立 argv 元素传入（数组传参，同 toast -Payload 范式）
    const script = "$p=$args[0]; (New-Object System.Media.SoundPlayer $p).PlaySync()";
    return ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script, joinTonePath("win32", files[0])];
  }
  return null;
}

/** 平台基目录 + 文件名拼接（按平台语义 join：win32 反斜杠、其余正斜杠；测试跨平台可断言）。 */
function joinTonePath(platform: string, file: string): string {
  const base = TONE_BASE_DIRS[platform];
  const pathApi = platform === "win32" ? pathWin : pathPosix;
  return pathApi.join(base, file);
}

/**
 * 构造系统通知命令参数（纯函数，smoke 可直接断言参数形态）。
 * 声音语义（#640/#641）：silent = sound===false || selfPlay（应用自播时系统通知
 * 静音/suppress-sound 防双响——spec 中 suppress-sound 的设计本意）。
 * - win32：spawn powershell -File toast.ps1 -Payload <base64>。标题/正文/silent
 *   打包为 base64(UTF-8 JSON) 单 token 传递（issue #238）——PS 5.1 的 -File 模式
 *   对 `-Name=Value` 等号形式不做命名参数绑定，空格形式的裸 dash token 又会被
 *   误认成下一个参数名；base64 字母表 [A-Za-z0-9+/=] 永不出现在 token 首、无空格
 *   无引号，彻底脱离命令行 tokenizer 的歧义面，依旧零 shell 拼接面。
 * - darwin：osascript display notification（转义 \ 与 "，换行替换为空格防
 *   脚本语法；非静音时带系统提示音，音色映射见 MAC_SOUND_NAMES）
 * - 其余：notify-send（notifySendAvailable === false 时返回 null=通道不可用；
 *   恒带 `-h boolean:suppress-sound:true`——Linux DE 对 sound hints 支持参差
 *   （GNOME 默认无声 / KDE 2025 才支持 / Xfce 依赖 libcanberra），toast 发声
 *   不可依赖，统一「suppress-sound + 宿主自播」，hint 仅防 DE 双响）。
 * @returns 通知命令 spawn 参数数组（首元素为可执行文件），或 null（不可用）。
 */
export function buildSystemCommand(
  platform: string,
  title: string,
  message: string,
  options: { sound: SoundSetting; selfPlay?: boolean; notifySendAvailable?: boolean; toastScript: string },
): string[] | null {
  const sound = options.sound ?? true;
  const silent = sound === false || options.selfPlay === true;
  if (platform === "win32") {
    const payload = Buffer.from(JSON.stringify({ title, message, silent }), "utf8").toString("base64");
    return ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", options.toastScript, "-Payload", payload];
  }
  if (platform === "darwin") {
    const esc = (s: string) => s.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, " ");
    // 非静音：true → Glass（现状保留）；SoundId → NSSound 系统名近似映射
    const soundName = silent ? "" : (typeof sound === "string" ? ` sound name "${MAC_SOUND_NAMES[sound] ?? "Glass"}"` : ' sound name "Glass"');
    const script = `display notification "${esc(message)}" with title "${esc(title)}"` + soundName;
    return ["osascript", "-e", script];
  }
  if (options.notifySendAvailable === false) return null;
  // Linux：无论声音如何都带 suppress-sound（DE 双响防护）；true/SoundId 时由
  // SystemNotifier 在节流窗口内一并 spawn 自播命令（事件文件 oga），见 server 域
  return ["notify-send", "-h", "boolean:suppress-sound:true", title, message];
}