/**
 * dsh-lan-proxy — 插件行身份的包内唯一事实源。
 *
 * 客户端 row config key 与服务端 settings namespace 均从同一 identity 派生；
 * standalone 与聚合 patch 的 YAML 字面量由契约测试锁为同一值。
 */

const LAN_PROXY_BUNDLE_PACKAGE = "@wingsky-1/dsh-lan-proxy";
const LAN_PROXY_ROW_ID = "ui-dsh-lan-proxy";

/** standalone 与聚合安装共享的 canonical 插件行身份。 */
export const LAN_PROXY_IDENTITY = Object.freeze({
  bundlePackage: LAN_PROXY_BUNDLE_PACKAGE,
  rowId: LAN_PROXY_ROW_ID,
  settingsNamespace: LAN_PROXY_ROW_ID,
  rowConfigKey: `${LAN_PROXY_BUNDLE_PACKAGE}#${LAN_PROXY_ROW_ID}`,
});
