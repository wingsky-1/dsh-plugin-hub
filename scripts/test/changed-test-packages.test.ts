#!/usr/bin/env node
"use strict";

/**
 * #742 阶段 1.7：test/** 变更检测的口径与 fail-loud 行为。
 *
 * 为什么值得单独测：这条链路决定「命中包的变异是全量还是复用」。判错的方向有两个——
 * 把「改了测试」判成没改 → static mutant 盲区假绿（维护者裁决 3 要治的正是这个）；
 * 把「没改测试」判成改了 → 每个 PR 都退化成全部变异段全量。故既要锁纯函数口径，
 * 也要在临时 git 仓库里真跑一次三点 diff（含改名到 test/ 的形态）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  diffTestPaths,
  packageOfTestPath,
  packagesToInvalidate,
  parseTestDiffPaths,
} from "../ci/changed-test-packages.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts/ci/changed-test-packages.mjs");

test("#742 1.7: packageOfTestPath 只认 packages/<pkg>/test/ 面内路径", () => {
  assert.equal(packageOfTestPath("packages/dsh-notifier/test/e2e/smoke.test.ts"), "dsh-notifier");
  assert.equal(packageOfTestPath("packages/dsh-notifier/test/helpers.ts"), "dsh-notifier");
  assert.equal(packageOfTestPath("packages/dsh-notifier/src/index.ts"), null);
  assert.equal(packageOfTestPath("test/smoke-lib.ts"), null, "根级 test/ 不属于任何包");
  assert.equal(packageOfTestPath("packages/dsh-notifier/test"), null, "目录本身不算变更文件");
  assert.equal(
    packageOfTestPath("packages/dsh-notifier/testing/a.ts"),
    null,
    "前缀相似不等于 face",
  );
});

test("#742 1.7: parseTestDiffPaths 去重升序，忽略空段", () => {
  const z = [
    "packages/dsh-notifier/test/a.test.ts",
    "packages/dsh-lan-proxy/test/e2e/smoke.test.ts",
    "packages/dsh-notifier/test/b.test.ts",
    "packages/dsh-notifier/src/index.ts",
    "shared/util.ts",
    "",
  ].join("\0");
  assert.deepEqual(parseTestDiffPaths(z), ["dsh-lan-proxy", "dsh-notifier"]);
  assert.deepEqual(parseTestDiffPaths(""), []);
  assert.deepEqual(parseTestDiffPaths("\0\0"), []);
});

test("#742 1.7: packagesToInvalidate 覆盖 test/** 之外的测试面输入（注册表标记条目）", () => {
  const reg = JSON.parse(readFileSync(join(ROOT, "scripts/data/ci-face-registry.json"), "utf8"));
  assert.deepEqual(packagesToInvalidate(["packages/dsh-notifier/test/a.test.ts"], reg), [
    "dsh-notifier",
  ]);
  // 共享测试库：4 个包都在用（其中只有 notifier 在变异面内，其余 3 个是 e2e/client 层——
  // 按整包失效是有意的过宽，漏跑的代价更大）
  assert.deepEqual(packagesToInvalidate(["test/smoke-lib.ts"], reg), [
    "dsh-lan-proxy",
    "dsh-mcp-manager",
    "dsh-notifier",
    "dsh-provider-usage",
  ]);
  assert.deepEqual(packagesToInvalidate(["vitest.stryker.d/dsh-lan-proxy.config.ts"], reg), [
    "dsh-lan-proxy",
  ]);
  assert.deepEqual(
    packagesToInvalidate(["stryker.conf.d/dsh-provider-usage-report-execute.json"], reg),
    ["dsh-provider-usage"],
  );
  // 面外/豁免/未标记的数据资产一律不触发失基线——否则改一个 workflow 或锁文件就会让全部
  // 全部变异段退化为全量，把最坏成本变成默认成本
  for (const f of [
    ".github/workflows/ci.yml",
    "package.json",
    "pnpm-lock.yaml",
    "scripts/data/mutation-topology.json",
    "scripts/gate/mutation-plan.mjs",
    "docs/DEVELOPMENT.md",
    "scripts/data/dsh-notifier-export-faces.json",
  ]) {
    assert.deepEqual(packagesToInvalidate([f], reg), [], `${f} 不得触发失基线`);
  }
  assert.deepEqual(packagesToInvalidate([""], reg), [], "空路径段忽略");
});

test("#742 1.7: 三点 diff 口径在真实 git 仓库里成立（含改名到 test/ 的形态）", () => {
  const repo = mkdtempSync(join(tmpdir(), "changed-test-pkgs-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env } });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    mkdirSync(join(repo, "packages/dsh-x/test"), { recursive: true });
    mkdirSync(join(repo, "packages/dsh-x/src"), { recursive: true });
    writeFileSync(join(repo, "packages/dsh-x/test/a.test.ts"), "// a\n");
    writeFileSync(join(repo, "packages/dsh-x/src/a.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "base");

    git("checkout", "-q", "-b", "topic");
    writeFileSync(join(repo, "packages/dsh-x/test/b.test.ts"), "// b\n");
    git("add", "-A");
    git("commit", "-qm", "add test");
    assert.deepEqual(
      parseTestDiffPaths(diffTestPaths("main", repo)),
      ["dsh-x"],
      "新增 test 文件必须被识别为该包 test 变更",
    );

    // 改名：src/a.ts → test/c.ts。--no-renames 保证新路径一定出现（不被 rename 折叠掉）
    git("mv", "packages/dsh-x/src/a.ts", "packages/dsh-x/test/c.ts");
    git("commit", "-qm", "rename into test");
    assert.deepEqual(
      parseTestDiffPaths(diffTestPaths("main", repo)),
      ["dsh-x"],
      "改名进 test/ 的路径必须出现（--no-renames 的作用）",
    );

    // 只改 src：不得判成 test 变更
    git("checkout", "-q", "main");
    git("checkout", "-q", "-b", "src-only");
    writeFileSync(join(repo, "packages/dsh-x/src/a.ts"), "export const a = 2;\n");
    git("add", "-A");
    git("commit", "-qm", "src only");
    assert.deepEqual(parseTestDiffPaths(diffTestPaths("main", repo)), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("#742 1.7: CLI 在同基线上输出空清单，基准不可解析时 fail-loud（不得静默当成没改测试）", () => {
  // GITHUB_OUTPUT 指向隔离临时文件：一是走 CI 的真实写入路径（CI 每个 run 步骤都带该变量），
  // 二是避免子进程往调用方的输出文件里追加内容（#218 产物零污染）。
  const outDir = mkdtempSync(join(tmpdir(), "changed-test-cli-"));
  const outFile = join(outDir, "github-output.txt");
  const same = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, BASE: "HEAD", GITHUB_OUTPUT: outFile },
  });
  assert.equal(same.status, 0, `BASE=HEAD 必须成功（stderr: ${same.stderr}）`);
  assert.match(same.stdout, /test\/ 有变更的包（HEAD\.\.\.HEAD）：\[\]/);
  assert.match(
    readFileSync(outFile, "utf8"),
    /^testChangedPackages=\[\]$/m,
    "必须把清单写进 GITHUB_OUTPUT（ci-matrix 的唯一输入通道）",
  );
  rmSync(outDir, { recursive: true, force: true });

  const missing = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, BASE: "__no_such_ref__", GITHUB_OUTPUT: "" },
  });
  assert.equal(missing.status, 1, "基准不存在必须 exit 1（否则会静默按「无 test 变更」处理）");

  const noBase = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, BASE: "", GITHUB_OUTPUT: "" },
  });
  assert.equal(noBase.status, 1, "BASE 为空必须 exit 1");
});
