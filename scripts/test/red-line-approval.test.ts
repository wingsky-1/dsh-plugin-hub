#!/usr/bin/env node
/**
 * red-line-approval 自测（#843 M1 / R-1）。
 *
 * 判据有两层，缺一层都会给出假绿：
 *   1. 纯函数层——`judgeRedLine` 的语义（命中且无 approved 才判红）；
 *   2. 接线层——CLI 的退出码契约（0/1/2）与 ci.yml 里那个 job 真的在调它、真的挂进
 *      repo-gate 的 needs。判据本体对而接线错，是"有测试却拦不住"的经典形态。
 *
 * 第 3 类用例（只改普通文件一律放行）是防误伤的关键：判据一旦写成"没标签就红"，
 * 本仓绝大多数 PR 会被无差别卡死，比没有判据更糟。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { judgeRedLine, parseArgs, main, RED_LINE_PATTERNS } from "../gate/red-line-approval.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT_REL = "scripts/gate/red-line-approval.mjs";
const SCRIPT = join(ROOT, SCRIPT_REL);
const CI_YML_REL = ".github/workflows/ci.yml";
const JOB = "red-line-approval";

/** 取 CI 的 job 块：从 job 头到下一个顶格 job 键为止（与 workflow-assert 同款口径）。 */
function jobBlock(text: string, job: string) {
  const start = text.indexOf(`\n  ${job}:`);
  assert.ok(start !== -1, `ci.yml 必须存在 ${job} job`);
  const rest = text.slice(start + 1);
  const end = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

// ─────────────────────────── 一、红线面常量 ───────────────────────────

test("红色面常量：默认红线面恰为 .github/** 与 scripts/gate/**（判定不散成 if）", () => {
  // 与实现比对的是**字面期望**，不是从 RED_LINE_PATTERNS 派生的副本——后者会让
  // "把红线面删空"这类改动自证通过。
  assert.deepEqual([...RED_LINE_PATTERNS], [".github/**", "scripts/gate/**"]);
});

// ─────────────────────────── 二、纯函数判据 ───────────────────────────

test("判据①：命中红线且无 approved → 判红，且逐条点名命中文件", () => {
  const r = judgeRedLine({ changedFiles: [".github/workflows/ci.yml"], labels: [] });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0], /\.github\/workflows\/ci\.yml/);
  assert.match(r.violations[0], /approved/);
});

test("判据①：scripts/gate/** 同属红线面，多文件命中逐条落违规", () => {
  const r = judgeRedLine({
    changedFiles: ["scripts/gate/red-line-approval.mjs", "scripts/gate/local-gate.mjs"],
    labels: ["ci"],
  });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 2);
});

test("判据②：命中红线且带 approved → 放行", () => {
  const r = judgeRedLine({
    changedFiles: [".github/workflows/ci.yml"],
    labels: ["approved"],
  });
  assert.deepEqual(r, { ok: true, violations: [] });
});

test("判据②：标签多且 approved 不在首位 → 仍放行", () => {
  const r = judgeRedLine({
    changedFiles: [".github/workflows/ci.yml", "docs/DEVELOPMENT.md"],
    labels: ["ci", "needs-proposal-review", "approved", "zone:auto"],
  });
  assert.deepEqual(r, { ok: true, violations: [] });
});

test("判据③（防误伤）：只改普通文件、且无任何标签 → 放行", () => {
  const r = judgeRedLine({
    changedFiles: [
      "packages/dsh-notifier/src/index.ts",
      "docs/DEVELOPMENT.md",
      "scripts/test/red-line-approval.test.ts",
    ],
    labels: [],
  });
  assert.deepEqual(r, { ok: true, violations: [] });
});

test("判据③：红线与普通文件混合、无 approved → 只对红线文件判红（不连坐普通文件）", () => {
  const r = judgeRedLine({
    changedFiles: ["packages/dsh-notifier/src/index.ts", ".github/workflows/observe.yml"],
    labels: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0], /observe\.yml/);
});

test("判据④：标签大小写不敏感（Approved / APPROVED 等价于 approved）", () => {
  for (const label of ["Approved", "APPROVED", " approved "]) {
    const r = judgeRedLine({ changedFiles: [".github/workflows/ci.yml"], labels: [label] });
    assert.deepEqual(
      r,
      { ok: true, violations: [] },
      `标签 ${JSON.stringify(label)} 应等价于 approved`,
    );
  }
});

test("判据④：非 approved 标签仅前缀近似不构成批准（approved-ish 不算）", () => {
  const r = judgeRedLine({
    changedFiles: [".github/workflows/ci.yml"],
    labels: ["approved-by-bot", "not-approved", "needs-proposal-review"],
  });
  assert.equal(r.ok, false);
});

test("判据④：红线面字面段大小写敏感——.GITHUB/ 与 Scripts/Gate/ 不得被判红", () => {
  // 匹配器是仓内共用的 node:path `matchesGlob`（ci-face-coverage / local-scope /
  // vendored-binaries-lib 同款），实测语义：**字面段大小写敏感、`**` 段大小写不敏感**
  // （`.github/Workflows/ci.yml` 命中 `.github/**`，`.GITHUB/workflows/ci.yml` 不命中）。
  // 这条用例把"字面段"这一半钉住：它保证判据不会把大小写不同的**另一个目录**误判成红线。
  const r = judgeRedLine({
    changedFiles: [".GITHUB/workflows/ci.yml", "Scripts/Gate/x.mjs", "scripts/GATE/x.mjs"],
    labels: [],
  });
  assert.deepEqual(r, { ok: true, violations: [] });
});

test("判据④：红线面正例仍逐条命中（不因大小写口径把真红线放过）", () => {
  const r = judgeRedLine({
    changedFiles: [".github/workflows/ci.yml", "scripts/gate/local-gate.mjs"],
    labels: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 2);
});

test("判据④：隔离窗（.githubX/…）不得误命中 .github/**", () => {
  const r = judgeRedLine({ changedFiles: [".githubX/ci.yml"], labels: [] });
  assert.deepEqual(r, { ok: true, violations: [] });
});

test("判据：./ 前缀被归一化，不能靠多写一段路径绕过", () => {
  const r = judgeRedLine({ changedFiles: ["./.github/workflows/ci.yml"], labels: [] });
  assert.equal(r.ok, false);
  assert.match(r.violations[0], /红线文件 \.github\/workflows\/ci\.yml/);
});

test("判据：空输入不判红（判红只来自「命中红线且未批准」这一条）", () => {
  assert.deepEqual(judgeRedLine({ changedFiles: [], labels: [] }), { ok: true, violations: [] });
  assert.deepEqual(judgeRedLine({}), { ok: true, violations: [] });
});

test("判据：patterns 可注入（消费方不必改内部实现就能换面）", () => {
  const r = judgeRedLine({
    changedFiles: ["docs/x.md", ".github/workflows/ci.yml"],
    labels: [],
    patterns: ["docs/**"],
  });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0], /docs\/x\.md/);
});

// ─────────────────────────── 三、CLI 退出码契约 ───────────────────────────

/** 直跑真实 CLI（离线、零网络），返回 spawnSync 结果。 */
function runCli(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
}

test("CLI：命中红线且无 approved → exit 1（判红），违规写到 stderr", () => {
  const r = runCli(["--files", ".github/workflows/ci.yml", "--labels", ""]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /red-line-approval: FAIL/);
  assert.match(r.stderr, /\.github\/workflows\/ci\.yml/);
});

test("CLI：命中红线且带 approved → exit 0", () => {
  const r = runCli(["--files", ".github/workflows/ci.yml", "--labels", "approved"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /red-line-approval: OK/);
});

test("CLI：只改普通文件 → exit 0（防误伤回归锚）", () => {
  const r = runCli(["--files", "packages/dsh-notifier/src/index.ts", "--labels", ""]);
  assert.equal(r.status, 0, r.stderr);
});

test("CLI fail-closed：缺失/不可解析的输入一律 exit 2，且不得与 exit 1 混淆", () => {
  const cases = [
    { args: [], why: "无任何参数（--files 缺失）" },
    { args: ["--labels", ""], why: "只有 --labels" },
    { args: ["--files"], why: "--files 缺少参数值" },
    { args: ["--files", ","], why: "--files 解析后为空" },
    { args: ["--files", ".github/workflows/ci.yml", "--unknown", "x"], why: "未知 flag" },
    { args: ["--files", "a.md", "--files-json", "x.json"], why: "同一字段给了两种取数口径" },
    { args: ["--files-json"], why: "--files-json 缺少参数值" },
    { args: ["--files-json", "@缺失路径.json"], why: "@ 指向的 JSON 文件不存在" },
  ];
  for (const { args, why } of cases) {
    const r = runCli(args);
    assert.equal(r.status, 2, `${why} 必须 exit 2（实际 ${r.status}）：${r.stderr}`);
  }
});

test("CLI fail-closed：同一次调用里 --files 重复给出 → exit 2（不取最后一次）", () => {
  const r = runCli(["--files", "a.md", "--files", ".github/workflows/ci.yml"]);
  assert.equal(r.status, 2, r.stderr);
});

test("CLI：--flag=value 形态与逗号分隔的空项都被容忍", () => {
  const ok = runCli(["--files=docs/a.md,docs/b.md,", "--labels=none,"]);
  assert.equal(ok.status, 0, ok.stderr);
  const red = runCli(["--files=scripts/gate/x.mjs,", "--labels="]);
  assert.equal(red.status, 1, red.stderr);
});

test("CLI：--files-json / --labels-json 按 filename / name 抽取（API 原始响应口径）", () => {
  const dir = mkdtempSync(join(tmpdir(), "red-line-json-"));
  try {
    const filesJson = join(dir, "files.json");
    const labelsJson = join(dir, "labels.json");
    writeFileSync(
      filesJson,
      JSON.stringify([
        { filename: ".github/workflows/ci.yml", status: "modified" },
        { filename: "docs/x.md", status: "added" },
      ]),
    );
    writeFileSync(labelsJson, JSON.stringify([{ name: "ci" }, { name: "approved" }]));
    const ok = runCli(["--files-json", filesJson, "--labels-json", labelsJson]);
    assert.equal(ok.status, 0, ok.stderr);
    // 去掉 approved → 同一份文件清单必须判红（证明抽取出来的确实是 filename 列）
    writeFileSync(labelsJson, JSON.stringify([{ name: "ci" }]));
    const red = runCli(["--files-json", filesJson, "--labels-json", labelsJson]);
    assert.equal(red.status, 1, red.stderr);
    assert.match(red.stderr, /\.github\/workflows\/ci\.yml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：--files-json 支持多页拼接——判定必须覆盖所有页，而不是只读第一页", () => {
  // 旧版本把 labels 指向不存在的路径后断言 exit 2：分页解析无论成功还是失败都 exit 2，这条
  // 用例对分页零覆盖。现在 labels 用存在的文件，判定结果才有分辨力。
  const dir = mkdtempSync(join(tmpdir(), "red-line-pages-"));
  try {
    const filesJson = join(dir, "files.json");
    const labelsJson = join(dir, "labels.json");
    const filesPage = (...names: string[]) =>
      JSON.stringify(names.map((filename) => ({ filename, status: "modified" })));
    // 页 1 普通文件、页 2 红线文件：只读首页就会静默漏判（--paginate 存在的唯一理由）
    writeFileSync(filesJson, filesPage("docs/a.md") + filesPage(".github/workflows/observe.yml"));
    writeFileSync(labelsJson, "[]");
    const red = runCli(["--files-json", filesJson, "--labels-json", labelsJson]);
    assert.equal(red.status, 1, red.stderr);
    assert.match(red.stderr, /.github\/workflows\/observe\.yml/);
    // 红线文件在页 1、approved 只在页 2 的 labels 里：两页都要读进来才放行
    writeFileSync(filesJson, filesPage(".github/workflows/ci.yml") + filesPage("docs/a.md"));
    writeFileSync(
      labelsJson,
      JSON.stringify([{ name: "ci" }]) + JSON.stringify([{ name: "approved" }]),
    );
    const ok = runCli(["--files-json", filesJson, "--labels-json", labelsJson]);
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：含 patch 的真实 gh 响应形态必须可解析（P0 回归锚）", () => {
  // 真机形态：pulls/N/files 的每个条目都带 patch（统一 diff 文本）。旧的「正则切 JSON」在这个
  // 形态下会把数组提前收口，JSON.parse 在字符串中间断开 → exit 2 → repo-gate 因 needs 连坐，
  // 对**所有** PR 判红（run 35044624161 即此形态）。故 fixture 必须带 patch，且 patch 里要有
  // 能骗过非贪婪正则的 `]` / `[`。
  const dir = mkdtempSync(join(tmpdir(), "red-line-patch-"));
  try {
    const filesJson = join(dir, "files.json");
    const labelsJson = join(dir, "labels.json");
    writeFileSync(
      filesJson,
      JSON.stringify([
        {
          filename: ".github/workflows/ci.yml",
          status: "modified",
          patch:
            "@@ -1,4 +1,5 @@\n jobs:\n-  needs: [changes]\n+  needs: [changes, x]\n   # ] 注释里的方括号\n",
        },
        {
          filename: "docs/x.md",
          status: "added",
          patch: '@@ -0,0 +1 @@\n+见 [文档](x.md) 与 "引号"\n',
        },
      ]),
    );
    writeFileSync(labelsJson, "[]");
    const red = runCli(["--files-json", filesJson, "--labels-json", labelsJson]);
    assert.equal(red.status, 1, red.stderr);
    assert.match(red.stderr, /.github\/workflows\/ci\.yml/);
    // 同一份含 patch 的响应 + approved → 放行：证明标签在真实形态下真的生效
    writeFileSync(labelsJson, JSON.stringify([{ name: "ci" }, { name: "approved" }]));
    const ok = runCli(["--files-json", filesJson, "--labels-json", labelsJson]);
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：renamed 条目必须把 previous_filename 一并纳入判定（搬出红线面同样要 approved）", () => {
  // 只看 filename 时，把 .github/workflows/ci.yml 改名成 docs/ci.yml.bak 判 exit 0——
  // 那是绕过红线面的通道（评审实测）。
  const dir = mkdtempSync(join(tmpdir(), "red-line-rename-"));
  try {
    const filesJson = join(dir, "files.json");
    const labelsJson = join(dir, "labels.json");
    writeFileSync(
      filesJson,
      JSON.stringify([
        {
          filename: "docs/ci.yml.bak",
          previous_filename: ".github/workflows/ci.yml",
          status: "renamed",
        },
      ]),
    );
    writeFileSync(labelsJson, "[]");
    const red = runCli(["--files-json", filesJson, "--labels-json", labelsJson]);
    assert.equal(red.status, 1, red.stderr);
    assert.match(red.stderr, /.github\/workflows\/ci\.yml/);
    // 普通文件的改入改出不受影响（判据只认红线路径）
    writeFileSync(
      filesJson,
      JSON.stringify([
        { filename: "docs/b.md", previous_filename: "docs/a.md", status: "renamed" },
      ]),
    );
    const pass = runCli(["--files-json", filesJson, "--labels-json", labelsJson]);
    assert.equal(pass.status, 0, pass.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：--files 取值支持 \`@<json 路径>\` 形态（原生字符串列表）", () => {
  const dir = mkdtempSync(join(tmpdir(), "red-line-at-"));
  try {
    const filesJson = join(dir, "files.json");
    writeFileSync(filesJson, JSON.stringify(["scripts/gate/local-gate.mjs"]));
    const r = runCli(["--files", `@${filesJson}`, "--labels", ""]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /scripts\/gate\/local-gate\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI fail-closed：响应不是 JSON 数组 / 条目缺字段 → exit 2（不判成放行也不判成判红）", () => {
  const dir = mkdtempSync(join(tmpdir(), "red-line-badjson-"));
  try {
    const filesJson = join(dir, "files.json");
    const labelsJson = join(dir, "labels.json");
    writeFileSync(labelsJson, "[]");
    // 形态 1：对象而不是数组（例如 gh 的 404 正文）
    writeFileSync(filesJson, JSON.stringify({ message: "Not Found" }));
    const obj = runCli(["--files-json", filesJson, "--labels-json", labelsJson]);
    assert.equal(obj.status, 2, obj.stderr);
    // 形态 2：数组但条目缺 filename
    writeFileSync(filesJson, JSON.stringify([{ sha: "deadbeef" }]));
    const missing = runCli(["--files-json", filesJson, "--labels-json", labelsJson]);
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stderr, /filename/);
    // 形态 3：零字节（gh 失败时的典型残留）
    writeFileSync(filesJson, "");
    const empty = runCli(["--files-json", filesJson, "--labels-json", labelsJson]);
    assert.equal(empty.status, 2, empty.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：--patterns 覆盖默认红线面（消费方换面无需改实现）", () => {
  const hit = runCli(["--files", "docs/x.md", "--labels", "", "--patterns", "docs/**"]);
  assert.equal(hit.status, 1, hit.stderr);
  const pass = runCli(["--files", "docs/x.md", "--labels", "", "--patterns", ".github/**"]);
  assert.equal(pass.status, 0, pass.stderr);
});

test("parseArgs/main 可被 import 直调（不产生副作用）——main 与 CLI 退出码同源", () => {
  assert.deepEqual(parseArgs(["--files", "a,b", "--labels", "x"]).sources, {
    files: "a,b",
    labels: "x",
  });
  assert.equal(parseArgs(["--files", "a"]).mode, "literal");
  assert.equal(parseArgs(["--files-json", "f.json"]).mode, "json");
  assert.deepEqual(parseArgs(["--files", "a"]).patterns, [...RED_LINE_PATTERNS]);
  assert.equal(parseArgs([]).ok, false);
  assert.equal(parseArgs(["--files", "a", "--files-json", "f.json"]).ok, false);
  assert.equal(main(["--files", ".github/x.yml"]), 1);
  assert.equal(main(["--files", ".github/x.yml", "--labels", "approved"]), 0);
  assert.equal(main([]), 2);
});

// ─────────────────────────── 四、接线（ci.yml） ───────────────────────────

test("接线：ci.yml 有 red-line-approval job，仅 PR 触发、显式 pull-requests: read", () => {
  const ci = readFileSync(join(ROOT, CI_YML_REL), "utf8");
  const block = jobBlock(ci, JOB);
  assert.match(block, /if: github\.event_name == 'pull_request'/, "必须只在 pull_request 上跑");
  assert.match(
    block,
    /permissions:[\s\S]*?\n\s+pull-requests: read/,
    "必须显式声明 pull-requests: read（changed files / labels 的取数前提）",
  );
  assert.ok(block.includes(`node ${SCRIPT_REL}`), `job 必须调用 ${SCRIPT_REL}`);
  assert.match(block, /gh api/, "changed files / labels 必须经 gh api 取（取不到 fail-closed）");
});

test("接线：gh 取数必须带 token——permissions 只授权不注入（PR #851 真机 FAILURE 的根因）", () => {
  const ci = readFileSync(join(ROOT, CI_YML_REL), "utf8");
  const block = jobBlock(ci, JOB);
  // Actions 里 gh 认的是 GH_TOKEN/GITHUB_TOKEN 环境变量；只写 permissions 时 gh 以未认证失败，
  // 真机表现为「取数步 failure + 判据步 skipped」。这条断言就是那次事故的回归钉。
  assert.match(
    block,
    /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/,
    "job 必须把 github.token 映射成 GH_TOKEN（缺失时取数必失败，真机 PR #851 即此形态）",
  );
  // 取数步必须在判据步之前：顺序反了会让判据步读到不存在的文件（fail-closed 但判词错位）
  const fetchIdx = block.indexOf("Resolve changed files & labels");
  const judgeIdx = block.indexOf("node scripts/gate/red-line-approval.mjs");
  assert.ok(fetchIdx > 0 && judgeIdx > fetchIdx, "取数步必须排在判据步之前");
  // 有界重试：次数必须封顶，且耗尽后仍以非零退出（宁可重试也不能 fail-open）
  assert.match(
    block,
    /attempt\s*\}\s*3|attempt\s*>=\s*3|attempt.*-ge 3/,
    "必须是有界重试（封顶次数）",
  );
  assert.match(block, /sleep\s+\d+/, "重试之间必须有间隔，不能忙等");
});

test("接线：红线 job 已挂进 repo-gate 的 needs（否则它红不影响聚合闸）", () => {
  const ci = readFileSync(join(ROOT, CI_YML_REL), "utf8");
  const block = jobBlock(ci, "repo-gate");
  const needs = /^\s{4}needs: \[(.+)\]$/m.exec(block);
  assert.ok(needs !== null, "repo-gate 必须声明 needs 列表");
  const list = needs[1].split(",").map((s) => s.trim());
  assert.ok(list.includes(JOB), `repo-gate needs 必须含 ${JOB}（实际 ${list.join(", ")}）`);
  for (const upstream of [
    "changes",
    "build-test",
    "coverage",
    "mutation-gate",
    "mutation-verdict",
  ]) {
    assert.ok(list.includes(upstream), `repo-gate needs 不得丢掉原有维度 ${upstream}`);
  }
});

test("接线：脚本已登记进 scripts/README.md（引用即登记棘轮）", () => {
  const index = readFileSync(join(ROOT, "scripts/README.md"), "utf8");
  assert.ok(
    index.includes("`gate/red-line-approval.mjs`"),
    "scripts/README.md 必须登记 gate/red-line-approval.mjs",
  );
});
