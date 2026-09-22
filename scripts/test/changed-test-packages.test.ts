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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  diffTestPaths,
  packageOfTestPath,
  packagesToInvalidate,
  parseTestDiffPaths,
  segmentEntryFor,
  testFileEntries,
  findDirectConsumers,
  isExemptTestFile,
  supportFileEntries,
} from "../ci/changed-test-packages.mjs";
import { projectTestSurface } from "../gate/test-surface.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts/ci/changed-test-packages.mjs");

test("#742 1.7 + P1-D1: packageOfTestPath 不认 e2e/client 层（永不进变异面）", () => {
  assert.equal(
    packageOfTestPath("packages/dsh-notifier/test/e2e/smoke.test.ts"),
    null,
    "e2e 层不进变异面，不得触发失基线",
  );
  assert.equal(
    packageOfTestPath("packages/dsh-notifier/test/client/a.test.ts"),
    null,
    "client 层不进变异面，不得触发失基线",
  );
  assert.equal(packageOfTestPath("packages/dsh-notifier/test/helpers.ts"), "dsh-notifier");
  assert.equal(
    packageOfTestPath("packages/dsh-notifier/test/client-unit/a.test.ts"),
    "dsh-notifier",
    "client-unit 是变异层，仍触发",
  );
  assert.equal(
    packageOfTestPath("packages/dsh-notifier/test/client-dom/a.test.ts"),
    "dsh-notifier",
    "client-dom 是变异层，仍触发",
  );
  assert.equal(packageOfTestPath("packages/dsh-notifier/src/index.ts"), null);
  assert.equal(packageOfTestPath("test/smoke-lib.ts"), null, "根级 test/ 不属于任何包");
  assert.equal(packageOfTestPath("packages/dsh-notifier/test"), null, "目录本身不算变更文件");
  assert.equal(
    packageOfTestPath("packages/dsh-notifier/testing/a.ts"),
    null,
    "前缀相似不等于 face",
  );
});

test("#742 1.7 + P1-D1: parseTestDiffPaths 去重升序，忽略空段与排除层", () => {
  const z = [
    "packages/dsh-notifier/test/a.test.ts",
    "packages/dsh-lan-proxy/test/e2e/smoke.test.ts",
    "packages/dsh-lan-proxy/test/client/a.test.ts",
    "packages/dsh-notifier/test/b.test.ts",
    "packages/dsh-notifier/src/index.ts",
    "shared/util.ts",
    "",
  ].join("\0");
  assert.deepEqual(parseTestDiffPaths(z), ["dsh-notifier"], "e2e/client 不得触发");
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
  // P1-D2：单段配置变更只发射 包:段（下游仅该段失基线），不再连坐整包
  assert.deepEqual(
    packagesToInvalidate(["stryker.conf.d/dsh-provider-usage-report-execute.json"], reg),
    ["dsh-provider-usage:report-execute"],
  );
  assert.deepEqual(packagesToInvalidate(["stryker.conf.d/dsh-notifier-pipeline.json"], reg), [
    "dsh-notifier:pipeline",
  ]);
  // e2e / client 测试变更不触发（D1），unit 仍触发
  assert.deepEqual(packagesToInvalidate(["packages/dsh-notifier/test/e2e/smoke.test.ts"], reg), []);
  assert.deepEqual(packagesToInvalidate(["packages/dsh-notifier/test/client/a.test.ts"], reg), []);
  assert.deepEqual(packagesToInvalidate(["packages/dsh-notifier/test/unit/a.test.ts"], reg), [
    "dsh-notifier",
  ]);
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

test("P1-D2: segmentEntryFor 只认段级 conf，非段路径一律回落整包（null）", () => {
  assert.equal(
    segmentEntryFor("stryker.conf.d/dsh-notifier-pipeline.json", "dsh-notifier"),
    "dsh-notifier:pipeline",
  );
  assert.equal(
    segmentEntryFor("stryker.conf.d/dsh-notifier.json", "dsh-notifier"),
    null,
    "包级 conf 仍整包失效",
  );
  assert.equal(
    segmentEntryFor("vitest.stryker.d/dsh-notifier.config.ts", "dsh-notifier"),
    null,
    "包级测试面配置仍整包失效",
  );
  assert.equal(segmentEntryFor("test/smoke-lib.ts", "dsh-notifier"), null);
  assert.equal(
    segmentEntryFor("stryker.conf.d/dsh-notifier-a:b.json", "dsh-notifier"),
    null,
    "含冒号段名 fail-closed 回整包",
  );
  assert.equal(
    segmentEntryFor("stryker.conf.d/other-pkg-x.json", "dsh-notifier"),
    null,
    "前缀不匹配回整包",
  );
  assert.equal(
    segmentEntryFor("vitest.stryker.d/dsh-notifier-pipeline.config.ts", "dsh-notifier"),
    "dsh-notifier:pipeline",
    "段级 vitest 配置只失效该段",
  );
  assert.equal(
    segmentEntryFor("vitest.stryker.d/dsh-notifier.config.ts", "dsh-notifier"),
    null,
    "包级 vitest 配置仍整包失效",
  );
});

test("P2c: 其余包段条目映射", () => {
  const reg = JSON.parse(readFileSync(join(ROOT, "scripts/data/ci-face-registry.json"), "utf8"));
  const topo = JSON.parse(readFileSync(join(ROOT, "scripts/data/mutation-topology.json"), "utf8"));
  assert.deepEqual(
    packagesToInvalidate(["stryker.conf.d/dsh-provider-usage-pipeline.json"], reg, topo),
    ["dsh-provider-usage:pipeline"],
  );
  assert.deepEqual(
    packagesToInvalidate(["vitest.stryker.d/dsh-lan-proxy-tls.config.ts"], reg, topo),
    ["dsh-lan-proxy:tls"],
  );
  const jevClient = "packages/dsh-jev-decide/test/client-unit/format.test.ts";
  const got = packagesToInvalidate([jevClient], reg, topo);
  assert.ok(got.includes("dsh-jev-decide:client"), "client 测试须命中 client 段");
  assert.ok(!got.includes("dsh-jev-decide"), "不得连坐整包");
  assert.deepEqual(
    packagesToInvalidate(["packages/dsh-worktree-sidebar/test/unit/tools.test.ts"], reg, topo),
    ["dsh-worktree-sidebar"],
  );
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

test("P2-L4: 测试文件按 topology testFiles 映射到段（回落/显式/未认领/缺字段）", () => {
  const reg = JSON.parse(readFileSync(join(ROOT, "scripts/data/ci-face-registry.json"), "utf8"));
  const topo = JSON.parse(readFileSync(join(ROOT, "scripts/data/mutation-topology.json"), "utf8"));
  const face = projectTestSurface(ROOT, topo, "dsh-notifier").testFiles;
  assert.ok(face.length > 1, "notifier 变异面须有至少 2 个文件才可做映射断言");
  const [fa, fb] = face;
  // P2c 起 notifier 已显式窄化：apply-lifecycle 横跨 channels/client（跨段杀灭的合法重叠）
  assert.deepEqual(packagesToInvalidate([fa], reg, topo), [
    "dsh-notifier:channels",
    "dsh-notifier:client",
  ]);
  // 合成窄化：一显式一回落，改文件只发射命中段
  const narrow = structuredClone(topo);
  narrow.packages["dsh-notifier"].segments = {
    segA: { testFiles: [fa], mutate: [], excludes: [] },
    segB: { testFiles: [fb], mutate: [], excludes: [] },
    segC: { testFiles: "*", mutate: [], excludes: [] },
  };
  assert.deepEqual(packagesToInvalidate([fa], reg, narrow), [
    "dsh-notifier:segA",
    "dsh-notifier:segC",
  ]);
  assert.deepEqual(packagesToInvalidate([fb], reg, narrow), [
    "dsh-notifier:segB",
    "dsh-notifier:segC",
  ]);
  // 未认领（面内文件无段登记）：整包 fail-closed
  const gap = structuredClone(topo);
  gap.packages["dsh-notifier"].segments = {
    segA: { testFiles: [fa], mutate: [], excludes: [] },
  };
  assert.deepEqual(packagesToInvalidate([fb], reg, gap), ["dsh-notifier"]);
  // 缺字段段：整包 fail-closed（形状错时不静默窄化）
  const missing = structuredClone(topo);
  missing.packages["dsh-notifier"].segments = {
    segA: { testFiles: [fa], mutate: [], excludes: [] },
    segB: { mutate: [], excludes: [] },
  };
  assert.deepEqual(packagesToInvalidate([fa], reg, missing), ["dsh-notifier"]);
  // 无 topology：旧行为（整包）
  assert.deepEqual(packagesToInvalidate([fa], reg), ["dsh-notifier"]);
  // testFileEntries 直调：包外形状
  assert.deepEqual(testFileEntries(null, ROOT, new Map(), "dsh-notifier", fa), ["dsh-notifier"]);
});

test("D: 双 worker allowlist 锚 + 各 1 消费者全在豁免层 + 不失效", () => {
  const reg = JSON.parse(readFileSync(join(ROOT, "scripts/data/ci-face-registry.json"), "utf8"));
  const topo = JSON.parse(readFileSync(join(ROOT, "scripts/data/mutation-topology.json"), "utf8"));
  const pkg = "dsh-provider-usage";
  const testDir = join(ROOT, "packages", pkg, "test");
  const workers = readdirSync(testDir)
    .filter((f) => f.endsWith(".worker.mjs"))
    .sort();
  assert.deepEqual(workers, ["client-fetch-timeout.worker.mjs", "client-revalidate.worker.mjs"]);
  const w1 = "packages/dsh-provider-usage/test/client-fetch-timeout.worker.mjs";
  const w2 = "packages/dsh-provider-usage/test/client-revalidate.worker.mjs";
  const c1 = findDirectConsumers(ROOT, pkg, w1);
  const c2 = findDirectConsumers(ROOT, pkg, w2);
  assert.deepEqual(c1, ["packages/dsh-provider-usage/test/client/unit-fetch-timeout.test.ts"]);
  assert.deepEqual(c2, ["packages/dsh-provider-usage/test/client/unit-refresh-revalidate.test.ts"]);
  for (const c of [...c1, ...c2]) {
    assert.equal(isExemptTestFile(c, pkg), true, c + " 须在豁免层");
  }
  const surf = projectTestSurface(ROOT, topo, pkg);
  assert.equal(surf.testFiles.includes(w1), false, "worker 不得进变异面");
  assert.equal(surf.testFiles.includes(w2), false, "worker 不得进变异面");
  assert.deepEqual(
    (surf.layerFiles as Record<string, unknown>)["client-unit"],
    [],
    "本包无 client-unit 文件",
  );
  assert.deepEqual(
    (surf.layerFiles as Record<string, unknown>)["client-dom"],
    [],
    "本包无 client-dom 文件",
  );
  assert.deepEqual(packagesToInvalidate([w1], reg, topo), [], "豁免层独占消费者：不失效");
  assert.deepEqual(packagesToInvalidate([w2], reg, topo), [], "豁免层独占消费者：不失效");
  assert.deepEqual(packagesToInvalidate([w1, w2], reg, topo), [], "双 worker 同改亦不失效");
  const helpersPath = "packages/dsh-provider-usage/test/helpers.ts";
  assert.equal(c1.includes(helpersPath), false, "helpers 不得是 worker 消费者");
  assert.equal(c2.includes(helpersPath), false, "helpers 不得是 worker 消费者");
  const hDirects = findDirectConsumers(ROOT, pkg, helpersPath);
  assert.equal(hDirects.includes(w1), false, "worker 不得是 helpers 消费者");
  assert.equal(hDirects.includes(w2), false, "worker 不得是 helpers 消费者");
});

test("D: helpers 反向断言 + 命中窄化/全段回落 + 未命中复用", () => {
  const reg = JSON.parse(readFileSync(join(ROOT, "scripts/data/ci-face-registry.json"), "utf8"));
  const topo = JSON.parse(readFileSync(join(ROOT, "scripts/data/mutation-topology.json"), "utf8"));
  const pkg = "dsh-provider-usage";
  const helpersPath = "packages/dsh-provider-usage/test/helpers.ts";
  const hDirects = findDirectConsumers(ROOT, pkg, helpersPath);
  assert.ok(hDirects.length >= 10, "helpers 须有变异面消费者");
  assert.ok(hDirects.includes("packages/dsh-provider-usage/test/unit/apply/unit-apply.test.ts"));
  assert.ok(
    hDirects.includes(
      "packages/dsh-provider-usage/test/integration/pipeline/composition-root.test.ts",
    ),
  );
  assert.ok(
    hDirects.includes("packages/dsh-provider-usage/test/smoke-pure.ts"),
    "经 support 中转的 e2e 链须被闭包发现",
  );
  assert.equal(
    hDirects.includes("packages/dsh-provider-usage/test/client/unit-report-p0.test.ts"),
    false,
    "report-helpers 不得误计为 test/helpers 消费者",
  );
  const surf = projectTestSurface(ROOT, topo, pkg);
  const inFace = hDirects.filter((f) => surf.testFiles.includes(f));
  const exempt = hDirects.filter((f) => isExemptTestFile(f, pkg));
  assert.ok(inFace.length > 0, "helpers 闭包须交变异面");
  assert.ok(exempt.length > 0, "helpers 亦有豁免层消费者");
  assert.deepEqual(
    packagesToInvalidate([helpersPath], reg, topo),
    ["dsh-provider-usage"],
    "helpers 并集覆盖全段：等价回落整包",
  );
  const probe = "packages/dsh-provider-usage/test/hotreload-probe.mjs";
  assert.deepEqual(findDirectConsumers(ROOT, pkg, probe), [
    "packages/dsh-provider-usage/test/unit/shared/unit-contract.test.ts",
  ]);
  assert.deepEqual(
    packagesToInvalidate([probe], reg, topo),
    [
      "dsh-provider-usage:contracts",
      "dsh-provider-usage:entry",
      "dsh-provider-usage:pipeline",
      "dsh-provider-usage:registry",
      "dsh-provider-usage:sanitize",
    ],
    "仅闭包命中段失效",
  );
  const pure = "packages/dsh-provider-usage/test/smoke-pure.ts";
  assert.deepEqual(findDirectConsumers(ROOT, pkg, pure), [
    "packages/dsh-provider-usage/test/e2e/smoke.test.ts",
  ]);
  assert.deepEqual(packagesToInvalidate([pure], reg, topo), [], "豁免层独占：不失效");
  const w1 = "packages/dsh-provider-usage/test/client-fetch-timeout.worker.mjs";
  assert.deepEqual(
    packagesToInvalidate([w1, probe], reg, topo),
    [
      "dsh-provider-usage:contracts",
      "dsh-provider-usage:entry",
      "dsh-provider-usage:pipeline",
      "dsh-provider-usage:registry",
      "dsh-provider-usage:sanitize",
    ],
    "worker 叠加不扩散",
  );
});

test("D: 解析失败回整包 + 混合 diff 工人不扩散", () => {
  const reg = JSON.parse(readFileSync(join(ROOT, "scripts/data/ci-face-registry.json"), "utf8"));
  const topo = JSON.parse(readFileSync(join(ROOT, "scripts/data/mutation-topology.json"), "utf8"));
  const pkg = "dsh-provider-usage";
  const w1 = "packages/dsh-provider-usage/test/client-fetch-timeout.worker.mjs";
  const w2 = "packages/dsh-provider-usage/test/client-revalidate.worker.mjs";
  assert.deepEqual(
    testFileEntries(topo, ROOT, new Map(), pkg, "packages/dsh-provider-usage/test/__orphan__.mjs"),
    [pkg],
    "孤儿支撑 fail-closed",
  );
  assert.deepEqual(
    testFileEntries(topo, "/no/such/root-962d", new Map(), pkg, w1),
    [pkg],
    "根不可读 fail-closed",
  );
  assert.deepEqual(
    supportFileEntries(topo, "/no/such/root-962d", new Map(), pkg, w1, []),
    [pkg],
    "闭包直调 fail-closed",
  );
  assert.equal(isExemptTestFile("packages/dsh-provider-usage/test/client/a.test.ts", pkg), true);
  assert.equal(isExemptTestFile("packages/dsh-provider-usage/test/e2e/a.test.ts", pkg), true);
  assert.equal(isExemptTestFile("packages/dsh-provider-usage/test/unit/a.test.ts", pkg), false);
  assert.equal(isExemptTestFile("packages/dsh-provider-usage/test/helpers.ts", pkg), false);
  const unit = "packages/dsh-provider-usage/test/unit/apply/unit-apply.test.ts";
  const onlyUnit = packagesToInvalidate([unit], reg, topo);
  assert.ok(onlyUnit.length > 0);
  assert.deepEqual(packagesToInvalidate([w1, w2, unit], reg, topo), onlyUnit, "worker 不扩散");
  const lanUnit = "packages/dsh-lan-proxy/test/unit/unit-apply.test.ts";
  const lanOnly = packagesToInvalidate([lanUnit], reg, topo);
  assert.deepEqual(packagesToInvalidate([w1, lanUnit], reg, topo), lanOnly, "跨包不扩散");
});
