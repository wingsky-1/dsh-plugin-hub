/**
 * upgrade 域的刻度落点：「**存储版本**」（`version` 文件里的刻度）的唯一读写面。
 *
 * 本文件只管「刻度落在哪个文件、怎么读写」，不判断该推进到哪一格——推进由
 * `shared/upgrade-chain.js` 的链驱动统一回写；版本号比较、包根定位等通用算法同属共享层，
 * 本域不再留一份实现。
 */
import { readTextFile, versionFile, writeFileAtomic } from "../../../shared/interface.ts";

/** 没有版本文件时的起点：从未升级过。 */
const BASELINE_VERSION = "0.0.0";

/**
 * 读存储版本。没有版本文件 = 从未升级过 = 从零跑整条链：每一步都会自己判断有没有它的活要干，
 * 全新安装下只有「落定初始形态」那部分生效，而从更早版本升上来的安装正好借这一轮把该做的做掉。
 */
export async function readStoredVersion(): Promise<string> {
  const text = await readTextFile(versionFile());
  if (text === null) return BASELINE_VERSION;
  const trimmed = text.trim();
  return trimmed === "" ? BASELINE_VERSION : trimmed;
}

/** 写存储版本：一步升级完成即推进一档。写不进去即抛，调用方中止这一次升级、下次从同一步重跑。 */
export async function writeStoredVersion(version: string): Promise<void> {
  await writeFileAtomic(versionFile(), `${version}\n`);
}
