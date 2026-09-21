/** upgrade 域实现：本域文件布局（与 config 域各管各，不跨域直引；文件名常量走共享契约）。 */
import { join } from "node:path";
import { dshHome } from "../../../../../../shared/dsh-home.js";
import {
  CONFIG_FILE_NAME,
  PACKAGE_DIR,
  PRESETS_FILE_NAME,
  SECRETS_FILE_NAME,
  VERSION_FILE_NAME,
} from "../../../shared/interface.ts";

/** 命名空间根。 */
export function namespaceDir(home?: string): string {
  return join(home ?? dshHome(), PACKAGE_DIR);
}

/** VERSION 完整路径。 */
export function versionFile(home?: string): string {
  return join(namespaceDir(home), VERSION_FILE_NAME);
}

/** config.json 完整路径。 */
export function configFile(home?: string): string {
  return join(namespaceDir(home), CONFIG_FILE_NAME);
}

/** presets.json 完整路径。 */
export function presetsFile(home?: string): string {
  return join(namespaceDir(home), PRESETS_FILE_NAME);
}

/** secrets.json 完整路径。 */
export function secretsFile(home?: string): string {
  return join(namespaceDir(home), SECRETS_FILE_NAME);
}
