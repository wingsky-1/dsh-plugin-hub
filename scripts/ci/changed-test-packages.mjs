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
 *       → stdout/`$GITHUB_OUTPUT` 得 `testChangedPackages=["dsh-notifier",...]`
 * 退出码：0 = 成功；1 = 环境错误（BASE 缺失 / git 失败）——fail-loud，不静默当成「没有变更」。
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY_REL = "scripts/data/ci-face-registry.json";

/** `packages/<pkg>/test/**` 的相对路径 → 包名；不在该面内返回 null。 */
export function packageOfTestPath(file) {
  const m = /^packages\/([^/]+)\/test\//.exec(file);
  return m === null ? null : m[1];
}

/**
 * 从 diff 路径清单派生「必须失效增量基线」的包清单（去重升序）。
 *
 * 两条来源：
 *   ① `packages/<pkg>/test/**` —— 测试本体变更；
 *   ② 注册表里 `invalidatesBaseline: true` 且声明了包面的条目 —— 测试面输入：共享测试库
 *      （`test/smoke-lib.ts`）、stryker 段配置、包级 stryker 测试面配置。它们同样能改变
 *      「哪些测试在杀 mutant」，而 Stryker 对 static mutant 不看测试侧变更。
 *
 * 为什么把注册表当映射而不是在脚本里另写一张表：注册表已经是「文件 → 归属面」的唯一事实源，
 * 且被 ci-face-coverage 断言与 ci.yml 的 filters 双向核对着；另写一张必然漂移。
 *
 * 边界：声明为 global / 豁免的条目**不**触发失基线——否则改一个 workflow 文件或锁文件就会让
 * 全部 32 段退化为全量，把最坏成本变成默认成本；那类改动的变异正确性由夜间全量兜底。
 * 已知的过宽（有意为之）：`test/smoke-lib.ts` 的 5 个面里有 4 个只在 e2e/client 层用它、不进
 * 变异面，本判据仍按整包失效——多跑一次的代价可接受，漏跑（假绿）不可接受。
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
      if (hit) for (const face of e.faces) pkgs.add(face);
    }
  }
  return [...pkgs].sort();
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
