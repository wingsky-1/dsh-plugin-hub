#!/usr/bin/env node
/**
 * scripts/ci/changed-test-packages.mjs —— 本次 diff 里 `packages/<pkg>/test/**` 有变更的包清单
 * （#742 阶段 1.7：Stryker static mutant 盲区处置）。
 *
 * 为什么需要：Stryker 对 static mutant 没有覆盖信息、测试变更对它们不可见（官方 Limitations）。
 * PR 侧变异靠 incremental 基线复用（未被改动的 mutant 直接沿用上次结果），于是「新增用例意图杀掉
 * 存活 mutant」这种 PR 会被整段复用跳过 → 拿到假绿。命中包的 test/** 有变更时主动失效该包基线，
 * 让它跑一次全量，是这个盲区唯一可控的处置（维护者裁决 3：失效而非仅告警）。
 *
 * 为什么用 git diff 而不是 paths-filter 的 list-files：路径规则的唯一事实源是 filters 块（面向
 * 「包面」），而「哪些文件属于 test/」是 diff 本身的性质，不是面。用 git diff 的第二个好处是
 * 本地可完整复现与单测（同一个 BASE...HEAD 三点口径，见 parseTestDiffPaths）。
 *
 * 口径：`git diff --name-only -z --no-renames <base>...HEAD`（三点 = 与 base 的 merge-base，
 * 与 pull_request 的语义一致；--no-renames 保证改名到 test/ 的新路径一定出现，不被 rename 折叠）。
 *
 * 用法：BASE=origin/main node scripts/ci/changed-test-packages.mjs
 *       → stdout/`$GITHUB_OUTPUT` 得 `testChangedPackages=["dsh-notifier","dsh-notifier:pipeline",...]`
 *      （`包:段` 条目 = 单段配置变更，下游仅该段失基线；变量名与输出名不变，ci.yml 无需改）
 * 退出码：0 = 成功；1 = 环境错误（BASE 缺失 / git 失败）——fail-loud，不静默当成「没有变更」。
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY_REL = "scripts/data/ci-face-registry.json";

/**
 * `packages/<pkg>/test/**` 的相对路径 → 包名；不在该面内返回 null。
 *
 * D1（增量命中率）：`test/e2e/**` 与 `test/client/**` 永不进变异面（拓扑
 * `mutationLayers=[unit,integration,client-unit,client-dom]`，派生的
 * `vitest.stryker.d/<pkg>.config.ts` 全仓 grep 零含这两层），故不触发失基线——
 * 否则纯 e2e/client 改动的 PR 会误让整包变异段退化为全量。unit / integration /
 * client-unit / client-dom 与 support 文件（helpers 等）仍触发（保守：support 被
 * 变异层 import，误放行=假绿）。
 */
export function packageOfTestPath(file) {
  const m = /^packages\/([^/]+)\/test\//.exec(file);
  if (m === null) return null;
  const rest = file.slice(m[0].length);
  if (
    rest === "e2e/" ||
    rest.startsWith("e2e/") ||
    rest === "client/" ||
    rest.startsWith("client/")
  ) {
    return null;
  }
  return m[1];
}

/**
 * 从 diff 路径清单派生「必须失效增量基线」的包清单（去重升序）。
 *
 * 三条来源（返回值是包名与 `包:段` 条目的混合清单，去重升序；`包:段` 由下游
 * ci-matrix 拆成段级失效，工作流变量名与输出名不变，故无需改 ci.yml）：
 *   ① `packages/<pkg>/test/**` —— 测试本体变更（D1：e2e / client 层除外，见 packageOfTestPath）；
 *   ② 注册表里 `invalidatesBaseline: true` 且声明了包面的条目 —— 测试面输入：共享测试库
 *      （`test/smoke-lib.ts`）、stryker 段配置、包级 stryker 测试面配置。它们同样能改变
 *      「哪些测试在杀 mutant」，而 Stryker 对 static mutant 不看测试侧变更；
 *   ③ D2（段配置包级连坐消除）：`stryker.conf.d/<pkg>-<seg>.json` 只发射 `<pkg>:<seg>`，
 *      下游仅该段失基线；包级 `<pkg>.json`（当前仓库已无，仅守形状）与包级 vitest 配置仍
 *      发射整包。解析失败一律回落整包（fail-closed：宁可多跑，不假绿）。
 *
 * 为什么把注册表当映射而不是在脚本里另写一张表：注册表已经是「文件 → 归属面」的唯一事实源，
 * 且被 ci-face-coverage 断言与 ci.yml 的 filters 双向核对着；另写一张必然漂移。
 *
 * 边界：声明为 global / 豁免的条目**不**触发失基线——否则改一个 workflow 文件或锁文件就会让
 * 全部变异段退化为全量，把最坏成本变成默认成本；那类改动的变异正确性由夜间全量兜底。
 * 已知的过宽（有意为之）：`test/smoke-lib.ts` 的 consumers 含变异层文件（如
 * `test/integration/real-context.test.ts`，见 ci-face-registry），按整包失效——多跑一次的
 * 代价可接受，漏跑（假绿）不可接受。（D4：旧注释称其 4 个面只在 e2e/client 层用它，
 * 与注册表 consumers 矛盾，结论对、理由错，此处以注册表为准。）
 */
export function packagesToInvalidate(files, registry) {
  const pkgs = new Set();
  const flagged = (registry?.entries ?? []).filter(
    (e) => e.invalidatesBaseline === true && Array.isArray(e.faces) && e.faces.length > 0,
  );
  for (const file of files) {
    if (file === "") continue;
    const own = packageOfTestPath(file);
    if (own !== null) {
      pkgs.add(own);
      continue;
    }
    for (const face of facesHitBy(file, flagged)) {
      const segEntry = segmentEntryFor(file, face);
      pkgs.add(segEntry ?? face);
    }
  }
  return [...pkgs].sort();
}

/**
 * D2：段级配置变更映射到 `<pkg>:<seg>` 条目；非段配置返回 null（调用方回落整包）。
 *
 * 形状与 ci-matrix 的 resolveSegmentNames 同源：段名 = 文件基名剥掉 `${pkg}-` 前缀与
 * `.json` 后缀。包级 `<pkg>.json`（无段后缀）不是段配置，返回 null。
 * vitest 包级配置与 smoke-lib 等非 conf 路径同样返回 null。
 */
export function segmentEntryFor(file, face) {
  const prefix = "stryker.conf.d/";
  if (!file.startsWith(prefix)) return null;
  const base = file.slice(prefix.length);
  if (!base.endsWith(".json") || base.includes("/")) return null;
  const name = base.slice(0, -5);
  if (name === face) return null;
  if (!name.startsWith(`${face}-`)) return null;
  const seg = name.slice(face.length + 1);
  if (seg === "" || seg.includes(":")) return null;
  return `${face}:${seg}`;
}

/** 一个非 test/ 路径命中的包面（声明为 global 的条目不参与失基线，见上文边界）。 */
function facesHitBy(file, flagged) {
  const faces = [];
  for (const e of flagged) {
    if (e.faces.includes("global")) continue;
    let hit = false;
    try {
      hit = matchesGlob(file, e.path);
    } catch {
      // 非法 pattern 在 Node 下表现为「不命中」而非抛错；条目可用性由 ci-face-coverage
      // 的悬空条目/死 glob 断言守着，这里不吞掉真问题。
      hit = false;
    }
    if (hit) faces.push(...e.faces);
  }
  return faces;
}

/**
 * 只按 `packages/<pkg>/test/**` 路径规则解析（等价于注册表里没有标记条目时的结果）。
 * 纯函数：输入是 NUL 分隔的路径串，测试直接喂字符串即可，不依赖 git 环境。
 */
export function parseTestDiffPaths(diffZOutput) {
  return packagesToInvalidate(diffZOutput.split("\0"), { entries: [] });
}

export function loadRegistry(rootDir = ROOT) {
  return JSON.parse(readFileSync(join(rootDir, REGISTRY_REL), "utf8"));
}

export function diffTestPaths(base, rootDir = ROOT) {
  return execFileSync("git", ["diff", "--name-only", "-z", "--no-renames", `${base}...HEAD`], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function main() {
  const base = (process.env.BASE || "").trim();
  if (base === "") {
    console.error(
      "[changed-test-packages] BASE 为空 —— 无法定位 diff 基准（fail-loud：不得静默按「无 test 变更」处理）",
    );
    return 1;
  }
  let out;
  try {
    out = diffTestPaths(base);
  } catch (err) {
    console.error(
      `[changed-test-packages] git diff ${base}...HEAD 失败：${String(err.message).split("\n")[0]}`,
    );
    return 1;
  }
  let registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    console.error(
      `[changed-test-packages] 归属注册表不可解析：${REGISTRY_REL} —— ${String(err.message).split("\n")[0]}`,
    );
    return 1;
  }
  const pkgs = packagesToInvalidate(out.split("\0"), registry);
  const json = JSON.stringify(pkgs);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `testChangedPackages=${json}\n`, "utf8");
  }
  console.log(`test/ 有变更的包（${base}...HEAD）：${json}`);
  return 0;
}

// CLI 守卫：被测试 import 时不执行 main（纯函数可离线复用）。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
