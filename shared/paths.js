// dsh 插件家族共享层 — 插件主目录拼装（单一事实源）。
//
// 历史：`join(dshHome(), PACKAGE_DIR)` 在 5 包 6 处逐字复制
// （lan-proxy / mcp-manager / notifier 的包主目录、decision-gateway config/history 两域、
// worktree-sidebar 绑定表）——分区策略变化时要改 6 处。统一由本模块承载：
// `pluginHome(base, ...segments)` 即 `join(base, ...segments)`，默认形态路径逐字节不变。
//
// 只收敛「包主目录」一类拼装；以下 7 类排除，各有不可收敛的理由（函数 JSDoc 列清单）。
// provider-registry 的旧 `pluginHome` 保留为包内 facade：公开签名由
// export-surface 门禁锁定，不动；其 `plugins/provider-usage` 两段式布局与
// 包主目录直拼不同构，不收敛。

import { join } from "node:path";

/**
 * 插件主目录拼装：`join(base, ...segments)` 的唯一入口。base 一般取
 * `dshHome()`（需参数化测试基时显式传 base，如 decision-gateway 两域的
 * `home ?? dshHome()`）。纯拼装、不做存在校验，默认形态路径逐字节不变。
 *
 * 只收敛「包主目录」直拼（`join(<DSH home>, PACKAGE_DIR[, 子段])`）；以下 7 类排除：
 * 1. legacy/旧根：旧版布局迁移读面（lan-proxy `legacyPluginDir`、
 *    notifier/mcp-manager `legacyFile`、mcp-manager `LEGACY_LAYOUT`/
 *    `legacyProjectConfigFile`、notifier `documentCandidates` 的 DSH home 根直拼）——
 *    旧路径是迁移契约读面，只读不写，收敛会把新写面与旧读面混成一处。
 * 2. settings 文档：notifier `documentCandidates` 按官方缺省名在 DSH home 根下找
 *    宿主 settings 文档（SETTINGS_DOC_FILES）——那是宿主文档读面，不是插件私有目录。
 * 3. resolve 对比：mcp-manager `isProjectConfigFile`/`fileMode`/`directoryMode` 的
 *    basename/dirname 比较、provider `resolvePath` 的候选对比——前者是比较
 *    不是拼装，后者候选含用户输入且命中顺序是语义。
 * 4. 用户输入解析：provider `expandHomePath`/`resolvePath`——用户输入的 `~`/
 *    相对路径展开与解析（含 `~user` 不展开边界），base 来自用户输入语义，
 *    不是固定的包主目录拼装。
 * 5. credentials-userHome：provider `opencodeAuthFile` 的
 *    `join(userHome(), ".local", "share", "opencode", "auth.json")`——DSH_HOME 域外的
 *    第三方工具凭据落点，跟随用户 home 而非 DSH home，base 就不是 DSH home。
 * 6. 展示脱敏：provider `sanitizeDiagnostic` 的
 *    `split(dshHome()).join("~/.dsh")`——展示层脱敏（字符串替换），
 *    不产生落盘路径。
 * 7. 包内反推：notifier `toastScriptPath` 经 `dirname(fileURLToPath(import.meta.url))`
 *    反推产物内脚本位置——随包分发、不在 DSH home 下，base 不是 DSH home。
 *
 * provider-registry 的旧 `pluginHome(base = dshHome())` 保留为包内 facade（公开签名不变），
 * 不收敛到本模块。
 *
 * @param {string} base - DSH home 格（一般取 `dshHome()`）。
 * @param {...string} segments - 包分区目录及其下子段。
 * @returns {string} 拼装后的路径（等同 `join(base, ...segments)`）。
 */
export function pluginHome(base, ...segments) {
  return join(base, ...segments);
}
