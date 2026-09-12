/**
 * dsh-notifier channels 域 —— 系统通知出口的投递参数与探测结果。
 *
 * 平台适配是本出口的实现细节，因此探测结果的形状也归这里，不外溢成公共语言。
 */

/** 系统通知出口：OS 原生弹窗 / 提示音。 */
export interface SystemTarget {
  type: "system";
  pop: boolean;
  sound: boolean | string;
  /** 系统通知脚本路径（由调用方推导后传入）。 */
  toastScript: string;
}

/** 平台能力探测结果：出口决策与设置页展示共用。 */
export interface PlatformProbe {
  platform: string;
  /** 系统通知脚本是否可用。 */
  toastScriptAvailable: boolean;
  /** Linux 下 notify-send 是否可用（不可用时回落脚本）。 */
  notifySendAvailable: boolean;
  /** 可用的音频播放器候选（首个可用者胜）；空 = 本平台放不出声。 */
  players: readonly string[];
}
