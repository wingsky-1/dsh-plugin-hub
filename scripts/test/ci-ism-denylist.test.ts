#!/usr/bin/env node
// @ts-nocheck
/**
 * ci-ism-denylist.mjs 自测（#843 评论侧 L4）：真实仓库扫描 + 注入对照（应判红 / 应放行）+ 载体自证 + fail-closed。
 *
 * 执行点 = `test:scripts`（`node --test scripts/test/*.test.ts`）：ci.yml 的恒跑静态闸与本地
 * `gate:pr` 的「廉价全仓一致性闸」都是它，所以本判据在 CI 与本地三档都可见。
 * 判据本体是 `scripts/lib/ci-ism-denylist.mjs`（纯裁决 + git 探测分开，见该文件的自证说明）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CI_ISM_PATTERNS,
  CONTROL_SAMPLES,
  judgeRepoRoot,
  probeRepoRoot,
  scanRepoRoot,
} from "../lib/ci-ism-denylist.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

/** 真实 git 仓库 fixture：目录项与「未跟踪/被忽略」都由真 git 判定，不在测试里替它猜。 */
function fixtureRepo({ ignore = [], files = [], withMarker = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-ism-denylist-"));
  const git = spawnSync("git", ["init", "-q", "."], { cwd: dir, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  if (withMarker) writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
  if (ignore.length > 0) writeFileSync(join(dir, ".gitignore"), ignore.join("\n") + "\n");
  for (const { rel, content } of files) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function run(dir, fn) {
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("放行：仓库根只有开发草稿（未跟踪的 md / 草稿目录）→ 0 违规", () => {
  const dir = fixtureRepo({
    files: [
      { rel: "notes.md", content: "scratch\n" },
      { rel: ".maintenance-drafts/plan.md", content: "draft\n" },
    ],
  });
  run(dir, (d) => {
    const r = scanRepoRoot(d);
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.selfProofProblems, []);
    assert.ok(r.scanned > 0, `扫描面不应为空，实际 ${r.scanned}`);
  });
});

test("判红：仓库根 GITHUB_ENV（未跟踪、未被 ignore）→ 点名该文件（#843 评论侧 L4 的验收形态）", () => {
  const dir = fixtureRepo({ files: [{ rel: "GITHUB_ENV", content: "BASH_ENV=/z\n" }] });
  run(dir, (d) => {
    const r = scanRepoRoot(d);
    assert.equal(r.violations.length, 1, JSON.stringify(r.violations));
    assert.equal(r.violations[0].path, "GITHUB_ENV");
    assert.equal(r.violations[0].pattern, "GITHUB_ENV");
  });
});

test("判红：GITHUB_ENV 被 .gitignore 兜底时仍然判红（兜底不等于许可）", () => {
  const dir = fixtureRepo({
    ignore: ["GITHUB_ENV", "*.jsonl", "undefined/"],
    files: [
      { rel: "GITHUB_ENV", content: "BASH_ENV=/z\n" },
      { rel: "residue.jsonl", content: "{}\n" },
      { rel: "undefined/a.txt", content: "artifact\n" },
    ],
  });
  run(dir, (d) => {
    const r = scanRepoRoot(d);
    assert.deepEqual(
      r.violations.map((v) => v.path).sort(),
      ["GITHUB_ENV", "residue.jsonl", "undefined"],
      JSON.stringify(r.violations),
    );
  });
});

test("放行：仓库根的其他文件（含 .gitignore 兜底的常规产物目录）不受影响", () => {
  const dir = fixtureRepo({
    ignore: ["node_modules/", "coverage/", "lib/"],
    files: [
      { rel: "node_modules/pkg/index.js", content: "module.exports = 1\n" },
      { rel: "coverage/coverage-final.json", content: "{}\n" },
    ],
  });
  run(dir, (d) => {
    const r = scanRepoRoot(d);
    assert.deepEqual(r.violations, [], JSON.stringify(r.violations));
  });
});

test("边界：命中的同名文件已进 git index 时只记 note、不判红（可见性由 diff/评审保证）", () => {
  const dir = fixtureRepo({ files: [{ rel: "GITHUB_ENV", content: "x\n" }] });
  run(dir, (d) => {
    const add = spawnSync("git", ["add", "GITHUB_ENV"], { cwd: d, encoding: "utf8" });
    assert.equal(add.status, 0, add.stderr);
    const r = scanRepoRoot(d);
    assert.deepEqual(r.violations, []);
    assert.deepEqual(
      r.notes.map((n) => n.path),
      ["GITHUB_ENV"],
    );
  });
});

test("载体自证：denylist 为空 → 自证失败（判据不得因为清单被清空而恒绿）", () => {
  const r = judgeRepoRoot({
    rootEntries: ["package.json", "GITHUB_ENV"],
    untracked: new Set(["GITHUB_ENV"]),
    patterns: [],
  });
  assert.deepEqual(r.violations, []);
  assert.match(r.selfProofProblems.join("\n"), /denylist 为空/);
});

test("载体自证：denylist 漏掉点名的形态 → 自证失败并点出漏掉的样本", () => {
  const r = judgeRepoRoot({
    rootEntries: ["package.json"],
    untracked: new Set(),
    patterns: CI_ISM_PATTERNS.filter((p) => p.pattern !== "GITHUB_ENV"),
  });
  assert.match(r.selfProofProblems.join("\n"), /未覆盖自证样本：GITHUB_ENV/);
});

test("载体自证：扫描面为空 / 不是仓库根 → 自证失败（--root 指错地方不静默放行）", () => {
  const empty = judgeRepoRoot({ rootEntries: [], untracked: new Set() });
  assert.match(empty.selfProofProblems.join("\n"), /扫描面为空/);
  const wrongRoot = judgeRepoRoot({ rootEntries: ["notes.md"], untracked: new Set() });
  assert.match(wrongRoot.selfProofProblems.join("\n"), /不是仓库根/);
});

test("fail-closed：非 git 目录不是「没有残留」而是探测失败（抛错，不返回绿色）", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-ism-nongit-"));
  run(dir, (d) => {
    assert.throws(() => probeRepoRoot(d), /git status 退出码/);
  });
});

test("真实仓库：本仓根目录扫描 → 0 违规，且自证通过（扫描面非空、含仓库根标记）", () => {
  const r = scanRepoRoot(ROOT);
  assert.deepEqual(r.violations, [], JSON.stringify(r.violations));
  assert.deepEqual(r.selfProofProblems, []);
  assert.ok(r.scanned > 0, "扫描面为 0 等于空转，必须判红而不是恒绿");
  assert.ok(CONTROL_SAMPLES.length >= 6, "自证样本清单被削短——载体自证形同虚设");
});
