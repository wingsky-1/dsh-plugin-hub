/** upgrade 域刻度落点：**存储版本**（`version` 文件里的刻度）的读写与读策略。刻度是「这一步做完了」
 * 的凭证，故读侧是 fail-closed——读不到与读坏了必须分开：只有精确 ENOENT 才回落 0.0.0 起跑，空文件、
 * 坏内容与读错误一律中止启动，把坏源伪装成全新安装比不启动糟得多。
 *
 * 插件版本（对账目标）与版本比较不在本模块：它们是跨包骨架，属 shared/upgrade-chain.js。 */
import { readFileSync } from "node:fs";
import {
  writeTextAtomicSync,
  VERSION_FILE_NAME,
  notifierFile,
  type FileWrite,
} from "../../../shared/interface.ts";

/** 没有版本文件时的起点：从未升级过。 */
const BASELINE_VERSION = "0.0.0";

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

/** Node 文件错误会带稳定 code；没有 code 的异常仍按读取失败处理。 */
function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
}
