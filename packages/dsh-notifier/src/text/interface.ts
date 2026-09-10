/**
 * dsh-notifier — text/interface.ts：文本域唯一对外引用面。
 *
 * 目录外代码只能从这里引用：文案单表（NOTIFY_KINDS）、展示强度映射
 * （KIND_SEVERITY）、耗时/工具名美化、错误脱敏、系统命令构造与音色平台映射。
 * 全部纯函数；跨域消费者所需符号在本文件收口（verify-dir-imports 静态强制）。
 */
export { KIND_SEVERITY, NOTIFY_KINDS, formatDuration, prettyToolName } from "./message.ts";
export type { NotifyDetail } from "./message.ts";
export { sanitizeErrorText } from "./sanitize.ts";
export {
  LINUX_DEFAULT_TONE_FILE,
  LINUX_TONE_FILES,
  MAC_SOUND_NAMES,
  TONE_BASE_DIRS,
  WIN_TONE_FILES,
  buildSoundCommand,
  buildSystemCommand,
  toneFileCandidates,
} from "./system-commands.ts";
export type { SystemTone } from "./system-commands.ts";