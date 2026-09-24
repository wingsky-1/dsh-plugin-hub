/** upgrade 域版本号与版本文件：**存储版本**（`version` 文件里的刻度）与**插件版本**（package.json 里的目标）在这里
 * 相遇，升级链就是把前者逐刻度推到后者——两者分开存放，才区分得开「还没升」与「升完了」。 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  writeTextAtomicSync,
  VERSION_FILE_NAME,
  notifierFile,
  type FileWrite,
} from "../../../shared/interface.ts";

/** 没有版本文件时的起点：从未升级过。 */
const BASELINE_VERSION = "0.0.0";

/** 取不到插件版本时的兜底。读到包清单失败不该阻断启动——升级链空转一轮而已。 */
const UNKNOWN_VERSION = "0.0.0";

/** 存储刻度只接受 v0/v1 的规范三段式；预发布、缺段、前后缀与前导零都不属于本升级链。 */
const SUPPORTED_STORED_VERSION = /^(?:0|1)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

/** 读取器接缝只为稳定覆盖 Node 文件错误码；生产默认直接同步读取。 */
type ReadVersionFile = (file: string) => string;

/** 读存储版本。仅目标文件精确不存在时从零起跑；读错、空值或坏内容都必须让启动中止，不能把坏源伪装成全新安装。 */
export function readStoredVersion(
  read: ReadVersionFile = (file) => readFileSync(file, "utf8"),
): string {
  let raw: string;
  try {
    raw = read(notifierFile(VERSION_FILE_NAME));
  } catch (cause) {
    const code = errorCode(cause);
    if (code === "ENOENT") return BASELINE_VERSION;
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `dsh-notifier: 存储版本文件读取失败${code === undefined ? "" : `（${code}）`} — ${reason}`,
      { cause },
    );
  }

  const version = raw.trim();
  if (version === "") throw new Error("dsh-notifier: 存储版本文件为空");
  if (!SUPPORTED_STORED_VERSION.test(version)) {
    throw new Error(
      `dsh-notifier: 存储版本文件包含非法或不支持的版本号：${JSON.stringify(version)}`,
    );
  }
  return version;
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

/** 版本号比较：逐段数值比较。段数不同按缺位补零（`0.3` 等价 `0.3.0`）；预发布后缀（`-rc.1`）不是本升级链支持的版本格式，
 * 会明确抛错，而不是悄悄截断前缀。 */
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
  const parts = text.split(".");
  if (parts.length > 3 || parts.some((part) => !/^(?:0|[1-9]\d*)$/u.test(part))) {
    throw new Error(`dsh-notifier: 不支持的版本号：${JSON.stringify(text)}`);
  }
  return parts.map((part) => Number(part));
}

/** Node 文件错误会带稳定 code；没有 code 的异常仍按读取失败处理。 */
function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
}
