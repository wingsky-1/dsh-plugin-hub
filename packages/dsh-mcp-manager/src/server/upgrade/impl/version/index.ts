/**
 * upgrade 域版本号与版本文件：**存储版本**（`version` 文件里的刻度）与**插件版本**（package.json 里的目标）
 * 在这里相遇，升级链就是把前者逐刻度推到后者——两者分开存放，才区分得开「还没升」与「升完了」。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextFile, versionFile, writeFileAtomic } from "../../../shared/interface.ts";

/** 没有版本文件时的起点：从未升级过。 */
const BASELINE_VERSION = "0.0.0";

/** 取不到插件版本时的兜底。读到包清单失败不该阻断启动——升级链空转一轮而已。 */
const UNKNOWN_VERSION = "0.0.0";

/**
 * 向上搜索包根的层数上限。真实形态只差 1 层（产物内联进 `lib/index.js`），白盒单测差 5 层；
 * 不设边界就等于允许一路走到文件系统根，去撞一个与本包无关的 `package.json`。
 */
const PACKAGE_ROOT_MAX_DEPTH = 8;

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

/**
 * 本插件当前版本：读包根的 package.json。**不写成常量**——常量与发布版本之间没有任何机制保证同步，
 * 而漂移的那一次会让升级链永远停在旧刻度上（「版本没变」与「升级没做完」外部表现一模一样）。
 *
 * 包根按**最近的一个 `package.json`** 解析而不是固定 `..`：产物形态经 bundle-host 全部内联进
 * `lib/index.js`（上一级即包根），而白盒单测直接加载 `src/server/upgrade/impl/version/index.ts`
 * （五级）；写死层数只有一种形态成立，另一种会让版本静默回落到兜底值。
 */
export function pluginVersion(): string {
  const root = packageRootFrom(dirname(fileURLToPath(import.meta.url)));
  if (root === undefined) return UNKNOWN_VERSION;
  try {
    const parsed: { version?: unknown } = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    return typeof parsed.version === "string" ? parsed.version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

/**
 * 从 `fromDir` 向上找最近的含 `package.json` 的目录；走到层数上限仍没有则 undefined。
 * 导出只为本域用例能断言「没有包根」这条边界——对外契约面仍只有 `installUpgrade` / `releaseUpgrade`。
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
 * 版本号比较：逐段数值比较。段数不同按缺位补零（`0.3` 等价 `0.3.0`）；预发布后缀（`-rc.1`）不参与
 * 比较——本包的版本序列只用到 `主.次.修订`，为一个不会出现的输入引一套 semver 语义，换来的是又一处
 * 需要跟着上游走的依赖。
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
  // #903 parseVersion 宽松收口：预发布后缀显式剥离（旧 parseInt 截断碰巧同效，语义隐晦）；
  // 段非纯数字仍归零——未知输入按 0.0.0 起算跑整条链（各步幂等自查），不抛
  // （启动期读盘数据不可信，抛即崩；归零方向恒为 fail-safe）。
  const core = text.split("-")[0] ?? "";
  return core.split(".").map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : 0));
}
