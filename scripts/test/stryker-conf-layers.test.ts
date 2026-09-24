"use strict";

/**
 * 变异面登记完整性门禁回归（#690 S2b / #713 T3）。
 *
 * 为什么在临时 fixture 根里跑：`--check` 的判据是「拓扑声明 ↔ 磁盘实际」的派生一致性，
 * 在仓库内造包目录会违反产物零污染纪律（#218）。故用 GEN_STRYKER_ROOT 注入 mkdtemp 根，
 * 与 verify-dir-imports-s0.test.ts 的 fixture 形态一致。
 *
 * 覆盖的判据（每条都有反向用例，防「门禁写得像门禁」）：
 *   ① 单元层文件自动进变异面（新增 test/unit/ 文件零手工步骤）
 *   ② runner 面文件必须落入某一层 glob 或某条逐条豁免（无层归属 → 判红）
 *   ③ 豁免必须带理由且真实存在于 unit 层
 *   ④ `--min` == runner glob 实际文件数（脱节 → 判红；--sync-test-min 可同步）
 *   ⑤ 从派生 conf 删掉一条登记条目 → 判红
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { MUTATION_FACE_GATE } from "../gate/mutation-topology.mjs";
import { projectTestSurface } from "../gate/test-surface.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const GENERATOR = join(ROOT, "scripts", "gate", "gen-stryker-conf.mjs");
const PKG = "fixture-pkg";

/** fixture 拓扑宽形态：各用例按需增删段/层/元键乃至非法值（fail-closed 反例），窄字面量类型承接不了，
 * 故声明一次宽形态；形状合法性本身由门禁实现断言，测试侧不断言类型。 */
interface FixtureSegment {
  mutate: string[];
  excludes: string[];
  testFiles?: string;
  [key: string]: unknown;
}
interface FixturePackage {
  testLayers?: unknown;
  segments: Record<string, FixtureSegment>;
  enableMutations?: unknown;
  [key: string]: unknown;
}
interface FixtureTopology {
  $testLayers: {
    layers: Record<string, string>;
    mutationLayers: string[];
    mutationExcludeLayers: string[];
  };
  sharedDefaults: Record<string, unknown>;
  packages: Record<string, FixturePackage>;
  $noMutationPackages?: Record<string, string>;
  [key: string]: unknown;
}
const TOPOLOGY: FixtureTopology = {
  $testLayers: {
    layers: {
      unit: "test/unit/**/*.test.ts",
      integration: "test/integration/**/*.test.ts",
      client: "test/client/**/*.test.ts",
      e2e: "test/e2e/**/*.test.ts",
    },
    mutationLayers: ["unit", "integration"],
    mutationExcludeLayers: ["client", "e2e"],
  },
  sharedDefaults: {
    testRunner: "vitest",
    concurrency: 16,
    timeoutMS: 60000,
    dryRunTimeoutMinutes: 5,
    reporters: ["progress"],
    coverageAnalysis: "perTest",
    tempDirName: ".stryker-tmp",
    cleanTempDir: true,
    excludedMutations: [],
    vitest: { related: false },
  },
  packages: {
    [PKG]: {
      testLayers: {},
      segments: {
        only: {
          mutate: [`packages/${PKG}/src/**/*.ts`],
          excludes: [`!packages/${PKG}/src/client/**`],
          testFiles: "*",
        },
      },
    },
  },
};

const BASE_FILES = {
  [`packages/${PKG}/src/index.ts`]: "export const a = 1\n",
  [`packages/${PKG}/src/client/ui.ts`]: "export const b = 2\n",
  [`packages/${PKG}/test/unit/unit-a.test.ts`]: 'import "../../src/index.ts"\n',
  [`packages/${PKG}/test/unit/unit-b.test.ts`]: 'import "../../src/index.ts"\n',
  [`packages/${PKG}/test/unit/unit-d.test.ts`]: 'import "../../src/index.ts"\n',
  [`packages/${PKG}/test/integration/flow.test.ts`]: 'import "../../src/index.ts"\n',
  [`packages/${PKG}/test/client/client-a.test.ts`]: 'import "../../src/client/ui.ts"\n',
  [`packages/${PKG}/test/e2e/smoke.test.ts`]: 'import "../../src/index.ts"\n',
  [`packages/${PKG}/test/helpers.ts`]: "export const h = 1\n",
  [`packages/${PKG}/package.json`]: `${JSON.stringify({ name: PKG, scripts: { test: "node ../../scripts/test/run-vitest.mjs --min 6" } }, null, 2)}\n`,
};

/**
 * 把 fixture 当前内容提交成基准 commit。
 *
 * #843 计划项 3-1 起 `--check` 的判据⑦ 要读**基准 ref 上的拓扑**，故 fixture 必须是个真 git
 * 仓库：基准 = 建 fixture 时提交的那份拓扑，工作区 = 之后被改成的形态。与
 * scripts/test/threshold-monotonic.test.ts 的 gitFixture 同款做法（fixture 自带 user.name /
 * user.email，不依赖宿主 git 配置）。
 */
function commitBase(root: string) {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-qm", "base");
}

/** 造 fixture 仓库根（含拓扑与 stryker.conf.d），返回根路径。 */
function makeFixtureRoot(
  extraFiles: Record<string, string> = {},
  topologyOverride: unknown = TOPOLOGY,
) {
  const root = mkdtempSync(join(tmpdir(), "s2b-fixture-"));
  const files = {
    ...BASE_FILES,
    "scripts/data/mutation-topology.json": `${JSON.stringify(topologyOverride, null, 2)}\n`,
    ...extraFiles,
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  mkdirSync(join(root, "stryker.conf.d"), { recursive: true });
  commitBase(root);
  return root;
}

/** 主线程上的同步毫秒退避：Atomics.wait 是 Node 里唯一不烧 CPU 的同步 sleep。 */
function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 删掉 fixture 根。
 *
 * 夹具是**真 git 仓库**（commitBase 要 base commit），而清理与夹具里最后一批写盘
 * 存在残余竞态：rmSync 的递归删除在「读完目录条目 → rmdir」之间若仍有条目落盘，
 * rmdir 会抛 ENOTEMPTY。默认 maxRetries=0 时 Node **不重试**，该竞态直接冒到用例上
 * （真机 CI 已复现：PR #863 的 Build / Contract / Smoke / Pack 里 T3② 在清理阶段
 * 报 ENOTEMPTY, Directory not empty: /tmp/s2b-fixture-*）。此处把清理收口到一个位置
 * 统一加固，避免 22 处各自裸调 rmSync 时口径漂移。
 *
 * 为什么退避自己写、不交给 Node 的 maxRetries / retryDelay：同步递归删除在 POSIX 上
 * 把退避实现成 `sleep(i * retryDelay / 1000)`（整秒 + 整除截断），毫秒级 retryDelay
 * 一律截成 0 秒——`maxRetries: 10, retryDelay: 50` 因此退化成 11 次零间隔重试
 * （实测 11 次合计约 10ms），对持续数十毫秒的残余写者与裸调无差别（对照实验
 * 296/300 vs 裸调 298/300 次 ENOTEMPTY）。退避改在 JS 里按毫秒计，口径与原来的
 * maxRetries: 10 + retryDelay: 50 线性退避一致（上限 2.75s）；窗口过后仍删不掉照样抛。
 */
function removeFixtureRoot(root: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      // 非 Error 投掷按未知故障上抛：只有 ENOTEMPTY 值得退避重试。
      if ((err as { code?: unknown }).code !== "ENOTEMPTY" || attempt >= 10) throw err;
      sleepSync((attempt + 1) * 50);
    }
  }
}

/** 覆写 fixture 工作区的拓扑（基准 commit 不变 —— 这正是判据⑦ 要看的差异）。 */
function writeTopology(root: string, topologyOverride: unknown) {
  writeFileSync(
    join(root, "scripts", "data", "mutation-topology.json"),
    `${JSON.stringify(topologyOverride, null, 2)}\n`,
    "utf8",
  );
}

function runGenerator(root: string, args: string[] = []) {
  // --base HEAD：fixture 的基准就是它自己的 base commit（默认 origin/main 在 fixture 里不存在）。
  const res = spawnSync(process.execPath, [GENERATOR, ...args, "--base", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GEN_STRYKER_ROOT: root },
  });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** 生成到磁盘（写模式），返回 conf 路径。 */
function generate(root: string) {
  const res = runGenerator(root);
  assert.equal(res.status, 0, `生成应成功：\n${res.out}`);
  return join(root, "stryker.conf.d", `${PKG}-only.json`);
}

test("T2/T3①：runner 面文件全部自动分层，单元/集成层进变异面，client/e2e 层排除", () => {
  const root = makeFixtureRoot();
  try {
    const p = projectTestSurface(root, TOPOLOGY, PKG);
    assert.deepEqual(p.errors, [], `投影不应有错误：${p.errors.join("; ")}`);
    assert.equal(p.runFiles.length, 6, `runner 面应为 6 个文件：${p.runFiles.join(", ")}`);
    assert.deepEqual(
      p.testFiles.map((f) => f.replace(`packages/${PKG}/`, "")),
      [
        "test/integration/flow.test.ts",
        "test/unit/unit-a.test.ts",
        "test/unit/unit-b.test.ts",
        "test/unit/unit-d.test.ts",
      ],
    );
    assert.deepEqual(
      p.excludedFiles.map((f) => f.replace(`packages/${PKG}/`, "")),
      ["test/client/client-a.test.ts", "test/e2e/smoke.test.ts"],
      "client/e2e 层必须被排除",
    );
    assert.ok(
      !p.runFiles.includes(`packages/${PKG}/test/helpers.ts`),
      "支撑模块不得进入 runner 测试面",
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test("T2/T3① 反证：往 unit 层丢新文件 → 变异面自动纳入，零手工步骤", () => {
  const root = makeFixtureRoot({ [`packages/${PKG}/test/unit/unit-new.test.ts`]: "// new\n" });
  try {
    const p = projectTestSurface(root, TOPOLOGY, PKG);
    assert.ok(
      p.testFiles.includes(`packages/${PKG}/test/unit/unit-new.test.ts`),
      `新 unit 文件必须自动进变异面：${p.testFiles.join(", ")}`,
    );
    assert.equal(p.runFiles.length, 7, "runner 面也应自动纳入");
    assert.deepEqual(p.errors, []);
  } finally {
    removeFixtureRoot(root);
  }
});

test("T3① 反证：runner 面出现无层归属的文件 → 判红并点名", () => {
  const root = makeFixtureRoot({ [`packages/${PKG}/test/loose.test.ts`]: "// 无层归属\n" });
  try {
    const conf = generate(root);
    const res = runGenerator(root, ["--check"]);
    assert.equal(res.status, 1, `无层归属必须判红：\n${res.out}`);
    assert.match(res.out, /测试文件无层归属/, "应点名无层归属");
    assert.match(res.out, /test\/loose\.test\.ts/, "应给出文件路径");
    // 无层归属的文件不得被默默收进变异面
    assert.doesNotMatch(
      readFileSync(conf, "utf8"),
      /loose\.test\.ts/,
      "未决定层归属的文件不得进 conf",
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test("T3②：豁免必须带理由且真实存在于 unit 层", () => {
  const withBadReason = structuredClone(TOPOLOGY);
  withBadReason.packages[PKG].testLayers = {
    testMutationExemptions: { unit: { "test/unit/unit-b.test.ts": "   " } },
  };
  const root = makeFixtureRoot({}, withBadReason);
  try {
    const p = projectTestSurface(root, withBadReason, PKG);
    assert.ok(
      p.errors.some((e) => /缺少理由/.test(e)),
      `空理由必须判红：${p.errors.join("; ")}`,
    );
  } finally {
    removeFixtureRoot(root);
  }

  const withGhost = structuredClone(TOPOLOGY);
  withGhost.packages[PKG].testLayers = {
    testMutationExemptions: { unit: { "test/unit/ghost.test.ts": "不存在的文件" } },
  };
  const root2 = makeFixtureRoot({}, withGhost);
  try {
    const p = projectTestSurface(root2, withGhost, PKG);
    assert.ok(
      p.errors.some((e) => /不存在/.test(e)),
      `幽灵豁免必须判红：${p.errors.join("; ")}`,
    );
  } finally {
    removeFixtureRoot(root2);
  }
});

test("T3③：--min == runner glob 实际文件数；脱节判红，--sync-test-min 可同步", () => {
  const root = makeFixtureRoot();
  try {
    generate(root);
    assert.equal(
      runGenerator(root, ["--check"]).status,
      0,
      "--min=6 且 runner 面 6 个文件时应通过",
    );

    // 只加文件、不改 --min → 判红（--min 必须随文件数上调）
    writeFileSync(join(root, `packages/${PKG}/test/unit/unit-c.test.ts`), "// c\n");
    generate(root);
    const stale = runGenerator(root, ["--check"]);
    assert.equal(stale.status, 1, `--min 脱节必须判红：\n${stale.out}`);
    assert.match(stale.out, /登记完整性 ③/, "应点名 --min 判据");
    assert.match(stale.out, /--min 6 != 实际测试文件数 7/, "应给出两个数字");

    // 显式同步后恢复绿
    const synced = runGenerator(root, ["--sync-test-min"]);
    assert.equal(synced.status, 0, `同步应成功：\n${synced.out}`);
    const pkgJson = JSON.parse(readFileSync(join(root, `packages/${PKG}/package.json`), "utf8"));
    assert.match(pkgJson.scripts.test, /--min 7/, "--min 应被同步为 7");
    assert.equal(runGenerator(root, ["--check"]).status, 0, "同步后应通过");
  } finally {
    removeFixtureRoot(root);
  }
});

test("T3③-回归：test 脚本换 runner 后 --min 契约不变（#722）", () => {
  const root = makeFixtureRoot();
  try {
    // #722 把包级 test 脚本从 run-tests.mjs 换成 run-vitest.mjs。门禁只认「test 脚本声明
    // `--min <n>`」这一契约，不认 runner 实现名——否则换 runner 会让判据 ③ 把全部已切换的
    // 包误报为「--min 缺失」，而配置与拓扑其实完全一致（实测即此现象）。
    const pkgJsonPath = join(root, `packages/${PKG}/package.json`);
    writeFileSync(
      pkgJsonPath,
      `${JSON.stringify({ name: PKG, scripts: { test: "node ../../scripts/test/run-vitest.mjs --min 6" } }, null, 2)}\n`,
    );
    generate(root);
    assert.equal(runGenerator(root, ["--check"]).status, 0, "换 runner 后 --min=6 仍应通过");

    writeFileSync(join(root, `packages/${PKG}/test/unit/unit-c.test.ts`), "// c\n");
    generate(root);
    assert.equal(runGenerator(root, ["--check"]).status, 1, "换 runner 后 --min 脱节仍必须判红");

    assert.equal(runGenerator(root, ["--sync-test-min"]).status, 0, "--sync-test-min 应能写回");
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    assert.match(
      pkgJson.scripts.test,
      /run-vitest\.mjs --min 7/,
      "runner 名应原样保留，仅 --min 被同步",
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test("T3 反证：从派生 conf / vitest 测试面配置删掉登记条目 → --check 判红", () => {
  const root = makeFixtureRoot();
  try {
    const conf = generate(root);
    const vitestConf = join(root, "vitest.stryker.d", `${PKG}.config.ts`);
    assert.equal(runGenerator(root, ["--check"]).status, 0, "生成后应立即一致");

    // (a) conf 侧：删掉一条 mutate 登记
    const parsed = JSON.parse(readFileSync(conf, "utf8"));
    assert.ok(parsed.mutate.length >= 1, "fixture 应至少有一条 mutate 登记");
    parsed.mutate = [...parsed.mutate, `!packages/${PKG}/src/ghost.ts`];
    writeFileSync(conf, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    const confRes = runGenerator(root, ["--check"]);
    assert.equal(confRes.status, 1, `conf 被改必须判红：\n${confRes.out}`);
    assert.match(confRes.out, /内容与拓扑派生不一致/, "应点名 conf 与派生脱节");

    // (b) vitest 测试面配置侧：删掉一条 include（#722 后测试面的承载物）
    assert.equal(runGenerator(root).status, 0, "先恢复派生一致");
    const vLines = readFileSync(vitestConf, "utf8").split("\n");
    const firstInclude = vLines.findIndex((l) => l.includes(`packages/${PKG}/test/`));
    assert.ok(firstInclude > 0, "vitest 配置应含变异面 include 条目");
    vLines.splice(firstInclude, 1);
    writeFileSync(vitestConf, vLines.join("\n"), "utf8");
    const vRes = runGenerator(root, ["--check"]);
    assert.equal(vRes.status, 1, `vitest 测试面配置被改必须判红：\n${vRes.out}`);
    assert.match(vRes.out, /vitest 测试面配置与拓扑派生不一致/, "应点名 vitest 配置与派生脱节");
  } finally {
    removeFixtureRoot(root);
  }
});

test("T2 幂等：连续两次生成后 --check 仍绿（无静默漂移）", () => {
  const root = makeFixtureRoot();
  try {
    generate(root);
    const first = readFileSync(join(root, "stryker.conf.d", `${PKG}-only.json`), "utf8");
    generate(root);
    const second = readFileSync(join(root, "stryker.conf.d", `${PKG}-only.json`), "utf8");
    assert.equal(first, second, "两次生成必须逐字一致");
    assert.equal(runGenerator(root, ["--check"]).status, 0);
  } finally {
    removeFixtureRoot(root);
  }
});

test("P0-1 反证：import 派生模块不得写盘（否则 test:scripts 会静默修好被破坏的产物）", () => {
  // 假绿向量：若纯函数与带副作用的 CLI 同模块，测试一旦 import 它就会重写真实仓库的
  // stryker.conf.d/*.json 与 vitest.stryker.d/*.config.ts ——「删掉登记条目 → 门禁判红」
  // 会在下次 test:scripts 后自动变绿。
  const root = makeFixtureRoot();
  try {
    generate(root);
    const vitestConf = join(root, "vitest.stryker.d", `${PKG}.config.ts`);
    // 破坏派生结果，模拟「测试面登记被删」
    const broken = readFileSync(vitestConf, "utf8").split("\n");
    const firstInclude = broken.findIndex((l) => l.includes(`packages/${PKG}/test/`));
    broken.splice(firstInclude, 1);
    writeFileSync(vitestConf, broken.join("\n"), "utf8");
    assert.equal(runGenerator(root, ["--check"]).status, 1, "破坏后 --check 应判红");

    // import 纯模块（不是 CLI）：必须零输出、零写盘
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(join(ROOT, "scripts", "gate", "test-surface.mjs"))}).then(() => process.stdout.write('IMPORT-OK'))`,
      ],
      { encoding: "utf8", env: { ...process.env, GEN_STRYKER_ROOT: root } },
    );
    assert.equal(probe.status, 0, `import 应成功：${probe.stdout}${probe.stderr}`);
    assert.match(probe.stdout, /IMPORT-OK/, "纯模块 import 应无副作用");
    assert.equal(
      readFileSync(vitestConf, "utf8"),
      broken.join("\n"),
      "import 纯模块不得改写 vitest 测试面配置",
    );
    assert.equal(
      runGenerator(root, ["--check"]).status,
      1,
      "import 之后 --check 仍须判红（未被静默修好）",
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test("P0-2 反证：磁盘上有测试但未登记的包 → 判红点名（不得只遍历拓扑声明）", () => {
  const root = makeFixtureRoot({
    "packages/ghost-pkg/test/unit/unit-x.test.ts": "// 未登记拓扑的包\n",
    "packages/ghost-pkg/package.json": `${JSON.stringify({ name: "ghost-pkg", scripts: { test: "node ../../scripts/test/run-vitest.mjs --min 1" } }, null, 2)}\n`,
  });
  try {
    generate(root);
    const res = runGenerator(root, ["--check"]);
    assert.equal(res.status, 1, `未登记包必须判红：\n${res.out}`);
    assert.match(res.out, /ghost-pkg/, "应点名未登记的包");
    assert.match(
      res.out,
      /磁盘上有测试文件但未在 mutation-topology\.json 登记/,
      "应说明 fail-closed 理由",
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test("P0-2b：$noMutationPackages 声明过的包放行，但其 --min 仍受限", () => {
  const withSkip = structuredClone(TOPOLOGY);
  withSkip.$noMutationPackages = { "ghost-pkg": "只有 e2e 冒烟，刻意不登记变异面" };
  const root = makeFixtureRoot(
    {
      "packages/ghost-pkg/test/unit/unit-x.test.ts": "// 刻意不进变异面\n",
      "packages/ghost-pkg/package.json": `${JSON.stringify({ name: "ghost-pkg", scripts: { test: "node ../../scripts/test/run-vitest.mjs --min 1" } }, null, 2)}\n`,
    },
    withSkip,
  );
  try {
    generate(root);
    assert.equal(runGenerator(root, ["--check"]).status, 0, "声明过的包应放行");
    // 把 --min 改错（实际 1 个文件）→ 仍必须判红（声明的意思是「不登记变异面」，不是「不受门禁」）
    writeFileSync(
      join(root, "packages/ghost-pkg/package.json"),
      `${JSON.stringify({ name: "ghost-pkg", scripts: { test: "node ../../scripts/test/run-vitest.mjs --min 9" } }, null, 2)}\n`,
    );
    const res = runGenerator(root, ["--check"]);
    assert.equal(res.status, 1, `$noMutationPackages 的包 --min 脱节也必须判红：\n${res.out}`);
    assert.match(res.out, /ghost-pkg.*--min 9 != 实际测试文件数 1/s, "应点名该包的 --min 脱节");
  } finally {
    removeFixtureRoot(root);
  }
});

test("P0-3 反证：把必需层移出 mutationLayers（或加进排除层）→ 判红", () => {
  // 假绿向量：两行拓扑改动（mutationExcludeLayers 加 "unit"）能把变异面从 56 个文件削到 12 个，
  // 而「声明 ↔ 派生一致」类判据全绿。充分性下限必须由代码常量锚定。
  // [用例名, 拓扑变异]：变异函数只改内存形态，落盘由调用方做。
  const layerCases: Array<[string, (t: FixtureTopology) => void]> = [
    [
      "unit 被移出 mutationLayers",
      (t) => {
        t.$testLayers.mutationLayers = ["integration"];
      },
    ],
    [
      "unit 被加进排除层",
      (t) => {
        t.$testLayers.mutationExcludeLayers = ["client", "e2e", "unit"];
      },
    ],
    [
      "mutationLayers 清空",
      (t) => {
        t.$testLayers.mutationLayers = [];
      },
    ],
  ];
  for (const [label, mutate] of layerCases) {
    const broken = structuredClone(TOPOLOGY);
    mutate(broken);
    const root = makeFixtureRoot({}, broken);
    try {
      const p = projectTestSurface(root, broken, PKG);
      assert.ok(
        p.errors.length > 0,
        `${label}：必须报充分性错误，实际无错误（变异面 ${p.testFiles.length} 个）`,
      );
      assert.match(
        p.errors.join("; "),
        /必需层|变异面/,
        `${label}：错误应点明充分性：${p.errors.join("; ")}`,
      );
    } finally {
      removeFixtureRoot(root);
    }
  }
});

test("P1-5：--sync-test-min 遇无法同步的 --min 必须非零退出", () => {
  const root = makeFixtureRoot();
  try {
    const pkgJsonPath = join(root, `packages/${PKG}/package.json`);
    // 去掉 --min（保留 run-vitest.mjs 入口）→ sync 无法自动修
    writeFileSync(
      pkgJsonPath,
      `${JSON.stringify({ name: PKG, scripts: { test: "node ../../scripts/test/run-vitest.mjs" } }, null, 2)}\n`,
    );
    const res = runGenerator(root, ["--sync-test-min"]);
    assert.equal(res.status, 1, `存在无法同步项时必须非零退出：\n${res.out}`);
    assert.match(res.out, /无法自动同步/, "应说明无法同步");
  } finally {
    removeFixtureRoot(root);
  }
});

test("P2-7：unit 层零命中（glob 被改坏）→ 判红并点名", () => {
  const broken = structuredClone(TOPOLOGY);
  broken.$testLayers.layers.unit = "test/units/**/*.test.ts";
  const root = makeFixtureRoot({}, broken);
  try {
    const p = projectTestSurface(root, broken, PKG);
    assert.ok(
      p.errors.some((e) => /unit.*零命中/.test(e)),
      `应报 unit 层零命中：${p.errors.join("; ")}`,
    );
  } finally {
    removeFixtureRoot(root);
  }
});

/**
 * #843 计划项 3-1 判据⑦（包级变异面并集棘轮）的 fixture 拓扑。
 *
 * 为什么必须自己造：默认 TOPOLOGY 只有一段、且 mutate 是整包 glob，「把某一个文件挪进同段
 * excludes」这种攻击在 glob 形态下写不出来（它的前提是 mutate 逐文件登记——本仓 5 个包里有 4 个
 * 正是这种形态）。这里显式造「两段 + 逐文件登记」：
 *   段 1 = src/index.ts；段 2 = src/mid.ts + src/leaf.ts；两段 excludes 都排除 src/client/**
 * 基准面（并集）= {index.ts, mid.ts, leaf.ts}。
 */
function ratchetTopology(
  seg2Mutate: string[],
  seg2Excludes: string[] = [`!packages/${PKG}/src/client/**`],
) {
  const base = structuredClone(TOPOLOGY);
  base.packages[PKG].segments = {
    "1": {
      mutate: [`packages/${PKG}/src/index.ts`],
      excludes: [`!packages/${PKG}/src/client/**`],
      testFiles: "*",
    },
    "2": { mutate: seg2Mutate, excludes: seg2Excludes, testFiles: "*" },
  };
  return base;
}

const RATCHET_FILES = {
  [`packages/${PKG}/src/mid.ts`]: "export const mid = 1\n",
  [`packages/${PKG}/src/leaf.ts`]: "export const leaf = 1\n",
};
const SEG2_BOTH = [`packages/${PKG}/src/mid.ts`, `packages/${PKG}/src/leaf.ts`];

/** 攻击态：把 mid.ts 从段 2 的 mutate 挪进**同段** excludes（段里还剩 leaf.ts，故判据⑥ 也绿）。 */
const ATTACKED = () =>
  ratchetTopology(
    [`packages/${PKG}/src/leaf.ts`],
    [`!packages/${PKG}/src/client/**`, `!packages/${PKG}/src/mid.ts`],
  );

test("判据⑦ 反证：文件从段 mutate 挪进**同段** excludes 并重生成 conf → 判红点名包与文件", () => {
  // 这正是技术面评审亲手复现的攻击：判据⑤ 看每条条目都合法（! 指向的确实是真实文件）、判据⑥
  // 看有效面也非空，故「文件静默离开变异面」不被任何既有判据拦下——本用例就是它的回归。
  const root = makeFixtureRoot(RATCHET_FILES, ratchetTopology(SEG2_BOTH));
  try {
    assert.equal(runGenerator(root).status, 0, "对照组生成应成功");
    const control = runGenerator(root, ["--check"]);
    assert.equal(control.status, 0, `对照组（未改拓扑）应绿：\n${control.out}`);

    writeTopology(root, ATTACKED());
    assert.equal(runGenerator(root).status, 0, "重生成仍应成功（攻击要的是「门禁判绿」）");
    const res = runGenerator(root, ["--check"]);
    assert.equal(res.status, 1, `把文件挪出变异面必须判红：\n${res.out}`);
    assert.match(res.out, /变异面并集相对基准收缩/, "判词要点明是并集棘轮");
    assert.match(res.out, new RegExp(`\\[${PKG}\\]`), "判词要点名包");
    assert.match(res.out, new RegExp(`packages/${PKG}/src/mid\\.ts`), "判词要点名收缩掉的文件");
    // 红必须是判据⑦ 自己产生的：⑤/⑥ 与磁盘一致性判据在这条攻击下全绿（这正是缺陷本身）
    assert.doesNotMatch(
      res.out,
      /条目腐烂|判据⑥|内容与拓扑派生不一致|登记完整性/,
      `除并集棘轮外不得有其它判词：\n${res.out}`,
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test("判据⑦：段之间挪动合法（并集不变）→ 绿；真删除并同步拓扑 → 绿", () => {
  const root = makeFixtureRoot(RATCHET_FILES, ratchetTopology(SEG2_BOTH));
  try {
    assert.equal(runGenerator(root).status, 0, "生成应成功");
    // (a) mid.ts 从段 2 挪到段 1：并集仍是三个文件，只是换了段
    const moved = ratchetTopology([`packages/${PKG}/src/leaf.ts`]);
    moved.packages[PKG].segments["1"].mutate = [
      `packages/${PKG}/src/index.ts`,
      `packages/${PKG}/src/mid.ts`,
    ];
    writeTopology(root, moved);
    assert.equal(runGenerator(root).status, 0, "重生成应成功");
    const movedRes = runGenerator(root, ["--check"]);
    assert.equal(movedRes.status, 0, `段间挪动不得判红：\n${movedRes.out}`);
    // 载体自证也一并钉住：比过 1 个包 / 3 个候选文件（否则「没比」与「比过且没收缩」不可区分）
    assert.match(
      movedRes.out,
      /变异面并集棘轮对照 HEAD 比过 1 个包 \/ 3 个候选文件，无收缩/,
      "通过行必须给出实际的比对面大小",
    );

    // (b) 真删除：磁盘上的 mid.ts 消失，拓扑里也从 mutate 摘掉。基准面在**工作区源码世界**里展开，
    // 故 mid.ts 根本不进基准面——「删除即正当收缩」由这一条实现，不需要第二个存在性判断点。
    rmSync(join(root, `packages/${PKG}/src/mid.ts`));
    writeTopology(root, ratchetTopology([`packages/${PKG}/src/leaf.ts`]));
    assert.equal(runGenerator(root).status, 0, "重生成应成功");
    const deletedRes = runGenerator(root, ["--check"]);
    assert.equal(deletedRes.status, 0, `真删除不得判红：\n${deletedRes.out}`);
    assert.match(deletedRes.out, /无收缩/);
  } finally {
    removeFixtureRoot(root);
  }
});

/** 造一份 fixture 台账（唯一放宽通道 = scripts/data/gate-exemptions.json 的 gate=mutation-face）。 */
function exemptionFixture(path: string) {
  return `${JSON.stringify(
    {
      version: 1,
      note: "fixture：判据⑦ 的豁免台账",
      exemptions: [
        {
          // 门禁名取自实现导出的常量，避免 fixture 与台账口径漂移
          gate: MUTATION_FACE_GATE,
          path,
          reason: "fixture：模拟一条经批准的收缩登记",
          trackingIssue: "#843",
        },
      ],
    },
    null,
    2,
  )}\n`;
}

test("判据⑦：台账是唯一放宽通道（精确键 / 整包键），错键与失效条目判红（反腐烂）", () => {
  const exemptPath = "scripts/data/gate-exemptions.json";
  const fixture = (path: string) =>
    makeFixtureRoot(
      { [exemptPath]: exemptionFixture(path), ...RATCHET_FILES },
      ratchetTopology(SEG2_BOTH),
    );

  // (a) 精确键命中收缩文件 → 放行
  const exact = fixture(`${PKG}:packages/${PKG}/src/mid.ts`);
  try {
    assert.equal(runGenerator(exact).status, 0, "生成应成功");
    writeTopology(exact, ATTACKED());
    assert.equal(runGenerator(exact).status, 0, "重生成应成功");
    const res = runGenerator(exact, ["--check"]);
    assert.equal(res.status, 0, `已登记的收缩应放行：\n${res.out}`);
  } finally {
    removeFixtureRoot(exact);
  }

  // (b) 整包键 <包名>:* 同样放行（整包收缩是一次显式裁决）
  const whole = fixture(`${PKG}:*`);
  try {
    assert.equal(runGenerator(whole).status, 0, "生成应成功");
    writeTopology(whole, ATTACKED());
    assert.equal(runGenerator(whole).status, 0, "重生成应成功");
    const res = runGenerator(whole, ["--check"]);
    assert.equal(res.status, 0, `整包键应放行：\n${res.out}`);
  } finally {
    removeFixtureRoot(whole);
  }

  // (c) 错键（指向没收缩的文件）不得顺带关掉判据，且自身按反向腐烂判红
  const wrong = fixture(`${PKG}:packages/${PKG}/src/leaf.ts`);
  try {
    assert.equal(runGenerator(wrong).status, 0, "生成应成功");
    writeTopology(wrong, ATTACKED());
    assert.equal(runGenerator(wrong).status, 0, "重生成应成功");
    const res = runGenerator(wrong, ["--check"]);
    assert.equal(res.status, 1, `错键不得放行收缩：\n${res.out}`);
    assert.match(res.out, /变异面并集相对基准收缩/, "收缩仍须点名");
    assert.match(res.out, /没有对应的收缩缺口/, "失效条目须按反向腐烂判红");
  } finally {
    removeFixtureRoot(wrong);
  }
});

test("判据⑦ 载体自证：基准拓扑无包登记（比对面为空）→ 空转判红而非恒绿", () => {
  // 最危险的失效形态：判据一条没比却恒绿。把基准的包集合清空后，除了「空转」不该有任何判词——
  // 这样这条红就只能来自载体自证本身。
  const empty = structuredClone(TOPOLOGY);
  empty.packages = {};
  empty.$noMutationPackages = { [PKG]: "fixture：刻意不进变异面（用于空转用例）" };
  const root = makeFixtureRoot({}, empty);
  try {
    assert.equal(runGenerator(root).status, 0, "生成应成功（无包登记即无 conf）");
    const res = runGenerator(root, ["--check"]);
    assert.equal(res.status, 1, `比对面为空必须判红：\n${res.out}`);
    assert.match(res.out, /变异面棘轮空转/, "判词要点明空转");
    assert.match(res.out, /进入比对面的包 0 个、候选文件 0 个/, "判词要给出口径内的实测计数");
    assert.doesNotMatch(
      res.out,
      /条目腐烂|判据⑥|内容与拓扑派生不一致|登记完整性/,
      `红必须来自载体自证，而不是别的判据顺带报出来的：\n${res.out}`,
    );
  } finally {
    removeFixtureRoot(root);
  }
});

const LITERALS = ["StringLiteral", "ArrayLiteral", "ObjectLiteral", "TemplateLiteral"];

function enabledTopology() {
  const topology = structuredClone(TOPOLOGY);
  topology.sharedDefaults.excludedMutations = [...LITERALS];
  topology.packages[PKG].enableMutations = [...LITERALS];
  topology.packages[PKG].segments.only.excludes = [];
  return topology;
}

test("#847：显式空 excludes 与四类减项派生零排除，check 仍判有效面", () => {
  const topology = enabledTopology();
  const root = makeFixtureRoot({}, topology);
  try {
    const generated = runGenerator(root);
    assert.equal(generated.status, 0, generated.out);
    const conf = JSON.parse(readFileSync(join(root, "stryker.conf.d", PKG + "-only.json"), "utf8"));
    assert.deepEqual(conf.mutate, ["packages/fixture-pkg/src/**/*.ts"]);
    assert.deepEqual(conf.mutator.excludedMutations, []);
    const checked = runGenerator(root, ["--check"]);
    assert.equal(checked.status, 0, checked.out);
    topology.packages[PKG].segments.only.mutate = [];
    writeTopology(root, topology);
    assert.equal(runGenerator(root).status, 0);
    const empty = runGenerator(root, ["--check"]);
    assert.equal(empty.status, 1);
    assert.match(empty.out, /有效面为空/);
  } finally {
    removeFixtureRoot(root);
  }
});

// [用例名, 拓扑变异, 期望判词]：变异函数只改拓扑内存形态，不落盘（落盘由调用方做）。
const OPERATOR_CASES: Array<[string, (t: FixtureTopology) => void, RegExp]> = [
  [
    "删除字段",
    (t) => {
      delete t.packages[PKG].enableMutations;
    },
    /有效算子排除集合相对基准增加/,
  ],
  [
    "撤销部分启用",
    (t) => {
      (t.packages[PKG].enableMutations as string[]).pop();
    },
    /有效算子排除集合相对基准增加：TemplateLiteral/,
  ],
  [
    "全局增加排除",
    (t) => {
      (t.sharedDefaults.excludedMutations as string[]).push("BooleanLiteral");
    },
    /有效算子排除集合相对基准增加：BooleanLiteral/,
  ],
];
for (const [label, change, expected] of OPERATOR_CASES) {
  test("#847：有效算子排除棘轮拦截" + label, () => {
    const topology = enabledTopology();
    const root = makeFixtureRoot({}, topology);
    try {
      change(topology);
      writeTopology(root, topology);
      assert.equal(runGenerator(root).status, 0);
      const checked = runGenerator(root, ["--check"]);
      assert.equal(checked.status, 1, checked.out);
      assert.match(checked.out, expected);
    } finally {
      removeFixtureRoot(root);
    }
  });
}

for (const value of [
  null,
  "StringLiteral",
  {},
  [42],
  [""],
  ["Unknown"],
  ["StringLiteral", "StringLiteral"],
  ["BooleanLiteral"],
]) {
  test("#847：非法 enableMutations fail-closed " + JSON.stringify(value), () => {
    const topology = enabledTopology();
    topology.packages[PKG].enableMutations = value;
    const root = makeFixtureRoot({}, topology);
    try {
      const generated = runGenerator(root);
      assert.equal(generated.status, 1, generated.out);
      assert.match(generated.out, /enableMutations/);
      assert.doesNotMatch(generated.out, /TypeError/);
    } finally {
      removeFixtureRoot(root);
    }
  });
}

for (const value of [
  null,
  "StringLiteral",
  [42],
  ["Unknown"],
  ["StringLiteral", "StringLiteral"],
]) {
  test("#847：非法共享排除集合 fail-closed " + JSON.stringify(value), () => {
    const topology = enabledTopology();
    topology.sharedDefaults.excludedMutations = value;
    const root = makeFixtureRoot({}, topology);
    try {
      const generated = runGenerator(root);
      assert.equal(generated.status, 1, generated.out);
      assert.match(generated.out, /sharedDefaults.excludedMutations/);
    } finally {
      removeFixtureRoot(root);
    }
  });
}

test("fail-closed：基准 ref 不可解析 → exit 2 且统一故障注解", () => {
  const root = makeFixtureRoot();
  try {
    const res = spawnSync(
      process.execPath,
      [GENERATOR, "--check", "--base", "refs/heads/no-such-ref-xyz"],
      { cwd: ROOT, encoding: "utf8", env: { ...process.env, GEN_STRYKER_ROOT: root } },
    );
    assert.equal(res.status, 2, `${res.stdout}${res.stderr}`);
    assert.match(
      String(res.stderr),
      /^::error::门禁故障（非判据结论）：\[gen-stryker-conf\] 基准 ref refs\/heads\/no-such-ref-xyz 不可解析/m,
    );
    assert.equal(String(res.stdout), "");
  } finally {
    removeFixtureRoot(root);
  }
});

test("CLI 三态：判据⑦ 判红仍 exit 1 且无故障注解", () => {
  const root = makeFixtureRoot(RATCHET_FILES, ratchetTopology(SEG2_BOTH));
  try {
    writeTopology(root, ATTACKED());
    assert.equal(runGenerator(root).status, 0, "重生成应成功");
    const res = runGenerator(root, ["--check"]);
    assert.equal(res.status, 1, `攻击态必须判红：\n${res.out}`);
    assert.doesNotMatch(res.out, /::error::门禁故障/);
    assert.match(res.out, /变异面并集相对基准收缩/);
  } finally {
    removeFixtureRoot(root);
  }
});

test("P2 root-shared：精确生成 settings-namespace 段且不把 node:test 收入 Vitest 面", () => {
  const topology = structuredClone(TOPOLOGY);
  topology.$rootShared = {
    testRoot: "shared",
    testPattern: "test/**/*.mutation.test.ts",
    threshold: 60,
    segments: {
      "settings-namespace": {
        mutate: ["shared/settings-namespace.js"],
        excludes: [],
        testFiles: ["shared/test/settings-namespace.mutation.test.ts"],
      },
    },
  };
  const root = makeFixtureRoot(
    {
      "shared/settings-namespace.js": "export const covered = true\n",
      "shared/test/settings-namespace.mutation.test.ts": "// Vitest mutation face\n",
      "shared/test/config-shape.test.ts": "// node:test standard entry\n",
    },
    topology,
  );
  try {
    assert.equal(runGenerator(root).status, 0, "生成应成功");
    const sharedConfPath = join(root, "stryker.conf.d", "shared-settings-namespace.json");
    assert.equal(
      existsSync(sharedConfPath),
      true,
      "旧生成器忽略 $rootShared，必须以缺少 shared-settings-namespace.json 判红",
    );
    const sharedConf = JSON.parse(readFileSync(sharedConfPath, "utf8"));
    assert.deepEqual(sharedConf.mutate, ["shared/settings-namespace.js"]);
    assert.deepEqual(sharedConf.thresholds, { high: 60, low: 60, break: 60 });
    assert.deepEqual(sharedConf.mutator.excludedMutations, []);
    assert.equal(
      sharedConf.vitest.configFile,
      "vitest.stryker.d/shared-settings-namespace.config.ts",
    );

    const sharedVitestPath = join(root, "vitest.stryker.d", "shared-settings-namespace.config.ts");
    const sharedVitest = readFileSync(sharedVitestPath, "utf8");
    assert.match(sharedVitest, /shared\/test\/settings-namespace\.mutation\.test\.ts/);
    assert.doesNotMatch(sharedVitest, /shared\/test\/config-shape\.test\.ts/);

    assert.equal(
      existsSync(join(root, "stryker.conf.d", `${PKG}-only.json`)),
      true,
      "root-shared 适配不得改变 packages/* 的段派生",
    );
    assert.equal(runGenerator(root, ["--check"]).status, 0, "生成后 topology 与派生物应一致");
  } finally {
    removeFixtureRoot(root);
  }
});
