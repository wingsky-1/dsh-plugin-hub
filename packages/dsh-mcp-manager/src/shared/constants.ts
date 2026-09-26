/**
 * dsh-mcp-manager — shared/constants.ts：跨端契约常量单一事实源（D5，#767 B2a-wire W3b）。
 *
 * scope / 全局 root 与插件行 identity 都是跨端契约。物理定义集中在这里，目录外模块
 * 统一经 shared/interface.ts 消费，避免宿主、客户端或构建元数据各维护一份同值字面量。
 *
 * 为什么本文件零 import：它落在 workspace 域与各消费方的模块求值路径上，必须是最先可求值的
 * 叶子；任何依赖都会把初始化顺序与值环重新引回来。
 */

/** 全局作用域（配置里的 scope 取值；客户端浮窗比较同一字面量）。 */
export const SCOPE_GLOBAL = "global";

/** 项目级作用域。 */
export const SCOPE_PROJECT = "project";

/** 全局虚拟 root（全局服务器经中间层访问时的路由 key）。 */
export const MIDDLEWARE_GLOBAL_ROOT = "@global";

/** bundle package、row ID 与 settings namespace 各自保持稳定身份。 */
const MCP_MANAGER_BUNDLE_PACKAGE = "@wingsky-1/dsh-mcp-manager";
const MCP_MANAGER_ROW_ID = "dsh-mcp-manager";
const MCP_MANAGER_SETTINGS_NAMESPACE = "dsh-mcp-manager";

/** dsh 0.1.7-rc.2 插件行配置的 canonical identity；宿主与客户端只消费此对象。 */
export const MCP_MANAGER_IDENTITY = Object.freeze({
  bundlePackage: MCP_MANAGER_BUNDLE_PACKAGE,
  rowId: MCP_MANAGER_ROW_ID,
  settingsNamespace: MCP_MANAGER_SETTINGS_NAMESPACE,
  rowConfigKey: `${MCP_MANAGER_BUNDLE_PACKAGE}#${MCP_MANAGER_ROW_ID}`,
});
