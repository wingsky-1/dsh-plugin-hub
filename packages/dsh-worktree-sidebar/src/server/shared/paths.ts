/**
 * 落盘位置的单一事实源。只看 `DSH_HOME` 一个变量（经 shared/dsh-home.js 归一），
 * 隔离验证换掉它即换掉全部落盘位置——路径若在别处再拼一次，隔离性就有第二个事实源。
 */
import { dshHome } from "../../../../../shared/dsh-home.js";
import { pluginHome } from "../../../../../shared/paths.js";

/** 本插件在 DSH home 下的私有目录（按 npm 包名分区，避免与其它插件争用根目录）。 */
const PACKAGE_DIR = "@wingsky-1/dsh-worktree-sidebar";

/** 绑定表文件名。 */
const BINDINGS_FILE_NAME = "bindings.json";

/** 绑定表完整路径。目录是否存在由写入方按需创建。 */
export function bindingsFile(): string {
  return pluginHome(dshHome(), PACKAGE_DIR, BINDINGS_FILE_NAME);
}
