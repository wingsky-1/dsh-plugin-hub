/**
 * store 域门面：只转出组合根实际用的落盘原语（无逻辑）。
 */
export {
  atomicWrite0600Sync,
  ensureDir0700,
  listFilesSync,
  mtimeMs,
  readJsonSync,
  readTextSync,
  removeFileSync,
} from "./impl/io.ts";
