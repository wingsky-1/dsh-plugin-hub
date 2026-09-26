/**
 * dsh-lan-proxy — 插件行身份的包内唯一事实源。
 *
 * row ID 面向 Plugin Manager；settings namespace 面向官方持久化。
 * 两者保持 v0.2.5 已发布的独立身份，row config key 仍由 row ID 派生。
 */

const LAN_PROXY_BUNDLE_PACKAGE = "@wingsky-1/dsh-lan-proxy";
const LAN_PROXY_ROW_ID = "dsh-lan-proxy";
const LAN_PROXY_SETTINGS_NAMESPACE = "dsh-lan-proxy";

/** standalone 与聚合安装共享的 canonical 插件行身份。 */
export const LAN_PROXY_IDENTITY = Object.freeze({
  bundlePackage: LAN_PROXY_BUNDLE_PACKAGE,
  rowId: LAN_PROXY_ROW_ID,
  settingsNamespace: LAN_PROXY_SETTINGS_NAMESPACE,
  rowConfigKey: `${LAN_PROXY_BUNDLE_PACKAGE}#${LAN_PROXY_ROW_ID}`,
});
