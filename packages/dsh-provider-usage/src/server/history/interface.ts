/**
 * dsh-provider-usage — server/history 域对外门面（#768 D5：history 新域）。
 *
 * 域承诺 = 按天分片 JSONL 历史存储（HistoryStore）+ v3 旧桶迁移（migrateLegacyV3）+
 * 纯函数（parseJsonl/startOfDay/legacySampleToData/listAdapters）：目录外
 * （pipeline/apply）一律经本文件消费；目录内互引直连。最小面 = 逐个命名导出
 * 实际被消费的「类型 + 函数」，禁整文件 re-export。
 *
 * 本域无 deps.ts（D1/config 前例）：唯一上游值依赖是 shared 的 safeSegment
 * 纯函数（零 node 状态，经 shared/interface.ts 复用）；管线对本域的窄需要
 * （如 v2.ts 的 Pick<HistoryStore, "last">）由消费侧内联声明，不另包聚合面——
 * 聚合体会成为无消费者的导出（最小导出纪律）。
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
