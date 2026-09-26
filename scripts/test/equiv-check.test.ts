import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * equiv-check 的离线自测（#843 M10）。
 *
 * 为什么需要它：DEVELOPMENT §4.1 把「机制性等价性检查器」列为等价重构验收「缺一不可」的第 2 件，
 * 但 #839 把它写成一次性草稿（只在当次的 .maintenance-drafts/，已 gitignore），仓内没有任何
 * 可复跑的实现。本文件是该工具入库后的自测面，覆盖四件事。注意：**工具本身不是判据**，
 *
 *   ① 真实重构校准：对 #839（基线 8447025d = merge 的父，改动 df68b9b1 = merge 本身）跑出
 *      0 条未登记差异——注意 #839 并不是纯「只搬不改」，它真的新增了键名与字面量，所以这
 *      一条是**带登记表**的：281 条差异逐条枚举 + 按组写明理由，登记后归零。
 *   ② 未登记差异 exit 1（另含 exit 2 的输入错误面与「登记失效」的反向腐烂）。
 *   ③ **把回归种回去时工具仍报 0 差异**——这条防的是误用不是回归：它证明工具诚实承认自己
 *      的覆盖面。两种形态各一条：控制流改写（两条 push 对调）、记号原样保留的**语义对调**
 *      （两个 return 的值互换）。两条用例都把两个版本真跑一遍并断言输出确实不同，否则
 *      「0 差异」可能只是因为两版本就等价。
 *   ④ 边界声明常驻（--help / 每次输出 / --json 三处都不许丢）。
 *
 * 纪律：全程离线、不联网、不读用户 HOME；一切落盘进 mkdtempSync 的隔离目录并在 finally
 * 里删干净（仓库内零产物）。①② 的 --base/--head 是历史 ref，CI 的 test:scripts 跑在
 * fetch-depth: 0 的 build-test job 上，对象可达。
 */

const TOOL = fileURLToPath(new URL("../maintenance/equiv-check.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));

/** #839 的两版 ref：merge 提交本身与其父提交（gh 实测 mergeCommit = df68b9b1…）。 */
const PR839_BASE = "8447025d";
const PR839_HEAD = "df68b9b1";

interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 跑工具本体（不是 import 纯函数）——退出码三态本身就是被测契约。 */
function runTool(args: string[], cwd: string = REPO): ToolResult {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 临时仓：同一路径的多个版本分次提交，供 ② ③ 与两个专项造夹具。 */
function makeTempRepo(): { dir: string; commit: () => string } {
  const dir = mkdtempSync(join(tmpdir(), "equiv-repo-"));
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["config", "user.email", "equiv@example.invalid"]);
  git(["config", "user.name", "equiv"]);
  const commit = (): string => {
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "c"]);
    return git(["rev-parse", "HEAD"]).trim();
  };
  return { dir, commit };
}

/** 登记表落进隔离目录，用完即删——仓库内不留任何产物。 */
function withRegistryFile<T>(groups: unknown[], fn: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "equiv-reg-"));
  try {
    const file = join(dir, "registry.json");
    writeFileSync(file, JSON.stringify({ groups }, null, 2));
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Report {
  boundary: string;
  counts: {
    files: number;
    skipped: number;
    nodes: number;
    differences: number;
    registered: number;
    unregistered: number;
    stale: number;
  };
  registered: Entry[];
  unregistered: Entry[];
  stale: Entry[];
  exit: number;
}

interface Entry {
  path: string;
  facet: string;
  value: string;
  delta: number;
}

/** 差异项的稳定标识：比较两组差异集合时用它，避免对象键序影响判词。 */
function key4(e: Entry): string {
  return [e.path, e.facet, e.value, String(e.delta)].join(" | ");
}

function parseJson(r: ToolResult): Report {
  return JSON.parse(r.stdout) as Report;
}

interface RegistryGroup {
  path: string;
  facet: string;
  reason: string;
  items: { value: string; delta: number }[];
}
/**
 * #839 的差异登记表（43 组 / 281 条）。它是一次性内容，不是本工具的默认配置——工具本身不
 * 带任何默认白名单，每次比对都要显式 --allow 传进来。
 *
 * 登记粒度：一个（文件 × 类别）一条理由，组内**逐条枚举**（值, 计数差），不接受通配符 /
 * 前缀 / 范围。理由按组写而不是按条写，是因为同组内的差异同源（§4.1 的结构回声，或同一次
 * 去重 / 参数化），逐条重述只会把同一句话复制 281 遍；组内每一条仍被逐条枚举、逐条比对，
 * 少登记一条就会变成未登记差异而 exit 1。
 *
 * **具体披露（不能用上面那句一般性声明代替本段）**：本表 281 条里有 **68 条（24.2%）是负向
 * delta**，即同一记号的计数**下降**——典型如 `scripts/gate/local-gate.mjs` 的 `str:"--filter"`
 * 7→4、`scripts/lib/config-matrix-lib.ts` 的 `num:12` 2→1。成因是去重收敛与消息参数化：原本
 * 在多处逐字重复的同一记号被收敛为一处 / 一条带变量的模板串。
 * §4.1 对「结构回声」给的是**计数 +N** 的字面定义，**这 68 条按该定义不属这一类**——它们是
 * 本表对 §4.1 允许类别的一次**放宽**。本工具不校验此类（见 BOUNDARY：只校验登记项非空且与
 * 实测集合互相吻合），**该放宽是否可接受由评审环节判断，不由工具判断**。
 * 负向条目集中在 13 个文件，前三个占 41 条：config-matrix-lib.ts 16、local-gate.mjs 14、
 * mutation-report-lib.mjs 11。该计数由用例 ①c 断言，改表即红。
 *
 * 事实核对（#839 实测，可复跑）：键名新增 80 / 删除 0 / 同一键计数变化 85；数字字面量无任何
 * 整段消失（number-lost = 0）；新增函数无零引用（function-orphan = 0）。故本表只需登记
 * literal / key / regex 三类。两个专项为零这一事实本身被用例断言——它同时证明 §4.1 点名的
 * 两个专项不是恒真空转的判据。
 */
const PR839_REGISTRY: RegistryGroup[] = [
  {
    path: "scripts/build/build-client.ts",
    facet: "key",
    reason:
      "结构回声 + 新键：#732 把 buildClient 的 options 拆成按职责取值的 helper，同一组选项键在调用点字面量与 helper 内取值两侧各计一次；sourceText 是拆分时新起的参数键。键名无删除（键面全局实测：新增 80 / 删除 0 / 计数变化 85）。",
    items: [
      { value: "id:externals", delta: 2 },
      { value: "id:inlineBareImports", delta: 2 },
      { value: "id:mode", delta: 2 },
      { value: "id:sourceText", delta: 2 },
    ],
  },
  {
    path: "scripts/ci/ci-matrix.mjs",
    facet: "literal",
    reason: "新增 1 处空串字面量（基线 3 → 改动 4）：#732 抽 helper 时新增的默认值。",
    items: [{ value: 'str:""', delta: 1 }],
  },
  {
    path: "scripts/gate/crap-check.mjs",
    facet: "literal",
    reason:
      "纯非字符串字面量计数上升（null 15→22、0 43→48、true 15→21、false 15→19）：拆分出的 helper 各自带默认值与结果对象字段；字符串字面量零差异，说明文案没动。",
    items: [
      { value: "null:", delta: 7 },
      { value: "num:0", delta: 5 },
      { value: "bool:true", delta: 6 },
      { value: "bool:false", delta: 4 },
    ],
  },
  {
    path: "scripts/gate/crap-check.mjs",
    facet: "key",
    reason:
      "新键 + 结构回声：#732 把单文件扫描主体拆成多个 helper，各自带一份配置键（threshold / repoRoot）与结果键，故键计数上升；baseRef / relevantDiffFiles / coverageByAbs / relPath / fileDiff / failed / absPath / currentFns / baseFns / hitByLine / normFile / normRoot / isDiff 为拆分时新起的键名。键名无删除（键面全局实测：新增 80 / 删除 0 / 计数变化 85）。",
    items: [
      { value: "id:fns", delta: 2 },
      { value: "id:repoRoot", delta: 6 },
      { value: "id:threshold", delta: 8 },
      { value: "id:baseArg", delta: 2 },
      { value: "id:violations", delta: 6 },
      { value: "id:touchedCount", delta: 4 },
      { value: "id:compliantCount", delta: 4 },
      { value: "id:hotspots", delta: 4 },
      { value: "id:totalFns", delta: 3 },
      { value: "id:coveredFns", delta: 3 },
      { value: "id:scannedFiles", delta: 2 },
      { value: "id:parseFailed", delta: 2 },
      { value: "id:baseRef", delta: 6 },
      { value: "id:relevantDiffFiles", delta: 2 },
      { value: "id:coverageByAbs", delta: 4 },
      { value: "id:relPath", delta: 6 },
      { value: "id:fileDiff", delta: 6 },
      { value: "id:failed", delta: 5 },
      { value: "id:absPath", delta: 2 },
      { value: "id:currentFns", delta: 2 },
      { value: "id:baseFns", delta: 2 },
      { value: "id:hitByLine", delta: 4 },
      { value: "id:normFile", delta: 2 },
      { value: "id:normRoot", delta: 2 },
      { value: "id:isDiff", delta: 2 },
    ],
  },
  {
    path: "scripts/gate/forbid-homedir-src.mjs",
    facet: "literal",
    reason:
      "非字符串字面量计数上升（null 8→12、true 2→3、false 0→1）：新结果对象的默认值与布尔兜底；字符串字面量零差异。",
    items: [
      { value: "null:", delta: 4 },
      { value: "bool:true", delta: 1 },
      { value: "bool:false", delta: 1 },
    ],
  },
  {
    path: "scripts/gate/forbid-homedir-src.mjs",
    facet: "key",
    reason:
      "新键：#732 抽出统一的结果构造 helper，violations / parseFailures 由内联返回改写成对象字段，两键在基线侧均不存在。",
    items: [
      { value: "id:violations", delta: 2 },
      { value: "id:parseFailures", delta: 2 },
    ],
  },
  {
    path: "scripts/gate/forbid-module-state-src.mjs",
    facet: "literal",
    reason:
      "去重收敛 + 新字段：空模板片段与行首缩进串原先在 4 处逐字重复，#732 收敛到 2 处（8→6、4→2）；true 与 false 各 +1 是新结果对象的布尔字段。",
    items: [
      { value: "bool:false", delta: 1 },
      { value: "bool:true", delta: 1 },
      { value: 'tpl:""', delta: -2 },
      { value: 'tpl:"  - "', delta: -2 },
    ],
  },
  {
    path: "scripts/gate/forbid-module-state-src.mjs",
    facet: "key",
    reason:
      "新键：同 forbid-homedir，#732 把统计口径抽成一张结果对象，violations / badExemptions / legitExemptions / parseFailures 四键在基线侧均不存在（各 +2 = 构造点 + 取值点）。",
    items: [
      { value: "id:violations", delta: 2 },
      { value: "id:badExemptions", delta: 2 },
      { value: "id:legitExemptions", delta: 2 },
      { value: "id:parseFailures", delta: 2 },
    ],
  },
  {
    path: "scripts/gate/local-gate.mjs",
    facet: "literal",
    reason:
      "去重收敛（同一段拼装被步骤表复用）：--filter 7→4、--if-present 4→2，build / test / typecheck 三串与三段模板片段各 -1，空模板 -2、逗号分隔串 6→5、数字 0 17→16——都是同一渲染逻辑从三处重复收成一处。",
    items: [
      { value: "num:0", delta: -1 },
      { value: 'tpl:""', delta: -2 },
      { value: 'str:", "', delta: -1 },
      { value: 'tpl:"build（命中包 + 依赖："', delta: -1 },
      { value: 'tpl:"）"', delta: -1 },
      { value: 'str:"--filter"', delta: -3 },
      { value: 'str:"build"', delta: -1 },
      { value: 'tpl:"test "', delta: -1 },
      { value: 'str:"--if-present"', delta: -2 },
      { value: 'str:"test"', delta: -1 },
      { value: 'tpl:"typecheck "', delta: -1 },
      { value: 'str:"typecheck"', delta: -1 },
    ],
  },
  {
    path: "scripts/gate/local-gate.mjs",
    facet: "key",
    reason:
      "步骤表重构：#732 把 main 里的 if 链改成数据驱动步骤表——tier / effectiveTier / plan / cheapGlobal / prereqStep / scriptsSelfTest / pkgFilters / scopedBuild / scopeArg 为新起的表项键；label 与 args 各 -3 是三处分支里重复写一遍的表项收敛为一处。键名无删除（键面全局实测：新增 80 / 删除 0 / 计数变化 85）。",
    items: [
      { value: "id:hitPackages", delta: 2 },
      { value: "id:withCoverage", delta: 2 },
      { value: "id:base", delta: 2 },
      { value: "id:scopeLabel", delta: 4 },
      { value: "id:label", delta: -3 },
      { value: "id:args", delta: -3 },
      { value: "id:escalated", delta: 2 },
      { value: "id:files", delta: 4 },
      { value: "id:pkgFilters", delta: 2 },
      { value: "id:scopedBuild", delta: 2 },
      { value: "id:scopeArg", delta: 2 },
      { value: "id:cheapGlobal", delta: 4 },
      { value: "id:prereqStep", delta: 2 },
      { value: "id:scriptsSelfTest", delta: 4 },
      { value: "id:plan", delta: 4 },
      { value: "id:tier", delta: 2 },
      { value: "id:effectiveTier", delta: 2 },
    ],
  },
  {
    path: "scripts/gate/mutation-ledger.mjs",
    facet: "literal",
    reason: "exit 2 字面量 9→8（收进统一出口），null 3→6（新聚合函数的空值兜底）。",
    items: [
      { value: "num:2", delta: -1 },
      { value: "null:", delta: 3 },
    ],
  },
  {
    path: "scripts/gate/mutation-ledger.mjs",
    facet: "key",
    reason:
      "新键：#732 抽出按 run 聚合的小函数，scope / runId / fromLog 是新起的记录字段（各 +1 = 只出现一次的新键）。",
    items: [
      { value: "id:scope", delta: 1 },
      { value: "id:runId", delta: 1 },
      { value: "id:fromLog", delta: 1 },
    ],
  },
  {
    path: "scripts/gate/mutation-topology.mjs",
    facet: "key",
    reason: "结构回声（无新键）：抽 helper 后同一组段字段键在返回对象与调用点取值两侧各多计一次。",
    items: [
      { value: "id:mutate", delta: 2 },
      { value: "id:excludes", delta: 2 },
    ],
  },
  {
    path: "scripts/gate/repo-gate-assert.mjs",
    facet: "literal",
    reason:
      "新增 7 处 null 字面量（基线 0 → 改动 7）：results 表里本 job 未产出结果的空值占位，基线侧完全没有 null 字面量。",
    items: [{ value: "null:", delta: 7 }],
  },
  {
    path: "scripts/gate/repo-gate-assert.mjs",
    facet: "key",
    reason:
      "判词重构：#732 把逐 job 的 if 链改成一张 results 表——failure（+7）与 pkgs（+2）是新键，coverage / mutation / verdict 各 +2 为结构回声；changes / buildTest / hasMutations 各 -1 是原先散在条件表达式里的单次取值收敛进表项。",
    items: [
      { value: "id:changes", delta: -1 },
      { value: "id:buildTest", delta: -1 },
      { value: "id:coverage", delta: 2 },
      { value: "id:mutation", delta: 2 },
      { value: "id:verdict", delta: 2 },
      { value: "id:hasMutations", delta: -1 },
      { value: "id:pkgs", delta: 2 },
      { value: "id:failure", delta: 7 },
    ],
  },
  {
    path: "scripts/gate/test-surface.mjs",
    facet: "key",
    reason:
      "新键 + 结构回声：#732 把测试面派生拆成多个 helper，mutationLayers / excludeLayers / root / pkgDir / layers / exemptions / excluded / explained / layerName / rel / reason 为新起键名，其余为同一组键在多处取值导致计数上升。",
    items: [
      { value: "id:testFiles", delta: 2 },
      { value: "id:layerFiles", delta: 6 },
      { value: "id:errors", delta: 6 },
      { value: "id:mutationLayers", delta: 6 },
      { value: "id:excludeLayers", delta: 6 },
      { value: "id:root", delta: 6 },
      { value: "id:pkgDir", delta: 2 },
      { value: "id:layers", delta: 2 },
      { value: "id:exemptions", delta: 4 },
      { value: "id:excluded", delta: 2 },
      { value: "id:explained", delta: 2 },
      { value: "id:layerName", delta: 2 },
      { value: "id:rel", delta: 2 },
      { value: "id:reason", delta: 2 },
    ],
  },
  {
    path: "scripts/gate/threshold-monotonic.mjs",
    facet: "literal",
    reason:
      "三态判词落地：ok 与 env-error 两个状态名在基线侧为 0、改动侧分别出现 5 / 12 次（原先是内联文案）；exit 2 字面量 8→4 收敛到统一出口；null 18→20、数字 0 16→18 为新判词对象的字段。",
    items: [
      { value: "null:", delta: 2 },
      { value: "num:0", delta: 2 },
      { value: "num:2", delta: -4 },
      { value: 'str:"ok"', delta: 5 },
      { value: 'str:"env-error"', delta: 12 },
    ],
  },
  {
    path: "scripts/gate/threshold-monotonic.mjs",
    facet: "key",
    reason:
      "三态判词落地：#732 把通过 / 判红 / 门禁故障显式命名为 status（新键 +13），oldCfg / newCfg 是比对两侧的记录；exitCode -4 与 failures -3 是原先散在分支里的出口收敛为一处。",
    items: [
      { value: "id:exitCode", delta: -4 },
      { value: "id:failures", delta: -3 },
      { value: "id:status", delta: 13 },
      { value: "id:coverage", delta: 3 },
      { value: "id:oldCfg", delta: 1 },
      { value: "id:newCfg", delta: 1 },
    ],
  },
  {
    path: "scripts/gate/verify-coverage-scope.mjs",
    facet: "literal",
    reason:
      "消息参数化：include 与 exclude 两条近乎相同的条目腐烂文案合并为一条带前缀的模板串（前缀本身作为 str 各 +1），旧的整条文案各 -1；exit 2 字面量 7→4 收敛，null 3→13 为新判词对象的字段。",
    items: [
      { value: 'str:"include"', delta: 1 },
      { value: 'str:"exclude"', delta: 1 },
      { value: "num:0", delta: -1 },
      { value: "null:", delta: 10 },
      { value: "num:2", delta: -3 },
      { value: 'tpl:"include 模式在覆盖率根内命中 0 个文件（条目腐烂）："', delta: -1 },
      { value: 'tpl:"exclude 模式在覆盖率根内命中 0 个文件（条目腐烂）："', delta: -1 },
      { value: "bool:false", delta: 1 },
      { value: "bool:true", delta: 1 },
      { value: 'tpl:" 模式在覆盖率根内命中 0 个文件（条目腐烂）："', delta: 1 },
    ],
  },
  {
    path: "scripts/gate/verify-dir-imports.mjs",
    facet: "literal",
    reason:
      "同一条报错消息的模板串被拆成两段（冒号独立成一段），故片段集合变而文案不变；null 65→76、true 11→15、0 51→53 为拆分后 helper 的空值与布尔兜底；1 与 2 各 -1 是出口收敛。",
    items: [
      { value: 'tpl:""', delta: 1 },
      { value: "num:2", delta: -1 },
      { value: "num:1", delta: -1 },
      { value: "null:", delta: 11 },
      { value: "bool:true", delta: 4 },
      { value: "num:0", delta: 2 },
      { value: 'tpl:"：实参不是可解析的对象字面量，无法与 "', delta: -1 },
      { value: 'tpl:"实参不是可解析的对象字面量，无法与 "', delta: 1 },
      { value: 'tpl:"："', delta: 1 },
    ],
  },
  {
    path: "scripts/gate/verify-dir-imports.mjs",
    facet: "key",
    reason:
      "新键 + 结构回声：#732 拆分本文件是最大的一处，current / depth / quote / i / start / keys / problems / isFacade / allTsFiles / files / edges / intended / valueImports / kept / count / quality / firstCount 为新起键名，其余为同一组键在多个 helper 的返回对象与取值点各计一次。",
    items: [
      { value: "id:package", delta: 1 },
      { value: "id:srcDir", delta: 1 },
      { value: "id:modules", delta: 4 },
      { value: "id:refs", delta: 4 },
      { value: "id:raLegacy", delta: 2 },
      { value: "id:raImpl", delta: 2 },
      { value: "id:cycles", delta: 3 },
      { value: "id:top", delta: 2 },
      { value: "id:leaf", delta: 2 },
      { value: "id:file", delta: 2 },
      { value: "id:deadDeclarations", delta: 2 },
      { value: "id:depsValueImports", delta: 2 },
      { value: "id:rises", delta: 2 },
      { value: "id:improvements", delta: 2 },
      { value: "id:qualityPruned", delta: 1 },
      { value: "id:qualityNeedsAcceptance", delta: 1 },
      { value: "id:qualityAccepted", delta: 1 },
      { value: "id:current", delta: 1 },
      { value: "id:depth", delta: 1 },
      { value: "id:quote", delta: 1 },
      { value: "id:i", delta: 1 },
      { value: "id:start", delta: 1 },
      { value: "id:keys", delta: 2 },
      { value: "id:problems", delta: 2 },
      { value: "id:isFacade", delta: 2 },
      { value: "id:allTsFiles", delta: 2 },
      { value: "id:files", delta: 2 },
      { value: "id:edges", delta: 3 },
      { value: "id:intended", delta: 2 },
      { value: "id:valueImports", delta: 2 },
      { value: "id:kept", delta: 2 },
      { value: "id:count", delta: 2 },
      { value: "id:quality", delta: 2 },
      { value: "id:firstCount", delta: 2 },
    ],
  },
  {
    path: "scripts/gate/verify-docs.ts",
    facet: "literal",
    reason:
      "非字符串字面量计数上升（0 12→13、1 10→12、null 4→8）：新 helper 的索引与空值兜底；字符串字面量零差异。",
    items: [
      { value: "num:0", delta: 1 },
      { value: "num:1", delta: 2 },
      { value: "null:", delta: 4 },
    ],
  },
  {
    path: "scripts/gate/verify-docs.ts",
    facet: "key",
    reason:
      "新键：#732 抽出链接解析 helper，frag / rawPath 是新起的解析结果字段（各 +2 = 构造 + 取值）。",
    items: [
      { value: "id:frag", delta: 2 },
      { value: "id:rawPath", delta: 2 },
    ],
  },
  {
    path: "scripts/gate/verify-shared-fanin.mjs",
    facet: "key",
    reason:
      "新键 + 结构回声：pkgName / srcRel / sharedRoot 为 #732 拆分时新起的记录字段，file / consumers / dangling 各 +2 为返回对象与取值点。",
    items: [
      { value: "id:file", delta: 2 },
      { value: "id:consumers", delta: 2 },
      { value: "id:dangling", delta: 2 },
      { value: "id:pkgName", delta: 2 },
      { value: "id:srcRel", delta: 2 },
      { value: "id:sharedRoot", delta: 2 },
    ],
  },
  {
    path: "scripts/lib/catalog-peers-lib.ts",
    facet: "literal",
    reason: "非字符串字面量计数上升（0 5→6、null 1→3）：新 helper 的空值兜底。",
    items: [
      { value: "num:0", delta: 1 },
      { value: "null:", delta: 2 },
    ],
  },
  {
    path: "scripts/lib/catalog-peers-lib.ts",
    facet: "key",
    reason: "结构回声（无新键）：抽 helper 后同一对键在 3 个返回对象 / 取值点各多计一次。",
    items: [
      { value: "id:problems", delta: 3 },
      { value: "id:officialPeerCount", delta: 3 },
    ],
  },
  {
    path: "scripts/lib/config-matrix-gate.ts",
    facet: "literal",
    reason: "新增 7 处 null 字面量（11→18）：新行字段的空值占位。",
    items: [{ value: "null:", delta: 7 }],
  },
  {
    path: "scripts/lib/config-matrix-gate.ts",
    facet: "key",
    reason:
      "矩阵行结构改造：defaults / normalizer / booleanKeys / countLimits 为新起的行字段键；problems / lines / warnings 各 -1 是原先每次重建的同名字段收敛为一处。",
    items: [
      { value: "id:problems", delta: -1 },
      { value: "id:lines", delta: -1 },
      { value: "id:warnings", delta: -1 },
      { value: "id:defaults", delta: 2 },
      { value: "id:normalizer", delta: 2 },
      { value: "id:booleanKeys", delta: 1 },
      { value: "id:countLimits", delta: 1 },
    ],
  },
  {
    path: "scripts/lib/config-matrix-lib.ts",
    facet: "literal",
    reason:
      "查表化：peelWrappingNode 的节点类型名 if 链改成查表，各类型名从 2 处收敛到 1 处（本组 12 条 -1）；num:12 的循环上界 2→1（提为常量），num:0 14→12、num:1 13→12 随之收敛；null 15→25 是新 helper 的空值兜底。",
    items: [
      { value: "null:", delta: 10 },
      { value: "num:1", delta: -1 },
      { value: "num:0", delta: -2 },
      { value: 'str:"Identifier"', delta: -1 },
      { value: "num:12", delta: -1 },
      { value: 'str:"ObjectExpression"', delta: -2 },
      { value: 'str:"ParenthesizedExpression"', delta: -1 },
      { value: 'str:"TSAsExpression"', delta: -1 },
      { value: 'str:"TSSatisfiesExpression"', delta: -1 },
      { value: 'str:"TypeCastExpression"', delta: -1 },
      { value: 'str:"CallExpression"', delta: -1 },
      { value: 'str:"Literal"', delta: -1 },
      { value: 'str:"string"', delta: -1 },
      { value: 'str:"loc"', delta: -1 },
      { value: 'str:"start"', delta: -1 },
      { value: 'str:"end"', delta: -1 },
      { value: 'str:"range"', delta: -1 },
    ],
  },
  {
    path: "scripts/lib/gate-scope-registry.ts",
    facet: "literal",
    reason: "去重收敛：类型判定串 6→4、数字 0 9→7，#732 把两处重复的类型分支合并。",
    items: [
      { value: 'str:"string"', delta: -2 },
      { value: "num:0", delta: -2 },
    ],
  },
  {
    path: "scripts/lib/mutation-report-lib.mjs",
    facet: "literal",
    reason:
      "魔数与状态名收敛：四个变异状态名各 2→1，num:1 9→5、num:100 与 num:10000 各 2→1（两处重复的 coveredScore 表达式收敛为一处；若真 1→0 则 number-lost 会命中，而它为 0），utf8 2→1；空模板片段新增 2 处。",
    items: [
      { value: 'str:"utf8"', delta: -1 },
      { value: "null:", delta: 2 },
      { value: "num:0", delta: -2 },
      { value: 'str:"Killed"', delta: -1 },
      { value: "num:1", delta: -4 },
      { value: 'str:"Timeout"', delta: -1 },
      { value: 'str:"Survived"', delta: -1 },
      { value: 'str:"NoCoverage"', delta: -1 },
      { value: "num:10000", delta: -1 },
      { value: "num:100", delta: -1 },
      { value: 'tpl:""', delta: 2 },
    ],
  },
  {
    path: "scripts/lib/mutation-report-lib.mjs",
    facet: "key",
    reason:
      "统计口径收敛（无新键）：四个变异状态键各 +1（原先合在一个对象里，拆成两个对象后各计一次），total 与 coveredScore 各 -1 是重复的汇总字段合并为一处。",
    items: [
      { value: "id:killed", delta: 1 },
      { value: "id:timeout", delta: 1 },
      { value: "id:survived", delta: 1 },
      { value: "id:noCoverage", delta: 1 },
      { value: "id:total", delta: -1 },
      { value: "id:coveredScore", delta: -1 },
    ],
  },
  {
    path: "scripts/lib/vendored-binaries-lib.mjs",
    facet: "key",
    reason:
      "新键 + 结构回声：withPath / hashable 为 #732 拆分时新起的中间结果字段，problems +2 为返回对象与取值点。",
    items: [
      { value: "id:problems", delta: 2 },
      { value: "id:withPath", delta: 2 },
      { value: "id:hashable", delta: 2 },
    ],
  },
  {
    path: "scripts/maintenance/repair-mcp-catalog-sessions.mjs",
    facet: "literal",
    reason: "数字 0 41→48：拆分出的解析步骤各自的起点下标。",
    items: [{ value: "num:0", delta: 7 }],
  },
  {
    path: "scripts/maintenance/repair-mcp-catalog-sessions.mjs",
    facet: "key",
    reason:
      "解析结构改造：#732 把帧解析拆成独立步骤，descriptor 与 bodyStart 为新起的单次字段，frames 与 tornStart 各 -3 是原先三处分支各自写一遍的键收敛为一处。",
    items: [
      { value: "id:frames", delta: -3 },
      { value: "id:tornStart", delta: -3 },
      { value: "id:descriptor", delta: 1 },
      { value: "id:bodyStart", delta: 1 },
    ],
  },
  {
    path: "scripts/maintenance/scan-actions-concurrency.mjs",
    facet: "key",
    reason:
      "结构回声（无新键）：#732 抽出 buildEvents 与 sweepPeak 后，peakConcurrency 的返回对象与 scanRun 的展开对象各多计一次。",
    items: [
      { value: "id:peak", delta: 2 },
      { value: "id:peakAt", delta: 2 },
      { value: "id:peakUntil", delta: 2 },
      { value: "id:maxAfterPeak", delta: 2 },
    ],
  },
  {
    path: "scripts/release/baseline-staleness.mjs",
    facet: "literal",
    reason: "null 8→10：新 helper 的空值兜底。",
    items: [{ value: "null:", delta: 2 }],
  },
  {
    path: "scripts/release/baseline-staleness.mjs",
    facet: "key",
    reason:
      "新键 + 结构回声：injectedDate / rawNow 为 #732 拆分时新起的时钟注入字段，thresholdHours 与 branch 各 +2 为返回对象与取值点。",
    items: [
      { value: "id:thresholdHours", delta: 2 },
      { value: "id:branch", delta: 2 },
      { value: "id:injectedDate", delta: 2 },
      { value: "id:rawNow", delta: 2 },
    ],
  },
  {
    path: "scripts/test/orphan-baseline.test.ts",
    facet: "literal",
    reason:
      "夹具参数化：四条近乎相同的 shell 失败脚本合并为一条带变量的模板串（echo 引号段与 boom 段新起，四个实体名各 +1），四条整串文案各 -1。",
    items: [
      { value: "tpl:\"echo 'jobs boom' >&2; exit 1\"", delta: -1 },
      { value: "tpl:\"echo 'pulls boom' >&2; exit 1\"", delta: -1 },
      { value: "tpl:\"echo 'artifacts boom' >&2; exit 1\"", delta: -1 },
      { value: "tpl:\"echo 'runs boom' >&2; exit 1\"", delta: -1 },
      { value: 'tpl:"echo \'"', delta: 1 },
      { value: 'tpl:" boom\' >&2; exit 1"', delta: 1 },
      { value: 'str:"jobs"', delta: 1 },
      { value: 'str:"pulls"', delta: 1 },
      { value: 'str:"artifacts"', delta: 1 },
      { value: 'str:"runs"', delta: 1 },
    ],
  },
  {
    path: "scripts/test/scan-actions-concurrency.test.ts",
    facet: "key",
    reason: "结构回声（无新键）：用例里逐字段断言同一组返回键，参考实现与生产实现各计一次。",
    items: [
      { value: "id:peak", delta: 2 },
      { value: "id:peakAt", delta: 2 },
      { value: "id:peakUntil", delta: 2 },
      { value: "id:maxAfterPeak", delta: 2 },
    ],
  },
  {
    path: "scripts/test/verify-dir-imports-s0.test.ts",
    facet: "literal",
    reason:
      "新增 F5c 用例：既有夹具串各 +1（新增一条用例复用同一批夹具），另 4 条是 F5c 自己的文案与源码夹具（基线侧为 0）。",
    items: [
      { value: "bool:true", delta: 2 },
      { value: 'tpl:""', delta: 6 },
      { value: 'str:"export const A = 1;\\n"', delta: 1 },
      { value: "num:0", delta: 1 },
      { value: 'tpl:"：\\n"', delta: 1 },
      { value: 'tpl:"/a/interface.ts"', delta: 1 },
      { value: 'str:"export { A } from \\"./impl.ts\\";\\n"', delta: 1 },
      { value: 'tpl:"/a/impl.ts"', delta: 1 },
      { value: 'tpl:"/b/interface.ts"', delta: 1 },
      { value: 'str:"export { B } from \\"./impl.ts\\";\\n"', delta: 1 },
      { value: 'tpl:"/b/impl.ts"', delta: 1 },
      { value: 'str:"--zones"', delta: 1 },
      {
        value: 'str:"引用提取：字符串之后的注释同样不得当真（F5c，stripComments 引号态复位）"',
        delta: 1,
      },
      {
        value:
          'str:"const url = \\"https://example.com/x\\";\\n// import { A } from \\"../a/impl.ts\\";\\n/*\\nimport { A } from \\"../a/impl.ts\\";\\n*/\\nexport const B = 2;\\n"',
        delta: 1,
      },
      { value: 'tpl:"字符串之后的注释里的 import 不得产生违规，实际 "', delta: 1 },
      { value: 'tpl:"字符串之后的注释不得计入 R-A：\\n"', delta: 1 },
    ],
  },
  {
    path: "scripts/test/verify-dir-imports-s0.test.ts",
    facet: "key",
    reason: "新增 F5c 用例带出的四个 spawnSync 选项键（各只出现一次）。",
    items: [
      { value: "id:recursive", delta: 1 },
      { value: "id:status", delta: 1 },
      { value: "id:out", delta: 1 },
      { value: "id:force", delta: 1 },
    ],
  },
  {
    path: "scripts/test/verify-dir-imports-s0.test.ts",
    facet: "regex",
    reason: "新增 F5c 用例的期望正则（R-A 语义切换前的旧口径），基线侧无此正则。",
    items: [{ value: "re:R-A 语义切换前（impl → 他域任意文件，旧口径）：0 条/", delta: 1 }],
  },
];
/* ------------------------------ ① #839 的真实校准 ----------------------------- */

test("①#839 两版：带登记表跑出 0 条未登记差异（exit 0）", () => {
  const r = withRegistryFile(PR839_REGISTRY, (file) =>
    runTool(["--base", PR839_BASE, "--head", PR839_HEAD, "--allow", file, "--json"]),
  );
  assert.equal(r.code, 0, "登记表覆盖后必须判绿；判词：\n" + r.stdout + r.stderr);
  const rep = parseJson(r);
  assert.equal(rep.counts.files, 39, "#839 改动面是 39 个文件");
  assert.equal(rep.counts.differences, 281, "差异项总数是 #839 的实测值 281");
  assert.equal(rep.counts.registered, 281, "281 条差异必须逐条被登记");
  assert.equal(rep.counts.unregistered, 0, "未登记差异必须为 0");
  assert.equal(rep.counts.stale, 0, "登记项必须全部命中（反向腐烂）");
  assert.equal(rep.exit, 0);
});

test("①b 同一对 ref 不带登记表必须 exit 1，且登记表恰好等于那份未登记集合", () => {
  // 这条是①的反面：它证明「0 条未登记差异」来自**登记表与实测集合的对账**，而不是抽取侧恒返回空。
  // 注意它证明的是「没人漏登 / 多登」，**不**证明登记的理由正当——理由是否落在 §4.1 允许的
  // 两类内由人负责（见 BOUNDARY 常驻文本与文件头）。
  // 若提取口径被改坏（多算 / 少算一类记号），两侧集合不再相等，本条立刻红。
  const bare = runTool(["--base", PR839_BASE, "--head", PR839_HEAD, "--json"]);
  assert.equal(bare.code, 1, "无登记表时 281 条未登记差异必须判红");
  const rep = parseJson(bare);
  assert.equal(rep.counts.unregistered, 281);
  assert.equal(rep.counts.registered, 0);
  assert.ok(
    rep.unregistered.some(
      (e) =>
        e.path === "scripts/gate/local-gate.mjs" &&
        e.facet === "key" &&
        e.value === "id:label" &&
        e.delta === -3,
    ),
    "键计数的负向差异必须被抓到（local-gate 的 label -3）",
  );
  assert.ok(
    rep.unregistered.some(
      (e) =>
        e.path === "scripts/lib/config-matrix-lib.ts" && e.value === "num:12" && e.delta === -1,
    ),
    "数字字面量的收敛必须被抓到（config-matrix-lib 的 num:12 -1）",
  );
  const fromRegistry = PR839_REGISTRY.flatMap((g) =>
    g.items.map((it) => ({ path: g.path, facet: g.facet, value: it.value, delta: it.delta })),
  );
  assert.equal(fromRegistry.length, rep.unregistered.length, "登记表条目数必须与未登记差异数一致");
  assert.deepEqual(
    fromRegistry.map(key4).sort(),
    rep.unregistered.map(key4).sort(),
    "登记表必须恰好覆盖实测出的全部差异：多一条即登记失效，少一条即未登记",
  );
});

test("①c #839 的两个专项均为 0（事实断言，不是判据断言）", () => {
  const rep = parseJson(runTool(["--base", PR839_BASE, "--head", PR839_HEAD, "--json"]));
  const num = rep.unregistered.filter((e) => e.facet === "number-lost");
  const orphan = rep.unregistered.filter((e) => e.facet === "function-orphan");
  assert.equal(num.length, 0, "#839 没有整段消失的数字字面量");
  assert.equal(orphan.length, 0, "#839 没有新增的零引用函数");
  assert.equal(
    rep.counts.differences,
    281,
    "281 = literal 115 + key 165 + regex 1，两专项为 0 才对得上",
  );
  // 披露的数目必须由断言守住：文件头与本表的 JSDoc 都写了「281 条里 68 条是负向 delta」，
  // 数目一变那两处披露即失效——而披露失效正是本轮修订要消除的那类不实陈述。
  const negative = PR839_REGISTRY.flatMap((g) => g.items.filter((it) => it.delta < 0));
  assert.equal(negative.length, 68, "68 条负向 delta 是披露的具体事实，改表即须同步改披露与本断言");
});

/* ------------------------ ② / ③ / 专项：自造夹具（临时仓） -------------------- */

/** 夹具基线：两条 push 的顺序、逗号分隔、以及一个 process.exit(3)。 */
const FIXTURE_BASE =
  [
    "const LIMIT = 10;",
    "",
    "export function render(order) {",
    "  const parts = [];",
    "  for (const step of order) {",
    '    parts.push("A" + step);',
    '    parts.push("B" + step);',
    "  }",
    '  return parts.join(",");',
    "}",
    "",
    "export function bail() {",
    "  process.exit(3);",
    "}",
  ].join("\n") + "\n";

/** 控制流回归：只把两条 push 对调。记号多重集逐位相同，行为已经变了。 */
const FIXTURE_REGRESSED = FIXTURE_BASE.replace(
  '    parts.push("A" + step);\n    parts.push("B" + step);\n',
  '    parts.push("B" + step);\n    parts.push("A" + step);\n',
);

/**
 * 语义对调夹具：记号原样保留（"A" / "B" 各一次、数字 3 一次），只把两个 return 的值互换。
 * 它既不是控制流改动，也不是 §4.1 的结构回声，是 BOUNDARY 里明写的第三类不可见改法。
 */
const FIXTURE_PICK_BASE =
  FIXTURE_BASE + '\nexport function pick(n) {\n  if (n > 3) return "A";\n  return "B";\n}\n';

/** 只把两个 return 的值互换：多重集逐位相同，行为已经变了。 */
const FIXTURE_PICK_SWAPPED = FIXTURE_PICK_BASE.replace(
  '  if (n > 3) return "A";\n  return "B";\n',
  '  if (n > 3) return "B";\n  return "A";\n',
);

function setupFixtureRepo(): {
  dir: string;
  base: string;
  regressed: string;
  pickBase: string;
  swapped: string;
  drifted: string;
  dropped: string;
  orphaned: string;
  broken: string;
  show: (ref: string) => string;
} {
  const { dir, commit } = makeTempRepo();
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const put = (content: string): void => writeFileSync(join(dir, "m.mjs"), content);
  const from = (ref: string, content: string): string => {
    git(["checkout", "-q", ref, "--", "."]);
    put(content);
    return commit();
  };
  put(FIXTURE_BASE);
  const base = commit();
  const regressed = from(base, FIXTURE_REGRESSED);
  const pickBase = from(base, FIXTURE_PICK_BASE);
  const swapped = from(pickBase, FIXTURE_PICK_SWAPPED);
  const drifted = from(base, FIXTURE_REGRESSED.replace('"A"', '"Z"'));
  const dropped = from(base, FIXTURE_BASE.replace("= 10;", "= 20;"));
  const orphaned = from(base, FIXTURE_BASE + '\nfunction neverUsed() {\n  return "Z";\n}\n');
  const broken = from(base, "export function oops( {\n");
  const show = (ref: string): string => git(["show", ref + ":m.mjs"]);
  return { dir, base, regressed, pickBase, swapped, drifted, dropped, orphaned, broken, show };
}

test("③控制流回归种回去时工具仍报 0 差异（防误用，不是防回归）", async () => {
  const fx = setupFixtureRepo();
  try {
    const r = runTool(["--base", fx.base, "--head", fx.regressed, "--json"], fx.dir);
    assert.equal(r.code, 0, "控制流回归不可见，工具必须如实报绿（这是它诚实承认覆盖面）");
    const rep = parseJson(r);
    assert.equal(rep.counts.differences, 0, "记号多重集逐位相同，差异必须是 0 条");
    assert.equal(rep.counts.unregistered, 0);

    // 关键一步：证明这两版真的不等价。否则「0 差异」可能只是因为夹具本身没变，
    // 那这条用例就成了装饰。断言放在 import 之前不成立——这里现读现导入临时文件。
    const modDir = mkdtempSync(join(tmpdir(), "equiv-behav-"));
    try {
      writeFileSync(join(modDir, "base.mjs"), fx.show(fx.base));
      writeFileSync(join(modDir, "head.mjs"), fx.show(fx.regressed));
      const b = (await import(pathToFileURL(join(modDir, "base.mjs")).href)) as {
        render: (o: string[]) => string;
      };
      const h = (await import(pathToFileURL(join(modDir, "head.mjs")).href)) as {
        render: (o: string[]) => string;
      };
      assert.equal(b.render(["1"]), "A1,B1", "基线版渲染顺序");
      assert.equal(h.render(["1"]), "B1,A1", "改动版渲染顺序已被对调");
      assert.notEqual(
        b.render(["1"]),
        h.render(["1"]),
        "两版行为确实不同，工具的 0 差异才是盲区而非事实",
      );
    } finally {
      rmSync(modDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("③b 记号原样保留、只在语义上被对调时工具仍报 0 差异（既非控制流也非结构回声）", async () => {
  const fx = setupFixtureRepo();
  try {
    const r = runTool(["--base", fx.pickBase, "--head", fx.swapped, "--json"], fx.dir);
    assert.equal(r.code, 0, "两个 return 的值互换不增删任何记号，工具必须如实报绿");
    assert.equal(parseJson(r).counts.differences, 0, "记号逐位相同：A / B 各一次、数字 3 一次");

    // 与 ③ 同理：不把两版真跑一遍，就无法区分「工具看不见」与「夹具本来就没变」。
    const modDir = mkdtempSync(join(tmpdir(), "equiv-behav-"));
    try {
      writeFileSync(join(modDir, "base.mjs"), fx.show(fx.pickBase));
      writeFileSync(join(modDir, "head.mjs"), fx.show(fx.swapped));
      const b = (await import(pathToFileURL(join(modDir, "base.mjs")).href)) as {
        pick: (n: number) => string;
      };
      const h = (await import(pathToFileURL(join(modDir, "head.mjs")).href)) as {
        pick: (n: number) => string;
      };
      assert.equal(b.pick(5), "A", "基线版 pick(5)");
      assert.equal(h.pick(5), "B", "改动版 pick(5) 的返回值已被对调");
      assert.notEqual(b.pick(5), h.pick(5), "两版行为确实不同，0 差异是盲区而非事实");
    } finally {
      rmSync(modDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("②存在未登记差异时 exit 1（字面量漂移）", () => {
  const fx = setupFixtureRepo();
  try {
    const r = runTool(["--base", fx.base, "--head", fx.drifted, "--json"], fx.dir);
    assert.equal(r.code, 1, "一个字符串字面量被改就足以判红");
    const rep = parseJson(r);
    assert.equal(rep.counts.unregistered, 2, "一条删除 + 一条新增");
    assert.ok(rep.unregistered.some((e) => e.value === 'str:"A"' && e.delta === -1));
    assert.ok(rep.unregistered.some((e) => e.value === 'str:"Z"' && e.delta === 1));

    const text = runTool(["--base", fx.base, "--head", fx.drifted], fx.dir);
    assert.equal(text.code, 1);
    assert.ok(
      text.stdout.includes('str:"A"') && text.stdout.includes('str:"Z"'),
      "文本输出必须直接点名未登记差异的记号，不能只给计数",
    );
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
test("专项⑤ 数字字面量整段消失必须被抓到（10 改成 20 即整段消失）", () => {
  const fx = setupFixtureRepo();
  try {
    const r = runTool(["--base", fx.base, "--head", fx.dropped, "--json"], fx.dir);
    assert.equal(r.code, 1);
    const rep = parseJson(r);
    const lost = rep.unregistered.filter((e) => e.facet === "number-lost");
    assert.equal(lost.length, 1, "num:10 整段消失必须单独成条");
    assert.equal(lost[0].value, "num:10");
    assert.ok(
      rep.unregistered.some((e) => e.facet === "literal" && e.value === "num:10" && e.delta === -1),
      "literal 面同样要记一条：登记 number-lost 不豁免 literal（两个专项必须各自登记）",
    );
    assert.ok(
      rep.unregistered.some((e) => e.facet === "literal" && e.value === "num:20" && e.delta === 1),
    );
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("专项⑥ 新增零引用函数必须被抓到（抽了不用）", () => {
  const fx = setupFixtureRepo();
  try {
    const r = runTool(["--base", fx.base, "--head", fx.orphaned, "--json"], fx.dir);
    assert.equal(r.code, 1);
    const rep = parseJson(r);
    const orphan = rep.unregistered.filter((e) => e.facet === "function-orphan");
    assert.equal(orphan.length, 1, "只新增了一个函数");
    assert.equal(orphan[0].value, "fn:neverUsed");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

/* ------------------------------ ④ 三态退出码 -------------------------------- */

test("④环境或输入错误一律 exit 2，且走 stderr（与判红可区分）", () => {
  const fx = setupFixtureRepo();
  try {
    const badRef = runTool(["--base", "no-such-ref-xyz", "--head", fx.base], fx.dir);
    assert.equal(badRef.code, 2, "ref 不存在是输入错误，不是判红");
    assert.ok(badRef.stderr.includes("exit 2"), "判词必须自带三态标注");

    const brokenSrc = runTool(["--base", fx.base, "--head", fx.broken, "--json"], fx.dir);
    assert.equal(brokenSrc.code, 2, "解析失败是输入错误");
    assert.ok(brokenSrc.stderr.includes("解析失败"));

    const notSource = runTool(
      ["--base", fx.base, "--head", fx.base, "--path", "README.md"],
      fx.dir,
    );
    assert.equal(notSource.code, 2, "--path 指向非源码面必须拒绝，不能静默跳过");

    const missingArgs = runTool(["--base", fx.base], fx.dir);
    assert.equal(missingArgs.code, 2, "--head 必填");

    const unknownFlag = runTool(["--base", fx.base, "--head", fx.base, "--nope"], fx.dir);
    assert.equal(unknownFlag.code, 2, "未知参数必须拒绝");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("④c git 侧读失败必须走 exit 2，不得退化成「整文件增删」差异项", () => {
  // 造一个**树项指向不存在的 blob**的提交。两种判存在性的方式在这里分道扬镳：
  //   git ls-tree --name-only  只读树对象、照样列出路径，退出码 0；
  //   git cat-file -e <ref>:<path>  要真去读 blob，遇到缺失对象退出码非零。
  // 旧实现用后者判存在性且 catch 后一律 false，于是 head 侧被读成「文件不存在」，报成一条
  // file/removed 差异 → exit 1 判红：把 git 自身的故障读成了判据结论。改回 cat-file -e，
  // 本条立刻红。
  const dir = mkdtempSync(join(tmpdir(), "equiv-missingblob-"));
  try {
    const git = (args: string[]): string =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["init", "-q"]);
    git(["config", "user.email", "equiv@example.invalid"]);
    git(["config", "user.name", "equiv"]);
    writeFileSync(join(dir, "m.mjs"), 'export const A = "x";\n');
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "c1"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    const missing = "1111111111111111111111111111111111111111";
    const tree = execFileSync("git", ["mktree", "--missing"], {
      cwd: dir,
      input: "100644 blob " + missing + "\tm.mjs\n",
      encoding: "utf8",
    }).trim();
    const head = git(["commit-tree", tree, "-m", "c2"]).trim();
    assert.equal(
      git(["ls-tree", "--name-only", head, "--", "m.mjs"]).trim(),
      "m.mjs",
      "前提：ls-tree 仍列出路径",
    );

    const r = runTool(["--base", base, "--head", head, "--json"], dir);
    assert.equal(r.code, 2, "读不到 blob 是输入错误，必须 exit 2 而不是 exit 1");
    assert.equal(r.stdout, "", "exit 2 走 stderr，stdout 不应有 JSON 结果可供消费");
    assert.ok(
      r.stderr.includes("git show"),
      "判词必须指名是 git 读失败，而不是含糊的「比对面为空」",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("④b 登记表坏了走 exit 2；登记项没命中走 exit 1（反向腐烂）", () => {
  const fx = setupFixtureRepo();
  try {
    const noReason = withRegistryFile(
      [
        {
          path: "m.mjs",
          facet: "literal",
          reason: "   ",
          items: [{ value: 'str:"A"', delta: -1 }],
        },
      ],
      (file) => runTool(["--base", fx.base, "--head", fx.regressed, "--allow", file], fx.dir),
    );
    assert.equal(noReason.code, 2, "缺理由的登记表是坏表，不得降级成未登记或放行");

    const badDelta = withRegistryFile(
      [
        {
          path: "m.mjs",
          facet: "literal",
          reason: "x",
          items: [{ value: 'str:"A"', delta: 0 }],
        },
      ],
      (file) => runTool(["--base", fx.base, "--head", fx.regressed, "--allow", file], fx.dir),
    );
    assert.equal(badDelta.code, 2, "delta 为 0 的登记项无意义，属坏表");

    const dup = withRegistryFile(
      [
        {
          path: "m.mjs",
          facet: "key",
          reason: "同一条差异登记两次",
          items: [{ value: "id:ghost", delta: 2 }],
        },
        {
          path: "m.mjs",
          facet: "key",
          reason: "同一条差异登记两次",
          items: [{ value: "id:ghost", delta: 2 }],
        },
      ],
      (file) => runTool(["--base", fx.base, "--head", fx.regressed, "--allow", file], fx.dir),
    );
    assert.equal(dup.code, 2, "同一差异登记两条时判词不自洽，属坏表");

    const stale = withRegistryFile(
      [
        {
          path: "m.mjs",
          facet: "key",
          reason: "登记了一条这次根本没发生的差异",
          items: [{ value: "id:ghost", delta: 2 }],
        },
      ],
      (file) =>
        runTool(["--base", fx.base, "--head", fx.regressed, "--allow", file, "--json"], fx.dir),
    );
    assert.equal(stale.code, 1, "登记项没命中说明表已与现实脱节，同样判红");
    const rep = parseJson(stale);
    assert.equal(rep.counts.stale, 1);
    assert.ok(rep.stale[0].value === "id:ghost");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

/* -------------------------- ⑤ 边界声明常驻（三处 + 文件头） ------------------- */

test("⑤覆盖面边界声明在 --help / 文本输出 / --json / 文件头四处都在", () => {
  const help = runTool(["--help"]);
  assert.equal(help.code, 0);
  for (const needle of [
    "不构成等价性证明",
    "控制流等价性不在覆盖面内",
    "被对调", // 记号原样保留、只在语义上被对调同样不可见；BOUNDARY 不写，读者会以为之外都在面内
    "不对「差异是否无害」作任何判定", // 它是抽取 + 对账器，不是判据
    "不校验理由的类别", // 逐条填 TODO 也能过，正当性由人负责
    "非源码面被跳过",
    "0",
    "1",
    "2",
  ]) {
    assert.ok(help.stdout.includes(needle), "--help 缺 " + needle);
  }
  const fx = setupFixtureRepo();
  try {
    const text = runTool(["--base", fx.base, "--head", fx.drifted], fx.dir);
    assert.equal(text.code, 1);
    assert.ok(
      text.stdout.split("\n")[0].includes("不构成等价性证明"),
      "每次文本输出的第一行必须是边界声明，不能被业务输出挤掉",
    );
    const json = parseJson(runTool(["--base", fx.base, "--head", fx.drifted, "--json"], fx.dir));
    assert.ok(json.boundary.includes("不构成等价性证明"), "--json 必须带 boundary 字段");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
  const source = readFileSync(TOOL, "utf8");
  assert.ok(
    source.includes("不构成等价性证明") && source.includes("控制流等价性不在覆盖面内"),
    "文件头必须同样声明边界——只写在 --help 里的话，不读源码的人看不到",
  );
});
