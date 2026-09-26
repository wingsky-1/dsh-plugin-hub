#!/usr/bin/env node
/**
 * build-script-shape —「各包 build 必须按 clean-lib → tsc → bundle-host 顺序调用」形态断言
 * （#843 M9 的另一半）。
 *
 * 为什么此前是空的：gate-wiring.test.ts 在 :1778-1780 逐字声明了这条断言**不在该面的论域内**
 * （scripts/build 目录因「各包 package.json 的 pnpm 别名展开未被建模」而拿不到执行点，详见那段
 * 注释末句），本条判据要的是**另一条形态断言**。落点因此独立成文件，不塞回 gate-wiring。
 *
 * 判的是什么（真不变量）：manifest 在册的每个包，其 build 脚本必须依次完成三件事——
 *   clean-lib（清干净 lib/，否则上一轮残留会混进本轮产物）
 *     → tsc（产出 .js + .d.ts）
 *     → bundle-host（esbuild 内联第三方 + license 归集）
 * 顺序是语义的一部分：先 bundle 再 tsc 会把没清过的旧 .d.ts 打进产物，先 tsc 再 clean 会把
 * 刚编出来的 .js 删掉。故**必须比段索引**，纯 `includes` 文本匹配判不出顺序。
 * 另一层语义是「三步都真跑且都致命」：`clean-lib || true`（为容忍 flaky clean 兜底）会把
 * 「clean 成功后才编译」这条前提悄悄去掉，`echo clean-lib` 这类占位更是根本没跑。
 *
 * 三条设计约束（审核判词）：
 *   1. **由 manifest 决定覆盖面**：scope = `scripts/data/plugins-manifest.json` 的
 *      `active` ∪ `standalone`（经 `plugins-manifest-lib` 的 `loadManifest` 读，不自己解析）。
 *      早先版本用「有无 src/ 目录」当过滤条件，复核实测那是**可无声逃逸**的启发式：把源码目录
 *      改名、或新增一个不叫 src/ 的包，该包即永久脱管，而只要还有别的包带 src/，空转绿守卫就
 *      不触发（E15：build 写成 `echo TODO nothing at all` 仍判绿）。现在 src/ 存在性
 *      **降为被断言的事实**（在册包没有 src/ 目录即判红），不再当过滤器。
 *      依赖说明：这条判据因此**依赖 `scripts/data/plugins-manifest.json`**。该文件已登记在
 *      `scripts/data/threshold-registry.json` 的非阈值面（notAGate），且已有多个消费方
 *      （aggregate.ts / pack-check.ts / contract-check.ts / config-matrix-gate），不是本判据
 *      私有的第二事实源。
 *   2. **双向覆盖，防新增包脱管**：在册包必须逐个被判定（缺目录 / 缺 src/ / build 不合规都
 *      点名）；反向，磁盘上未登记 manifest 的 dsh-* 子包（排除聚合包与已退役残留）也判红。
 *   3. **空转绿即红**：manifest 的 active ∪ standalone 为空即判红。空扫描面若静默通过，
 *      判据就退化成零违规。
 *
 * 锚点为什么不是纯子串：`tsconfig.json` 里也含 "tsc"，`echo clean-lib` / `STAGE=clean-lib`
 * 也含锚点字面量。故三锚点都要求「确实调用」的形态——clean / bundle 要求 `node <path>/x.ts`，
 * tsc 要求段首（可带 runner 前缀）即 tsc（E6/E8/E9/E12）。且锚定段内不得含 `||` / `;` /
 * `&`：这三者都是把步骤降级为非致命的写法（E7）。
 *
 * 已知边界（判据管不到 / 会误红，均为显式声明而非静默）：
 *   - 分隔符只认 `&&`。改用 `;` 串联的脚本里三个锚点会落进同一段、段索引相等，于是判
 *     「顺序错」——是 fail-closed（红），不是静默放行。仓内 8 个包当前一律用 `&&`。
 *   - 锚点脚本改名（`clean-lib.ts` → 别的名字）：本判据判红，而构建本身也会响亮失败
 *     （路径写错即 ENOENT），影响有限。
 *   - 三步收进单个脚本（`node ../../scripts/build/all.ts`）：合法重构，本判据判红。
 *   - 三步移进 `prebuild` 而 build 只剩 `echo`：合法重构，本判据判红。
 *   后两条要判绿只能显式改判据，不允许靠「判据看起来绿了」蒙混。
 *
 * 覆盖边界：manifest.retired（**有意不判 build 形态**，是取舍不是缺口）
 *   scope 取 active ∪ standalone，不取 retired——按 manifest 的设计契约：retired 是「已退役、
 *   **目录待清理**」的登记簿（plugins-manifest-lib.ts:90 的 T1/#397 注释、contract-check.ts:33、
 *   pack-check.ts:198 均据此只告警不判红），退役包的目录本就该被删除，要求一个待删的包
 *   「build 形态合规」是判错了对象。故本判据不判 retired 包的 build 形态。
 *   但「不判形态」不能等于「静默不管」，否则「把在册包挪进 retired」就是一条无守卫的休眠
 *   通道（复核实测：目录与 package.json 俱留、build 写成 `echo TODO`，判绿）。故本判据只断言
 *   **这条豁免自身的前提**：retired 条目的 packages/<name>/package.json 仍在磁盘 → 判红。
 *   切面很窄：只管「带 package.json」；retired 残留的**裸目录**（无 package.json，即 T1
 *   文档化的已知清理债）不判红，仍由 checkDirSets 告警，不与聚合侧口径打架。
 *   **已登记的既有缺口（全仓级，非本判据）**：现网没有任何判据会因「retired 条目但目录仍在
 *   且带 package.json + src/」而红——checkDirSets / contract-check / pack-check /
 *   verify-npm-layout 一律 console.warn。本文件的前置条件断言是**本判据豁免的前提闸**，不是
 *   那个缺口的实现；缺口本体由聚合侧独立跟踪项跟进，届时本断言被其取代。
 *   **豁免的退出条件**：retired 目录删除后本判据的 retired 面自然为空，豁免自动消失；在那
 *   之前，前提一旦不成立（retired 条目又有 package.json）就由本断言报出来。
 *
 * 覆盖边界：BUILD_SHAPE_* 两个环境接缝
 *   `BUILD_SHAPE_ROOT`（换审计根）与 `BUILD_SHAPE_AUDIT_ONLY`（切审计独立模式）都是决策开关：
 *   被外部设上就能让本文件改判别处、或整份塌成一条用例还 EXIT=0（复核实测 14 条塌成 1 条）。
 *   故本文件自带断言：可执行面（package.json scripts / lefthook.yml / .github/workflows /
 *   各包 package.json / scripts 与 tools 源码）**不得出现 BUILD_SHAPE_**——把这条接缝从
 *   「靠没人设」变成「被守卫」。本文件自身是定义点，已排除在该扫描面之外。
 * * 退出码（AGENTS.md 三态）：0 = 通过；1 = 判红可信（build 形态确实不达标）；**2 = 门禁故障
 * 不可信**（manifest 或某个 package.json 读不出来/解析不了——输入坏了，此时任何「通过」或
 * 「不达标」都是假的），由 `scripts/lib/gate-exit.mjs` 的 `failClosed` 唯一出口结案。
 *
 * 为什么判定跑在**独立进程**里而不是本文件内直接判：`node --test` 会把被测文件里任何非零的
 * `process.exit` 一律折成 1（实测：test 回调内 exit 2 与模块顶层 exit 2 出来都是 1），
 * 于是「门禁故障」与「判红」在 `test:scripts` 这一层永远读不出来。故本文件带一个
 * `BUILD_SHAPE_AUDIT_ONLY=1` 模式：不被 `--test` 包裹，直接按三态退出；真实仓库的判定与
 * 门禁故障用例都经 `node <本文件>` 子进程实测真实 exit code（同 verify-provider-usage-shape
 * 的做法）。fixture 形态用例仍在本进程内跑纯函数（它们不产生门禁故障）。

 * 运行：node --test scripts/test/build-script-shape.test.ts（pnpm test:scripts 亦覆盖）。
 * 注入实验的根接缝：BUILD_SHAPE_ROOT 指向临时 fixture 根（先例 VERIFY_DIR_IMPORTS_ROOT），
 * 便于在 mkdtemp 隔离目录里造反例而不碰工作树；未设时即仓库根，即 CI 与本地的常态口径。
 * fixture 根同时携带一份最小合法的 plugins-manifest.json（loadManifest 会校验 configSurfaces
 * 覆盖 active ∪ standalone，故最小 manifest 也得有逐包声明）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { failClosed } from "../lib/gate-exit.mjs";
import { walkFiles } from "../lib/walk-files.ts";
import { filterOutRetiredDirs, listPluginDirs, loadManifest } from "../lib/plugins-manifest-lib.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const ROOT = process.env.BUILD_SHAPE_ROOT ?? REPO_ROOT;

const CHAIN_OK =
  "node ../../scripts/build/clean-lib.ts && tsc -p tsconfig.json && node ../../scripts/build/bundle-host.ts .";

/** 锚点正则：要求「确实调用」形态而非字面量出现。 */
const CLEAN_RE = /(?:^|\s)node\s+\S*clean-lib\.ts(?:\s|$)/;
const BUNDLE_RE = /(?:^|\s)node\s+\S*bundle-host\.ts(?:\s|$)/;
/** 段首可带的 runner 前缀（tsc 锚点允许 pnpm exec tsc 这类包装）。 */
const RUNNER_RE = /^(?:pnpm\s+(?:exec|run)\s+|npx\s+|bunx\s+|yarn\s+(?:dlx|run)\s+)/;
/** 锚定段内的降级写法：`||` 吞错、`;` 断链不短路、`&` 后台化。三者都破坏「三步都致命」。 */
const DEGRADE_RE = /\|\||;|&/;

/**
 * 锚点 → 判词用名。
 *
 * **数组顺序只决定 missing 判词的列举顺序**：顺序不变式不在这里，而在 chainProblem 里以
 * 显式比较 `clean < tsc < bundle` 表达。重排本数组不会改变判定结果——照着「顺序即要求」的
 * 读法去改数组，会得到「改了没反应」的错觉。
 */
const ANCHORS = [
  ["clean", CLEAN_RE, "clean-lib"],
  ["tsc", null, "tsc"],
  ["bundle", BUNDLE_RE, "bundle-host"],
] as const;

/** 段首去掉 runner 前缀后的首个词——tsc 锚点据此判「段首即 tsc」。 */
function commandHead(step: string): string {
  return step.replace(RUNNER_RE, "").trim().split(/\s+/)[0] ?? "";
}

/** 锚点是否命中该段：clean/bundle 走正则，tsc 走「段首即 tsc」。 */
function anchorHits(key: string, step: string): boolean {
  if (key === "tsc") return commandHead(step) === "tsc";
  const entry = ANCHORS.find(([k]) => k === key);
  return entry?.[1] !== null && entry !== undefined && entry[1].test(step);
}

interface Audit {
  scoped: string[];
  problems: string[];
}

interface Scope {
  /** active ∪ standalone：必须满足三段 build 形态的包。 */
  scoped: string[];
  /** manifest.retired 的包名：有意不判形态（见文件头「覆盖边界：retired」）。 */
  retired: string[];
}

/** 门禁故障（输入不可读）走 exit 2；判红结论绝不落到这里。 */
function readManifestScope(root: string): Scope {
  try {
    const manifest = loadManifest(root);
    return {
      scoped: [...manifest.active, ...manifest.standalone].sort(),
      retired: manifest.retired.map((r) => r.name),
    };
  } catch (e) {
    failClosed(
      `build-script-shape 读不出 ${root} 的 plugins-manifest.json：${(e as Error).message}`,
    );
    // failClosed 内部 process.exit(2)，不可达；保留返回仅为满足类型收敛。
    return { scoped: [], retired: [] };
  }
}

/** 读一个包的 scripts.build。文件缺失 = 判红事实（调用方给判词）；读不了/坏 JSON = 门禁故障。 */
function readBuildScript(root: string, name: string): string | null {
  const file = join(root, "packages", name, "package.json");
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    failClosed(`build-script-shape 读不出 ${file}：${(e as Error).message}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    failClosed(`build-script-shape 解析 ${file} 失败：${(e as Error).message}`);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return null;
  const build = (scripts as { build?: unknown }).build;
  return typeof build === "string" ? build : null;
}

/** build 脚本按 `&&` 切段并去空白；段的先后就是语义上的执行先后。 */
function splitSteps(build: string): string[] {
  return build
    .split("&&")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 判一条 build 脚本的形态，返回判词（无违规返回 null）。 */
function chainProblem(build: string | null, label: string): string | null {
  if (build === null) return `${label}: package.json 的 scripts.build 缺失或不可读`;
  const steps = splitSteps(build);
  const at: Record<string, number> = {};
  const missing: string[] = [];
  for (const [key, , display] of ANCHORS) {
    const idx = steps.findIndex((s) => anchorHits(key, s));
    at[key] = idx;
    if (idx === -1) missing.push(display);
  }
  if (missing.length > 0) {
    return `${label}: build 缺少 ${missing.join(" / ")}（三段须齐全：clean-lib → tsc → bundle-host；实得：${build}）`;
  }
  for (const [key, , display] of ANCHORS) {
    if (DEGRADE_RE.test(steps[at[key]])) {
      return (
        `${label}: build 的 ${display} 段被降级为非致命（段内含 || ; &）：${steps[at[key]]}` +
        `——三步必须各自失败即中止（实得：${build}）`
      );
    }
  }
  if (!(at.clean < at.tsc && at.tsc < at.bundle)) {
    return (
      `${label}: build 三段顺序错，须 clean-lib → tsc → bundle-host` +
      `（实得 clean-lib@段${at.clean} / tsc@段${at.tsc} / bundle-host@段${at.bundle}：${build}）`
    );
  }
  return null;
}

/** 在册包的形态前置事实：目录在、src/ 是**目录**（名为 src 的文件不算，见 P3-1）。 */
function packageLayoutProblem(root: string, name: string): string | null {
  const dir = join(root, "packages", name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return `packages/${name}: manifest 在册但目录不存在`;
  }
  const src = join(dir, "src");
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    return (
      `packages/${name}: 没有 src/ **目录**（在册功能包的源码面必须是 src/；` +
      `改名或以同名文件顶替会让本判据与 tsc 口径同时失配）`
    );
  }
  return null;
}

/** 反向：磁盘上未登记 manifest 的 dsh-* 子包（排除聚合包与已退役残留）也判红。 */
function unregisteredProblems(root: string, scoped: string[]): string[] {
  if (!existsSync(join(root, "packages"))) return [];
  const known = new Set(scoped);
  const { kept } = filterOutRetiredDirs(listPluginDirs(root), loadManifest(root));
  return kept
    .filter((d) => !known.has(d))
    .map((d) => `packages/${d}: 磁盘存在但未登记 manifest（active/standalone），本判据覆盖不到它`);
}

/**
 * retired 豁免的**前提闸**：retired 条目的 package.json 仍在磁盘即判红。
 *
 * 这里不判 retired 包的 build 形态（按 manifest 契约，退役包的目录本就该删，判形态是判错
 * 对象），只守「不判形态」这个豁免自己的前提——否则「把在册包挪进 retired」就是一条无守卫的
 * 脱管休眠通道。切面只到「带 package.json」：retired 残留的裸目录（T1 已知清理债）不判红。
 */
function retiredLeftoverProblems(root: string, retired: string[]): string[] {
  return retired
    .filter((name) => existsSync(join(root, "packages", name, "package.json")))
    .map(
      (name) =>
        `packages/${name}: manifest.retired 条目但 package.json 仍在磁盘 —— ` +
        `退役包的目录应当被删除（manifest 设计契约）。本判据有意不判 retired 包的 build 形态，` +
        `但这条豁免的前提一旦不成立就必须报出来；裸目录残留（T1 清理债）不归本断言`,
    );
}

/** 扫描一个根：在册包逐个判形态，反查脱管包与 retired 前提，汇总判词。 */
export function auditBuildChain(root: string): Audit {
  const { scoped, retired } = readManifestScope(root);
  const problems: string[] = retiredLeftoverProblems(root, retired);
  if (scoped.length === 0) {
    return {
      scoped,
      problems: [`${root}: manifest 的 active ∪ standalone 为空，扫描面为空即判红`],
    };
  }
  for (const name of scoped) {
    const layout = packageLayoutProblem(root, name);
    if (layout !== null) {
      problems.push(layout);
      continue;
    }
    const problem = chainProblem(readBuildScript(root, name), `packages/${name}`);
    if (problem !== null) problems.push(problem);
  }
  if (existsSync(join(root, "packages"))) problems.push(...unregisteredProblems(root, scoped));
  return { scoped, problems };
}

/** 造 fixture 根：`<name>` 全部进 manifest.active，并写一份最小合法 manifest。 */
function fixture(
  packages: Array<{ name: string; build?: string; src?: boolean; srcAsFile?: boolean }>,
  retired: string[] = [],
): string {
  const dir = mkdtempSync(join(tmpdir(), "build-shape-"));
  for (const p of packages) {
    const abs = join(dir, "packages", p.name);
    mkdirSync(abs, { recursive: true });
    if (p.srcAsFile) writeFileSync(join(abs, "src"), "not a directory\n");
    else if (p.src !== false) mkdirSync(join(abs, "src"), { recursive: true });
    const manifest: Record<string, unknown> = { name: `@wingsky-1/${p.name}` };
    if (p.build !== undefined) manifest.scripts = { build: p.build };
    writeFileSync(join(abs, "package.json"), JSON.stringify(manifest, null, 2));
  }
  mkdirSync(join(dir, "scripts", "data"), { recursive: true });
  writeFileSync(
    join(dir, "scripts", "data", "plugins-manifest.json"),
    JSON.stringify(
      {
        active: packages.map((p) => p.name),
        retired: retired.map((name) => ({ name, reason: "fixture：已退役待清理", successor: "" })),
        configSurfaces: packages.map((p) => ({
          package: p.name,
          surface: "none",
          reason: "fixture：无配置面",
        })),
      },
      null,
      2,
    ),
  );
  return dir;
}

/** 在 fixture 根上跑审计并清理（仓库零污染纪律）。 */
function withFixture<T>(
  packages: Parameters<typeof fixture>[0],
  retired: string[],
  body: (dir: string) => T,
): T {
  const dir = fixture(packages, retired);
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("覆盖面来自 manifest：在册包逐个判定，未登记的磁盘包反向判红", () => {
  withFixture(
    [
      { name: "dsh-probe-a", build: CHAIN_OK },
      { name: "dsh-probe-b", build: CHAIN_OK },
    ],
    [],
    (dir) => {
      mkdirSync(join(dir, "packages", "dsh-probe-unregistered"), { recursive: true });
      writeFileSync(
        join(dir, "packages", "dsh-probe-unregistered", "package.json"),
        '{"name":"@wingsky-1/dsh-probe-unregistered","scripts":{"build":"echo TODO"}}',
      );
      const { scoped, problems } = auditBuildChain(dir);
      assert.deepEqual(scoped, ["dsh-probe-a", "dsh-probe-b"]);
      assert.equal(problems.length, 1, `未登记的包必须判红，实得：${JSON.stringify(problems)}`);
      assert.match(problems[0], /dsh-probe-unregistered/);
    },
  );
});

test("src/ 从过滤器降为被断言的事实：源码目录改名 → 判红（不再无声脱管）", () => {
  withFixture(
    [{ name: "dsh-probe-renamed", build: "echo TODO nothing at all", src: false }],
    [],
    (dir) => {
      mkdirSync(join(dir, "packages", "dsh-probe-renamed", "sources"), { recursive: true });
      const { problems } = auditBuildChain(dir);
      assert.equal(problems.length, 1, `改名后必须判红，实得：${JSON.stringify(problems)}`);
      assert.match(problems[0], /没有 src\/ \*\*目录\*\*/);
    },
  );
});

test("src/ 必须是目录：名为 src 的文件不算源码面", () => {
  withFixture([{ name: "dsh-probe-srcfile", build: CHAIN_OK, srcAsFile: true }], [], (dir) => {
    const { problems } = auditBuildChain(dir);
    assert.equal(problems.length, 1, `src 是文件时必须判红，实得：${JSON.stringify(problems)}`);
    assert.match(problems[0], /没有 src\/ \*\*目录\*\*/);
  });
});

test("retired 豁免的前提闸：retired 条目但 package.json 仍在磁盘 → 判红（堵休眠通道）", () => {
  withFixture([{ name: "dsh-probe-live", build: CHAIN_OK }], ["dsh-probe-dead"], (dir) => {
    // 造一个「已退役但目录与 package.json 俱在」的包：build 是垃圾，形态判据按契约不碰它
    const abs = join(dir, "packages", "dsh-probe-dead");
    mkdirSync(join(abs, "src"), { recursive: true });
    writeFileSync(
      join(abs, "package.json"),
      '{"name":"@wingsky-1/dsh-probe-dead","scripts":{"build":"echo TODO nothing at all"}}',
    );
    const { problems } = auditBuildChain(dir);
    assert.equal(problems.length, 1, `retired 残留必须报出，实得：${JSON.stringify(problems)}`);
    assert.match(problems[0], /manifest\.retired 条目但 package\.json 仍在磁盘/);
    assert.match(problems[0], /dsh-probe-dead/, "判词须点名包");
  });
});

test("retired 残留的裸目录（T1 已知清理债）不判红：不与聚合侧告警口径打架", () => {
  withFixture([{ name: "dsh-probe-live", build: CHAIN_OK }], ["dsh-probe-bare"], (dir) => {
    mkdirSync(join(dir, "packages", "dsh-probe-bare"), { recursive: true });
    const { problems } = auditBuildChain(dir);
    assert.deepEqual(
      problems,
      [],
      "无 package.json 的裸残留归 checkDirSets 告警，本判据不重复判红",
    );
  });
});

/** walkFiles 返回相对路径；这里要的是可直接读的绝对路径。 */
function under(base: string, predicate: (name: string) => boolean): string[] {
  return walkFiles(base, predicate).map((rel) => join(base, rel));
}

test("BUILD_SHAPE_* 不得出现在可执行面（把接缝从「靠没人设」变成「被守卫」）", () => {
  // 用 REPO_ROOT 而非 ROOT：可执行面是**本仓库**的属性，与注入的审计根无关；
  // 用 ROOT 会让注入实验扫到临时 fixture（面近空）而误触发下面那条 fail-closed 断言。
  const groups: Array<[string, string[]]> = [
    ["package.json", [join(REPO_ROOT, "package.json")]],
    ["lefthook.yml", [join(REPO_ROOT, "lefthook.yml")]],
    [".github/workflows/**", under(join(REPO_ROOT, ".github", "workflows"), () => true)],
    ["packages/*/package.json", under(join(REPO_ROOT, "packages"), (n) => n === "package.json")],
    ["scripts/**", under(join(REPO_ROOT, "scripts"), (n) => /\.(mjs|ts|cjs|js)$/.test(n))],
    ["tools/**", under(join(REPO_ROOT, "tools"), (n) => /\.(mjs|ts|cjs|js)$/.test(n))],
  ];
  // 本文件是 BUILD_SHAPE_* 的定义点，不是设置点
  const surface = groups.flatMap(([where, files]) =>
    files.filter((f) => f !== import.meta.filename).map((f) => [where, f] as const),
  );
  assert.ok(surface.length > 0, "可执行面扫描为空即判红（枚举失效时不得静默放行）");
  const hits = surface
    .filter(([, file]) => readFileSync(file, "utf8").includes("BUILD_SHAPE_"))
    .map(([where, file]) => `${where}: ${file}`);
  assert.deepEqual(hits, [], `可执行面不得设置本判据的环境开关：${hits.join("、")}`);
});

test("顺序敏感性：clean-lib 与 bundle-host 对调 → 判红（includes 文本匹配判不出这一条）", () => {
  const swapped =
    "node ../../scripts/build/bundle-host.ts . && tsc -p tsconfig.json && node ../../scripts/build/clean-lib.ts";
  withFixture([{ name: "dsh-probe-swap", build: swapped }], [], (dir) => {
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
    withFixture([{ name: "dsh-probe-order", build }], [], (dir) => {
      const { problems } = auditBuildChain(dir);
      assert.equal(problems.length, 1, `${label} 必须判红，实得：${JSON.stringify(problems)}`);
      assert.match(problems[0], /顺序错/);
    });
  }
});

test("缺环节：删掉 clean-lib / tsc / bundle-host 各自判红且点名包", () => {
  const bad: Array<[string, string | undefined]> = [
    ["缺 clean-lib", "tsc -p tsconfig.json && node ../../scripts/build/bundle-host.ts ."],
    [
      "缺 tsc",
      "node ../../scripts/build/clean-lib.ts && node ../../scripts/build/bundle-host.ts .",
    ],
    ["缺 bundle-host", "node ../../scripts/build/clean-lib.ts && tsc -p tsconfig.json"],
    ["无 build 脚本", undefined],
  ];
  for (const [label, build] of bad) {
    withFixture([{ name: "dsh-probe-missing", build }], [], (dir) => {
      const { problems } = auditBuildChain(dir);
      assert.equal(problems.length, 1, `${label} 必须判红，实得：${JSON.stringify(problems)}`);
      assert.match(problems[0], /dsh-probe-missing/, `${label} 的判词须点名包`);
    });
  }
});

test("锚点不吃字面量：echo 占位 / 变量赋值 / 只提 tsconfig.json，各判红", () => {
  const bad: Array<[string, string]> = [
    ["echo 占位 clean", `echo clean-lib && ${CHAIN_OK.split(" && ").slice(1).join(" && ")}`],
    [
      "echo 占位 tsc",
      "node ../../scripts/build/clean-lib.ts && echo tsc && node ../../scripts/build/bundle-host.ts .",
    ],
    [
      "echo 占位 bundle",
      "node ../../scripts/build/clean-lib.ts && tsc -p tsconfig.json && echo bundle-host",
    ],
    [
      "变量字面量",
      "STAGE=clean-lib && tsc -p tsconfig.json && node ../../scripts/build/bundle-host.ts .",
    ],
    [
      "只提 tsconfig.json",
      "node ../../scripts/build/clean-lib.ts && cat tsconfig.json && node ../../scripts/build/bundle-host.ts .",
    ],
  ];
  for (const [label, build] of bad) {
    withFixture([{ name: "dsh-probe-literal", build }], [], (dir) => {
      const { problems } = auditBuildChain(dir);
      assert.equal(problems.length, 1, `${label} 必须判红，实得：${JSON.stringify(problems)}`);
      assert.match(problems[0], /缺少/);
    });
  }
});

test("步骤不得降级为非致命：clean-lib || true（容忍 flaky clean 的最现实写法）→ 判红", () => {
  const build =
    "node ../../scripts/build/clean-lib.ts || true && tsc -p tsconfig.json && node ../../scripts/build/bundle-host.ts .";
  withFixture([{ name: "dsh-probe-nofatal", build }], [], (dir) => {
    const { problems } = auditBuildChain(dir);
    assert.equal(problems.length, 1, `|| true 必须判红，实得：${JSON.stringify(problems)}`);
    assert.match(problems[0], /降级为非致命/);
    assert.match(problems[0], /\|\|/);
  });
});

test("tsc 段首允许 runner 前缀：pnpm exec tsc 判绿", () => {
  const build =
    "node ../../scripts/build/clean-lib.ts && pnpm exec tsc -p tsconfig.json && node ../../scripts/build/bundle-host.ts .";
  withFixture([{ name: "dsh-probe-runner", build }], [], (dir) => {
    assert.deepEqual(auditBuildChain(dir).problems, [], "runner 包装的 tsc 仍是真跑 tsc");
  });
});

test("中间多一段不破坏顺序不变量：prepare-lib-entry 夹在 tsc 与 bundle 之间仍判绿", () => {
  const build = `${CHAIN_OK.split(" && ").slice(0, 2).join(" && ")} && node scripts/prepare-lib-entry.ts && node ../../scripts/build/bundle-host.ts .`;
  withFixture([{ name: "dsh-probe-extra", build }], [], (dir) => {
    assert.deepEqual(auditBuildChain(dir).problems, [], "额外环节只要不破坏三段先后就应通过");
  });
});

test("空转绿守卫：manifest 的 active ∪ standalone 为空 → 判红", () => {
  const dir = mkdtempSync(join(tmpdir(), "build-shape-empty-"));
  try {
    mkdirSync(join(dir, "scripts", "data"), { recursive: true });
    writeFileSync(
      join(dir, "scripts", "data", "plugins-manifest.json"),
      '{"active":[],"retired":[],"configSurfaces":[]}',
    );
    const { scoped, problems } = auditBuildChain(dir);
    assert.deepEqual(scoped, []);
    assert.equal(problems.length, 1, "扫描面退化为空必须报错，不得静默通过");
    assert.match(problems[0], /扫描面为空即判红/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 以「独立进程」跑本文件的审计模式，拿真实退出码。
 *
 * 不能在 `node --test` 内部判：那会把任何非零 `process.exit` 折成 1（实测过），exit 2 这条
 * 契约就永远读不出来。故子进程不经 `--test`，直接按三态退出。
 */
function auditProcess(root: string | undefined) {
  return spawnSync(process.execPath, [import.meta.filename], {
    encoding: "utf8",
    env: {
      ...process.env,
      BUILD_SHAPE_AUDIT_ONLY: "1",
      ...(root === undefined ? {} : { BUILD_SHAPE_ROOT: root }),
    },
  });
}

test("真实仓库：manifest 在册的每个包 build 均为 clean-lib → tsc → bundle-host（子进程 exit 0）", () => {
  const r = auditProcess(ROOT);
  assert.equal(r.status, 0, `build 形态判红（exit ${r.status}）：\n${r.stderr}`);
  assert.match(r.stdout, /build-script-shape: OK/);
  const count = r.stdout.match(/已判定 (\d+) 个包/);
  assert.ok(count && Number(count[1]) > 0, "审计须真的判定到包，否则本用例就是空转");
});

test("门禁故障以 exit 2 结案：manifest 坏 JSON / package.json 坏 JSON（子进程实测）", () => {
  const cases: Array<[string, (dir: string) => void]> = [
    [
      "manifest 坏 JSON",
      (dir) => writeFileSync(join(dir, "scripts", "data", "plugins-manifest.json"), "{ not json"),
    ],
    [
      "package.json 坏 JSON",
      (dir) =>
        writeFileSync(join(dir, "packages", "dsh-probe-fault", "package.json"), "{ not json"),
    ],
  ];
  for (const [label, corrupt] of cases) {
    const dir = fixture([{ name: "dsh-probe-fault", build: CHAIN_OK }]);
    try {
      corrupt(dir);
      const r = auditProcess(dir);
      assert.equal(r.status, 2, `${label} 必须以 exit 2 结案，实得 ${r.status}：${r.stdout}`);
      assert.match(r.stderr, /::error::门禁故障/, `${label} 须打印门禁故障注解`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("判红与门禁故障不同码：形态违规 exit 1，输入损坏 exit 2（三态可区分）", () => {
  const dir = fixture([{ name: "dsh-probe-red", build: "echo TODO nothing at all" }]);
  try {
    const r = auditProcess(dir);
    assert.equal(r.status, 1, `形态违规必须是 exit 1（可信判红），实得 ${r.status}：${r.stderr}`);
    assert.match(r.stderr, /build-script-shape: FAIL/);
    assert.match(r.stderr, /dsh-probe-red/, "判词须点名包");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// 审计独立模式（BUILD_SHAPE_AUDIT_ONLY=1）：不注册用例、不被 `node --test` 包裹，
// 按 AGENTS.md 的三态直接退出。必须放在文件**末尾**——本块要跑在所有 const/function 声明之后
// （函数声明会提升，const 不会；提前执行会撞 TDZ）。
if (process.env.BUILD_SHAPE_AUDIT_ONLY === "1") {
  const { scoped, problems } = auditBuildChain(ROOT);
  if (problems.length === 0) {
    console.log(`build-script-shape: OK（已判定 ${scoped.length} 个包）`);
    process.exit(0);
  }
  for (const p of problems) console.error(`build-script-shape: FAIL — ${p}`);
  console.error("build-script-shape: FAIL");
  process.exit(1);
}
