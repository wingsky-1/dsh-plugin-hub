/**
 * dsh-lan-proxy — 主机端。dsh web UI 的零依赖 LAN 转发器：等回环 web 服务器
 * 绑定后，在 0.0.0.0:<port> 上监听并把 HTTP + WebSocket 转发到
 * 127.0.0.1:<webServer.port>（默认 3080），重写 Host/Origin 使 /api 浏览器
 * 信任围栏接受这些请求。
 *
 * 端口不是固定的：默认 3081，可通过两层途径修改（都实时生效）——
 *   1. GUI 设置卡片（设置 → 插件 → dsh-lan-proxy）：经 loopback HTTP 配置路由
 *      写入官方 settings 命名空间（scope.update/replace），scope.watch 触发热更新；
 *      settings 服务不可解析时自动降级并打 warn 日志。
 *   2. 组合层配置（profile 的 cordis.patch.yml 覆盖 lan-proxy 行的 config，
 *      或启动时 --patch overlay）——作为 settings 命名空间的 base 层生效。
 *
 * 配置单一通道（issue #110）：不再维护自建 `~/.dsh/lan-proxy/config.json` 与
 * RPC state/config 端点；配置一律存官方 settings 存储（settings.register 注册的
 * `dsh-lan-proxy` 命名空间，owner scope get/watch/update/replace）。存量
 * config.json 在 settings 服务 attach 后做一次性 marker 迁移（原子改名
 * `config.json.migrated.bak` 幂等标记 → 校验过滤 → scope.update 增量写入，
 * 失败回滚改名）；此后手改 config.json 不再生效。
 *
 * 激活方式：把本包安装进某个 profile，其 cordis.patch.yml（通过
 * `dsh.bundle.patch` 声明）会插入 `lan-proxy` 这一行：
 *
 *   dsh plugin --profile web add link:<本包路径>
 *
 * 该行是普通 cordis 插件：主机端（exports "."）在宿主进程运行，注入
 * `webServer`，因此只在回环服务器监听后启动，并从 ctx.webServer.port
 * 解析真实上游端口（`--port 0` 与自定义 `--port` 均可用）。
 *
 * 结构（#826 域归位）：实现按域归位到 src/server/<域>/（config / host-trust / migrate / proxy / tls）
 * 与 src/server/shared/（包内共享叶子），装配在 src/server/apply.ts；本文件保留插件契约
 * （name/inject 与 apply、路由表转发）与全部公共符号 re-export（导出面不变，外部消费者从
 * lib/index.js 导入不受影响）。apply 实现于 server/apply.ts，不 import 本文件。
 */
export const name = "lan-proxy";

/** 等回环 web 服务器绑定并初始化后再启动。 */
export const inject = ["webServer"];

// ------------------------------------------------------------------ 对外 re-export
// 注意：bundle-host 会把 tsc 产物中的子模块全部内联进 lib/index.js 并清理游离 .js，
// smoke/lint 只能从 lib/index.js 导入，故契约与核心模块一律在此 re-export。
// 配置模型与校验（#276 方案 A 阶段 3 拆出：schema / 校验 / 净化 / 类型面；
// normalizeLegacyWsCompressPaths 为 #395 M2 存量白名单归一化纯函数）
export {
  Config,
  sanitizeSettings,
  validateSettings,
  normalizeLegacyWsCompressPaths,
} from "./server/config/interface.ts";
export type {
  HttpCompressSnapshot,
  LanProxyConfig,
  ResolvedConfig,
  SettingInvalid,
} from "./server/config/interface.ts";
export { SETTINGS_NS, installLanProxySettings } from "./server/config/interface.ts";
export type { LanProxySettingsHooks, OwnerScopeLike } from "./server/config/interface.ts";
export {
  ROUTES,
  applyConfigPatch,
  buildCaCertRoutes,
  buildConfigRoutes,
} from "./server/config/interface.ts";
export type { CaCertRouteDeps, ConfigRouteDeps, PatchResult } from "./server/config/interface.ts";
export { MIGRATED_BAK_NAME, migrateFileConfig } from "./server/migrate/interface.ts";
export type { MigrationOutcome } from "./server/migrate/interface.ts";
export { LEGACY_BAK_SUFFIX, resolvePluginDir } from "./server/migrate/interface.ts";
export type { LayoutMigrateOptions, LayoutMigrateOutcome } from "./server/migrate/interface.ts";
// host trust 域（#856）不进包导出面：自条件注入纯函数、官方 index 变换钩子注册与两条
// 契约字面量都只被包内 apply 消费，属实现细节而非安装面 / 配置面 / 契约面
// （docs/ARCHITECTURE-METHOD.md §6）。域门面 src/server/host-trust/interface.ts 保留为
// 内部 seam，白盒单测直连 src 即可；不得以「测试需要」为由重新追加导出。
export { apply, pluginDir, DEFAULT_WSS_COMPRESS_PATHS } from "./server/apply.ts";

// 既有包导出面（历史 ABI，冻结）：下列内部符号自 #276 拆分起就随 lib/index.js 发布，
// 收窄属公共 API 变更（红线，需独立 PR 走导出面评审）；不得以「测试需要」为由继续追加。
export {
  createLanProxy,
  hostnameAllowed,
  formatAuthority,
  rewriteHeaders,
  bridgeUpstreamHeaders,
  compressWsPath,
  isCompressible,
  resolveCompressionOptions,
  deflateAllowedByPolicy,
  hasDshAuthCookie,
  isTokenMintCandidate,
  withLaunchToken,
} from "./server/proxy/interface.ts";
export type { ConnStats, LanProxy, TokenProvider } from "./server/proxy/interface.ts";
// 包内共享叶子（#826：默认值常量与回环判定从 proxy.ts 归位）
export {
  DEFAULT_DEFLATE_POLICY,
  DEFAULT_OPTIONS,
  isLoopbackTarget,
} from "./server/shared/interface.ts";
export type { DeflatePolicy } from "./server/shared/interface.ts";
// TLS 域（#826：cert.ts 归位为 server/tls/）
export {
  ensureSelfSignedTls,
  certStillValid,
  toSanEntry,
  loadTlsFromFiles,
  SELF_SIGNED_KEY,
  SELF_SIGNED_CERT,
} from "./server/tls/interface.ts";
