/** api 域门面：包内跨域引用的唯一入口（只转出，不放实现）。 */
export type {
  ApiDeps,
  HistoryQuery,
  LoggerPort,
  PresetListItem,
  RouteRegistration,
} from "./deps.ts";
export type { Endpoint, MethodTable, RegisterRoute } from "./impl/route.ts";
export { registerEndpoints, sendFailure, sendJson } from "./impl/route.ts";
export { buildEndpoints } from "./impl/handlers.ts";
export { installApi } from "./impl/service.ts";
