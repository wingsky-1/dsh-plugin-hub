/**
 * dsh-notifier channels 域 —— 宿主能力自检面的**契约形状**（只有类型，没有决策）。
 *
 * 为什么维度状态与组级 `verdict` 共用一套词表：组级取「各维度最严重者」，两套词表会让聚合需要一张
 * 映射表，而那张表会随维度增减漂移——漂移的那次就是客户端把「未知」渲染成「可用」。
 */

/** 四态。`unknown` 是一等结论：不可无副作用探测时不许猜（猜成 `unreachable` 与猜成 `ok` 一样是假警报）。 */
export type Verdict = "ok" | "degraded" | "unreachable" | "unknown";

/** 能力面的两个维度名。 */
export type CapabilityDimension = "popup" | "sound";

/**
 * 探测维度闭集（6 项）。**不加** win32 独有的取值（toast 脚本、窗口站、通知开关）：契约里躺着永不生产的
 * 取值，等于给自己留一份「看起来完备」的假象；真做那一格时再加，加了才有判据。
 */
export type CheckedDimension =
  "notify-send" | "dbus-name-owner" | "dbus-activatable" | "session-bus" | "players" | "tone-file";

/** 包管理器族闭集：只承诺族，不承诺具体发行版——发行版到包名的映射是包管理器级知识。 */
export type PackageManager = "apt" | "dnf" | "pacman";

/**
 * 诊断出路。`params` 的取值全部来自数据表，**不经输入透传**：响应体里出现宿主原文（os-release 任一行、
 * 命令 stdout）就是把宿主信息送给任何一个能读 `/health` 的人。
 */
export interface RemediationParams {
  packagemanager?: PackageManager;
  packages?: readonly string[];
}

/** 出路 code 闭集。与 `reason` 的 code 同族（都是「给用户看的下一步」），但分属两侧事实源。 */
export type RemediationCode =
  | "host-no-dbus-session"
  | "host-popup-no-daemon"
  | "host-no-sound-server-and-player"
  | "host-no-player"
  | "host-no-tone-file"
  | "host-managed-by-others";

export interface Remediation {
  code: RemediationCode;
  params?: RemediationParams;
}

export interface PopupCapability {
  state: Verdict;
  /** 实际咨询过的维度；空数组 = 本条结论没有探测任何东西（darwin/win32 走系统自带工具）。 */
  checked: readonly CheckedDimension[];
}

export interface SoundCapability {
  state: Verdict;
  /** 探测到的播放器候选（可执行文件名）。**不给绝对路径**：绝对路径正是 lan-proxy 已披露的那类泄露。 */
  players: readonly string[];
  /** 音色文件是否就位。给布尔而不是路径，理由同上。 */
  toneFileAvailable: boolean;
  checked: readonly CheckedDimension[];
}

export interface HostCapabilities {
  verdict: Verdict;
  /**
   * 被判为 `unknown` 的维度名。组级 `verdict` 会把 `unknown` 吞掉（`popup=unknown` + `sound=unreachable`
   * 得到 `unreachable`，用户看不到「弹窗那半边其实无法判定」），客户端靠这个数组才说得出那句话。
   */
  unknownDimensions: readonly CapabilityDimension[];
  popup: PopupCapability;
  sound: SoundCapability;
  remediation: readonly Remediation[];
}
