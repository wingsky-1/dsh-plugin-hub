/** 存储布局的单一事实源：文件名是**迁移契约**（升级模块要把旧文件搬到这些名字上），两处各写一份会静默漂移成丢数据；
 * 根目录只看 DSH home 一个变量——隔离验证换掉 `DSH_HOME` 即换掉全部落盘位置。 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dshHome } from "../../../../../shared/dsh-home.js";

/** 本插件在 DSH home 下的私有目录（按 npm 包名分区，避免与其它插件争用根目录）。 */
const PACKAGE_DIR = "@wingsky-1/dsh-notifier";

/** 用户设置文件名。 */
export const CONFIG_FILE_NAME = "config.json";

/** 通知历史文件名（jsonl 追加写）。 */
export const HISTORY_FILE_NAME = "history.jsonl";

/** 频道投递状态文件名。 */
export const STATUS_FILE_NAME = "status.json";

/** SSE 序号计数器文件名（重启后续计数）。 */
export const SEQ_FILE_NAME = "seq.json";

/** 存储版本文件名：内容只有一行版本号，是**升级链的刻度**（存储已经升到哪版）而不是插件版本（后者读 package.json）。 */
export const VERSION_FILE_NAME = "version";

/** 只给目录不给完整路径：文件不存在与目录不存在是两件事，前者是各域的读语义（回落空值），后者由写入方按需创建。 */
function notifierHome(): string {
  return join(dshHome(), PACKAGE_DIR);
}

/** 存储根下的一个文件路径。 */
export function notifierFile(fileName: string): string {
  return join(notifierHome(), fileName);
}

/** 旧版存储位置：DSH home 根目录。「旧文件在哪」与「新文件在哪」分开放会各自漂移——漂移的那次就是迁移读空。 */
export function legacyFile(fileName: string): string {
  return join(dshHome(), fileName);
}

/** 系统通知脚本（Windows 的 WinRT toast）在本包产物里的位置：它随包分发、不在 DSH home 下，只能从本模块位置反推。 */
export function toastScriptPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "server",
    "channels",
    "impl",
    "system",
    "toast.ps1",
  );
}
