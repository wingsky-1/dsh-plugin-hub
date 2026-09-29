#!/usr/bin/env node
/**
 * ci-ism-denylist.mjs 自测（#843 评论侧 L4）：真实仓库扫描 + 注入对照（应判红 / 应放行）+ 载体自证 + fail-closed。
 *
 * **执行点：仍只有本自测**——原文件头写的「ci.yml 恒跑静态闸与本地 gate:pr 都是它」是假的，已按实测
 * 改正：`.github/**`、`package.json`、`gate-steps.mjs`、`local-gate.mjs` 全无 ci-ism 引用，删一条
 * denylist 在 CI 与本地三档都不会响。补执行点的 CLI 与接线本刀受阻于三条红线（逐条实测见
 * `scripts/lib/ci-ism-denylist.mjs` 文件头），随批次二落地；本刀先把自证独立性与三态裁决收进 lib。
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
  ciIsmVerdict,
  judgeRepoRoot,
  probeRepoRoot,
  scanRepoRoot,
} from "../lib/ci-ism-denylist.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

/** 真实 git 仓库 fixture：目录项与「未跟踪/被忽略」都由真 git 判定，不在测试里替它猜。 */
function fixtureRepo({
  ignore = [],
  files = [],
  withMarker = true,
}: {
  ignore?: string[];
  files?: { rel: string; content: string }[];
  withMarker?: boolean;
} = {}) {
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

function run(dir: string, fn: (d: string) => void) {
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
  run(dir, (d: string) => {
    const r = scanRepoRoot(d);
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.selfProofProblems, []);
    assert.ok(r.scanned > 0, `扫描面不应为空，实际 ${r.scanned}`);
  });
});

test("判红：仓库根 GITHUB_ENV（未跟踪、未被 ignore）→ 点名该文件（#843 评论侧 L4 的验收形态）", () => {
  const dir = fixtureRepo({ files: [{ rel: "GITHUB_ENV", content: "BASH_ENV=/z\n" }] });
  run(dir, (d: string) => {
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
  run(dir, (d: string) => {
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
  run(dir, (d: string) => {
    const r = scanRepoRoot(d);
    assert.deepEqual(r.violations, [], JSON.stringify(r.violations));
  });
});

test("边界：命中的同名文件已进 git index 时只记 note、不判红（可见性由 diff/评审保证）", () => {
  const dir = fixtureRepo({ files: [{ rel: "GITHUB_ENV", content: "x\n" }] });
  run(dir, (d: string) => {
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
  run(dir, (d: string) => {
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

// ── 载体自证的独立性（审计 batch1）：样本必须与 denylist 无派生关系 ──────────────────────────
test("独立性：CONTROL_SAMPLES 不经 GITHUB_ACTIONS_FILES 派生——删共享常量不再让自证一并通过", () => {
  // 判据不读源码文本，而是构造「denylist 少一条」的真实形态：这是审计给的原反证
  // （删 GITHUB_STEP_SUMMARY 后 selfProofProblems 仍为空数组、violations 3→2 静默逃逸）。
  const shrunk = judgeRepoRoot({
    rootEntries: [
      "package.json",
      "GITHUB_ENV",
      "GITHUB_OUTPUT",
      "GITHUB_PATH",
      "GITHUB_STEP_SUMMARY",
      "residue.jsonl",
      "undefined",
    ],
    untracked: new Set(["GITHUB_STEP_SUMMARY"]),
    patterns: CI_ISM_PATTERNS.filter((p) => p.pattern !== "GITHUB_STEP_SUMMARY"),
  });
  assert.equal(shrunk.violations.length, 0, "反证前提：删掉条目后确实少判一条");
  assert.ok(
    shrunk.selfProofProblems.length > 0,
    "denylist 少一条后自证仍通过 = 样本与 denylist 同源，独立性为假",
  );
  assert.match(shrunk.selfProofProblems.join("\n"), /GITHUB_STEP_SUMMARY/);
});

test("fail-closed：自证样本被删光 → 自证判红（空样本面不得让自证恒绿）", () => {
  // 反证形态：samples 传空数组。uncovered 恒为空 → 「未覆盖自证样本」这条恒不触发 → 静默恒绿。
  // 这比「删一条 denylist 条目」更短的逃逸通道，故必须由对称的一条自证堵死。
  const noSamples = judgeRepoRoot({
    rootEntries: ["package.json"],
    untracked: new Set(),
    samples: [],
    patterns: CI_ISM_PATTERNS,
  });
  assert.deepEqual(noSamples.violations, []);
  assert.match(noSamples.selfProofProblems.join("\n"), /自证样本为空/);
});

test("fail-closed：样本文件读不到 → 模块加载即抛错（不是「没有样本」而是判据不可信）", () => {
  // 独立成文件后新增的一条失败模式：文件被移动/改名/损坏时，loadControlSamples 必须响。
  // 这里直接验加载器的形状守卫（空数组 / 非字符串条目），文件缺失路径由 loadControlSamples 的
  // try/catch 抛出、且本仓 `gate:full` 的真实执行点会以 exit 2 结案。
  assert.ok(CONTROL_SAMPLES.length > 0, "样本面不得为空");
  for (const s of CONTROL_SAMPLES) {
    assert.equal(typeof s, "string", `样本条目须为字符串：${JSON.stringify(s)}`);
    assert.notEqual(s, "", "样本条目不得为空串（空串会被 suffix 规则匹配一切目录项）");
  }
});

test("三态映射 ciIsmVerdict：干净 0 / 残留 1 / 自证失败 2（自证优先于违规）", () => {
  // 批次二的薄 CLI 直接消费本函数，故三态口径在此锁死（CLI 本体因接线受阻暂不落地，见 lib 文件头）。
  const clean = ciIsmVerdict(
    judgeRepoRoot({ rootEntries: ["package.json", "notes.md"], untracked: new Set() }),
  );
  assert.equal(clean.code, 0);
  assert.equal(clean.verdict, "PASS");
  const dirty = ciIsmVerdict(
    judgeRepoRoot({
      rootEntries: ["package.json", "GITHUB_ENV"],
      untracked: new Set(["GITHUB_ENV"]),
    }),
  );
  assert.equal(dirty.code, 1);
  assert.match(dirty.lines.join("\n"), /GITHUB_ENV/);
  // 自证与违规**同时**成立时必须取 2：自证失败 = 判据不可信，报 1 会被读成「改动不达标」
  //（#843 P-2 事故形态）。这条断言就是那条顺序的回归锁。
  const broken = ciIsmVerdict(
    judgeRepoRoot({
      rootEntries: ["package.json", "GITHUB_ENV"],
      untracked: new Set(["GITHUB_ENV"]),
      patterns: [],
    }),
  );
  assert.equal(broken.code, 2, "自证优先于违规：denylist 为空时不得报 1");
  assert.equal(broken.verdict, "门禁故障");
});

test("真实仓库端到端：本仓根 0 违规 + 自证通过（判据可被真实调用，不是只能跑 fixture）", () => {
  const r = scanRepoRoot(ROOT);
  assert.equal(ciIsmVerdict(r).code, 0, JSON.stringify(r));
  // 注入形态后同一入口判红（不落盘到本仓，用 fixture 仓库承载）——证明扫描与 git 探测链真的通。
  const dir = fixtureRepo({ files: [{ rel: "GITHUB_ENV", content: "BASH_ENV=/z\n" }] });
  run(dir, (d) => {
    assert.equal(ciIsmVerdict(scanRepoRoot(d)).code, 1);
  });
});
