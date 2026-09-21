/** history 域门面：包内跨域引用的唯一入口（只转出，不放实现）。 */
export type { HistoryDeps, HistoryIoPorts, LoggerPort } from "./deps.ts";
export { resolveRootHash, rootDisplayOf, rootHashOf, stateHashOf } from "./impl/hash.ts";
export { redactSnippet } from "./impl/redact.ts";
export {
  appendEntry,
  assertSessionId,
  deleteSession,
  historyFile,
  queryEntries,
} from "./impl/service.ts";
export { historyRoot } from "./impl/paths.ts";
export type { EntryEvent } from "./impl/entry.ts";
export { assembleEntry } from "./impl/entry.ts";
