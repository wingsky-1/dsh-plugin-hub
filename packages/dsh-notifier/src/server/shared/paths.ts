/**
 * dsh-notifier 包内 —— **存储布局的单一事实源**。
 *
 * 存储根是 DSH home 下按包名分区的私有目录：本插件的配置、历史、投递状态、SSE
 * 序号各占一个文件，既彼此不重名，也不再往 DSH home 根目录散落。根目录只看
 * DSH home 一个变量——隔离验证换掉 `DSH_HOME` 即换掉全部落盘位置。
 *
 * 为什么目录与文件名都在这里而路径拼装留给各域：目录与文件名是**迁移契约**
 * （升级模块要把旧文件搬到这些名字上），两处各写一份就会静默漂移成丢数据；
 * 而「什么时候读、以什么语义读」是各域自己的事，集中过来只会让谁在写什么变得
 * 不可见。
 *
 * 依赖方向：只引用仓库共享层的 DSH home 解析与 Node 内置模块，不引用任何域。
 */
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

/**
 * 存储版本文件名。
 *
 * 内容只有一行版本号：它是**升级链的刻度**，记录「存储已经升到哪个版本」，而不是
 * 插件当前是什么版本（后者读 package.json）。刻度与目标分开，才区分得开「还没升」
 * 与「升完了」。
 */
export const VERSION_FILE_NAME = "version";

/**
 * 存储根目录。
 *
 * 只给目录不给完整路径：文件不存在与目录不存在是两件事，前者是各域的读语义
 * （回落空值），后者由写入方按需创建。
 */
function notifierHome(): string {
  return join(dshHome(), PACKAGE_DIR);
}

/** 存储根下的一个文件路径。 */
export function notifierFile(fileName: string): string {
  return join(notifierHome(), fileName);
}

/**
 * 旧版存储位置：DSH home 根目录。
 *
 * 本插件曾把配置、历史、状态直接散在 DSH home 下；解析旧位置的知识留在这里而不是
 * 搬进迁移模块，是因为「旧文件在哪」与「新文件在哪」是同一个问题的两半——分开放
 * 就会各自漂移，而漂移的那一次就是迁移读空、用户数据看起来凭空消失。
 */
export function legacyFile(fileName: string): string {
  return join(dshHome(), fileName);
}

/**
 * 系统通知脚本（Windows 的 WinRT toast）在本包产物里的位置。
 *
 * 与落盘路径不同：它随包分发而不在 DSH home 下，所以只能从**本模块所在位置**反推。
 * 产物形态是唯一要考虑的形态——tsc 产物经 bundle-host 全部内联进 `lib/index.js`，
 * 而 `.ps1` 这类资源由构建脚本按 `src/` 下的相对位置复制进 `lib/`，于是：
 * 本模块运行时在 `lib/`，脚本在 `lib/server/channels/impl/system/toast.ps1`。
 *
 * 脚本属于系统通知出口（平台适配是它的实现细节），但路径是**产物布局**的事实，与
 * 存储布局同理只有一个事实源，所以落在这里而不是出口内部。
 */
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
