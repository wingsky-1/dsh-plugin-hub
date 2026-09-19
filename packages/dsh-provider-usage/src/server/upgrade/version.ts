/**
 * dsh-provider-usage — upgrade 域版本刻度（存储版本文件 + 插件版本 + 版本比较）。
 *
 * 存储版本（historyRoot 下 `.upgrade-version` 文件里的刻度）与插件版本
 * （package.json 里的目标）在这里相遇：升级链就是把前者逐刻度推到后者。
 * 两者分开存放，才区分得开「还没升」与「升完了」。
 * mcp-manager `server/upgrade/impl/version/index.ts` 同构：语义逐项对应，
 * 落点改为 historyRoot 内——刻度随 historyDir 走，不散在 DSH_HOME 根。
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./storage-layout.ts";

/** 没有版本文件时的起点：从未升级过。 */
const BASELINE_VERSION = "0.0.0";

/** 取不到插件版本时的兜底。读包清单失败不阻断启动——升级链空转一轮而已。 */
const UNKNOWN_VERSION = "0.0.0";

/**
 * 向上搜索包根的层数上限。真实形态只差 3 层（src/server/upgrade → 包根），
 * 白盒单测同路径；不设边界就等于允许一路走到文件系统根，去撞一个与本包
 * 无关的 `package.json`。
 */
const PACKAGE_ROOT_MAX_DEPTH = 8;

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

/**
 * 本插件当前版本：读包根的 package.json。**不写成常量**——常量与发布版本之间
 * 没有任何机制保证同步，而漂移的那一次会让升级链永远停在旧刻度上（「版本
 * 没变」与「升级没做完」外部表现一模一样）。
 *
 * 包根按**最近的一个 `package.json`** 解析而不是固定层数：白盒单测与产物
 * 形态的目录深度不同，写死层数只有一种形态成立，另一种会让版本静默回落
 * 到兜底值。
 */
export function pluginVersion(): string {
  const root = packageRootFrom(dirname(fileURLToPath(import.meta.url)));
  if (root === undefined) return UNKNOWN_VERSION;
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return typeof parsed.version === "string" ? parsed.version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

/**
 * 从 `fromDir` 向上找最近的含 `package.json` 的目录；走到层数上限仍没有
 * 则 undefined。导出只为本域用例能断言「没有包根」这条边界——对外契约面
 * 仍只有 `installUpgrade`。
 */
export function packageRootFrom(fromDir: string): string | undefined {
  let current = fromDir;
  for (let depth = 0; depth < PACKAGE_ROOT_MAX_DEPTH; depth += 1) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * 版本号比较：逐段数值比较。段数不同按缺位补零（`0.3` 等价 `0.3.0`）；
 * 预发布后缀（`-rc.1`)不参与比较——本包的版本序列只用到主次修订，
 * 为不会出现的输入引一套 semver 语义，换来的是又一处要跟着上游走的依赖。
 */
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
  // 宽松收口：预发布后缀显式剥离；段非纯数字归零——未知输入按 0.0.0 起算
  // 跑整条链（各步幂等自查），不抛（启动期读盘数据不可信，抛即崩；归零方向
  // 恒为 fail-safe）。
  const core = text.split("-")[0] ?? "";
  return core.split(".").map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : 0));
}
