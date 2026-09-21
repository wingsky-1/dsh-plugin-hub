/** tools 域门面：包内跨域引用的唯一入口（只转出，不放实现）。 */
export type {
  DecideDeps,
  DecideEvent,
  EventRecorder,
  FetchImpl,
  KeyResolver,
  LoggerPort,
  ValidDecide,
  ValidQuestion,
} from "./deps.ts";
export type { DecideValidationFailure } from "./impl/validate.ts";
export { validateDecideArgs } from "./impl/validate.ts";
export { localPrecheckHit } from "./impl/precheck.ts";
export type { JevFailure, RemoteVerdict } from "./impl/client.ts";
export { callWithRetry, createSemaphore, defaultFetchImpl, parseVerdict } from "./impl/client.ts";
export { decide, listPresets } from "./impl/service.ts";
export type { ToolAssembly } from "./impl/define.ts";
export { buildToolDefinitions, rootOf, sessionOf } from "./impl/define.ts";
