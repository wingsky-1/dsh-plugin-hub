/**
 * 客户端端内共享门面：端内跨文件的唯一入口（与 server/shared/interface.ts 同形）。
 *
 * 共享层是叶子——它不依赖端内任何文件，其余文件依赖它。收口到一处，是为了让
 * 「客户端端内共享了什么」有唯一可被评审的答案。
 */
export { APP_ROUTES, CLIENT_ROUTES } from "./contract.ts";
export { DEFAULTS } from "./defaults.ts";
export type {
  CompressSnapshotView,
  ConfigSnapshotView,
  LanProxySettingsView,
  PutResultView,
} from "./view.ts";
