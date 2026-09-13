/**
 * dsh-notifier channels 域 —— 系统出口的投递参数与平台探测结果。
 */
import type { LoggerPort } from "../../../shared/interface.ts";
import type { ToneSetting } from "../deliver/type.ts";

/** 系统通知出口：OS 原生弹窗 / 提示音。 */
export interface SystemTarget {
  type: "system";
  /** 弹不弹：管线只搬配置，形态由本出口解释。 */
  popup: boolean;
  /** 提示音：false = 不发声；true = 跟随系统默认；字符串 = 指定音色。 */
  sound: ToneSetting;
  /** 系统通知脚本路径（由调用方推导后传入）。 */
  toastScript: string;
  /** 日志出口：命令的失败细节（bin、退出码、stderr 尾部）只经这里出声，不另存一份。 */
  logger: LoggerPort;
}

/** 平台能力探测结果（进程级事实，探测一次后缓存）。 */
export interface PlatformProbe {
  platform: string;
  /** Windows 的 toast 脚本文件是否存在。 */
  toastScriptAvailable: boolean;
  /** notify-send 是否可用（macOS / Windows 不走它，恒 false）。 */
  notifySendAvailable: boolean;
  /** 播放器候选（首个可用者胜）；空 = 无候选——Windows 经 PowerShell 播放，不看这里。 */
  players: readonly string[];
}

/**
 * 通知守护进程名的探测结论。三种 CLI（`gdbus`/`dbus-send`/`busctl`）的输出格式差异封在端口实现内，
 * 调用方只面对这五种语义——否则每个消费点都要认三种格式，且 `ListActivatableNames` 的输出一旦被
 * 按「尾部多少字节」截断就会漏项，把可激活的服务误判成不存在。
 */
export type NotificationNameProbe =
  | { kind: "owner" }
  | { kind: "activatable" }
  | { kind: "absent" }
  | { kind: "no-session-bus" }
  | { kind: "probe-failed"; detail: string };

/** `/etc/os-release` 的读取结论。**never-throw**：与本端口其余成员同族（调用侧没有 `try/catch`），
 * 只取 `ID=` 一行——整份文件是宿主原文，不得进响应体。 */
export type OsReleaseProbe = { ok: true; id: string } | { ok: false };

/** 弹窗命令的构造参数。 */
export interface SystemCommandOptions {
  sound: ToneSetting;
  /** 出口是否自播——自播时弹窗命令必须静音，否则会响两声。 */
  selfPlay: boolean;
  toastScript: string;
}
