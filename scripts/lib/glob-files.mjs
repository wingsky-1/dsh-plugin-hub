/**
 * scripts/lib/glob-files.mjs — 仓库根锚定的「glob → 物理文件」展开 + 源码世界定义（门禁共用）。
 *
 * 为什么单独成文件：覆盖率面的「条目腐烂」判据（verify-coverage-scope）与变异面的同族判据
 * （gen-stryker-conf 的 --check 判据 ⑤/⑥，实现落在 test-surface.mjs 的 mutationEntryProblems）
 * 要回答同一个问题——「这条 pattern 到底命中几个真实文件」。本仓原有三份同形实现（覆盖率面自带
 * 一份、变异面一份、外加 test-surface 的 expandGlob），再加一份就是下一次「一边改、一边漏」的
 * 漂移面（mutation-topology.mjs 头部记过同类教训）：现在覆盖率面与变异面共用本模块。
 *
 * 与 expandGlob 的差别**不是**「锚点不同」：两者是同一套 glob + 文件过滤，差别在返回契约——
 * 本模块返回仓库根相对 posix 路径，expandGlob 返回绝对路径。可合并，但要改它的调用方，
 * 属另一片；此处只做「门禁侧统一」。
 *
 * **本仓还有第 4 份 glob 语义**：verify-dir-imports.mjs 的手写 globToRegExp（同一批 topology
 * pattern 的逐文件匹配）。它与 node:fs 的 globSync 今天实测 0 分歧（103 pattern × 370 文件全等，
 * 口径 = 拓扑全部 pattern × 源码世界每个文件的判定逐对比对），
 * 属 latent 漂移面；统一它要两侧换同一套匹配器、成本与收益不成比例，故只记账不动手——
 * 读者不要以为 glob 语义已经收干净。
 *
 * 匹配用 node:fs 的 globSync（Node ≥22 内置），不引第三方 glob。
 */
import { globSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * 源码世界：仓库里业务源码可能出现的位置（覆盖率分母与变异面的共同底座）。
 *
 * 为什么两个门禁共用一份常量而不是各写一份：「哪些文件算源码」是仓库级事实，两边各写一份
 * 就是下一次「一边加目录、一边没加」的漂移。两个面用它做的事不同（覆盖率面拿它当分母 universe，
 * 变异面拿它当命中口径），但集合本身必须是同一件事。
 *
 * **「可能出现」是 where，「算源码」还要减掉构建产物**（#1028 后续重构新增的第二步）。
 * shared TS 化后声明与实现由 tsc **原地 emit**，产物（shared 下的 .js 与 .d.ts）与源码
 * 同目录——而本常量覆盖 shared 整个目录，产物就此落进源码世界。后果是实测过的真故障：
 * 变异面棘轮（判据⑦）把基准条目 `shared/settings-namespace.js` 在**当前工作区**展开，
 * 命中的其实是构建产物，于是「改名 .js 到 .ts」被误判成「变异面收缩」而判红。
 *
 * 减项的口径是 **gitignore**，不另立清单：产物之所以是产物，正因为它被 ignore。
 * 用 index ∪（未跟踪且未被 ignore）表达，恰好等于「会被提交的文件」，本地新增未
 * git add 的形态也覆盖在内（与 mjs-freeze-guard 的双向覆盖同一纪律）。
 *
 * 刻意**不**在此减 coverage.config 的 not-source 条目：那些是**覆盖率面**自己的分类
 * （type-only / pending-project 各有自己的语义），由 verify-coverage-scope 在面内消费。
 * 在此重复减一遍会让那 9 条 exclude 全部命中 0 个文件、反被判「条目腐烂」——实测过。
 */
export const SOURCE_UNIVERSE_PATTERNS = ["packages/*/src/**/*", "shared/**/*"];

/** 「会被提交的文件」：index（已跟踪/已暂存）∪ 未跟踪且未被 ignore。本地新增亦在内。 */
function committableFiles(root) {
  const read = (args) => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8" });
    } catch (error) {
      throw new Error(
        `源码世界口径失效：git ${args.join(" ")} 失败（${String(error)}）——判据没跑起来不能伪装成通过`,
      );
    }
  };
  const tracked = read(["ls-files"]);
  const others = read(["ls-files", "--others", "--exclude-standard"]);
  return new Set(
    [...tracked.split("\n"), ...others.split("\n")]
      .filter(Boolean)
      .map((p) => p.split("\\").join("/")),
  );
}

/** 展开 glob 取**文件**（相对 root 的 posix 路径，排序去重）。 */
export function globFiles(root, pattern) {
  const out = new Set();
  for (const hit of globSync(pattern, { cwd: root })) {
    const abs = join(root, hit);
    try {
      if (statSync(abs).isFile()) out.add(hit.split("\\").join("/"));
    } catch {
      // 展开途中消失的文件忽略：口径每次现算，不是清单
    }
  }
  return [...out].sort();
}

/** 源码世界的文件集合（每次现算，不存清单——清单会漂移）。 */
export function sourceUniverse(root, opts = {}) {
  const out = new Set();
  for (const pattern of SOURCE_UNIVERSE_PATTERNS) {
    for (const f of globFiles(root, pattern)) out.add(f);
  }
  // `excludeBuildArtifacts` 只给**变异面棘轮**用（#1028 后续重构）：shared TS 化后
  // tsc 原地 emit，shared 下的 .js/.d.ts 与源码同目录且被 gitignore——不排掉它们，判据⑦
  // 展开基准条目时命中的会是构建产物，于是「改名 .js 到 .ts」被误判成「变异面收缩」。
  //
  // 刻意**不是默认行为**：本函数同时是「import 边可解析的目标集合」的上游，而包的说明符是
  // `../../shared/client/i18n.js`——按 gitignore 收口会让这些边整体消失，连带打掉
  // ci-face-coverage 的载体自证（实测：packages/ 代码不再 import shared/ 判红）。
  // 「哪些文件算分母」与「哪些路径可被 import 命中」是两件事，只在棘轮那一个消费方上区分。
  if (opts.excludeBuildArtifacts === true) {
    const committable = committableFiles(root);
    for (const f of [...out]) {
      if (!committable.has(f)) out.delete(f);
    }
  }
  return out;
}
