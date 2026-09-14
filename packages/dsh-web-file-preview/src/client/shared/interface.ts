/**
 * dsh-web-file-preview — 客户端端内门面对外门面。
 *
 * 目录化约定：客户端实现（src/client/**）只经本文件消费跨端符号，转出面按客户端**实际用到**
 * 的符号收窄（装配需要的采集与地址构造，不含仅宿主/单测消费的常量）。端内实现直引
 * src/shared/ 会把共享面的消费点散到每个实现文件，面一改就要逐个追。
 */

export {
  fileAddressFor,
  isOpenRequest,
  looksLikeFilePath,
  sessionIdOf,
  usablePending,
} from "../../shared/interface.ts";
export type { PendingEntry } from "../../shared/interface.ts";
