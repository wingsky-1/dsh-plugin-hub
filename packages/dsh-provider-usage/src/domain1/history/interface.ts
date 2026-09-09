/**
 * dsh-provider-usage — domain1/history/ 历史存储对外门面（C4）。
 *
 * 目录外（pipeline/apply）一律经本文件消费；目录内互引直连。
 * 最小面 = 逐个命名导出实际被消费的「类型 + 函数」，禁整文件 re-export。
 */

export {
  HistoryStore,
  parseJsonl,
  startOfDay,
  migrateLegacyV3,
  legacySampleToData,
  listAdapters,
} from "./history.ts";
export type { HistoryEntry } from "./history.ts";