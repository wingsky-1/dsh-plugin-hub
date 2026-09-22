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
import { pluginHome } from "../../../../../shared/paths.js";

/** 本插件在 DSH home 下的私有目录（按 npm 包名分区）。 */
const PACKAGE_DIR = "@wingsky-1/dsh-lan-proxy";

/** 旧版扁平目录（#911 前自签证书缓存所在）；只做迁出源，不再写入。 */
const LEGACY_DIR = "lan-proxy";

/** 插件私有目录（自签证书缓存 + CA/叶子证书所在）。 */
export function pluginDir(): string {
  return pluginHome(dshHome(), PACKAGE_DIR);
}

/**
 * 一键 CA 证书子目录名（#930 F18：certs 子目录与文件名常量归本叶子，动作
 * 模块不硬编码 join；自签缓存仍在插件根（SELF_SIGNED_*），托管 CA/叶子独占
 * certs/，与自签缓存物理隔离——isManaged 谓词即以此为界）。
 */
export const CERTS_DIR_NAME = "certs";

/** 托管 CA 公钥文件名（下发源；固定名）。 */
export const CA_CERT_FILE = "ca-cert.pem";
/** 托管 CA 私钥文件名（固定名，永不进下发源；误指即 404 且响应不含私钥）。 */
export const CA_KEY_FILE = "ca-key.pem";
/** 托管叶子证书文件名（CA 签发，随 CA 一起生成与轮换）。 */
export const LEAF_CERT_FILE = "leaf-cert.pem";
/** 托管叶子私钥文件名（随 CA 一起生成与轮换）。 */
export const LEAF_KEY_FILE = "leaf-key.pem";

/** 托管证书文件名清单（装配层 resolvePluginDir files 清单共用同一来源）。 */
export const MANAGED_CERT_FILES: readonly string[] = [
  CA_CERT_FILE,
  CA_KEY_FILE,
  LEAF_CERT_FILE,
  LEAF_KEY_FILE,
];

/** 一键 CA 证书目录（pluginDir 下 certs/；调用方 mkdir 0700 后写入）。 */
export function certsDir(): string {
  return join(pluginDir(), CERTS_DIR_NAME);
}

/** 旧版扁平目录（迁移源；调用方不得再向其写入）。 */
export function legacyPluginDir(): string {
  return join(dshHome(), LEGACY_DIR);
}
