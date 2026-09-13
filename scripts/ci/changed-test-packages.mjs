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
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `packages/<pkg>/test/**` 的相对路径 → 包名；不在该面内返回 null。 */
export function packageOfTestPath(file) {
  const m = /^packages\/([^/]+)\/test\//.exec(file);
  return m === null ? null : m[1];
}

/**
 * 从 `git diff --name-only -z` 的输出解析出「test/ 有变更」的包清单（去重升序）。
 * 纯函数：输入是 NUL 分隔的路径串，测试直接喂字符串即可，不依赖 git 环境。
 */
export function parseTestDiffPaths(diffZOutput) {
  const pkgs = new Set();
  for (const file of diffZOutput.split("\0")) {
    if (file === "") continue;
    const pkg = packageOfTestPath(file);
    if (pkg !== null) pkgs.add(pkg);
  }
  return [...pkgs].sort();
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
  const pkgs = parseTestDiffPaths(out);
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
