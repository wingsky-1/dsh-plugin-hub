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

/** 登记是不是对象（.mjs 的 isPlainObject 推断出 boolean 而非类型守卫，故本地收窄）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * `coverageExcludes` 这个键出现在一份包登记的**任何**位置（包级 / testLayers 下 / 段里）。
 *
 * 唯一合法位置是 `testLayers` 下（见 mutation-topology.mjs 的 misplacedCoverageExcludesProblems：
 * 写错位置不报错、不进派生 conf，整组条目就此静默离开取值面与形状校验面）。
 */
function coverageExcludeKeyWhere(pkgDef: Record<string, unknown>): string | null {
  if (Object.hasOwn(pkgDef, "coverageExcludes")) return "包级";
  if (isRecord(pkgDef.testLayers) && Object.hasOwn(pkgDef.testLayers, "coverageExcludes")) {
    return "testLayers 下";
  }
  if (isRecord(pkgDef.segments)) {
    for (const [segKey, segDef] of Object.entries(pkgDef.segments)) {
      if (isRecord(segDef) && Object.hasOwn(segDef, "coverageExcludes")) return `段 "${segKey}" 里`;
    }
  }
  return null;
}

/**
 * 派生口径：coverageExcludes 形状校验的**对象**取「登记里任何位置出现 `coverageExcludes` 键」的
 * 包，按包名排序返回。
 *
 * 口径落在「键在场」而不是包名或条数上——包名清单与计数清单都是必须跟着代码走的漂移源，键在场是
 * 形状事实。值为非数组（形状错误）也留在面内：否则形状错误会被派生层当「没登记」静默吃掉。
 *
 * 为什么是「任何位置」而不只是 `testLayers` 下（本用例自身实测过的退化）：只认 testLayers 下那个键时，
 * 把某包整组条目挪到包级就会让该包**逐个**退出校验面，而载体自证只认「声明包数 == 0」这一种全局退化——
 * 另三包仍在声明时 `declared.length > 0` 照常成立，形状校验一条都没少判却看不出（实测：4 个声明包全挪走
 * 后本文件 31 条全绿）。把挪错位置的包留在面内，它才会被下面的位置断言点名。
 */
function declaredCoverageExcludePackages(topology: {
  packages?: Record<string, unknown>;
}): string[] {
  const declared: string[] = [];
  for (const [name, def] of Object.entries(topology.packages ?? {})) {
    if (!isRecord(def)) continue;
    if (coverageExcludeKeyWhere(def) !== null) declared.push(name);
  }
  return declared.sort();
}

test("P2 root-shared：真实拓扑精确登记两段变异面（settings-namespace + client）", () => {
  const topology = JSON.parse(readFileSync(TOPOLOGY_PATH, "utf8"));
  // 闭枚举快照：$rootShared 的**全部**段连同 comment 逐字钉住。#1074 起是两段（此前只有
  // settings-namespace 一段）。少一段=漏登记，多一段=凭空冒出来的未登记段——两种都判红。
  assert.deepEqual(topology.$rootShared, {
    testRoot: "shared",
    testPattern: "test/**/*.mutation.test.ts",
    threshold: 60,
    segments: {
      "settings-namespace": {
        mutate: ["shared/settings-namespace.ts"],
        excludes: [],
        testFiles: ["shared/test/settings-namespace.mutation.test.ts"],
        comment:
          "Phase 5 P2：lan/mcp 共同运行时接缝；descriptor/source/onChange 与写入委托由独立 Vitest 行为判据直接覆盖。",
      },
      client: {
        mutate: ["shared/client/ensure-style.ts", "shared/client/i18n.ts"],
        excludes: [],
        testFiles: ["shared/test/shared-client.mutation.test.ts"],
        comment:
          "新增（#1074）：shared/client 的**直连 .ts 源**判据。这两个文件此前记在 scripts/test/ 下的两个 node:test 文件里，import 的是 `shared/client/ensure-style.js` / `i18n.js`——**tsc 原地 emit 的产物**，被 shared 下的 .js not-source 条目排除，istanbul 计的是那个被 import 的 .js，.ts 源因此恒 0%；且那两个文件跑在 `node --test` 上，**根本不属于任何 vitest project**（vitest projects 的 include 恒带 `packages/*/` 前缀，见 coverage.config.json 里 shared/client/** 那条的 reason）。故 coverage.config.json 的 shared/client/** 豁免**从建立起就诚实**：它记的是「这个源没有任何可计分的判据」。本段修的是**根因**——判据换成 import `.ts` 源并落到 vitest 的 root-shared 面，判据一落位，豁免自然消失，不必单独去改台账。**为什么这两个文件没有登记进包级变异面资格**：`layerMeta` 的 assertionTarget 判据只覆盖 `$testLayers.layers`（包级六层），root-shared 面是独立一组 project，其断言对象是 shared 的直连源码、不属于任何包的 test/ 层，故不进包的变异面并集。**面内可变异的是什么**：`ensure-style.ts` 的注入/幂等/version 重建/disposer 路径，与 `i18n.ts` 的 bindLocale 活绑定与防御分支。**纯字面量表为何不逐个排除、而靠 sharedDefaults.excludedMutations**：仓内既有先例见本文件 `packages/dsh-notifier` 的 `channels` 段——「#769 批 4 加围栏拒答 code 表（refusal.ts，纯数据无变异体）」；该形态由 `sharedDefaults.excludedMutations` 的 StringLiteral / ArrayLiteral / ObjectLiteral / TemplateLiteral 四项统一排除，逐个登记只会**增加每个段的 dry run 成本、杀灭贡献为零**。本段不逐文件登记字面量表，同此纪律。",
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
        mutate: ["shared/settings-namespace.ts"],
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
    pattern === "shared/settings-namespace.ts" ? ["shared/settings-namespace.ts"] : [];
  const sharedDefaults = { excludedMutations: ["StringLiteral"] };
  const ratchet = mutationFaceRatchetProblems({
    baseTopology: { sharedDefaults, packages: {}, $rootShared: valid },
    headTopology: { sharedDefaults, packages: {} },
    expand,
  });
  assert.deepEqual([ratchet.packagesCompared, ratchet.filesCompared], [1, 1]);
  assert.match(ratchet.problems.join(), /\[\$rootShared\].*shared\/settings-namespace\.ts/);
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
  const missingExcludesProblems = specs?.problems ?? [];
  assert.ok(
    missingExcludesProblems.some((p) => p.includes('段 "noExcludes"') && p.includes("excludes")),
    `缺 excludes 的段必须判红并点名段名：${missingExcludesProblems.join(" | ")}`,
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

/**
 * coverageExcludes 的形状校验：**对象**是「每一个声明了 coverageExcludes 的登记包」（按上面的派生口径，
 * 即键出现在登记任何位置），从拓扑派生，不手挑包名。
 *
 * 为什么对象必须是派生的（本条的由来）：一份手挑的包名清单是「必须跟着代码走的清单」，登记里
 * 新增豁免的包（本轮实测即 dsh-lan-proxy 的 2 条）整段落空，而用例名与断言却声称覆盖全部登记包——
 * 过度声称。此时形态回归对清单外的包恒绿：裸 glob / 缺 pattern / reason 过短 / 未知 kind 都打不
 * 红它（已实测：把 dsh-lan-proxy 某条 kind 改成非法值、把另一条退化成裸字符串，本用例 30 条全绿）。
 *
 * 规模（每包条数、总条数）是**报告不是断言**：写死总数等于把清单复制进测试，于是下一次有意的登记
 * 动作必须改测试代码——那既制造漂移源，又让「数量变了」在 diff 里被当成测试改动顺带溜过。
 * 「加豁免必须是有意的登记动作」这条关切由谁接，写在本用例末尾的注释里。
 */
test("#773 R4：每个声明 coverageExcludes 的登记包都逐条过形状校验（对象派生，规模只报告）", (t) => {
  const topology = JSON.parse(readFileSync(TOPOLOGY_PATH, "utf8"));
  const registered = Object.entries(topology.packages) as Array<
    [string, { testLayers?: Record<string, unknown> }]
  >;
  const declaredNames = new Set(declaredCoverageExcludePackages(topology));
  const declared = registered.filter(([name]) => declaredNames.has(name));
  // 载体自证：派生集合为空 = 一条都没判，恒绿；这是判红不是跳过（与判据⑤⑥⑦ 同一纪律）。
  // 它只兜**全局**退化；逐包退化由下面的位置断言兜住（两者不可互相替代，见派生口径的注释）。
  assert.ok(
    declared.length > 0,
    "没有任何登记包声明 coverageExcludes（形状校验一条都没判，不得恒绿）",
  );

  const allReasons: string[] = [];
  const rows: string[] = [];
  let total = 0;
  for (const [pkgName, pkgDef] of declared) {
    // 位置先判：条目写在 testLayers 之外时下面那条 Array.isArray 会以「必须是数组」的形态报错，
    // 指不到真正的病根（键挪了地方，而不是类型不对）。
    assert.equal(
      coverageExcludeKeyWhere(pkgDef),
      "testLayers 下",
      `${pkgName} 把 coverageExcludes 登记在了 testLayers 之外——唯一合法位置是 testLayers 下` +
        `（门禁侧同一判据见 packageEntryProblems，判词：scripts/gate/mutation-topology.mjs）`,
    );
    const entries = pkgDef.testLayers?.coverageExcludes;
    assert.ok(Array.isArray(entries), `${pkgName} 的 coverageExcludes 必须是数组`);
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
    rows.push(`${pkgName}=${entries.length}`);
    total += entries.length;
  }
  assert.equal(
    new Set(allReasons).size,
    allReasons.length,
    "每条排除都是独立裁决，reason 不得复制同一句（跨全部声明包去重）",
  );
  // 规模是报告不是断言：`pnpm test:scripts` 的输出里能直接看到「谁、多少条」，
  // 评审 diff 时不必去数，也就不必在测试里维护第二份计数。
  t.diagnostic(
    `coverageExcludes 登记面：${declared.length}/${registered.length} 个登记包声明，共 ${total} 条（${rows.join(" / ")}）`,
  );

  // 「数量变化必须是有意的登记动作」这条关切，去掉计数后机器还接得住多少（逐层如实，均已实跑）：
  // 1) 形状层（本用例）：每条 entry 的 pattern/reason/kind、重复 pattern、复制 reason——机器化，且
  //    对象是「每个声明包」，新增登记包不会再掉出校验面。
  // 2) 有效裁剪层（既有判据⑦ `mutationFaceRatchetProblems`，gen-stryker-conf --check 跑）：新增一条
  //    coverageExcludes 若真把在面文件挪出本分支的变异面，就是一次并集收缩，与 origin/main 比对即判红
  //    （实测 exit 1）。唯一放宽通道是 gate-exemptions.json 里 gate=mutation-face 的台账条目——
  //    「有意的登记动作」在机器上留下的痕迹正是这条台账，不需要测试再记一份计数。
  // 3) 幽灵 glob（判据⑤ 存在性）：glob 在源码世界命中 0 个文件即判红（实测 exit 1）。
  // 4) 不可机器化的一层：glob 命中磁盘上真实存在、但当前不在任何段正向面里的文件（例如
  //    `!src/server/**/interface.ts`——服务端 8 个段的 mutate 都是显式文件，不含 interface.ts）。
  //    这类「口径声明」判据⑤⑥⑦ 与形状校验全都看不见（实测 gen-stryker-conf --check exit 0 通过）：
  //    机器无法区分「为将来形态兜底的有意声明」与「悄悄多加一条面不痛的排除」。改由 PR review
  //    承接——它是四条里唯一需要人裁决的，形状/数量/裁剪三类回归已不再依赖它。
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

/**
 * 本用例的「对象派生」这一层自身的反证：筛选口径落在「登记里该键在场」上，
 * 不是包名、也不是条数。派生逻辑抽成纯函数后逐形态判红——派生写错（键名写死、只认真值、
 * 漏了非数组形态、只认 testLayers 而漏掉挪错位置的）都会在这里被打红，而不是退化成静默少判几个包。
 */
test("#773 R4 反证：声明包派生口径（键在场即入面；非对象 / 无键都不入面；挪错位置仍入面）", () => {
  // 判定落在「键在场」：值为非数组（形状错误）也必须入面，否则 shape 错误会被派生层静默吃掉。
  assert.deepEqual(
    declaredCoverageExcludePackages({
      packages: {
        "a-good": { testLayers: { coverageExcludes: ["!x"] } },
        "b-nonarray": { testLayers: { coverageExcludes: "!x" } },
        "c-emptyarray": { testLayers: { coverageExcludes: [] } },
        "d-nokey": { testLayers: { other: 1 } },
        e: { testLayers: { coverageExcludes: ["!x"] } },
        f: {},
        g: { testLayers: null },
        h: { testLayers: "nope" },
        i: null,
        // 以下三种是「键在场但位置非法」：必须留在校验面内，由位置断言点名。只认 testLayers 下
        // 那个键的话，它们会静默退出校验面（实测：四个声明包全挪走后本文件 31 条全绿）。
        "j-pkglevel": { coverageExcludes: ["!x"], segments: { s: {} } },
        "k-seglevel": { segments: { s: { coverageExcludes: ["!x"] } } },
        "l-both": { coverageExcludes: ["!x"], testLayers: { coverageExcludes: ["!x"] } },
        // testLayers 非对象时键仍可能在别处：只认「testLayers 是对象」的那一层会把它吃掉。
        m: { testLayers: "nope", coverageExcludes: ["!x"] },
      } as never,
    }),
    ["a-good", "b-nonarray", "c-emptyarray", "e", "j-pkglevel", "k-seglevel", "l-both", "m"],
    "派生只认「登记是对象 + coverageExcludes 键在登记任何位置在场」；非数组/空数组是形状错误、位置非法是登记错误，两者都必须留在校验面内",
  );
  // 位置判词本身：三个非法位置各自说清「在哪」，对照组给出唯一合法位置。
  assert.equal(coverageExcludeKeyWhere({ testLayers: { coverageExcludes: [] } }), "testLayers 下");
  assert.equal(coverageExcludeKeyWhere({ coverageExcludes: [] }), "包级");
  assert.equal(coverageExcludeKeyWhere({ segments: { s: { coverageExcludes: [] } } }), '段 "s" 里');
  assert.equal(
    coverageExcludeKeyWhere({ testLayers: {}, segments: { s: { excludes: [] } } }),
    null,
  );
  // 对照组：无人声明即空集（真实拓扑里的空集由上一条用例的载体自证判红，不在此处静默放过）
  assert.deepEqual(
    declaredCoverageExcludePackages({ packages: { a: {}, b: { testLayers: {} } } }),
    [],
  );
});

/**
 * P2-2 反证（E2E）：把 coverageExcludes 挪出 testLayers（挪到包级 / 段级）必须两道门禁都判红。
 *
 * 为什么必须单立一条 E2E：本条修复前的实测形态是**两道门禁双双 exit 0**——挪位置不报错，派生 conf
 * 静默少出这些条目展开的全部 mutate 条目（实测 305 → 285），而形状校验面已不再看它们。单元面能证明
 * 判词函数判红，证明不了判红真的接到了两个调用点上（gen-stryker-conf 的形状关与 verify-dir-imports 的
 * `collectMutationSpecs` → `topologyProblems` 是两条独立通路）。
 *
 * fixture 用 `mkdtempSync` 隔离根，登记一份最小可派生拓扑：判据落在形状关上，故不要求 conf 已在盘。
 */
test("P2-2 反证：coverageExcludes 挪出 testLayers → gen-stryker-conf 与 verify-dir-imports 都判红", () => {
  const valid = {
    pattern: "!packages/fixture-pkg/src/client/**",
    reason: "这是一条足够长的理由说明",
    kind: "not-source",
  };
  const runBoth = (pkgDef: Record<string, unknown>) => {
    const root = mkdtempSync(join(tmpdir(), "p2-2-misplaced-"));
    try {
      for (const [rel, content] of Object.entries({
        "packages/fixture-pkg/src/a.ts": "export const a = 1\n",
        "packages/fixture-pkg/src/client/ui.ts": "export const b = 2\n",
      })) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), content, "utf8");
      }
      mkdirSync(join(root, "scripts", "data"), { recursive: true });
      writeFileSync(
        join(root, "scripts", "data", "mutation-topology.json"),
        `${JSON.stringify({ sharedDefaults: {}, packages: { "fixture-pkg": pkgDef } }, null, 2)}\n`,
        "utf8",
      );
      const gen = spawnSync(process.execPath, [GENERATOR, "--check"], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, GEN_STRYKER_ROOT: root, GEN_STRYKER_BASE: "HEAD" },
      });
      const vdi = spawnSync(process.execPath, [VERIFY_DIR_IMPORTS, "--package", "fixture-pkg"], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, VERIFY_DIR_IMPORTS_ROOT: root },
      });
      return {
        gen: { status: gen.status, out: `${gen.stdout ?? ""}${gen.stderr ?? ""}` },
        vdi: { status: vdi.status, out: `${vdi.stdout ?? ""}${vdi.stderr ?? ""}` },
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const segment = { mutate: ["packages/fixture-pkg/src/**/*.ts"], excludes: [] };

  // 攻击形态：整组条目挪到包级。形状合法（是对象、键名对），只是位置不在 testLayers 下。
  for (const [name, pkgDef] of Object.entries({
    包级: { coverageExcludes: [valid], segments: { only: segment } },
    段级: { segments: { only: { ...segment, coverageExcludes: [valid] } } },
  })) {
    const { gen, vdi } = runBoth(pkgDef);
    assert.equal(gen.status, 1, `挪到${name}必须让 gen-stryker-conf 判红：\n${gen.out}`);
    assert.match(gen.out, /coverageExcludes/, "判词要点名是 coverageExcludes 这一项");
    assert.equal(vdi.status, 1, `挪到${name}必须让 verify-dir-imports 判红：\n${vdi.out}`);
    assert.match(vdi.out, /coverageExcludes/, "判词要点名是 coverageExcludes 这一项");
  }

  // 对照组：同一个条目写在唯一合法位置 → 位置判据不得误报。
  // （fixture 缺 conf/stryker 基线，gen 仍会因别的判据红，故只断言「位置判词不在输出里」。）
  const ok = runBoth({ testLayers: { coverageExcludes: [valid] }, segments: { only: segment } });
  assert.doesNotMatch(
    ok.gen.out,
    /coverageExcludes 只能写在|不认 coverageExcludes/,
    `合法位置不得被判红（gen）：\n${ok.gen.out}`,
  );
  assert.doesNotMatch(
    ok.vdi.out,
    /coverageExcludes 只能写在|不认 coverageExcludes/,
    `合法位置不得被判红（vdi）：\n${ok.vdi.out}`,
  );
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
function confFileName(base: string, segKey: string): string {
  return segKey === "_single" ? `${base}.json` : `${base}-${segKey}.json`;
}

function confOwnerOf(
  topology: {
    packages?: Record<string, { segments?: Record<string, unknown> }>;
    $rootShared?: { segments?: Record<string, unknown> };
  },
  fileName: string,
) {
  // 归属候选按「packages 声明序 → shared」的固定次序铺平：次序即优先级，
  // 命中即返回，与派生侧 confOwners 的查找序一致。
  const owners: [string, Record<string, unknown> | undefined][] = [];
  for (const [pkgName, pkgDef] of Object.entries(topology.packages ?? {})) {
    owners.push([pkgName, pkgDef.segments]);
  }
  owners.push(["shared", topology.$rootShared?.segments]);
  for (const [owner, segments] of owners) {
    for (const segKey of Object.keys(segments ?? {})) {
      if (confFileName(owner, segKey) === fileName) return owner;
    }
  }
  return undefined;
}

/** #836 反证用的最小仓库根：一份 conf 的 mutate 面完全由段声明决定。 */
// excludes 取 undefined 时 JSON 落盘丢键，正是「段没写 excludes」的形态（见调用方注释）。
//
// rootLayers 同理：默认给一份**合法且非零命中**的登记（形状契约的对照组），传
// ABSENT_ROOT_LAYERS 则整个键在 JSON 里消失 = 「rootLayers 整节缺席」那条反证形态；传非法值则是
// 第三条反证。哨兵不能用 undefined —— 显式传 undefined 会触发默认参数，构造不出「整节缺席」。
const ABSENT_ROOT_LAYERS = Symbol("absent-rootLayers");

function makeMutationFixture(
  excludes: string[] | undefined,
  rootLayers: unknown = { "fixture-unit": "packages/*/test/unit/*.test.ts" },
) {
  // 哨兵折成 undefined：JSON.stringify 遇到 undefined 的属性会直接丢键，整节即缺席。
  const declaredRootLayers = rootLayers === ABSENT_ROOT_LAYERS ? undefined : rootLayers;
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
            bundle: "test/bundle/**/*.test.ts",
            e2e: "test/e2e/**/*.test.ts",
          },
          // 变异面资格由 layerMeta.assertionTarget 派生，两个手写列表键已删。
          layerMeta: {
            unit: { assertionTarget: "src", environment: "node", mandatory: true },
            integration: { assertionTarget: "src", environment: "node", mandatory: false },
            bundle: { assertionTarget: "artifact", environment: "node", mandatory: false },
            e2e: { assertionTarget: "live", environment: "node", mandatory: false },
          },
          // 形状契约必填项（#1074）：rootLayers 是 vitest 第二组 project 的唯一事实源。
          // 默认值指向本 fixture 自带的 packages/fixture-pkg/test/unit/unit-a.test.ts，零命中为假；
          // 传 ABSENT_ROOT_LAYERS 时下面的 declaredRootLayers 是 undefined，落盘即整节缺席。
          rootLayers: declaredRootLayers,
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

/**
 * #1074：rootLayers 的形状与零命中判据（gen-stryker-conf.mjs 的 rootLayerProblems）。
 *
 * 为什么零命中必须 **fail-closed**——判据存在的唯一理由，构造与退出码均为实测（mkdtemp 内真跑
 * vitest 4.1.11，两次分别复现）：
 *
 *   projects: [ {name:probe-has-files, include: <abs>/a.probe.test.ts},
 *               {name:probe-empty,     include: test/does-not-exist-*.test.ts} ]
 *   npx vitest run --project probe-has-files --project probe-empty
 *     → Test Files 1 passed (1)、Tests 1 passed (1)、**exit 0**，输出全程**零字**提到 probe-empty
 *   npx vitest run --project probe-empty          // 单独选它
 *     → No test files found, exiting with code 1、exit 1
 *
 * 即空 project 的报错**只在它是唯一选择时成立**；真实运行（pnpm cov、stryker 的 vitest runner）
 * 永远同时带着别的 project，那条报错**永不触发**。所以「运行期会不会发现」这个问题本身答案是
 * 「不会」——一个拼错的 rootLayers（段序写反、加错前缀）会让覆盖率照常绿、该 project 的判据
 * 永不执行，而没有任何一条判词指出这件事。故形状与零命中都必须在**生成期**判红。
 */
test("#1074 反证：rootLayers 的 glob 零命中 ⇒ 判红并点名该层与该 glob", () => {
  // 段序写反 / 加错前缀的典型形态：glob 指向磁盘上不存在的路径（收集 0 个文件）。
  const root = makeMutationFixture([], { "shared-mutation": "shared/test/**/*.mutation.test.ts" });
  try {
    const res = runGenerator(root);
    assert.equal(res.status, 1, `零命中必须判红：\n${res.out}`);
    assert.match(res.out, /rootLayer "shared-mutation"/, "判词要点名是哪个层");
    assert.match(
      res.out,
      /shared\/test\/\*\*\/\*\.mutation\.test\.ts/,
      "判词要点名那条 glob（否则改错的人不知道该改什么）",
    );
    assert.match(res.out, /零命中/, "判词要点明是零命中而不是别的形状问题");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1074 反证：rootLayers 整节缺席 ⇒ fail-closed 判红（不得静默退化为「没有 root 层」）", () => {
  // rootLayers 是 vitest 第二组 project 的**唯一**事实源。整节缺席 = 那一组 project 整体消失，
  // 与零命中同属无判据的静默，故按必填处理。
  const root = makeMutationFixture([], ABSENT_ROOT_LAYERS);
  try {
    const res = runGenerator(root);
    assert.equal(res.status, 1, `整节缺席必须判红：\n${res.out}`);
    assert.match(res.out, /\$testLayers\.rootLayers 缺失或形状不合法/, "判词要点名缺的是哪一节");
    assert.match(res.out, /fail-closed/, "判词要写明是 fail-closed 而非降级放行");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** [用例名, 非法 rootLayers 形态]：整节非法，以及在场但条目非法的三种。 */
const BAD_ROOT_LAYERS: Array<[string, unknown]> = [
  ["整节不是对象（字符串）", "nope"],
  ["整节是数组", ["packages/*/test/unit/*.test.ts"]],
  ["整节是 null", null],
  ["条目值不是字符串", { "fixture-unit": 42 }],
  ["条目值是空串", { "fixture-unit": "   " }],
];
for (const [label, bad] of BAD_ROOT_LAYERS) {
  test(`#1074 反证：rootLayers ${label} ⇒ 判红`, () => {
    const root = makeMutationFixture([], bad);
    try {
      const res = runGenerator(root);
      assert.equal(res.status, 1, `${label} 必须判红：\n${res.out}`);
      assert.match(res.out, /rootLayer|rootLayers/, `判词要点名是 rootLayers 这一节：\n${res.out}`);
      assert.doesNotMatch(
        res.out,
        /TypeError|is not iterable|Cannot read/,
        `形状错误不得以抛栈形态出现：\n${res.out}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("#1074 对照组：rootLayers 合法且非零命中 ⇒ 生成成功（证明上面几条红来自判据本身）", () => {
  const root = makeMutationFixture([]);
  try {
    const res = runGenerator(root);
    assert.equal(res.status, 0, `对照组应生成成功：\n${res.out}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
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
