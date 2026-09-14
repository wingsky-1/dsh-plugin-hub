// @ts-nocheck
"use strict";

/**
 * 变异拓扑派生规则共享模块的回归（#710 F15：覆盖断言必须复用「段无 excludes 用默认值」的派生逻辑）。
 *
 * 为什么单独测：F15 的隐患是「生成侧注入默认 excludes、断言侧只读段内显式值」——
 * 段一旦省略 excludes，覆盖断言就会出现盲区（源文件既不在 mutate 也不在断言的 excludes 里，
 * 却不报未覆盖）。本用例直接对共享函数做正反断言，并额外锚定「落盘 conf 与断言口径同源」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  COVERAGE_EXCLUDE_KINDS,
  COVERAGE_EXCLUDE_MIN_REASON,
  collectCoverageExcludePatterns,
  collectMutationSpecs,
  coverageExcludeProblems,
  defaultSegmentExcludes,
} from "../gate/mutation-topology.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const GENERATOR = join(ROOT, "scripts", "gate", "gen-stryker-conf.mjs");
const TOPOLOGY_PATH = join(ROOT, "scripts", "data", "mutation-topology.json");

test("F15：段未显式写 excludes 时，collectMutationSpecs 仍返回默认排除面", () => {
  const topology = {
    packages: {
      "fixture-pkg": {
        segments: {
          noExcludes: { mutate: ["packages/fixture-pkg/src/a.ts"] },
          withExcludes: {
            mutate: ["packages/fixture-pkg/src/b.ts"],
            excludes: ["!packages/fixture-pkg/src/skip/**"],
          },
        },
      },
    },
  };
  const specs = collectMutationSpecs(topology, "fixture-pkg");
  assert.equal(specs.noMutation, false, "登记在 packages 的包不是「无变异面」态");
  assert.deepEqual(
    specs.excludes.sort(),
    [
      "packages/fixture-pkg/src/client/**",
      "packages/fixture-pkg/src/skip/**",
      "packages/fixture-pkg/src/types.ts",
    ].sort(),
    `默认值必须与显式值一起进断言口径：${JSON.stringify(specs.excludes)}`,
  );
  assert.deepEqual(specs.excludes, [...new Set(specs.excludes)], "口径内不得重复");
});

test("F15：未登记包返回 null（调用方 fail-closed），默认值随包名派生", () => {
  assert.equal(collectMutationSpecs({ packages: {} }, "unknown-pkg"), null);
  assert.deepEqual(defaultSegmentExcludes("dsh-x"), [
    "!packages/dsh-x/src/client/**",
    "!packages/dsh-x/src/types.ts",
  ]);
});

test("#773 批 B：$noMutationPackages 成员返回「无变异面」态，未登记与元键仍为 null", () => {
  const topology = {
    packages: {},
    $noMutationPackages: { $comment: "元数据键不是包登记", "ghost-pkg": "只有 e2e 冒烟" },
  };
  assert.deepEqual(
    collectMutationSpecs(topology, "ghost-pkg"),
    { noMutation: true, reason: "只有 e2e 冒烟" },
    "登记在 $noMutationPackages 的包必须与「完全未登记」区分开，否则调用方无从显式声明",
  );
  assert.equal(collectMutationSpecs(topology, "$comment"), null, "$comment 元键不是包登记");
  assert.equal(collectMutationSpecs(topology, "unregistered-pkg"), null, "两处都未登记仍是 null");
  // 同时登记两处时以 packages 为准：只有它带得出可判定的 mutate/excludes 面。
  const both = {
    packages: { "ghost-pkg": { segments: { s: { mutate: ["packages/ghost-pkg/src/a.ts"] } } } },
    $noMutationPackages: { "ghost-pkg": "无变异面" },
  };
  const specs = collectMutationSpecs(both, "ghost-pkg");
  assert.equal(specs.noMutation, false);
  assert.deepEqual(specs.mutate, ["packages/ghost-pkg/src/a.ts"]);
});

test("F15 反证：落盘 conf 的 mutate 面与断言口径同源（含 coverageExcludes 追加）", () => {
  const topology = JSON.parse(readFileSync(TOPOLOGY_PATH, "utf8"));
  const specs = collectMutationSpecs(topology, "dsh-mcp-manager");
  const conf = JSON.parse(
    readFileSync(join(ROOT, "stryker.conf.d", "dsh-mcp-manager-entry.json"), "utf8"),
  );
  const confExcludes = conf.mutate.filter((g) => g.startsWith("!")).map((g) => g.replace(/^!/, ""));
  for (const g of specs.excludes) {
    assert.ok(confExcludes.includes(g), `段 conf 缺少断言口径里的排除 glob：${g}`);
  }
  // coverageExcludes（S0 存量登记）必须真的落到 conf，否则覆盖断言与生成器再次脱节；
  // #773 R4 起条目是 { pattern, reason, kind }，取值只经共享的 collectCoverageExcludePatterns
  for (const g of collectCoverageExcludePatterns(topology.packages["dsh-mcp-manager"])) {
    assert.ok(conf.mutate.includes(g), `coverageExcludes 未落盘到 conf：${g}`);
  }
});

test("#773 R4：coverageExcludes 是 { pattern, reason, kind } 结构化条目（3 包共 11 条）", () => {
  const topology = JSON.parse(readFileSync(TOPOLOGY_PATH, "utf8"));
  // 规模断言：批 D 的形状变更范围就是这 11 条（dsh-mcp-manager 1 / dsh-notifier 4 /
  // dsh-provider-usage 6）。数量变化必须是有意的登记动作，不能靠 diff 顺带溜过。
  const expected = { "dsh-mcp-manager": 1, "dsh-notifier": 4, "dsh-provider-usage": 6 };
  const allReasons = [];
  let total = 0;
  for (const [pkgName, count] of Object.entries(expected)) {
    const pkgDef = topology.packages[pkgName];
    const entries = pkgDef.testLayers.coverageExcludes;
    assert.ok(Array.isArray(entries), `${pkgName} 的 coverageExcludes 必须是数组`);
    assert.equal(
      entries.length,
      count,
      `${pkgName} 的 coverageExcludes 条目数与登记不符（形状变更范围必须显式同步）`,
    );
    // 共享校验器：形状合法即零 problems（裸字符串 / 缺 pattern / reason 过短 / 未知 kind 都会红）
    assert.deepEqual(
      coverageExcludeProblems(pkgDef),
      [],
      `${pkgName} 的 coverageExcludes 形状不合法`,
    );
    for (const entry of entries) {
      assert.equal(
        typeof entry,
        "object",
        `${pkgName} 出现裸 glob 条目（旧形状已不合法）：${JSON.stringify(entry)}`,
      );
      assert.equal(
        entry.glob,
        undefined,
        "键名是 pattern（与 vitest 面 coverage.config.json 同形同键名）",
      );
      assert.ok(entry.pattern.startsWith("!"), `pattern 必须是排除 glob：${entry.pattern}`);
      assert.ok(
        entry.reason.length >= COVERAGE_EXCLUDE_MIN_REASON,
        `${entry.pattern} 的 reason 过短（下限 ${COVERAGE_EXCLUDE_MIN_REASON}）：${entry.reason}`,
      );
      assert.ok(
        COVERAGE_EXCLUDE_KINDS.includes(entry.kind),
        `${entry.pattern} 的 kind 不在值域内：${entry.kind}`,
      );
      allReasons.push(entry.reason);
    }
    total += entries.length;
  }
  assert.equal(total, 11, "coverageExcludes 共 11 条（#773 R4 的形状变更范围）");
  assert.equal(
    new Set(allReasons).size,
    allReasons.length,
    "每条排除都是独立裁决，reason 不得复制同一句",
  );
});

test("#773 R4 反证：形状不合法必须判红（裸字符串 / 缺 pattern / reason 空或过短 / 未知 kind）", () => {
  const valid = {
    pattern: "!packages/x/src/a.ts",
    reason: "这是一条足够长的理由说明",
    kind: "type-only",
  };
  const cases = [
    ["裸 glob 字符串（旧形状）", ["!packages/x/src/a.ts"], /非对象项/],
    ["缺 pattern", [{ reason: "这是一条足够长的理由", kind: "type-only" }], /缺 pattern/],
    [
      "pattern 为空串",
      [{ pattern: "", reason: "这是一条足够长的理由", kind: "type-only" }],
      /缺 pattern/,
    ],
    ["reason 缺失", [{ pattern: "!packages/x/src/a.ts", kind: "type-only" }], /缺 reason/],
    [
      "reason 过短",
      [{ pattern: "!packages/x/src/a.ts", reason: "太短", kind: "type-only" }],
      /缺 reason/,
    ],
    ["kind 未知", [{ ...valid, kind: "whatever" }], /kind 须为/],
    [
      "缺 ! 前缀",
      [{ pattern: "packages/x/src/a.ts", reason: "这是一条足够长的理由", kind: "not-mutated" }],
      /!/,
    ],
    ["重复 pattern", [valid, { ...valid }], /重复 pattern/],
    ["空数组", [], /非空数组/],
    ["非数组", "!packages/x/src/a.ts", /非空数组/],
  ];
  for (const [name, entries, re] of cases) {
    const problems = coverageExcludeProblems({ testLayers: { coverageExcludes: entries } });
    assert.ok(problems.length > 0, `${name} 必须判红（这条判据不能恒绿）`);
    assert.ok(
      problems.some((p) => re.test(p)),
      `${name} 的判词要能定位问题（实际：${problems.join(" | ")}）`,
    );
  }
  // 对照组：合法条目零 problems —— 证明上面的红不是「凡输入皆红」
  assert.deepEqual(coverageExcludeProblems({ testLayers: { coverageExcludes: [valid] } }), []);
  // absent ≠ 空数组：未登记 coverageExcludes 的包不是形状错误
  assert.deepEqual(coverageExcludeProblems({ testLayers: {} }), []);
});

test("#773 R4 反证：生成器遇旧形状（裸 glob）必须以判词退出，不得抛栈崩掉", () => {
  const root = mkdtempSync(join(tmpdir(), "r4-shape-"));
  try {
    const dir = join(root, "scripts", "data");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "mutation-topology.json"),
      `${JSON.stringify(
        {
          sharedDefaults: {},
          packages: {
            "fixture-pkg": {
              testLayers: { coverageExcludes: ["!packages/fixture-pkg/src/a.ts"] },
              segments: {},
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const res = spawnSync(process.execPath, [GENERATOR, "--check"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GEN_STRYKER_ROOT: root },
    });
    assert.equal(res.status, 1, `旧形状必须判红：\n${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /非对象项/, "判词要点明「裸 glob 已不是合法形状」");
    assert.doesNotMatch(
      res.stderr,
      /TypeError|not a function/,
      `形状错误不得以抛栈形态出现（旧实现的失败形态）：\n${res.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F15 反证：段省略 excludes 时生成器注入默认值（fixture 最小仓库）", () => {
  const root = mkdtempSync(join(tmpdir(), "f15-fixture-"));
  try {
    const pkg = "fixture-pkg";
    const files = {
      [`packages/${pkg}/src/a.ts`]: "export const a = 1\n",
      [`packages/${pkg}/src/client/ui.ts`]: "export const b = 2\n",
      [`packages/${pkg}/test/unit/unit-a.test.ts`]: 'import "../../src/a.ts"\n',
      "scripts/data/mutation-topology.json": `${JSON.stringify(
        {
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
            concurrency: 1,
            timeoutMS: 1000,
            dryRunTimeoutMinutes: 5,
            reporters: ["progress"],
            coverageAnalysis: "perTest",
            tempDirName: ".stryker-tmp",
            cleanTempDir: true,
            excludedMutations: [],
            vitest: { related: false },
          },
          packages: {
            [pkg]: {
              testLayers: {},
              segments: { only: { mutate: [`packages/${pkg}/src/a.ts`] } },
            },
          },
        },
        null,
        2,
      )}\n`,
      [`packages/${pkg}/package.json`]: `${JSON.stringify({ name: pkg, scripts: { test: "node ../../scripts/test/run-vitest.mjs --min 1" } }, null, 2)}\n`,
    };
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    }
    mkdirSync(join(root, "stryker.conf.d"), { recursive: true });

    const res = spawnSync(process.execPath, [GENERATOR], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GEN_STRYKER_ROOT: root },
    });
    assert.equal(res.status, 0, `生成应成功：\n${res.stdout}${res.stderr}`);
    const conf = JSON.parse(readFileSync(join(root, "stryker.conf.d", `${pkg}-only.json`), "utf8"));
    for (const g of defaultSegmentExcludes(pkg)) {
      assert.ok(
        conf.mutate.includes(g),
        `段省略 excludes 时应注入默认值：${g}\n${JSON.stringify(conf.mutate)}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
