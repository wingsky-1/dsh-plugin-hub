/**
 * store 域门面：包内跨域引用的唯一入口（只转出，不放实现）。
 */
export type { LoggerPort } from "./deps.ts";
export {
  atomicWrite0600Sync,
  countLinesSync,
  ensureDir0700,
  listFilesSync,
  mtimeMs,
  readJsonSync,
  readTextSync,
  removeFileSync,
} from "./impl/io.ts";
