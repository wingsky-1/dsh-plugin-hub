/**
 * dsh-web-file-preview — 包内跨端共享面对外门面。
 *
 * 目录化约定：端内实现（当前仅 src/client/）与组合根一律经本文件消费。最小面 = 逐个命名
 * 导出实际被消费的值与类型，禁 `export * from` 整文件 re-export——整文件转发会让共享面的
 * 实际边界随实现文件的增删静默变化。
 */

// ------------------------------------------------------------------ 官方地址构造与请求识别（present-open.ts）

export {
  PRESENT_OPEN_PATH,
  PENDING_TTL_MS,
  isOpenRequest,
  sessionIdOf,
  fileAddressFor,
  looksLikeFilePath,
  usablePending,
} from "./present-open.ts";
export type { PendingEntry } from "./present-open.ts";
