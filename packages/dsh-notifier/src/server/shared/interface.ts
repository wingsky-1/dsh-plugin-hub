/**
 * 共享层门面：包内跨域引用的唯一入口。
 *
 * 共享层是叶子——它不依赖任何域，域依赖它。收口到一处是为了让「共享层提供了什么」
 * 有一个可被门禁校验的答案，而不是散落在各域对几个实现文件的直引里。
 */
export type { FileWrite } from "./file-io.ts";
export { readTextFileSync, writeTextAtomic, writeTextAtomicSync } from "./file-io.ts";
export type { LoggerPort } from "./type.ts";
export { truncateCodePoints } from "./text.ts";
export type { DeliverReason, ProducedReason, ReasonCode, ReasonParams } from "./reason.ts";
export {
  REASON_CODES,
  REASON_LEGACY,
  clampReasonDetail,
  normalizeReason,
  reason,
  reasonFromCause,
  sameReasonShape,
} from "./reason.ts";
export {
  CONFIG_FILE_NAME,
  HISTORY_FILE_NAME,
  SEQ_FILE_NAME,
  STATUS_FILE_NAME,
  VERSION_FILE_NAME,
  legacyFile,
  notifierFile,
  toastScriptPath,
} from "./paths.ts";
