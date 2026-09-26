#!/usr/bin/env node
/**
 * build-script-shape —「各包 build 必须按 clean-lib → tsc → bundle-host 顺序调用」形态断言
 * （#843 M9 的另一半）。
 *
 * 为什么此前是空的：gate-wiring.test.ts 在 :1778-1780 逐字声明了这条断言**不在该面的论域内**
 * （scripts/build 目录因「各包 package.json 的 pnpm 别名展开未被建模」而拿不到执行点，详见那段
 * 注释末句），本条判据要的是**另一条形态断言**。落点因此独立成文件，不塞回 gate-wiring。
 *
 * 判的是什么（真不变量）：有 src/ 的包，其 build 脚本必须依次完成三件事——
 *   clean-lib（清干净 lib/，否则上一轮残留会混进本轮产物）
 *     → tsc（产出 .js + .d.ts）
 *     → bundle-host（esbuild 内联第三方 + license 归集）
 * 顺序是语义的一部分：先 bundle 再 tsc 会把没清过的旧 .d.ts 打进产物，先 tsc 再 clean 会把
 * 刚编出来的 .js 删掉。故**必须比索引位置，纯 `includes` 文本匹配判不出顺序**（反例验收即
 * 「clean-lib 与 bundle-host 对调 → 必红」）。
 *
 * 三条设计约束（审核判词）：
 *   1. **条件式断言**：只对**存在 src/ 目录**的包断言。dsh-plugins-all 是纯聚合包（无 src/、
 *      无 tsconfig.json、build 是 `node build.ts`），属**结构性不适用**——不是豁免，
 *      因此这里没有任何包名清单，也没有豁免登记。判据少管一类包，是它自述的边界。
 *   2. **包名机械派生**：扫描面 = `packages` 下各一级子目录中有 src/ 的那些。不硬编码包名清单——
 *      那是第二份需同步的事实源（#843 S1 踩过的坑：自证式清单一旦漂移就静默漏包）。
 *   3. **空转绿即红**：扫描面为空（packages/ 不存在 / 无任何带 src/ 的包）一律判红。
 *      「若某天所有包都变成聚合包形态，断言要报错而不是静默通过」——本仓反复出现过的失败模式。
 *
 * 自述的口径边界：分隔符只认 `&&`。改用 `;` 串联的脚本里三个锚点会落进同一段、段索引
 * 相等，于是判「顺序错」——是 fail-closed（红），不是静默放行。仓内 8 个包当前一律用 `&&`。
 *
 * 运行：node --test scripts/test/build-script-shape.test.ts（pnpm test:scripts 亦覆盖）。
 * 注入实验的根接缝：BUILD_SHAPE_ROOT 指向临时 fixture 根（先例 VERIFY_DIR_IMPORTS_ROOT），
 * 便于在 mkdtemp 隔离目录里造反例而不碰工作树；未设时即仓库根，即 CI 与本地的常态口径。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const ROOT = process.env.BUILD_SHAPE_ROOT ?? REPO_ROOT;

/**
 * 三段锚点的识别正则。三个都必须锚在 `&&` 切出的**段**上，而不是整串文本：
 *   - clean-lib / bundle-host 按脚本路径名识别（`scripts/build/clean-lib.ts` 等）；
 *   - tsc **不能**按子串 "tsc" 识别——`tsconfig.json` 里也含 "tsc"，那样 `cat tsconfig.json`
 *     这类段会被误判成编译段，判据就成了恒真的摆设。故要求 tsc 两侧是段首/空白。
 */
const CLEAN_RE = /clean-lib/;
const BUNDLE_RE = /bundle-host/;
const TSC_RE = /(?:^|\s)tsc(?:\s|$)/;

/** 锚点 → 判词用名；顺序即 build 脚本里要求的先后顺序。 */
const ANCHORS = [
  ["clean", CLEAN_RE, "clean-lib"],
  ["tsc", TSC_RE, "tsc"],
  ["bundle", BUNDLE_RE, "bundle-host"],
] as const;

interface PackageDir {
  /** 相对 `packages/` 的目录名（即包名同形）。 */
  name: string;
  /** 该目录是否有 src/ 子目录——条件式断言的唯一判据。 */
  hasSrc: boolean;
}

/** 列出 packages/ 下带 package.json 的目录及其 src/ 形态（纯读，不写）。 */
function listPackageDirs(root: string): PackageDir[] {
  const base = join(root, "packages");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(base, e.name, "package.json")))
    .map((e) => ({ name: e.name, hasSrc: existsSync(join(base, e.name, "src")) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 取 build 脚本字符串；不可读 / 非字符串 / 缺失一律 null（由调用方判红，不静默放行）。 */
function readBuildScript(root: string, name: string): string | null {
  const raw = readFileSync(join(root, "packages", name, "package.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return null;
  const build = (scripts as { build?: unknown }).build;
  return typeof build === "string" ? build : null;
}

/**
 * 判一条 build 脚本的形态，返回判词（无违规返回 null）。
 *
 * 比的是**段索引**而非子串位置：`includes` 对 `clean-lib && tsc && bundle-host` 与
 * `bundle-host && tsc && clean-lib` 一视同仁地判过，顺序反了就静默通过——那正是本条判据
 * 要堵的洞。
 */
function chainProblem(build: string | null, label: string): string | null {
  if (build === null) return `${label}: package.json 的 scripts.build 缺失或不可读`;
  const steps = build
    .split("&&")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const at: Record<string, number> = {};
  const missing: string[] = [];
  for (const [key, re, display] of ANCHORS) {
    const idx = steps.findIndex((s) => re.test(s));
    at[key] = idx;
    if (idx === -1) missing.push(display);
  }
  if (missing.length > 0) {
    return `${label}: build 缺少 ${missing.join(" / ")}（三段须齐全：clean-lib → tsc → bundle-host；实得：${build}）`;
  }
  if (!(at.clean < at.tsc && at.tsc < at.bundle)) {
    return (
      `${label}: build 三段顺序错，须 clean-lib → tsc → bundle-host` +
      `（实得 clean-lib@段${at.clean} / tsc@段${at.tsc} / bundle-host@段${at.bundle}：${build}）`
    );
  }
  return null;
}

/** 扫描一个根下的全部带 src/ 的包，汇总判词。空扫描面按 fail-closed 判红。 */
export function auditBuildChain(root: string): { scoped: string[]; problems: string[] } {
  const dirs = listPackageDirs(root);
  if (dirs.length === 0) {
    return {
      scoped: [],
      problems: [`${root}: packages/ 下没有任何带 package.json 的包目录，扫描面为空即判红`],
    };
  }
  const scoped = dirs.filter((d) => d.hasSrc).map((d) => d.name);
  if (scoped.length === 0) {
    return {
      scoped: [],
      problems: [
        `${root}: ${dirs.length} 个包目录里没有任何一个带 src/，判据扫描面为空即判红` +
          `（若所有包都退化成聚合包形态，这条断言本就该报错而不是静默通过）`,
      ],
    };
  }
  const problems: string[] = [];
  for (const name of scoped) {
    const problem = chainProblem(readBuildScript(root, name), `packages/${name}`);
    if (problem !== null) problems.push(problem);
  }
  return { scoped, problems };
}

/** 造一个 fixture 根：`packages/<name>/{package.json,src/}`，src 缺省即无 src/ 目录。 */
function fixture(packages: Array<{ name: string; build?: string; src?: boolean }>): string {
  const dir = mkdtempSync(join(tmpdir(), "build-shape-"));
  for (const p of packages) {
    const abs = join(dir, "packages", p.name);
    mkdirSync(abs, { recursive: true });
    if (p.src !== false) mkdirSync(join(abs, "src"), { recursive: true });
    const manifest: Record<string, unknown> = { name: `@wingsky-1/${p.name}` };
    if (p.build !== undefined) manifest.scripts = { build: p.build };
    writeFileSync(join(abs, "package.json"), JSON.stringify(manifest, null, 2));
  }
  return dir;
}

/** 在 fixture 根上跑审计并清理（仓库零污染纪律）。 */
function withFixture<T>(packages: Parameters<typeof fixture>[0], body: (dir: string) => T): T {
  const dir = fixture(packages);
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CHAIN_OK =
  "node ../../scripts/build/clean-lib.ts && tsc -p tsconfig.json && node ../../scripts/build/bundle-host.ts .";

test("扫描面机械派生：只取有 src/ 的包，无 src/ 的包不进面（不靠包名清单）", () => {
  withFixture(
    [
      { name: "dsh-probe-a", build: CHAIN_OK },
      { name: "dsh-probe-aggregate", build: "node build.ts", src: false },
    ],
    (dir) => {
      const { scoped, problems } = auditBuildChain(dir);
      assert.deepEqual(scoped, ["dsh-probe-a"], "无 src/ 的包必须被排除在扫描面外");
      assert.deepEqual(problems, [], "聚合包形态（node build.ts）不属本判据论域，不得因此判红");
    },
  );
});

test("顺序敏感性：clean-lib 与 bundle-host 对调 → 判红（includes 文本匹配判不出这一条）", () => {
  const swapped =
    "node ../../scripts/build/bundle-host.ts . && tsc -p tsconfig.json && node ../../scripts/build/clean-lib.ts";
  withFixture([{ name: "dsh-probe-swap", build: swapped }], (dir) => {
    const { problems } = auditBuildChain(dir);
    assert.equal(problems.length, 1, `对调顺序必须判红，实得：${JSON.stringify(problems)}`);
    assert.match(problems[0], /顺序错/);
    assert.match(problems[0], /dsh-probe-swap/, "判词须点名包");
  });
});

test("三段顺序：tsc 提到最前 / bundle 提到最前，各判红", () => {
  const bad: Array<[string, string]> = [
    [
      "tsc 提前",
      "tsc -p tsconfig.json && node ../../scripts/build/clean-lib.ts && node ../../scripts/build/bundle-host.ts .",
    ],
    [
      "bundle 提前",
      "node ../../scripts/build/bundle-host.ts . && node ../../scripts/build/clean-lib.ts && tsc -p tsconfig.json",
    ],
  ];
  for (const [label, build] of bad) {
    withFixture([{ name: "dsh-probe-order", build }], (dir) => {
      const { problems } = auditBuildChain(dir);
      assert.equal(problems.length, 1, `${label} 必须判红，实得：${JSON.stringify(problems)}`);
      assert.match(problems[0], /顺序错/);
    });
  }
});

test("缺环节：删掉 clean-lib / tsc / bundle-host 各自判红且点名包", () => {
  const bad: Array<[string, string]> = [
    ["缺 clean-lib", "tsc -p tsconfig.json && node ../../scripts/build/bundle-host.ts ."],
    [
      "缺 tsc",
      "node ../../scripts/build/clean-lib.ts && node ../../scripts/build/bundle-host.ts .",
    ],
    ["缺 bundle-host", "node ../../scripts/build/clean-lib.ts && tsc -p tsconfig.json"],
    ["无 build 脚本", undefined as unknown as string],
  ];
  for (const [label, build] of bad) {
    withFixture([{ name: "dsh-probe-missing", build }], (dir) => {
      const { problems } = auditBuildChain(dir);
      assert.equal(problems.length, 1, `${label} 必须判红，实得：${JSON.stringify(problems)}`);
      assert.match(problems[0], /dsh-probe-missing/, `${label} 的判词须点名包`);
    });
  }
});

test("tsc 锚点不吃子串：只出现 tsconfig.json 的段不算编译段", () => {
  const build =
    "node ../../scripts/build/clean-lib.ts && cat tsconfig.json && node ../../scripts/build/bundle-host.ts .";
  withFixture([{ name: "dsh-probe-substr", build }], (dir) => {
    const { problems } = auditBuildChain(dir);
    assert.equal(problems.length, 1, "含 tsc 子串但没真跑 tsc 的脚本必须判红");
    assert.match(problems[0], /缺少 tsc/);
  });
});

test("中间多一段不破坏顺序不变量：prepare-lib-entry 夹在 tsc 与 bundle 之间仍判绿", () => {
  const build = `${CHAIN_OK.split(" && ").slice(0, 2).join(" && ")} && node scripts/prepare-lib-entry.ts && node ../../scripts/build/bundle-host.ts .`;
  withFixture([{ name: "dsh-probe-extra", build }], (dir) => {
    assert.deepEqual(auditBuildChain(dir).problems, [], "额外环节只要不破坏三段先后就应通过");
  });
});

test("空转绿守卫一：packages/ 不存在 → 判红", () => {
  const dir = mkdtempSync(join(tmpdir(), "build-shape-empty-"));
  try {
    const { scoped, problems } = auditBuildChain(dir);
    assert.deepEqual(scoped, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /扫描面为空即判红/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("空转绿守卫二：所有包都退化成聚合包形态（无一带 src/）→ 判红", () => {
  withFixture(
    [
      { name: "dsh-probe-agg-1", build: "node build.ts", src: false },
      { name: "dsh-probe-agg-2", build: "node build.ts", src: false },
    ],
    (dir) => {
      const { scoped, problems } = auditBuildChain(dir);
      assert.deepEqual(scoped, []);
      assert.equal(problems.length, 1, "扫描面退化为空必须报错，不得静默通过");
      assert.match(problems[0], /没有任何一个带 src\//);
    },
  );
});

test("真实仓库：全部带 src/ 的包 build 均为 clean-lib → tsc → bundle-host", () => {
  const { scoped, problems } = auditBuildChain(ROOT);
  assert.ok(scoped.length > 0, "真实仓库必有带 src/ 的包，否则本用例就是空转");
  assert.deepEqual(problems, [], `build 形态判词：\n${problems.join("\n")}`);
});
