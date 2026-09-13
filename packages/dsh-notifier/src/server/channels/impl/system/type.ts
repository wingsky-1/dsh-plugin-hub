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

/** 弹窗命令的构造参数。 */
export interface SystemCommandOptions {
  sound: ToneSetting;
  /** 出口是否自播——自播时弹窗命令必须静音，否则会响两声。 */
  selfPlay: boolean;
  toastScript: string;
}
