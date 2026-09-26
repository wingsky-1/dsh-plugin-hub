/**
 * dsh-provider-usage — upgrade 域存储刻度落点（historyRoot 下的 .upgrade-version 文件）。
 *
 * 刻度读写原语归本域：落点是**本包的事实**（文件名与所在目录），而读到什么算哪个版本、
 * 版本之间怎么比、怎么从包清单取插件版本，统统归 shared/upgrade-chain.js。
 *
 * 与 mcp-manager 的差异只有一处：刻度随 historyDir 走（root 由调用方给），不散在 DSH_HOME 根。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./storage-layout.ts";

/** 没有版本文件时的起点：从未升级过。 */
const BASELINE_VERSION = "0.0.0";

/** 存储版本文件（historyRoot 下；刻度随 historyDir 走）。 */
export function upgradeVersionFile(root: string): string {
  return join(root, ".upgrade-version");
}

/**
 * 读存储版本。没有版本文件 = 从未升级过 = 从零跑整条链：每一步都会自己判断
 * 有没有它的活要干，全新安装下只有「落定初始形态」那部分生效。
 */
export async function readStoredVersion(root: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(upgradeVersionFile(root), "utf8");
  } catch {
    return BASELINE_VERSION;
  }
  const trimmed = text.trim();
  return trimmed === "" ? BASELINE_VERSION : trimmed;
}

/**
 * 写存储版本：一步升级完成即推进一档。写不进去即抛，调用方中止这一次升级、
 * 下次从同一步重跑。0600 原子写经存储归位同域原语（同一目录内相对引用）。
 */
export async function writeStoredVersion(root: string, version: string): Promise<void> {
  await writeFileAtomic(upgradeVersionFile(root), version + "\n");
}
