/** history 域门面：只转出组合根实际用的符号（无逻辑）。 */
export type { HistoryDeps } from "./deps.ts";
export { appendEntry, deleteSession, queryEntries } from "./impl/service.ts";
export { assembleEntry } from "./impl/entry.ts";
