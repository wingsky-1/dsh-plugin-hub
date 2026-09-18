#!/usr/bin/env node
/**
 * red-line-approval 自测（#843 M1 / #851 裁决后的派生面）。
 *
 * 判据有三层，缺一层都会给出假绿：
 *   1. 纯函数层——`judgeRedLine` 的语义（命中且无 approved 才判红）；
 *   2. 面层——红线面是**派生**的（`.github/**` ∪ 声明表里每个 guard 的 `sources` ∪ 声明表自身），
 *      且 `scripts/gate/**` 明确**不在**面内（#851 撤回了上一版把它当"加固面"的扩大定义）；
 *   3. 接线层——CLI 的退出码契约（0/1/2）与 ci.yml 里那个 job 真的在调它、真的挂进
 *      repo-gate 的 needs。判据本体对而接线错，是"有测试却拦不住"的经典形态。
 *
 * 面层的用例一律用 fixture 声明表（mkdtemp 里），**不读** `scripts/data/threshold-registry.json`
 * 本体：那份表由 #850 引入，本 PR 的合并顺序在它之前——用例依赖它就等于把本 PR 的绿挂在下一次
 * 合并上。判定逻辑的用例用默认面（两种合并顺序下都成立的断言）。
 *
 * 防误伤仍然关键：判据一旦写成"没标签就红"，本仓绝大多数 PR 会被无差别卡死，比没有判据更糟。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { spawnSync } from "node:child_process";

import {
  judgeRedLine,
  parseArgs,
  main,
  RED_LINE_PATTERNS,
  redLinePatterns,
  REGISTRY_REL_PATH,
  DEFAULT_REGISTRY_PATH,
} from "../gate/red-line-approval.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT_REL = "scripts/gate/red-line-approval.mjs";
const SCRIPT = join(ROOT, SCRIPT_REL);
const CI_YML_REL = ".github/workflows/ci.yml";
const JOB = "red-line-approval";

/** 写一份 fixture 声明表（只在 mkdtemp 目录里，不入库），返回其绝对路径。 */
function writeRegistry(dir: string, guards: { id: string; sources: string[] }[]) {
  const path = join(dir, "threshold-registry.json");
  writeFileSync(path, JSON.stringify({ version: 1, guards }, null, 2));
  return path;
}

/** 建隔离目录 + fixture 声明表，跑完自动清理（测试产物零污染）。 */
function withRegistry<T>(
  guards: { id: string; sources: string[] }[],
  run: (registry: string) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), "red-line-registry-"));
  try {
    return run(writeRegistry(dir, guards));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 取 CI 的 job 块：从 job 头到下一个顶格 job 键为止（与 workflow-assert 同款口径）。 */
function jobBlock(text: string, job: string) {
  const start = text.indexOf(`\n  ${job}:`);
  assert.ok(start !== -1, `ci.yml 必须存在 ${job} job`);
  const rest = text.slice(start + 1);
  const end = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

// ─────────────────────────── 一、红线面（派生） ───────────────────────────

test("红线面：由 fixture 声明表派生——每个 guard 的 sources ∪ .github/** ∪ 声明表自身", () => {
  withRegistry(
    [
      {
        id: "coverage.thresholds",
        sources: ["scripts/data/coverage.config.json", "vitest.config.ts"],
      },
      { id: "mutation.strict", sources: ["scripts/data/gauntlet.config.json"] },
    ],
    (registry) => {
      // 与实现比对的是**字面期望**，不是从 redLinePatterns 派生的副本——后者会让"把红线面删空"
      // 这类改动自证通过。三个来源各有一条：基座 `.github/**`、sources 里的每个路径（含不在
      // scripts/data 下的 vitest.config.ts）、声明表自身（fixture 在 /tmp，自指项按规范路径入面）。
      assert.deepEqual(
        redLinePatterns(registry, () => {}),
        [
          ".github/**",
          "scripts/data/coverage.config.json",
          "scripts/data/gauntlet.config.json",
          "scripts/data/threshold-registry.json",
          "vitest.config.ts",
        ],
      );
    },
  );
});

test("红线面：规范化——./ 前缀归一、跨 guard 重复只算一条、排序稳定", () => {
  withRegistry(
    [
      {
        id: "a",
        sources: ["./scripts/data/gauntlet.config.json", "scripts/data/coverage.config.json"],
      },
      {
        id: "b",
        sources: ["scripts/data/gauntlet.config.json", "./scripts/data/coverage.config.json"],
      },
    ],
    (registry) => {
      // 4 条声明里有 2 组重复、2 条带 `./`：去掉去重会多出 2 条、去掉 `./` 归一会多出两条
      // `./scripts/…`——两种实现缺陷都被这份字面清单同时钉住。
      assert.deepEqual(
        redLinePatterns(registry, () => {}),
        [
          ".github/**",
          "scripts/data/coverage.config.json",
          "scripts/data/gauntlet.config.json",
          "scripts/data/threshold-registry.json",
        ],
      );
    },
  );
});

test("红线面：只收 guards[].sources——notAGate 的登记面不进面（红线定义不得悄悄扩大）", () => {
  const dir = mkdtempSync(join(tmpdir(), "red-line-notagate-"));
  try {
    const path = join(dir, "threshold-registry.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        guards: [{ id: "mutation.strict", sources: ["scripts/data/gauntlet.config.json"] }],
        notAGate: [
          { source: "scripts/data/ci-face-registry.json", why: "登记面，不是可放宽的阈值" },
        ],
      }),
    );
    // notAGate 是显式声明"不是可放宽的阈值"的登记面；把它一并拉进红线面，等于把红线定义扩大到
    // 第二类登记面——与撤回 scripts/gate/** 的同一条理由。这条钉住边界，扩面必须重新裁决。
    assert.deepEqual(
      redLinePatterns(path, () => {}),
      [".github/**", "scripts/data/gauntlet.config.json", "scripts/data/threshold-registry.json"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("红线面：声明表缺失 → 退化为仅 .github/** + ::warning::，不崩（#850 合入前 CI 也要能跑）", () => {
  const dir = mkdtempSync(join(tmpdir(), "red-line-missing-"));
  try {
    const missing = join(dir, "absent-registry.json");
    const warnings: string[] = [];
    const face = redLinePatterns(missing, (m) => warnings.push(m));
    assert.deepEqual(face, [".github/**"]);
    assert.equal(warnings.length, 1, "退化必须留痕，且只留一条");
    assert.match(warnings[0], /^::warning::/);
    assert.match(warnings[0], /声明表不可用/);
    assert.match(warnings[0], /absent-registry\.json/, "告警必须点名是哪份表不可用");
    // 退化面同时满足两件事：仍拦得住基座红线、不再拦数据文件。只断言其一的话，"退化成空面"
    // 或"根本没退化"都能蒙混过关。
    assert.equal(
      judgeRedLine({ changedFiles: [".github/workflows/ci.yml"], labels: [], patterns: face }).ok,
      false,
    );
    assert.deepEqual(
      judgeRedLine({
        changedFiles: ["scripts/data/gauntlet.config.json"],
        labels: [],
        patterns: face,
      }),
      { ok: true, violations: [] },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("红线面：声明表存在但不可用 → 同样退化 + 报警，且告警点名具体原因（不与表不存在含混）", () => {
  // 本条钉的是**已声明的边界**而不是"正确"：同一份表的 fail-closed 由 #850 的
  // threshold-monotonic（解析失败即 exit 2）承担，本判据再兜一层只会给所有 PR 加第二个断线通道。
  // 如实断言退化行为，是为了让它将来即便被改成 fail-closed 也要过一次复审，而不是悄悄换语义。
  const dir = mkdtempSync(join(tmpdir(), "red-line-broken-"));
  try {
    const cases = [
      { name: "broken.json", body: '{ "guards": [ ', why: /JSON 不可解析/ },
      { name: "noguards.json", body: '{"version":1}', why: /缺少 guards 数组/ },
      {
        name: "badsources.json",
        body: '{"guards":[{"id":"x","sources":"a.json"}]}',
        why: /sources 不是数组/,
      },
    ];
    const messages: string[] = [];
    for (const c of cases) {
      const path = join(dir, c.name);
      writeFileSync(path, c.body);
      const warnings: string[] = [];
      assert.deepEqual(
        redLinePatterns(path, (m) => warnings.push(m)),
        [".github/**"],
        c.name,
      );
      assert.match(warnings[0], c.why, `${c.name} 的告警必须点名原因`);
      messages.push(warnings[0]);
    }
    // 三种"存在但不可用"的告警互不相同，也不等于"表不存在"那条——否则读者从告警里分不出
    // 该等 #850 还是该修数据。
    assert.equal(new Set(messages).size, cases.length);
    const absent: string[] = [];
    redLinePatterns(join(dir, "nope.json"), (m) => absent.push(m));
    assert.ok(!messages.includes(absent[0]));
    assert.match(absent[0], /读取失败（ENOENT）/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回归锚：scripts/gate/** 不在面内——把它当加固面加回去必须被这条打红（#851 裁决）", () => {
  // 上一版把 scripts/gate/** 钉进常量，是自行扩大 AGENTS.md 的红线定义（清单里没有它），且在
  // GitHub 侧没有 approved 留痕。这条是那次裁决的回归锚。
  assert.ok(
    RED_LINE_PATTERNS.every((pattern) => !pattern.startsWith("scripts/gate")),
    `派生面不得含 scripts/gate/**（实际 ${RED_LINE_PATTERNS.join(", ")}）`,
  );
  assert.deepEqual(judgeRedLine({ changedFiles: ["scripts/gate/xxx.mjs"], labels: [] }), {
    ok: true,
    violations: [],
  });
  withRegistry(
    [{ id: "mutation.strict", sources: ["scripts/data/gauntlet.config.json"] }],
    (registry) => {
      const face = redLinePatterns(registry, () => {});
      assert.deepEqual(
        judgeRedLine({ changedFiles: ["scripts/gate/local-gate.mjs"], labels: [], patterns: face }),
        {
          ok: true,
          violations: [],
        },
      );
      // 非空洞性：同一条判据对基座面与声明源都判红，否则上面"不判红"可能只是因为面是空的
      assert.equal(
        judgeRedLine({ changedFiles: [".github/workflows/ci.yml"], labels: [], patterns: face }).ok,
        false,
      );
      assert.equal(
        judgeRedLine({
          changedFiles: ["scripts/data/gauntlet.config.json"],
          labels: [],
          patterns: face,
        }).ok,
        false,
      );
    },
  );
});

test("红线面：RED_LINE_PATTERNS 就是默认声明表的派生面，默认表路径即规范路径", () => {
  assert.equal(
    normalize(DEFAULT_REGISTRY_PATH),
    join(ROOT, REGISTRY_REL_PATH),
    "默认声明表必须指向仓库里的规范路径（写错路径会静默退化成仅 .github/**）",
  );
  // 与 import 期算出的常量比对：把默认面改成静态常量、或让它不再读默认表，这条会红。
  assert.deepEqual([...RED_LINE_PATTERNS], [...redLinePatterns(DEFAULT_REGISTRY_PATH, () => {})]);
});

// ─────────────────────────── 二、纯函数判据 ───────────────────────────

test("判据①：命中红线且无 approved → 判红，且逐条点名命中文件", () => {
  const r = judgeRedLine({ changedFiles: [".github/workflows/ci.yml"], labels: [] });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0], /\.github\/workflows\/ci\.yml/);
  assert.match(r.violations[0], /approved/);
});

test("判据①：被声明为事实源的数据文件无 approved → 判红，多文件命中逐条落违规", () => {
  withRegistry(
    [
      {
        id: "coverage.thresholds",
        sources: ["scripts/data/coverage.config.json", "vitest.config.ts"],
      },
    ],
    (registry) => {
      const r = judgeRedLine({
        changedFiles: ["scripts/data/coverage.config.json", "vitest.config.ts"],
        labels: ["ci"],
        patterns: redLinePatterns(registry, () => {}),
      });
      assert.equal(r.ok, false);
      assert.equal(r.violations.length, 2);
      assert.match(r.violations[0], /scripts\/data\/coverage\.config\.json/);
    },
  );
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
    changedFiles: [".github/workflows/ci.yml", ".github/workflows/observe.yml"],
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

test("#843 P-2：--status-file 落三态（scored / failed / crashed + exitCode），且不影响判分结论", () => {
  // 这个状态文件是 job 内部退出码离开 job 的唯一通道：ci.yml 据此产出 failureClass →
  // GATE_FAILURE_CLASS（exit 1 = 判红可信、exit 2 = 门禁故障）。三态必须逐字可辨，
  // 否则聚合闸又会把「门禁自己坏了」读成「判决已生效」。
  const dir = mkdtempSync(join(tmpdir(), "red-line-status-"));
  const withStatus = (args: string[], name: string) => {
    const p = join(dir, name);
    const r = runCli([...args, "--status-file", p]);
    return { r, status: existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null };
  };
  try {
    const ok = withStatus(
      ["--files", "packages/dsh-notifier/src/index.ts", "--labels", ""],
      "ok.json",
    );
    assert.equal(ok.r.status, 0, ok.r.stderr);
    assert.deepEqual(ok.status, { status: "scored", exitCode: 0 });
    const failed = withStatus(
      ["--files", ".github/workflows/ci.yml", "--labels", ""],
      "failed.json",
    );
    assert.equal(failed.r.status, 1, failed.r.stderr);
    assert.deepEqual(failed.status, { status: "failed", exitCode: 1 });
    const crashed = withStatus(
      ["--files-json", join(dir, "缺失.json"), "--labels-json", join(dir, "缺失.json")],
      "crashed.json",
    );
    assert.equal(crashed.r.status, 2, crashed.r.stderr);
    assert.deepEqual(crashed.status, { status: "crashed", exitCode: 2 });
    // 参数解析就失败（连判据都没跑到）：started 占位已先落，收尾仍是 crashed——
    // 「脚本崩了」不得伪装成「判据判红」。
    const argFail = withStatus([], "argfail.json");
    assert.equal(argFail.r.status, 2, argFail.r.stderr);
    assert.deepEqual(argFail.status, { status: "crashed", exitCode: 2 });
    // 诊断面是可选的：不给 --status-file 时不得在 cwd 里造出任何文件
    const noStatus = runCli(["--files", "docs/a.md", "--labels", ""]);
    assert.equal(noStatus.status, 0, noStatus.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    {
      args: ["--files", "a.md", "--patterns", "docs/**", "--registry", "x.json"],
      why: "红线面的两种来源同时给出（取哪一种都是猜）",
    },
  ];
  for (const { args, why } of cases) {
    const r = runCli(args);
    assert.equal(r.status, 2, `${why} 必须 exit 2（实际 ${r.status}）：${r.stderr}`);
    assert.match(
      r.stderr,
      /^::error::门禁故障（非判据结论）：red-line-approval:/m,
      `${why} 必须带统一故障注解`,
    );
    assert.equal(r.stdout, "", `${why} 不得污染 stdout`);
  }
});

test("CLI fail-closed：输入不可解析 → exit 2 且统一故障注解", () => {
  const dir = mkdtempSync(join(tmpdir(), "red-line-unparse-"));
  try {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    const r = runCli(["--files-json", bad]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^::error::门禁故障（非判据结论）：red-line-approval: 输入不可解析/m);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI fail-closed：同一次调用里 --files 重复给出 → exit 2（不取最后一次）", () => {
  const r = runCli(["--files", "a.md", "--files", ".github/workflows/ci.yml"]);
  assert.equal(r.status, 2, r.stderr);
});

test("CLI：--flag=value 形态与逗号分隔的空项都被容忍", () => {
  const ok = runCli(["--files=docs/a.md,docs/b.md,", "--labels=none,"]);
  assert.equal(ok.status, 0, ok.stderr);
  const red = runCli(["--files=.github/workflows/ci.yml,", "--labels="]);
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
    writeFileSync(filesJson, JSON.stringify([".github/workflows/ci.yml"]));
    const r = runCli(["--files", `@${filesJson}`, "--labels", ""]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /\.github\/workflows\/ci\.yml/);
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

test("CLI：--registry 用 fixture 声明表派生面——声明源判红、approved 放行、scripts/gate 不进面", () => {
  withRegistry(
    [{ id: "mutation.strict", sources: ["scripts/data/gauntlet.config.json"] }],
    (registry) => {
      const red = runCli([
        "--files",
        "scripts/data/gauntlet.config.json",
        "--labels",
        "",
        "--registry",
        registry,
      ]);
      assert.equal(red.status, 1, red.stderr);
      assert.match(red.stderr, /scripts\/data\/gauntlet\.config\.json/);
      // 放行侧：否则"一律判红"也能满足上面那条
      const ok = runCli([
        "--files",
        "scripts/data/gauntlet.config.json",
        "--labels",
        "approved",
        "--registry",
        registry,
      ]);
      assert.equal(ok.status, 0, ok.stderr);
      // 面确实来自这份 fixture（而不是默认面）：同一次调用里 scripts/gate/** 不在面内
      const gate = runCli([
        "--files",
        "scripts/gate/local-gate.mjs",
        "--labels",
        "",
        "--registry",
        registry,
      ]);
      assert.equal(gate.status, 0, gate.stderr);
      assert.match(
        gate.stdout,
        /红线面\[\.github\/\*\*, scripts\/data\/gauntlet\.config\.json, scripts\/data\/threshold-registry\.json\]/,
        "OK 行必须打印实际判的那一面",
      );
    },
  );
});

test("CLI：--registry 指向缺失的声明表 → 退化放行但必须打 ::warning::（不 fail-closed，也不静默）", () => {
  const dir = mkdtempSync(join(tmpdir(), "red-line-noreg-"));
  try {
    const missing = join(dir, "absent.json");
    const r = runCli([
      "--files",
      "scripts/data/gauntlet.config.json",
      "--labels",
      "",
      "--registry",
      missing,
    ]);
    // 退化为仅 .github/**：数据文件不再进面 → 放行；但必须在 stderr 留痕，且 OK 行如实打印退化后的面
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /::warning::/);
    assert.match(r.stderr, /声明表不可用/);
    assert.match(r.stderr, /absent\.json/);
    assert.match(r.stdout, /红线面\[\.github\/\*\*\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：给了 --registry / --patterns 就不再碰默认声明表——不得打出与实际面不符的退化告警", () => {
  // 默认面在 import 期是**静默**派生的（judgeRedLine 的默认值必须无副作用）；退化为基座面的告警
  // 只在本次真的用到默认面时补出（评审 ②）。否则「本次用的是注入的表」的运行里会多出一条
  // 「退化为 .github/**……本次无额外文件进面」，与实际判定的面矛盾。
  withRegistry(
    [{ id: "mutation.strict", sources: ["scripts/data/gauntlet.config.json"] }],
    (registry) => {
      const injected = runCli(["--files", "docs/a.md", "--labels", "", "--registry", registry]);
      assert.equal(injected.status, 0, injected.stderr);
      assert.ok(
        !injected.stderr.includes("::warning::"),
        `注入声明表时不得告警默认表（实际 stderr：${injected.stderr}）`,
      );
    },
  );
  // 取值刻意让面**不命中** docs/a.md：本条要证的是「注入面时不告警默认表」，不是判红
  const explicit = runCli(["--files", "docs/a.md", "--labels", "", "--patterns", ".github/**"]);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.ok(
    !explicit.stderr.includes("::warning::"),
    `--patterns 时不得告警默认表：${explicit.stderr}`,
  );
  // 反向：真的用默认面时，告警必须与默认表的可用性一致（本分支表缺失 → 恰好一条；#850 合入后 → 无）。
  // 这一条把「惰性」与「静默」区分开——只把告警删掉、默认面退化时不再报警，同样会红。
  const captured: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => captured.push(String(message));
  let parsed: { ok: boolean; patterns?: string[] };
  try {
    parsed = parseArgs(["--files", "docs/a.md"]) as { ok: boolean; patterns?: string[] };
  } finally {
    console.warn = original;
  }
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.patterns, [...RED_LINE_PATTERNS]);
  assert.equal(
    captured.length,
    existsSync(DEFAULT_REGISTRY_PATH) ? 0 : 1,
    "用默认面时：默认表不可用必须恰好告警一条，可用则不得告警",
  );
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
  // main([]) 不再直调断言：失败出口已改 failClosed（直调会把测试进程一起 exit 掉），
  // exit 2 面由下面 CLI 用例覆盖（与 CLI 退出码同源）。
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
  // 面必须由声明表派生：job 自带 --patterns 等于把面在 workflow 里钉死，#850 的声明表就白派生了
  assert.ok(!block.includes("--patterns"), "job 不得自带 --patterns（面只能来自声明表派生）");
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
