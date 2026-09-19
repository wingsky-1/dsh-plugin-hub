/**
 * dsh-lan-proxy — 插件私有目录路径（issue #911）。
 *
 * 与 notifier（PACKAGE_DIR = "@wingsky-1/dsh-notifier"，见其
 * src/server/shared/paths.ts）同形：按 npm 包名分区，避免与其它插件争用
 * DSH home 根目录；根目录只看 dshHome() 一个变量，隔离验证换掉 DSH_HOME
 * 即换掉全部落盘位置。
 *
 * 本叶子只回答“目录在哪”，搬运动作归 migrate 域（历史位置知识 + 落盘都
 * 在那一处，见 migrate/impl/layout）。
 */
import { join } from "node:path";
import { dshHome } from "../../../../../shared/dsh-home.js";

/** 本插件在 DSH home 下的私有目录（按 npm 包名分区）。 */
const PACKAGE_DIR = "@wingsky-1/dsh-lan-proxy";

/** 旧版扁平目录（#911 前自签证书缓存所在）；只做迁出源，不再写入。 */
const LEGACY_DIR = "lan-proxy";

/** 插件私有目录（自签证书缓存 + CA/叶子证书所在）。 */
export function pluginDir(): string {
  return join(dshHome(), PACKAGE_DIR);
}

/** 旧版扁平目录（迁移源；调用方不得再向其写入）。 */
export function legacyPluginDir(): string {
  return join(dshHome(), LEGACY_DIR);
}
