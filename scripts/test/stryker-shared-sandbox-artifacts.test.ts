"use strict";

/**
 * #875 回归：shared/ 段的 Stryker 沙箱必须排除 shared 的 tsc 原地 emit 产物。
 *
 * 缺陷形态（不是「测试没判别力」，是测量对象整个消失）：
 *   shared/tsconfig.json 是 outDir "." 原地 emit，产物 shared/*.js 与源码同目录；
 *   而 shared/test/settings-namespace.mutation.test.ts import 的是 "../settings-namespace.js"。
 *   夜间分片顺序是 install → build → stryker，产物在盘时解析器命中它、被变异的 .ts 压根
 *   不在测试的模块图里——336 个变异体一个都没激活，全 survived，分数 0.00、退出码 1。
 *   实测（#875 夜间 run 36356410110 与本地基线逐字一致）：0 killed / 336 survived。
 *
 * 本守卫断言的是派生契约（conf 里必须有那几条 ignorePatterns），不是分数：分数要真跑一遍
 * stryker（分钟级、还要先 build），不适合进门禁。派生契约由 stryker:check 的「磁盘 ↔ 派生
 * 严格比对」在真实仓库上兜住，本文件负责在 fixture 里把规则与它的边界钉住。
 *
 * 覆盖（含逐条反向用例，防「门禁写得像门禁」）：
 *   ① mutate 命中 shared/ 的段必须派生产物 ignorePatterns；
 *   ② 只排除（! 开头）不构成变异面，不得因此派生；
 *   ③ mutate 只命中 packages/ 的段不得带该字段（7 个包 outDir 是 lib，产物不进源码树，
 *      加了纯属噪音，且会让人误以为全仓都在原地 emit）；
 *   ④ 真实仓库的 shared 段 conf 已带上该字段，且只有它带（防规则扩散 / 防漏重生成）；
 *   ⑤ 形态不变量：shared 下无被追踪的 .js/.d.ts——否则 ignorePatterns 会误伤应被变异的源码。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..", "..");
const GENERATOR = join(ROOT, "scripts", "gate", "gen-stryker-conf.mjs");
const PKG = "fixture-pkg";
const PKG_MUTATE = "packages/" + PKG + "/src/**/*.ts";

/** 判据里的三条产物形态：与 generator 的 SHARED_BUILD_ARTIFACT_IGNORE_PATTERNS 同值。 */
const EXPECTED = ["shared/**/*.js", "shared/**/*.d.ts", "shared/**/*.tsbuildinfo"];

/** runGenerator 的返回形状：只看退出码与合并输出（生成器的判词走 stdout/stderr 两路）。 */
interface GeneratorResult {
  status: number | null;
  out: string;
}

/** 派生出的 conf 只按需取键，故键值放宽到 unknown；断言一律写死期望值。 */
type DerivedConf = Record<string, unknown>;

function makeTopology(sharedMutate: string[]): Record<string, unknown> {
  return {
    $testLayers: {
      layers: { unit: "test/unit/**/*.test.ts", bundle: "test/bundle/**/*.test.ts" },
      // 变异面资格由 layerMeta.assertionTarget 派生，两个手写列表键已删。
      layerMeta: {
        unit: { assertionTarget: "src", environment: "node", mandatory: true },
        bundle: { assertionTarget: "artifact", environment: "node", mandatory: false },
      },
      // 形状契约必填项：rootLayers 是 vitest 第二组 project 的唯一事实源，缺席即 fail-closed
      // （gen-stryker-conf.mjs 的 rootLayerProblems）。与真实拓扑同形：根相对、不加前缀。
      // FILES 里正好有 shared/test/settings-namespace.mutation.test.ts，故零命中为假。
      rootLayers: { "shared-mutation": "shared/test/**/*.mutation.test.ts" },
    },
    sharedDefaults: {
      testRunner: "vitest",
      concurrency: 2,
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
          only: { mutate: [PKG_MUTATE], excludes: [], testFiles: "*" },
        },
      },
    },
    $rootShared: {
      testRoot: "shared",
      testPattern: "test/**/*.mutation.test.ts",
      threshold: 60,
      segments: {
        "settings-namespace": {
          mutate: sharedMutate,
          excludes: [],
          testFiles: ["shared/test/settings-namespace.mutation.test.ts"],
        },
      },
    },
  };
}

const FILES = {
  ["packages/" + PKG + "/src/index.ts"]: "export const a = 1\n",
  ["packages/" + PKG + "/test/unit/unit-a.test.ts"]: 'import "../../src/index.ts"\n',
  ["packages/" + PKG + "/package.json"]:
    JSON.stringify(
      { name: PKG, scripts: { test: "node ../../scripts/test/run-vitest.mjs --min 1" } },
      null,
      2,
    ) + "\n",
  "shared/settings-namespace.ts": "export const covered = true\n",
  "shared/test/settings-namespace.mutation.test.ts": "// Vitest mutation face\n",
};

/** fixture 必须是真 git 仓库：--check 的判据⑦ 要读基准 ref 上的拓扑。 */
function commitBase(root: string): void {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-qm", "base");
}

function makeFixtureRoot(sharedMutate: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "875-fixture-"));
  const files = Object.assign({}, FILES, {
    "scripts/data/mutation-topology.json":
      JSON.stringify(makeTopology(sharedMutate), null, 2) + "\n",
  });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  mkdirSync(join(root, "stryker.conf.d"), { recursive: true });
  commitBase(root);
  return root;
}

function runGenerator(root: string, args: string[] = []): GeneratorResult {
  const res = spawnSync(process.execPath, [GENERATOR].concat(args || [], ["--base", "HEAD"]), {
    cwd: ROOT,
    encoding: "utf8",
    env: Object.assign({}, process.env, { GEN_STRYKER_ROOT: root }),
  });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

/** 递归删除对 ENOTEMPTY 退避重试：fixture 是真 git 仓库，末批写盘有残余竞态。 */
function removeFixtureRoot(root: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err as { code?: unknown }).code !== "ENOTEMPTY" || attempt >= 10) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (attempt + 1) * 50);
    }
  }
}

function deriveSharedConf(root: string): DerivedConf {
  const res = runGenerator(root);
  assert.equal(res.status, 0, "生成应成功：\n" + res.out);
  return JSON.parse(
    readFileSync(join(root, "stryker.conf.d", "shared-settings-namespace.json"), "utf8"),
  );
}

test("① mutate 命中 shared/ 的段必须派生产物 ignorePatterns（#875 根因回归）", () => {
  const root = makeFixtureRoot(["shared/settings-namespace.ts"]);
  try {
    const conf = deriveSharedConf(root);
    assert.deepEqual(
      conf.ignorePatterns,
      EXPECTED,
      "少了产物排除，产物在盘时变异测量静默失效（0 killed / 全 survived）",
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test("② 只排除 shared 不构成变异面：不得派生 ignorePatterns", () => {
  const root = makeFixtureRoot([PKG_MUTATE, "!shared/**/*.ts"]);
  try {
    const conf = deriveSharedConf(root);
    assert.equal(
      conf.ignorePatterns,
      undefined,
      "! 排除条目不构成变异面，凭它派生等于把判据挂在一个永不生效的条件上",
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test("③ mutate 只命中 packages/ 的段不得带该字段（outDir=lib，产物不进源码树）", () => {
  const root = makeFixtureRoot([PKG_MUTATE]);
  try {
    const conf = deriveSharedConf(root);
    assert.equal(
      conf.ignorePatterns,
      undefined,
      "给不进源码树的段加排除是噪音，且暗示全仓都在原地 emit",
    );
  } finally {
    removeFixtureRoot(root);
  }
});

test("④ 真实仓库：只有 shared 段 conf 带该字段，且取值与派生规则一致", () => {
  const confDir = join(ROOT, "stryker.conf.d");
  const withIgnore = readdirSync(confDir)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => JSON.parse(readFileSync(join(confDir, f), "utf8")).ignorePatterns !== undefined)
    .sort();
  // 口径：凡是 mutate 面命中 shared/ 的段，其 conf 都必须带该字段（不排掉 emit 产物，
  // 变异测量会静默失效——见 gen-stryker-conf.mjs 的 SHARED_BUILD_ARTIFACT_IGNORE_PATTERNS）。
  // #1074 起两段（settings-namespace 与 client）；#1015 起第三段：dsh-provider-usage-ui-primitives
  // 是**包级段**，但 mutate 面是 shared/client/ui/index.tsx（#1015 把 T1 原语层上提到 shared/），
  // 故同样适用——「是否带排除」由 mutate 面位置决定，与该段挂在包级还是 $rootShared 无关。
  // 枚举仍是闭的：少一份=漏重生成，多一份=派生条件写宽了（mutate 面不碰 shared/ 的段一个都不该有）。
  assert.deepEqual(
    withIgnore,
    [
      "dsh-provider-usage-ui-primitives.json",
      "shared-client.json",
      "shared-settings-namespace.json",
    ],
    "只有 mutate 命中 shared/ 的段该带产物排除；缺失=漏重生成，多出来=派生条件写宽了",
  );
  // 逐份核对取值：闭枚举把名字钉住了，但取值必须每份都对（此前只查一份，client 段是漏的）。
  for (const name of withIgnore) {
    const sharedConf = JSON.parse(readFileSync(join(confDir, name), "utf8"));
    assert.deepEqual(
      sharedConf.ignorePatterns,
      EXPECTED,
      `${name}：生成物与派生规则脱节（stryker:check 也会判红，这里先点名定位）`,
    );
  }
});

test("⑤ 形态不变量：shared 下无被追踪的 .js/.d.ts，ignorePatterns 不会误伤源码", () => {
  const tracked = spawnSync("git", ["ls-files", "--", "shared"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .stdout.split("\n")
    .filter(Boolean);
  const offenders = tracked.filter((p) => /\.(js|d\.ts|tsbuildinfo)$/.test(p));
  assert.deepEqual(
    offenders,
    [],
    "shared 下出现被追踪的产物形态文件：" +
      offenders.join(", ") +
      "——ignorePatterns 会把它一起挡掉，即漏掉一个应被变异的源文件" +
      "（形态不变量另有 shared-ts-shape.test.ts 守卫）",
  );
});

test("⑥ 派生值是合法 glob：非空字符串且无前导斜杠锚定", () => {
  for (const pattern of EXPECTED) {
    assert.equal(typeof pattern, "string");
    assert.ok(pattern.length > 0, "空 glob 会被静默当作无规则");
    assert.ok(
      !pattern.startsWith("/"),
      "Stryker 把前导 / 当作相对 cwd 锚定，语义与「shared 下全部」不同",
    );
  }
});
