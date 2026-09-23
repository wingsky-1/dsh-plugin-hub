/**
 * config 域实现：存储布局（文件名是迁移契约，集中一处）。
 *
 * 根目录只看 DSH home 一个变量（shared/dsh-home.js 接缝，感知 DSH_HOME 隔离）。
 */
import { join } from "node:path";
import { dshHome } from "../../../../../../shared/dsh-home.js";
import { pluginHome } from "../../../../../../shared/paths.js";
import {
  CONFIG_FILE_NAME,
  PACKAGE_DIR,
  CUSTOM_PRESETS_FILE_NAME,
  PRESETS_FILE_NAME,
  SECRETS_FILE_NAME,
  VERSION_FILE_NAME,
} from "../../../shared/interface.ts";

/** 本插件在 DSH home 下的独立命名空间目录。 */
export function decisionGatewayHome(home?: string): string {
  return pluginHome(home ?? dshHome(), PACKAGE_DIR);
}

/** config.json 完整路径。 */
export function configFile(home?: string): string {
  return join(decisionGatewayHome(home), CONFIG_FILE_NAME);
}

/** presets.json 完整路径（开关覆盖层）。 */
export function presetsFile(home?: string): string {
  return join(decisionGatewayHome(home), PRESETS_FILE_NAME);
}

/** custom-presets.json 完整路径（自建存储；缺席即空列表）。 */
export function customPresetsFile(home?: string): string {
  return join(decisionGatewayHome(home), CUSTOM_PRESETS_FILE_NAME);
}

/** secrets.json 完整路径（明文密钥唯一落盘处，0600）。 */
export function secretsFile(home?: string): string {
  return join(decisionGatewayHome(home), SECRETS_FILE_NAME);
}

/** VERSION 完整路径（存储版本刻度）。 */
export function versionFile(home?: string): string {
  return join(decisionGatewayHome(home), VERSION_FILE_NAME);
}
