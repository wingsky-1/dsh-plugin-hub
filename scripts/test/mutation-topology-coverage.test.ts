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
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  COVERAGE_EXCLUDE_KINDS,
  COVERAGE_EXCLUDE_MIN_REASON,
  collectCoverageExcludePatterns,
  collectMutationSpecs,
  coverageExcludeProblems,
  mutationFaceRatchetProblems,
  mutationPolicyProblems,
  mutationPolicyRatchetProblems,
  packageEntryProblems,
  packageMutationFace,
  packageRegistrationProblems,
  rootSharedEntryProblems,
  segmentTestShapeProblems,
  segmentTestUnionProblems,
} from "../gate/mutation-topology.mjs";
import {
  mutationEntryProblems,
  projectTestSurface,
  resolveSegmentTestFiles,
  segmentTestUnion,
} from "../gate/test-surface.mjs";
import { globFiles } from "../lib/glob-files.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const GENERATOR = join(ROOT, "scripts", "gate", "gen-stryker-conf.mjs");
const VERIFY_DIR_IMPORTS = join(ROOT, "scripts", "gate", "verify-dir-imports.mjs");
const TOPOLOGY_PATH = join(ROOT, "scripts", "data", "mutation-topology.json");

test("P2 root-shared：真实拓扑精确登记 settings namespace 变异段", () => {
  const topology = JSON.parse(readFileSync(TOPOLOGY_PATH, "utf8"));
  assert.deepEqual(topology.$rootShared, {
    testRoot: "shared",
    testPattern: "test/**/*.mutation.test.ts",
    threshold: 60,
    segments: {
      "settings-namespace": {
        mutate: ["shared/settings-namespace.js"],
        excludes: [],
        testFiles: ["shared/test/settings-namespace.mutation.test.ts"],
        comment:
          "Phase 5 P2：lan/mcp 共同运行时接缝；descriptor/source/onChange 与写入委托由独立 Vitest 行为判据直接覆盖。",
      },
    },
  });
});

test("P2 root-shared：独立 surface 纳入形状、算子与文件面棘轮", () => {
  const valid = {
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
  assert.deepEqual(rootSharedEntryProblems(valid), []);
  assert.match(
    rootSharedEntryProblems({ ...valid, testPattern: "test/**/*.test.ts" }).join(),
    /node:test 标准入口不得混入/,
  );
  assert.match(
    mutationPolicyProblems({
      sharedDefaults: { excludedMutations: [] },
      packages: {},
      $rootShared: { ...valid, excludedMutations: [] },
    }).join(),
    /\[\$rootShared\].*不允许包级排除 override/,
  );

  const expand = (pattern: string) =>
    pattern === "shared/settings-namespace.js" ? ["shared/settings-namespace.js"] : [];
  const sharedDefaults = { excludedMutations: ["StringLiteral"] };
  const ratchet = mutationFaceRatchetProblems({
    baseTopology: { sharedDefaults, packages: {}, $rootShared: valid },
    headTopology: { sharedDefaults, packages: {} },
    expand,
  });
  assert.deepEqual([ratchet.packagesCompared, ratchet.filesCompared], [1, 1]);
  assert.match(ratchet.problems.join(), /\[\$rootShared\].*shared\/settings-namespace\.js/);
  assert.match(
    mutationPolicyRatchetProblems(
      {
        sharedDefaults,
        packages: {},
        $rootShared: { ...valid, enableMutations: ["StringLiteral"] },
      },
      { sharedDefaults, packages: {}, $rootShared: valid },
    ).join(),
    /\[\$rootShared\].*StringLiteral/,
  );
});

test("#836：段缺 excludes 时判红且不给可判定的面，段声明了则只收显式值（无默认面）", () => {
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
  assert.equal(specs?.noMutation, false, "登记在 packages 的包不是「无变异面」态");
  assert.deepEqual(specs?.mutate, [], "形状不合法时不给可判定的面（fail-closed）");
  assert.deepEqual(specs?.excludes, []);
  assert.ok(
    (specs?.problems ?? []).some((p) => p.includes('段 "noExcludes"') && p.includes("excludes")),
    `缺 excludes 的段必须判红并点名段名：${(specs?.problems ?? []).join(" | ")}`,
  );

  // 对照组：每段都显式声明 excludes → 零 problems，且口径内只有声明过的条目。
  // defaultSegmentExcludes 删除后，「client/** + types.ts」不得再以任何形式被注入。
  const declared = {
    packages: {
      "fixture-pkg": {
        segments: {
          withExcludes: {
            mutate: ["packages/fixture-pkg/src/b.ts"],
            excludes: ["!packages/fixture-pkg/src/skip/**"],
          },
        },
      },
    },
  };
  const okSpecs = collectMutationSpecs(declared, "fixture-pkg");
  assert.deepEqual(okSpecs?.problems, []);
  assert.deepEqual(okSpecs?.excludes, ["packages/fixture-pkg/src/skip/**"]);
  assert.deepEqual(okSpecs?.mutate, ["packages/fixture-pkg/src/b.ts"]);
});

test("F15 收口：未登记包返回 null（调用方 fail-closed），不存在条目级默认面", () => {
  assert.equal(collectMutationSpecs({ packages: {} }, "unknown-pkg"), null);
  const specs = collectMutationSpecs(
    { packages: { "dsh-x": { segments: { s: { excludes: ["!packages/dsh-x/src/skip/**"] } } } } },
    "dsh-x",
  );
  assert.deepEqual(
    specs?.excludes,
    ["packages/dsh-x/src/skip/**"],
    "断言口径里只能出现拓扑里写着的条目（默认值已被 #836 删除）",
  );
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
    packages: {
      "ghost-pkg": {
        segments: {
          s: {
            mutate: ["packages/ghost-pkg/src/a.ts"],
            excludes: ["!packages/ghost-pkg/src/client/**"],
          },
        },
      },
    },
    $noMutationPackages: { "ghost-pkg": "无变异面" },
  };
  const specs = collectMutationSpecs(both, "ghost-pkg");
  assert.equal(specs?.noMutation, false);
  assert.deepEqual(specs?.mutate, ["packages/ghost-pkg/src/a.ts"]);
});

test("F15 反证：落盘 conf 的 mutate 面与断言口径同源（含 coverageExcludes 追加）", () => {
  const topology = JSON.parse(readFileSync(TOPOLOGY_PATH, "utf8"));
  const specs = collectMutationSpecs(topology, "dsh-mcp-manager");
  const conf = JSON.parse(
    readFileSync(join(ROOT, "stryker.conf.d", "dsh-mcp-manager-entry.json"), "utf8"),
  );
  const confExcludes = conf.mutate
    .filter((g: string) => g.startsWith("!"))
    .map((g: string) => g.replace(/^!/, ""));
  // 真实拓扑的已登记包必须给出 specs 且带 excludes 数组（null/缺数组即回归）：for-of 不得用空集兜底，
  // 那会把回归洗成绿。
  assert.ok(specs !== null, "dsh-mcp-manager 在真实拓扑已登记，specs 不得为 null");
  assert.ok(Array.isArray(specs.excludes), "已登记包的 specs 必须带 excludes 数组");
  for (const g of specs.excludes) {
    assert.ok(confExcludes.includes(g), `段 conf 缺少断言口径里的排除 glob：${g}`);
  }
  // coverageExcludes（S0 存量登记）必须真的落到 conf，否则覆盖断言与生成器再次脱节；
  // #773 R4 起条目是 { pattern, reason, kind }，取值只经共享的 collectCoverageExcludePatterns
  for (const g of collectCoverageExcludePatterns(topology.packages["dsh-mcp-manager"])) {
    assert.ok(conf.mutate.includes(g), `coverageExcludes 未落盘到 conf：${g}`);
  }
});

test("#773 R4：coverageExcludes 是 { pattern, reason, kind } 结构化条目（3 包共 14 条）", () => {
  const topology = JSON.parse(readFileSync(TOPOLOGY_PATH, "utf8"));
  // 规模断言：形状变更范围 14 条（dsh-mcp-manager 3 / dsh-notifier 5 / dsh-provider-usage 6）。
  // notifier 是 5 而不是 4：原 `**/deps.ts` 一条拆成两条——7 个纯类型域出口 + 含运行时
  // 实现的 system/deps.ts 单列（复核实测它转译后有运行时代码，不能与纯类型共用一条 reason）。
  // mcp 是 3 而不是 1（#767 B0 + B2a-wire W8）：原 facade 条重估后保留（目标形态的门面转译后仍有
  // 运行时代码，但只转调、不裁决，故不属 type-only）、新增目标树 `src/server/*/deps.ts` 的纯类型面
  // 出口条，W8 再新增 `src/connection/runtime/deps.ts`（B2b 前首个落在 `src/<域>/` 顶层的 deps.ts，
  // 该子层 mutate glob 全是显式文件，不登记就进 uncoveredSrcFiles）。
  // wfp 包已随 #840 退役（拓扑里无该包条目），故不计入三包范围。
  // 数量变化必须是有意的登记动作，不能靠 diff 顺带溜过。
  // pu 6→5（#767 终轮收尾：共享层 placement-math.js 退役，两包自持实现；
  // pu 的薄 facade coverageExcludes 条目随之删除，包内实现已在 pipeline 段 mutate 面内）。
  // pu 5→6（#768 S2：server/upgrade/deps.ts 纯类型窄面（UpgradeDeps 三项）新增 type-only 条目；
  // S3 新增 server/upgrade/interface.ts 复用既有 facade 条（**/interface.ts），不新增条目）。
  const expected = { "dsh-mcp-manager": 3, "dsh-notifier": 5, "dsh-provider-usage": 6 };

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
  assert.equal(
    total,
    14,
    "coverageExcludes 共 14 条（#773 R4 的形状变更范围：notifier deps.ts 拆分后 5 条；#840 退役 wfp（13→12）；#767 B0 mcp 第 2 条（→13）；W8 connection/runtime/deps.ts 第 3 条（→14）；#767 终轮收尾删 pu 薄 facade 条（→13）；#768 S2 加 pu server/upgrade/deps.ts 条（→14））",
  );
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
  // [用例名, 输入条目, 期望判词]：输入故意取非法形态，判据侧按 unknown 承接。
  const cases: Array<[string, unknown, RegExp]> = [
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

test("#773 R4 反证：包登记为 null / 非对象时给可读判词，不得抛栈（#813 复核发现）", () => {
  const pkgName = "fixture-pkg";
  for (const bad of [null, "not-an-object", 42]) {
    const topology = { packages: { [pkgName]: bad } };
    const problems = packageRegistrationProblems(topology);
    assert.ok(problems.length > 0, `包登记 ${JSON.stringify(bad)} 必须判红（这条判据不能恒绿）`);
    assert.ok(
      problems.some((p) => p.includes(pkgName) && p.includes("必须是对象")),
      `判词要点名包且说清形状要求（实际：${problems.join(" | ")}）`,
    );
    // 关键：collectMutationSpecs 不得在 pkgDef.segments 上抛栈，而是给出空面 + 同一条判词
    const specs = collectMutationSpecs(topology, pkgName);
    assert.equal(specs?.noMutation, false, "形状错误不是「无变异面」，而是没有可判定的面");
    assert.deepEqual(specs?.mutate, []);
    assert.deepEqual(specs?.excludes, []);
    assert.deepEqual(specs?.problems, [
      `包登记必须是对象（当前 ${JSON.stringify(bad)}）——形状不对时没有可判定的变异面，fail-closed`,
    ]);
  }
  // 顶层 packages 本身不是对象同样是形状错误
  assert.ok(packageRegistrationProblems({ packages: null }).length > 0);
  // 对照组：正常包登记零问题（证明上面的红不是「凡输入皆红」）
  assert.deepEqual(
    packageRegistrationProblems({
      packages: { [pkgName]: { segments: { only: { mutate: ["x"], excludes: ["!y"] } } } },
    }),
    [],
  );
});

test("#773 R4 反证：包登记的 segments 缺失 / null / 非对象 → 判词而非抛栈（复核 D1）", () => {
  const pkgName = "fixture-pkg";
  for (const bad of [undefined, null, "not-an-object", 42, []]) {
    const pkgDef = bad === undefined ? {} : { segments: bad };
    const topology = { packages: { [pkgName]: pkgDef } };
    const problems = packageRegistrationProblems(topology);
    assert.ok(
      problems.some((p) => p.includes(pkgName) && p.includes("segments 必须是对象")),
      `segments=${JSON.stringify(bad)} 必须判红且点名（实际：${problems.join(" | ")}）`,
    );
    // 关键：两个下游取值点都不得在 Object.entries(pkgDef.segments) 上抛栈
    const specs = collectMutationSpecs(topology, pkgName);
    assert.equal(specs?.noMutation, false);
    assert.deepEqual(specs?.mutate, []);
    assert.deepEqual(specs?.excludes, []);
    assert.deepEqual(specs?.problems, [
      `包登记的 segments 必须是对象（当前 ${JSON.stringify(bad)}）——形状不对时没有可判定的变异面，fail-closed`,
    ]);
  }
  // 对照组：segments 是非空对象零 problems；空对象是「登记了却没有面」（不派生任何 conf，
  // 条目判据永远看不到该包）——#848 起单独判红，故不再用空对象当对照
  assert.deepEqual(
    packageRegistrationProblems({
      packages: { [pkgName]: { segments: { only: { mutate: ["x"], excludes: ["!y"] } } } },
    }),
    [],
  );
  assert.match(
    packageRegistrationProblems({ packages: { [pkgName]: { segments: {} } } }).join(" | "),
    /segments 为空对象/,
  );
});

test("#836 反证：段缺 excludes / 非数组 / 段非对象 → 逐条判词，不得抛栈（显式空数组合法，见 #847 用例）", () => {
  const pkgName = "fixture-pkg";
  const cases: Array<[string, unknown, RegExp]> = [
    ["段缺 excludes", { mutate: [`packages/${pkgName}/src/a.ts`] }, /excludes 必须是数组/],
    ["excludes 非数组", { mutate: [], excludes: "!packages/x/src/**" }, /excludes 必须是数组/],
    ["段非对象", null, /必须是对象/],
  ];
  for (const [name, seg, re] of cases) {
    const topology = { packages: { [pkgName]: { segments: { s: seg } } } };
    const problems = packageRegistrationProblems(topology);
    assert.ok(problems.length > 0, `${name} 必须判红（这条判据不能恒绿）`);
    assert.ok(
      problems.some((p) => p.includes(pkgName) && p.includes('段 "s"') && re.test(p)),
      `${name} 的判词要点名段与形状要求（实际：${problems.join(" | ")}）`,
    );
    // 下游取值点不得在 seg.excludes 上抛栈：给出空面 + 同族判词，由调用方 fail-closed 落红
    const specs = collectMutationSpecs(topology, pkgName);
    assert.equal(specs?.noMutation, false, "形状错误不是「无变异面」，而是没有可判定的面");
    assert.deepEqual(specs?.mutate, []);
    assert.deepEqual(specs?.excludes, []);
    assert.ok((specs?.problems ?? []).length > 0, `${name}：形状问题必须随 spec 交给调用方`);
  }
  // 对照组：段自己声明了非空 excludes → 零 problems（形状判据不是「凡输入皆红」）
  assert.deepEqual(
    packageRegistrationProblems({
      packages: {
        [pkgName]: {
          segments: { s: { mutate: [], excludes: [`!packages/${pkgName}/src/anything/**`] } },
        },
      },
    }),
    [],
  );
});

test("#773 R4 反证：生成器遇坏包登记（null / {} / segments:null）以判词退出，不得抛栈", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /包登记必须是对象/],
    [{}, /segments 必须是对象/],
    [{ segments: null }, /segments 必须是对象/],
    [{ segments: "nope" }, /segments 必须是对象/],
  ];
  for (const [bad, re] of cases) {
    const root = mkdtempSync(join(tmpdir(), "r4-bad-pkg-"));
    try {
      const dir = join(root, "scripts", "data");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "mutation-topology.json"),
        `${JSON.stringify({ sharedDefaults: {}, packages: { "fixture-pkg": bad } }, null, 2)}\n`,
        "utf8",
      );
      const res = spawnSync(process.execPath, [GENERATOR, "--check"], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, GEN_STRYKER_ROOT: root },
      });
      const out = `${res.stdout}${res.stderr}`;
      assert.equal(res.status, 1, `包登记 ${JSON.stringify(bad)} 必须判红：\n${out}`);
      assert.match(out, re, `判词要点名形状要求（${JSON.stringify(bad)}）\n${out}`);
      assert.doesNotMatch(
        out,
        /TypeError|Cannot convert undefined or null to object/,
        `形状错误不得以抛栈形态出现（旧实现的失败形态）：\n${out}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("#773 R4 反证：verify-dir-imports 遇坏包登记（null / {} / segments:null）判红而非抛栈", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /包登记必须是对象/],
    [{}, /segments 必须是对象/],
    [{ segments: null }, /segments 必须是对象/],
  ];
  for (const [bad, re] of cases) {
    const root = mkdtempSync(join(tmpdir(), "r4-bad-vi-"));
    try {
      const files = {
        "packages/fixture-pkg/src/a.ts": "export const a = 1\n",
        "scripts/data/mutation-topology.json": `${JSON.stringify(
          { sharedDefaults: {}, packages: { "fixture-pkg": bad } },
          null,
          2,
        )}\n`,
      };
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(root, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
      }
      const res = spawnSync(process.execPath, [VERIFY_DIR_IMPORTS, "--package", "fixture-pkg"], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, VERIFY_DIR_IMPORTS_ROOT: root },
      });
      const out = `${res.stdout}${res.stderr}`;
      assert.equal(res.status, 1, `包登记 ${JSON.stringify(bad)} 必须判红：\n${out}`);
      assert.match(out, re, `判词要点名形状要求（${JSON.stringify(bad)}）\n${out}`);
      assert.doesNotMatch(
        out,
        /TypeError|Cannot convert undefined or null to object/,
        `形状错误不得以抛栈形态出现：\n${out}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("#773 R4：notifier 的 deps.ts 拆成「7 个纯类型域出口 + system/deps.ts 运行时段口」", () => {
  const topology = JSON.parse(readFileSync(TOPOLOGY_PATH, "utf8"));
  const entries = topology.packages["dsh-notifier"].testLayers.coverageExcludes;
  /** coverageExcludes 条目形态（门禁自述；非法形态另有专条用例）。 */
  interface CoverageExcludeEntry {
    pattern: string;
    reason: string;
    kind: string;
  }
  const byPattern = new Map(entries.map((e: CoverageExcludeEntry) => [e.pattern, e]));
  // 条目存在性由下文 assert.ok 钉住：as 收窄只为取字段，运行时形态不变。
  const pure = byPattern.get("!packages/dsh-notifier/src/server/*/deps.ts") as CoverageExcludeEntry;
  const runtime = byPattern.get(
    "!packages/dsh-notifier/src/server/channels/impl/system/deps.ts",
  ) as CoverageExcludeEntry;
  assert.ok(pure, "7 个纯类型域出口的 glob 必须在位");
  assert.equal(pure.kind, "type-only", "纯类型出口才配 type-only（真无运行时代码）");
  assert.ok(runtime, "system/deps.ts 必须单列：它的转译产物有运行时代码，不能与纯类型共用 reason");
  assert.equal(runtime.kind, "not-mutated");
  // 用**声明的那条 pattern** 直接匹配磁盘（不手写正则复刻 glob 语义——那等于第二份事实源）：
  // 两条 pattern 的并集必须等于 `**/deps.ts` 的全集 —— 拆分只改登记方式，不得改变被判定面。
  const matchedBy = (entry: CoverageExcludeEntry) =>
    globSync(entry.pattern.replace(/^!/, ""), { cwd: ROOT }).sort();
  const pureMatched = matchedBy(pure);
  const runtimeMatched = matchedBy(runtime);
  const union = [...new Set([...pureMatched, ...runtimeMatched])].sort();
  const all = globSync("packages/dsh-notifier/src/**/deps.ts", { cwd: ROOT }).sort();
  assert.equal(all.length, 8, `notifier 的 deps.ts 数量变了（当前 ${all.length}）：拆分表要同步`);
  assert.deepEqual(
    pureMatched,
    [
      "packages/dsh-notifier/src/server/api/deps.ts",
      "packages/dsh-notifier/src/server/config/deps.ts",
      "packages/dsh-notifier/src/server/events/deps.ts",
      "packages/dsh-notifier/src/server/pipeline/deps.ts",
      "packages/dsh-notifier/src/server/sdk/deps.ts",
      "packages/dsh-notifier/src/server/stores/deps.ts",
      "packages/dsh-notifier/src/server/upgrade/deps.ts",
    ],
    `纯类型 pattern 应恰好命中 7 个域出口（当前 ${pureMatched.join(", ")}）`,
  );
  assert.deepEqual(
    runtimeMatched,
    ["packages/dsh-notifier/src/server/channels/impl/system/deps.ts"],
    "单列 pattern 只应命中那个运行时段口",
  );
  assert.deepEqual(union, all, "两条 pattern 的并集必须与全量 glob 逐字相同（不漏、不多）");
});

test("#773 R4 反证：projectTestSurface 遇坏包登记给判词，不得抛栈", () => {
  for (const [bad, re] of [
    [null, /包登记必须是对象/],
    [{}, /segments 必须是对象/],
    [{ segments: null }, /segments 必须是对象/],
  ] as Array<[unknown, RegExp]>) {
    const projection = projectTestSurface(
      ROOT,
      { $testLayers: {}, packages: { "fixture-pkg": bad } },
      "fixture-pkg",
    );
    assert.deepEqual(projection.testFiles, []);
    assert.ok(
      projection.errors.some((e) => re.test(e)),
      `测试面投影必须给可读判词（${JSON.stringify(bad)}，实际：${projection.errors.join(" | ")}）`,
    );
  }
  // 对照组：正常包登记不因形状判据报错（形状守卫不是「凡输入皆红」）
  assert.deepEqual(projectTestSurface(ROOT, { packages: {} }, "fixture-pkg").errors, [
    "包未在变异拓扑登记：fixture-pkg —— 源码覆盖与测试面登记都无法判定（fail-closed）",
  ]);
});

/**
 * conf 文件名 → 所属包（判据 ⑤ 的锚定与 ⑥ 的有效面都要它）。与派生侧 confOwners 同一算法：
 * `_single` 段派生 `<pkg>.json`，其余段派生 `<pkg>-<seg>.json`。
 */
function confOwnerOf(
  topology: {
    packages?: Record<string, { segments?: Record<string, unknown> }>;
    $rootShared?: { segments?: Record<string, unknown> };
  },
  fileName: string,
) {
  for (const [pkgName, pkgDef] of Object.entries(topology.packages ?? {})) {
    for (const segKey of Object.keys(pkgDef.segments ?? {})) {
      const name = segKey === "_single" ? `${pkgName}.json` : `${pkgName}-${segKey}.json`;
      if (name === fileName) return pkgName;
    }
  }
  for (const segKey of Object.keys(topology.$rootShared?.segments ?? {})) {
    const name = segKey === "_single" ? "shared.json" : `shared-${segKey}.json`;
    if (name === fileName) return "shared";
  }
  return undefined;
}

/** #836 反证用的最小仓库根：一份 conf 的 mutate 面完全由段声明决定。 */
// excludes 取 undefined 时 JSON 落盘丢键，正是「段没写 excludes」的形态（见调用方注释）。
function makeMutationFixture(excludes: string[] | undefined) {
  const root = mkdtempSync(join(tmpdir(), "f836-fixture-"));
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
            segments: {
              only: { mutate: [`packages/${pkg}/src/a.ts`], excludes, testFiles: "*" },
            },
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
  // 判据⑦（#843 计划项 3-1）要读基准 ref 上的拓扑，故 fixture 必须是个真 git 仓库：基准 = 建
  // fixture 时提交的那份拓扑。与 scripts/test/stryker-conf-layers.test.ts 的 commitBase 同款。
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-qm", "base");
  return root;
}

/** 对 fixture 根跑生成器，返回 { status, out }（--base HEAD = fixture 自己的 base commit）。 */
function runGenerator(root: string, args: string[] = []) {
  const res = spawnSync(process.execPath, [GENERATOR, ...args, "--base", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GEN_STRYKER_ROOT: root },
  });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

test("#836 反证：段省略 excludes 时 --check 判红并点名段，不得抛栈", () => {
  // makeMutationFixture(undefined) 让 excludes 键整个缺席（JSON.stringify 会丢掉 undefined 值），
  // 这正是「段没写 excludes」的形态。
  const root = makeMutationFixture(undefined);
  try {
    const res = runGenerator(root, ["--check"]);
    assert.equal(res.status, 1, `缺 excludes 必须判红：\n${res.out}`);
    assert.match(res.out, /段 "only" 的 excludes 必须是数组/, "判词要点名是哪个段");
    assert.doesNotMatch(
      res.out,
      /TypeError|is not iterable/,
      `形状错误不得以抛栈形态出现（删掉回退后 ...seg.excludes 就是下一个裸引用的 iterable）：\n${res.out}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#836：仓库每份 conf 的每条 mutate 条目都命中物理文件（含 ! 排除条目）", () => {
  const confDir = join(ROOT, "stryker.conf.d");
  const confFiles = readdirSync(confDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  assert.ok(confFiles.length > 0, "仓库里应当有派生 conf");
  const topology = JSON.parse(readFileSync(TOPOLOGY_PATH, "utf8"));
  let scanned = 0;
  let entries = 0;
  for (const file of confFiles) {
    const mutate = JSON.parse(readFileSync(join(confDir, file), "utf8")).mutate;
    entries += mutate.length;
    const owner = confOwnerOf(topology, file);
    assert.ok(owner !== undefined, `${file} 必须能解析出所属包（锚定判据的输入）`);
    const res = mutationEntryProblems(ROOT, file, mutate, owner);
    assert.deepEqual(
      res.problems,
      [],
      `${file} 存在命中 0 个文件的条目：${res.problems.join(" | ")}`,
    );
    scanned += res.scanned;
  }
  // 面完整性自证：本判据最可能的失效形态是空转（一条都没判、恒绿），而空转时
  // problems 同样是空数组——所以必须断言「真的判过」，且判过的条数与 conf 里的条数相等。
  assert.equal(scanned, entries, "每条条目都必须真的被 glob 判过（scanned == 条目总数）");
  assert.ok(scanned > 0, `扫到的 pattern 条数必须 > 0（当前 ${scanned}）`);
});

test("#836 反证：命中 0 个文件的条目判红，判词点名 conf 与 pattern", () => {
  const root = mkdtempSync(join(tmpdir(), "f836-rot-"));
  try {
    mkdirSync(join(root, "packages", "dsh-x", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "dsh-x", "src", "a.ts"), "export const a = 1\n", "utf8");
    writeFileSync(join(root, "packages", "dsh-x", "src", "b.ts"), "export const b = 1\n", "utf8");
    // 对照组：正向面非空、排除条目真的命中且没吃光正向面（旧对照组用 `!packages/dsh-x/src/**`
    // 把正向面全吃掉，那是 #848 判据⑥ 的形态，不再能当「零判词」的对照）
    const declared = ["packages/dsh-x/src/**/*.ts", "!packages/dsh-x/src/b.ts"];
    const okRes = mutationEntryProblems(root, "dsh-x-entry.json", declared, "dsh-x");
    assert.deepEqual(okRes.problems, [], "对照组：命中的条目不得判红（判据不是凡输入皆红）");
    assert.equal(okRes.scanned, declared.length, "scanned 是实际判过的条目数");

    const rotRes = mutationEntryProblems(
      root,
      "dsh-x-entry.json",
      [...declared, "!packages/dsh-x/src/types.ts"],
      "dsh-x",
    );
    assert.equal(rotRes.problems.length, 1, `幽灵条目必须判红：${rotRes.problems.join(" | ")}`);
    assert.match(rotRes.problems[0], /dsh-x-entry\.json/, "判词必须点名是哪份 conf");
    assert.match(
      rotRes.problems[0],
      /!packages\/dsh-x\/src\/types\.ts/,
      "判词必须点名是哪条 pattern",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#836 反证：拓扑里的幽灵排除条目落进派生 conf，--check 判红且只报这一条", () => {
  // 对照组：同样的 fixture、同样的段，excludes 全部命中 → --check 绿（证明下面那条红来自幽灵条目）
  const okRoot = makeMutationFixture(["!packages/fixture-pkg/src/client/**"]);
  const ghostRoot = makeMutationFixture([
    "!packages/fixture-pkg/src/client/**",
    "!packages/fixture-pkg/src/types.ts",
  ]);
  try {
    assert.equal(runGenerator(okRoot).status, 0, "对照组的生成应成功");
    const okCheck = runGenerator(okRoot, ["--check"]);
    assert.equal(okCheck.status, 0, `对照组 --check 应通过：\n${okCheck.out}`);

    assert.equal(runGenerator(ghostRoot).status, 0, "含幽灵条目的生成仍应成功（判据在 --check）");
    const confPath = join(ghostRoot, "stryker.conf.d", "fixture-pkg-only.json");
    assert.ok(
      JSON.parse(readFileSync(confPath, "utf8")).mutate.includes(
        "!packages/fixture-pkg/src/types.ts",
      ),
      "幽灵条目必须真的落进 fixture 里那份 conf（判据判的就是它）",
    );
    const ghostCheck = runGenerator(ghostRoot, ["--check"]);
    assert.equal(ghostCheck.status, 1, `幽灵条目必须判红：\n${ghostCheck.out}`);
    assert.match(ghostCheck.out, /fixture-pkg-only\.json/, "判词必须点名是哪份 conf");
    assert.match(ghostCheck.out, /条目腐烂/, "判词必须说明是条目腐烂");
    assert.match(
      ghostCheck.out,
      /!packages\/fixture-pkg\/src\/types\.ts/,
      "判词必须点名是哪条 pattern",
    );
    // 磁盘一致、形状合法、--min 同步 —— 红必须是新判据自己产生的，而不是别的判据顺带报出来的
    assert.doesNotMatch(
      ghostCheck.out,
      /内容与拓扑派生不一致|登记完整性|形状不合法/,
      `除条目腐烂外不得有其它判词：\n${ghostCheck.out}`,
    );
  } finally {
    rmSync(okRoot, { recursive: true, force: true });
    rmSync(ghostRoot, { recursive: true, force: true });
  }
});

test("#848：判据⑤锚定/越界 与 判据⑥有效面（命中口径锚在源码世界，不认构建产物）", () => {
  const root = mkdtempSync(join(tmpdir(), "f848-anchor-"));
  try {
    mkdirSync(join(root, "packages", "dsh-x", "src"), { recursive: true });
    mkdirSync(join(root, "packages", "dsh-y", "src"), { recursive: true });
    mkdirSync(join(root, "packages", "dsh-x", "src", "client"), { recursive: true });
    writeFileSync(join(root, "packages", "dsh-x", "src", "a.ts"), "export const a = 1\n", "utf8");
    writeFileSync(
      join(root, "packages", "dsh-x", "src", "client", "ui.ts"),
      "export const b = 2\n",
      "utf8",
    );
    writeFileSync(join(root, "packages", "dsh-y", "src", "a.ts"), "export const a = 1\n", "utf8");
    const judge = (patterns: string[], owner: string = "dsh-x") =>
      mutationEntryProblems(root, "dsh-x-entry.json", patterns, owner).problems.join(" | ");

    // 对照组：锚定本包、命中源码世界 → 零判词（判据不是凡输入皆红）
    assert.equal(judge(["packages/dsh-x/src/**/*.ts", "!packages/dsh-x/src/client/**"]), "");
    // ⑤ 锚定：跨包 pattern 描述的不是本包的源码
    assert.match(judge(["packages/dsh-y/src/**/*.ts"]), /判据⑤ 锚定/);
    // ⑤ 锚定：广域通配会命中他包同名文件，故不能靠「命中 ≥1」自证
    assert.match(judge(["packages/dsh-x/src/**/*.ts", "!**/a.ts"]), /判据⑤ 锚定/);
    // ⑤ 锚定：`..` 归一化与 brace 展开都被字面判词拦下（否则前缀看着在本包、命中在他包）
    assert.match(judge(["!packages/dsh-x/../dsh-y/src/a.ts"]), /含 \.\. 上跳段/);
    assert.match(judge(["packages/dsh-x/{src,../dsh-y/src}/**/*.ts"]), /含 brace 展开/);
    assert.match(judge(["./packages/dsh-x/src/**/*.ts"]), /相对\/绝对路径/);
    // ⑤ 存在性：命中面只落在构建产物上 = 描述另一个真实的世界
    mkdirSync(join(root, "packages", "dsh-x", "lib"), { recursive: true });
    writeFileSync(join(root, "packages", "dsh-x", "lib", "a.js"), "export const a = 1\n", "utf8");
    assert.match(judge(["packages/dsh-x/lib/**"]), /条目腐烂/);
    // owner 是锚定判据的输入，缺省即 fail-closed（不得静默退化成「任何命中都合法」）
    assert.match(
      mutationEntryProblems(
        root,
        "dsh-x-entry.json",
        ["packages/dsh-x/src/a.ts"],
        undefined,
      ).problems.join(" | "),
      /缺少 owner/,
    );
    // ⑥ 有效面：条数不变地把正向面整包吃掉 → 只报 ⑥
    const wiped = mutationEntryProblems(
      root,
      "dsh-x-entry.json",
      ["packages/dsh-x/src/**/*.ts", "!packages/dsh-x/src/**"],
      "dsh-x",
    ).problems;
    assert.equal(wiped.length, 1, `整包被排除必须只报判据⑥：${wiped.join(" | ")}`);
    assert.match(wiped[0], /判据⑥ 有效面为空/);
    // ⑤ 有问题时不重复报 ⑥：条目不合法时「有效面为空」只是后果，报出来会误导定位
    const ghost = judge(["packages/dsh-x/src/legacy/**", "!packages/dsh-x/src/legacy/**"]);
    assert.match(ghost, /条目腐烂/);
    assert.doesNotMatch(ghost, /判据⑥/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#848：段级 excludes 条目形状（缺 ! / 非字符串）与空 segments 判红", () => {
  // seg 故意取非法形态（缺 ! / 非字符串）：判据侧按 unknown 承接并判红。
  const withSeg = (seg: unknown) => packageEntryProblems({ segments: { only: seg } });
  // 缺 ! 的条目会被原样拼进 conf 的 mutate，语义从「排除」极性反转成「要变异这个文件」
  assert.match(
    withSeg({
      mutate: ["packages/fixture-pkg/src/a.ts"],
      excludes: ["packages/fixture-pkg/src/b.ts"],
    }).join(" | "),
    /缺 ! 前缀/,
  );
  assert.match(withSeg({ mutate: ["x"], excludes: [""] }).join(" | "), /非空字符串/);
  assert.match(withSeg({ mutate: ["x"], excludes: [42] }).join(" | "), /非空字符串/);
  // 对照组：合法段零判词
  assert.deepEqual(withSeg({ mutate: ["x"], excludes: ["!packages/fixture-pkg/src/b.ts"] }), []);
  // 空 segments 不派生任何 conf，⑤/⑥ 都看不到它 → 无变异面的包必须进 $noMutationPackages
  assert.match(packageEntryProblems({ segments: {} }).join(" | "), /segments 为空对象/);
});

test("#848 反证：段把整包正向面排除光 → --check 判红并点名判据⑥", () => {
  const root = makeMutationFixture(["!packages/fixture-pkg/src/a.ts"]);
  try {
    assert.equal(runGenerator(root).status, 0, "生成仍应成功（判据在 --check）");
    const check = runGenerator(root, ["--check"]);
    assert.equal(check.status, 1, `有效面为空必须判红：\n${check.out}`);
    assert.match(check.out, /判据⑥ 有效面为空/, "判词必须点名判据⑥");
    assert.match(check.out, /fixture-pkg-only\.json/, "判词必须点名是哪份 conf");
    assert.doesNotMatch(
      check.out,
      /条目腐烂|内容与拓扑派生不一致|登记完整性/,
      `红必须是判据⑥ 自己产生的，而不是别的判据顺带报出来的：\n${check.out}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * #843 计划项 3-1 判据⑦ 的单元面（包级变异面并集棘轮）。
 *
 * 为什么还要单元面：E2E（stryker-conf-layers.test.ts）证明的是「攻击在门禁上被判红」，这里钉的是
 * 判据的**语义细节**——段与段互不串台、真删除的判法、载体自证的计数口径。这些细节错了 E2E 未必红
 * （例如把各段 excludes 汇总后再剔除所有正向条目，攻击照样红，但「段间挪动」会被误判成收缩）。
 */
test("#843 判据⑦ 单元：并集按段分别求值（除外不串台）、段间挪动合法", () => {
  const root = mkdtempSync(join(tmpdir(), "f843-face-"));
  try {
    for (const rel of [
      "packages/p/src/a.ts",
      "packages/p/src/b.ts",
      "packages/p/src/client/ui.ts",
    ]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), "export const x = 1\n", "utf8");
    }
    const expand = (pattern: string) => globFiles(root, pattern);
    const pkg = (segments: unknown) => ({ segments });

    // 段 1 变异 a.ts；段 2 的 excludes 排掉 a.ts（而 a.ts 并不在段 2 的正向面里）。
    // Stryker 逐份 conf 求值：段 1 的 conf 里 a.ts 仍是变异体，故并集必须含 a.ts。
    // 若实现把各段 excludes 汇总成一份全局排除面，这里会算出 {b.ts} —— 段间挪动就会被误判成收缩。
    const perSeg = pkg({
      s1: { mutate: ["packages/p/src/a.ts"], excludes: ["!packages/p/src/client/**"] },
      s2: { mutate: ["packages/p/src/b.ts"], excludes: ["!packages/p/src/a.ts"] },
    });
    assert.deepEqual(
      [...packageMutationFace(perSeg, expand)].sort(),
      ["packages/p/src/a.ts", "packages/p/src/b.ts"],
      "并集必须逐段求值后取并（段 2 的除外不得吃掉段 1 的正向面）",
    );
    const moved = pkg({
      s1: { mutate: ["packages/p/src/b.ts"], excludes: ["!packages/p/src/client/**"] },
      s2: { mutate: ["packages/p/src/a.ts"], excludes: ["!packages/p/src/client/**"] },
    });
    const movedRes = mutationFaceRatchetProblems({
      baseTopology: { packages: { p: perSeg } },
      headTopology: { packages: { p: moved } },
      expand,
    });
    assert.deepEqual(movedRes.problems, [], "段间挪动（并集不变）不得判红");
    assert.deepEqual(
      [movedRes.packagesCompared, movedRes.filesCompared],
      [1, 2],
      "载体自证口径：进入比对面的包数 / 段正向命中的候选文件数",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#843 判据⑦ 单元：收缩判红点名包与文件；真删除不判红；豁免按缺口消费、失效即反腐烂", () => {
  const root = mkdtempSync(join(tmpdir(), "f843-face2-"));
  try {
    for (const rel of ["packages/p/src/a.ts", "packages/p/src/b.ts"]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), "export const x = 1\n", "utf8");
    }
    const expand = (pattern: string) => globFiles(root, pattern);
    const seg = (mutate: string[], excludes: string[] = ["!packages/p/src/client/**"]) => ({
      segments: { only: { mutate, excludes } },
    });
    const base = { packages: { p: seg(["packages/p/src/a.ts", "packages/p/src/b.ts"]) } };
    const attacked = {
      packages: {
        p: seg(["packages/p/src/b.ts"], ["!packages/p/src/client/**", "!packages/p/src/a.ts"]),
      },
    };

    const hit = mutationFaceRatchetProblems({
      baseTopology: base,
      headTopology: attacked,
      expand,
    });
    assert.equal(hit.problems.length, 1, `只该报一条收缩：${hit.problems.join(" | ")}`);
    assert.match(hit.problems[0], /\[p\]/, "判词要点名包");
    assert.match(hit.problems[0], /packages\/p\/src\/a\.ts/, "判词要点名收缩掉的文件");

    // 豁免唯一通道：键 = <包名>:<文件>（或 <包名>:*），命中即放行且被记为「已消费」
    for (const key of ["p:packages/p/src/a.ts", "p:*"]) {
      const exempted = mutationFaceRatchetProblems({
        baseTopology: base,
        headTopology: attacked,
        expand,
        exemptions: new Map([[key, {}]]),
      });
      assert.deepEqual(exempted.problems, [], `已登记的收缩应放行（${key}）`);
    }
    // 错键：既不放行收缩，自身也按反向腐烂判红（一条豁免不得顺带关掉别的缺口）
    const wrong = mutationFaceRatchetProblems({
      baseTopology: base,
      headTopology: attacked,
      expand,
      exemptions: new Map([["p:packages/p/src/b.ts", {}]]),
    });
    assert.equal(wrong.problems.length, 2, `错键应报两条：${wrong.problems.join(" | ")}`);
    assert.match(wrong.problems.join(" | "), /没有对应的收缩缺口/);

    // 真删除：a.ts 从磁盘消失并从拓扑摘掉 → 基准面在 head 世界里展开后不含它 → 不判红
    rmSync(join(root, "packages/p/src/a.ts"));
    const deleted = mutationFaceRatchetProblems({
      baseTopology: base,
      headTopology: { packages: { p: seg(["packages/p/src/b.ts"]) } },
      expand,
    });
    assert.deepEqual(deleted.problems, [], "真删除属正当收缩");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#843 判据⑦ 单元：载体自证 —— 包集合为空 / 基准 mutate 不命中任何文件都判红", () => {
  const root = mkdtempSync(join(tmpdir(), "f843-face3-"));
  try {
    mkdirSync(join(root, "packages/p/src"), { recursive: true });
    writeFileSync(join(root, "packages/p/src/a.ts"), "export const x = 1\n", "utf8");
    const expand = (pattern: string) => globFiles(root, pattern);
    const only = (mutate: string[]) => ({
      segments: { only: { mutate, excludes: ["!packages/p/src/client/**"] } },
    });

    const empty = mutationFaceRatchetProblems({
      baseTopology: { packages: {} },
      headTopology: { packages: {} },
      expand,
    });
    assert.equal(empty.problems.length, 1, `空包集只该报空转：${empty.problems.join(" | ")}`);
    assert.match(empty.problems[0], /变异面棘轮空转/);
    assert.match(empty.problems[0], /包 0 个、候选文件 0 个/);

    // 包在、但基准的 mutate 面不命中任何现存文件（基因组被换成不存在的路径）→ 同样是「没有载体」
    const ghost = mutationFaceRatchetProblems({
      baseTopology: { packages: { p: only(["packages/p/src/ghost.ts"]) } },
      headTopology: { packages: {} },
      expand,
    });
    assert.equal(ghost.packagesCompared, 1, "包确实进入了比对面");
    assert.equal(ghost.filesCompared, 0, "但候选文件为 0");
    assert.match(ghost.problems.join(" | "), /变异面棘轮空转/);

    // 对照组：有载体时不得报空转（判据不是「凡输入皆红」）
    const ok = mutationFaceRatchetProblems({
      baseTopology: { packages: { p: only(["packages/p/src/*.ts"]) } },
      headTopology: { packages: { p: only(["packages/p/src/*.ts"]) } },
      expand,
    });
    assert.deepEqual([ok.problems, ok.packagesCompared, ok.filesCompared], [[], 1, 1]);

    test("P2: 段 testFiles 形状（缺席/非法/空条目判红，星号与数组放行）", () => {
      assert.match(segmentTestShapeProblems("p", "s", {}).join(), /缺 testFiles 声明/);
      assert.match(segmentTestShapeProblems("p", "s", { testFiles: 3 }).join(), /须是数组/);
      assert.match(segmentTestShapeProblems("p", "s", { testFiles: [""] }).join(), /非空字符串/);
      assert.deepEqual(segmentTestShapeProblems("p", "s", { testFiles: "*" }), []);
      assert.deepEqual(segmentTestShapeProblems("p", "s", { testFiles: ["a.test.ts"] }), []);
    });

    test("P2: 测试面并集恒等（缺口/越界判红，空转自证）", () => {
      const eq = segmentTestUnionProblems({
        pkgName: "p",
        packageFace: ["a", "b"],
        union: ["b", "a"],
      });
      assert.deepEqual([eq.problems, eq.compared], [[], 2]);
      const gap = segmentTestUnionProblems({ pkgName: "p", packageFace: ["a", "b"], union: ["a"] });
      assert.match(gap.problems.join(), /缺口.*b/);
      const over = segmentTestUnionProblems({
        pkgName: "p",
        packageFace: ["a"],
        union: ["a", "x"],
      });
      assert.match(over.problems.join(), /越界.*x/);
    });

    test("P2: 段测试面解析（回落/显式/R3 越界面/空面）", () => {
      const face = ["packages/dsh-notifier/test/unit/a.test.ts"];
      const fb = resolveSegmentTestFiles({
        root: ROOT,
        segDef: { testFiles: "*" },
        segLabel: "[p:s]",
        packageFace: face,
      });
      assert.deepEqual([fb.mode, fb.files, fb.errors], ["fallback", face, []]);
      assert.equal(fb.files === face, false, "回落须拷贝，不得别名包级面");
      const miss = resolveSegmentTestFiles({
        root: ROOT,
        segDef: {},
        segLabel: "[p:s]",
        packageFace: face,
      });
      assert.equal(miss.mode, "missing");
      assert.match(miss.errors.join(), /缺 testFiles 声明/);
      const bad = resolveSegmentTestFiles({
        root: ROOT,
        segDef: { testFiles: ["packages/dsh-notifier/test/e2e/smoke.test.ts"] },
        segLabel: "[p:s]",
        packageFace: face,
      });
      assert.match(bad.errors.join(), /不在包级变异面内/);
      const empty = resolveSegmentTestFiles({
        root: ROOT,
        segDef: { testFiles: [] },
        segLabel: "[p:s]",
        packageFace: [],
      });
      assert.match(empty.errors.join(), /为空/);
    });

    test("P2: 段并集 helper（多段合并去重排序）", () => {
      assert.deepEqual(segmentTestUnion({ a: { files: ["b", "a"] }, c: { files: ["c", "a"] } }), [
        "a",
        "b",
        "c",
      ]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
