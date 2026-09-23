/** tools 域门面：只转出组合根实际用的符号（无逻辑）。probeConnection 见 impl/probe.ts。 */
export type { DecideDeps, FetchImpl } from "./deps.ts";
export { callWithRetry, defaultFetchImpl } from "./impl/client.ts";
export { createSemaphore } from "./impl/semaphore.ts";
export { decide, listPresets } from "./impl/service.ts";
export { buildToolDefinitions, rootOf, sessionOf } from "./impl/define.ts";
export { probeConnection } from "./impl/probe.ts";
