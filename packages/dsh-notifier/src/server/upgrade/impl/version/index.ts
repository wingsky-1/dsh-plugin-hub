/** upgrade 域版本号与版本文件：**存储版本**（`version` 文件里的刻度）与**插件版本**（package.json 里的目标）在这里
 * 相遇，升级链就是把前者逐刻度推到后者——两者分开存放，才区分得开「还没升」与「升完了」。 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readTextFileSync,
  writeTextAtomicSync,
  VERSION_FILE_NAME,
  notifierFile,
  type FileWrite,
} from "../../../shared/interface.ts";

/** 没有版本文件时的起点：从未升级过。 */
const BASELINE_VERSION = "0.0.0";

/** 取不到插件版本时的兜底。读到包清单失败不该阻断启动——升级链空转一轮而已。 */
const UNKNOWN_VERSION = "0.0.0";

/** 读存储版本。没有版本文件 = 从未升级过 = 从零跑整条链：每一步都会自己判断有没有它的活要干，全新安装下全部空转，
 * 而从更早版本升上来的安装正好借这一轮把该做的做掉。 */
export function readStoredVersion(): string {
  const read = readTextFileSync(notifierFile(VERSION_FILE_NAME));
  if (!read.ok) return BASELINE_VERSION;
  const text = read.text.trim();
  return text === "" ? BASELINE_VERSION : text;
}

/** 写存储版本：一步升级完成即推进一档；写不进去就停在原处，下次重跑该步。 */
export function writeStoredVersion(version: string): FileWrite {
  return writeTextAtomicSync(notifierFile(VERSION_FILE_NAME), `${version}\n`);
}

/** 本插件当前版本：读包根的 package.json。不写成常量——常量与发布版本之间没有任何机制保证同步，而漂移的那一次会让
 * 升级链永远停在旧刻度上（「版本没变」与「升级没做完」外部表现一模一样）。路径按**产物形态**取：tsc 产物经
 * bundle-host 全部内联进 `lib/index.js`，故本模块运行时所在目录就是 `lib/`，包根在上一级。 */
export function pluginVersion(): string {
  try {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed: { version?: string } = JSON.parse(readFileSync(manifest, "utf8"));
    return typeof parsed.version === "string" ? parsed.version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

/** 版本号比较：逐段数值比较。段数不同按缺位补零（`0.3` 等价 `0.3.0`）；预发布后缀（`-rc.1`）不参与比较——本包的
 * 版本序列只用到 `主.次.修订`，为一个不会出现的输入引一套 semver 语义，换来的是又一处需要跟着上游走的依赖。 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function parseVersion(text: string): number[] {
  return text.split(".").map((part) => Number.parseInt(part, 10) || 0);
}
