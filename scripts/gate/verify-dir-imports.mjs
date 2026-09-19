#!/usr/bin/env node
"use strict";

/**
 * verify-dir-imports —— 目录 interface.ts 门面静态检查 + 依赖图尺子（#664 D10 / #670 C2 / #690 S0）。
 *
 * 规则：
 *   1. 模块 = 递归包含 `interface.ts` 的目录（叶子粒度），被模块外文件引用时必须提供
 *      `interface.ts`（该模块唯一对外引用面）。跨模块引用的目标若落在不含
 *      `interface.ts` 的目录内（分组层 / 未登记目录），同样判缺门面。
 *   2. 跨模块 import / export-from / dynamic-import 只能解析到目标模块的
 *      `interface.ts`（入口）或 `deps.ts`（出口），禁止直引模块内实现文件；
 *   3. 同模块相对 import 放行（含模块内子目录）；`src/` 根文件之间互引暂不约束；
 *      模块内文件 import 根文件放行（阶段 2–5 过渡债）。
 *   4. interface.ts 符号存在性（防虚导出）：被外部引用的 interface.ts 的每个具名
 *      导出符号，必须沿其 re-export 链可解析到真实实现（链终点可为模块内实现文件
 *      或同包根文件）。两模式（soft/hard）均硬执行（exit != 0）。
 *   5. 值依赖图无环：跨模块的**值** import/re-export 构成的有向图不得成环。
 *      `import type` / `export type` 边编译期擦除，允许成环。S0 起**判红口径为叶子
 *      模块粒度**（与模块定义同源）；顶层域口径退为「历史对照」行——它原样复刻修复
 *      粒度前的算法（起点与目标的直接父目录都须是顶层目录，嵌套目标整条边被丢弃），
 *      而那个算法正是环检测曾静默归零的成因，故只用于跨期比对、不参与判定。
 *      存量环登记在基线里只许降不许升，拆解属 #690 P1。
 *
 * S0 新增（#690）：
 *   - **叶子粒度模块定义**：模块名取相对 `src/` 的完整路径（如 `server/config`），
 *     分组层（不含 interface.ts 的中间目录）不进模块表，对门禁透明。旧实现只取
 *     `src/` 顶层一层，嵌套目标整条边被丢弃（实测用量统计包 13 个 interface.ts
 *     只被认作 4 个目录、丢弃 115 条边；MCP 包丢弃 27 条）。
 *   - `--zones`：叶子口径跨域引用明细 + R-A 两个语义口径计数（D-2 前后）。
 *   - `--graph`：依赖矩阵 + 扇入扇出 + 模块级/文件级值环 + 死声明。
 *   - **单调基线**（`scripts/data/dir-imports-baseline.json`）：结构型存**计数**
 *     （`--write-baseline` 登记），质量型存**证据集合**——新增证据判红、证据消失视为
 *     改善（写入时自动清理）、kind 由 value→type 视为收口、type→value 判红；放宽的
 *     唯一通道是登记到 `scripts/data/gate-exemptions.json`（gate = `verify-dir-imports`，
 *     key = `<包名>:<证据项>` 或 `<包名>:*`；后者专用于「本包无基线」，不声称任何证据）
 *     ——与另两闸共用同一份台账与同一个校验器，条目带 reason + trackingIssue（+ 可选
 *     reviewBy），并自动进 `collect-exemptions` 的到期台账。
 *   - **源码全覆盖断言**：`src` 下每个文件必须落在 `∪mutate ∪ ∪excludes` 之内。
 *     `gen-stryker-conf --check` 只比对「磁盘配置 ↔ 拓扑派生」，不会因新增源文件
 *     而变红，故新增未被度量覆盖的源文件必须由本断言兜住（存量登记在基线里）。
 *
 * #733 M0 修正：
 *   - **死声明口径改「值面判死、类型面豁免」**（M0a）：`deps.ts` 的类型边不进死声明
 *     计算（类型声明本身即完整性），值边必须由本模块非 deps.ts 文件佐证；`deps.ts`
 *     自身出现值 import 单独硬判红。
 *   - **结构型 / 质量型分组**（M0b；#733 后续升级为证据面）：结构型随新增文件/目录
 *     合法上升并由 `--write-baseline` 更新；质量型一律不得被自动放宽——写入只清理
 *     已消失的证据，新增证据必须显式接受并留痕（理由与条目入库）。
 *
 * #767 B0 切片 3a（两条今天没有执法点的宪法判据）：
 *   - **I2① 域间值边**：新增质量证据 `crossDomainValueEdges`——叶子模块粒度下**目标不是
 *     共享层**（`shared/**`、`server/shared/**`、仓库 `shared/`）的值边集合。它与
 *     `leafValueEdges` 不是同一条判据：后者含指向共享层的边、是**结构型计数**（新增
 *     文件/目录时合法上升），前者是**质量型证据**（新增判红、只许缩小、终态为空）。
 *     缺了它，I2① 只剩 `--graph` 的打印，B2 的「域间值边 = 0」是无执法点的空头验收。
 *   - **I2④ 值引组合根**：新增质量证据 `rootIndexImports`——`fileValueEdges` 面上目标为
 *     src 根 `index.ts` 的值边（域取组合根的常量即成文件级值环；`import type` 编译期
 *     擦除，不入此面）。该形态此前只在不巧构成环时才可见。
 *   - **§5.3 client 侧 import 面**：新增质量证据 `clientServerImports`——`src/client/**`
 *     不得 import `src/server/**`。**独立一遍扫描**：client 子树照旧不进 `files` /
 *     `leafValueEdges` / `fileValueEdges` / `crossModuleRefs`，故各包既有基线零位移。
 *     证据 id 用**包相对**路径（`src/client/…|src/server/…`），与 §5.3 登记的台账键同形。
 *   - 三类都是**新的证据类**：`--write-baseline` 对「基线里没有这个键」的类按首次登记
 *     写入存量并逐类提示（mcp 的 I2① 存量就是 33 条，逐条要求开豁免 = 把存量登记误当
 *     放宽通道）；类**内**新增证据仍一律不写入、判红、放宽须登记台账。
 *
 * #767 B0 切片 3b（I8 测试导入面判据，本轮**只对 `test/unit/**` 生效**）：
 *   - **I8①**：新增质量证据 `unitImportFaceViolations`——`test/unit/**` 下的文件不得 import
 *     包根组合根 `src/index.ts`、构建产物面 `lib/**`、客户端面 `src/client/**`。单元层是
 *     白盒直连 `src/server/<域>/impl/<块>/`（§8.1 的表），经组合根导入等于把装配顺序与服务面
 *     带进单元测试，等于用产物入口测单模块：分层由**导入面**定义，不由文件名前缀定义。
 *   - **裸包名自引用同样计入**（#767 B1.0 判据加固）：`import "<本包名>"` 与
 *     `import "<本包名>/<rest>"` 分别按 `lib/index.js`、`lib/<rest>` 落进**同一个证据面**（包名
 *     从本包 `package.json` 现读，不内嵌常量）。`resolveCandidates` 只吃 `.` 开头的说明符，不做
 *     这层映射时这种写法**零候选**、`resolveTarget` 返回 null，而它经 `exports["."]` 真能解析到
 *     `./lib/index.js`——「换个写法就能够到产物面却不留证据」正是本判据要堵的假绿。映射只落在
 *     I8① 的采集函数内：放开 `resolveCandidates` 会顺带改写 I2①/I2④/§5.3 的判据面（那三条禁的
 *     是 `src/server/**` 与 `src/index.ts`，不是本条的等价写法）。
 *   - **面外显式放行**：`test/helpers.ts` 等测试基础设施不在 `test/unit/**` 内；判据也只认
 *     `src/index.ts` / `lib/**` / `src/client/**` 三类目标，测试目录之间的互引一律不判。
 *     `test/e2e/**` 与 `test/integration/**` 各有产物与浏览器语义，**本轮明确不判**（I8 判据的
 *     ②③ 压后），故 `test/e2e/**` 引 `src/index.ts` 仍是合法形态。
 *   - **存量两档**：本包 13 条（14 处引用按 `文件|目标` 去重）进单调基线，随 §12 的批次清零；
 *     其他包 3 条（lan-proxy 2 / web-file-preview 1）同笔登记 `gate-exemptions.json`。
 *   - **包范围**：不内嵌包常量——判据随 `--package` 的调用面走，范围登记在
 *     `scripts/data/gate-scope-registry.json` 的 verify-dir-imports 条目（scopeFrom=cli）。
 *
 * 豁免：
 *   - `src/client/`（index.ts 为 build-client 契约锚点）：from 侧完全豁免（规则 1–5 的
 *     扫描面与三套依赖图都不含它）；target 侧同样不入模块表与依赖图。**唯一例外**是
 *     §5.3 的 `clientServerImports`——它按 client 侧 import 面单独扫一遍，不参与其余计数。
 *   - 跨包 shared/ 共享层、lib/ 产物、node_modules、client/ 内部资源不在检查范围。
 *
 * 模式（#710 F11：措辞必须区分「有基线 / 无基线」两态，否则会误读成 --soft 也判红）：
 *   - 默认（hard）：规则违规经单调基线判定（实际 > 基线即 FAIL，exit 1）。
 *   - `--soft`：规则 1–3 违规只打印软报告标签，仍受基线约束；规则 4（虚导出）两模式均硬执行。
 *   - **基线缺失或包未登记（fail-closed）**：
 *       · 本包在基线里**没有条目**（新包漏登 / 条目被删 / 基线整份缺失）= 该包不在任何
 *         单调基线之下，本条**自身即判红**（#843 D15：旧实现只在违规计数非零时才红，
 *         计数为零时打印「基线无本包条目 —— fail-closed」却 exit 0，提示语与行为相反）；
 *         唯一放宽通道是 `scripts/data/gate-exemptions.json` 里 `gate=verify-dir-imports`、
 *         path = `<包名>:*`（本包无基线）或 `<包名>:<证据项>` 的条目——豁免只免「无条目」
 *         这一条，违规/环/未覆盖照旧零容忍，且 `--soft` 不改变本条（它是「无基线 = 不放行」
 *         本身）；`<包名>:*` 不声称具体证据，故它的反向腐烂是「该包一旦落库基线即失效」；
 *       · hard 下规则 1/2 违规即刻 exit 1；
 *       · soft 下规则 1/2 仍只进软报告（不判红）——fail-closed 只保证「无基线 = 不放行」，
 *         不改变 soft 对规则 1–3 的软报告语义；
 *       · 两种模式下规则 4（虚导出）、规则 5（值环）与源码全覆盖断言都硬执行。
 *   - **$noMutationPackages 登记（#773 批 B / #710 §2-2）**：包登记在
 *     `scripts/data/mutation-topology.json` 的 `$noMutationPackages` 时，源码全覆盖断言
 *     **不适用**（该包没有变异面）——但不静默判绿：判绿输出里必须打印一条显式声明
 *     （含登记理由与跟踪 #690 S6/S8 / #773）。两处都未登记仍是 fail-closed；拓扑文件
 *     **整份缺失 / 内容非对象**（#773 R3）同样 fail-closed：此时未覆盖清单恒为空、判据整体
 *     失去依据，故门禁自身判红（缺失、顶层不是对象、解析失败是三种事实，不合并语义），
 *     `scripts/test/workflow-assert.test.ts` 的「单一事实源在位」断言保留为冗余兜底。
 *
 * 适用包白名单：`--package <name>`（可多次）；缺省 = 仅 dsh-mcp-manager。空值 / 等号形态 /
 * 非包名取值一律 exit 2——静默退化成默认包或空包集，等于调用点以为自己切了范围，实际扫的是
 * 另一个包、或一个包都没扫，却照样打印 PASS（#843 D15 同族 fail-open）。
 * `--write-baseline` 缺省取范围注册表里本闸的范围（= cli 调用点并集，登记面一致性的
 * 另一侧），不再全量扫描 packages 下有 src 的目录——旧口径会为「有 src、无调用点」的包
 * 落死条目（#843 D15）。
 * 用法：node scripts/gate/verify-dir-imports.mjs [--package <name>] [--soft] [--verbose]
 *                                              [--zones] [--graph] [--write-baseline]
 *                                              [--exemptions <path>]
 * 退出码：0 = 通过；1 = 硬违规 / 新增未登记的质量证据 / 结构型上升 / 台账条目失效；
 *         2 = 用法错误（豁免台账不可读、结构不合法或键形态非法 / --package 缺值或形态不认识 /
 *             写基线的缺省范围不可解析）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { argValue, loadLedger } from "../lib/exemption-gate.ts";
import { loadScopeRegistry, scopePackages } from "../lib/gate-scope-registry.ts";
import { failClosed } from "../lib/gate-exit.mjs";
import { collectMutationSpecs } from "./mutation-topology.mjs";

// 仓库根；测试可用 VERIFY_DIR_IMPORTS_ROOT 注入临时 fixture 根，避免在仓库内
// 造包目录（产物零污染纪律）。基线可用 VERIFY_DIR_IMPORTS_BASELINE 覆盖。
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = process.env.VERIFY_DIR_IMPORTS_ROOT ?? REPO_ROOT;
const BASELINE_PATH =
  process.env.VERIFY_DIR_IMPORTS_BASELINE ??
  join(ROOT, "scripts", "data", "dir-imports-baseline.json");
const TOPOLOGY_PATH = join(ROOT, "scripts", "data", "mutation-topology.json");
/** 本闸在范围注册表里的 gate 名（写基线的缺省范围与判据范围同源）。 */
const GATE_NAME = "verify-dir-imports";
const SCOPE_REGISTRY_PATH = join(ROOT, "scripts", "data", "gate-scope-registry.json");
const VERBOSE = process.argv.includes("--verbose");
const SOFT = process.argv.includes("--soft");
const ZONES = process.argv.includes("--zones");
const GRAPH = process.argv.includes("--graph");
const WRITE_BASELINE = process.argv.includes("--write-baseline");
// 质量证据的放宽通道：**统一走 scripts/data/gate-exemptions.json**（#765 收口）。
//
// 为什么删掉原先的 `--accept-quality-new` / 基线内 `$acceptances`：那是本闸私有的第二套
// 豁免机制——没有 trackingIssue、没有 reviewBy、没有反向腐烂校验，也不进 collect-exemptions
// 的到期台账。同一件事两套机制必然漂移（一处能到期、一处不能），而「放宽」恰恰是最需要
// 留痕与收口处的动作。现在与 forbid-homedir-src / forbid-module-state-src 共用同一份台账、
// 同一个校验器（scripts/lib/exemption-gate.ts）与同一条到期台账。
//
// 条目形态：`path` 填**证据键** `<包名>:<证据项>`（证据项取自基线的 quality 集合，边的形态是
// `from|to`；环是签名；未覆盖源文件是路径），并必填 reason + trackingIssue。
// 默认锚在**真实仓库根**而不是 fixture 扫描根：与另两闸同语义——`--root` 只改扫描面，
// 台账永远是仓库里那一份（否则 fixture 会因为「临时根下没有台账」而 fail-closed）。
const EXEMPTIONS_PATH = argValue(
  process.argv,
  "--exemptions",
  join(REPO_ROOT, "scripts", "data", "gate-exemptions.json"),
);
const EXEMPTIONS_DISPLAY = relative(REPO_ROOT, EXEMPTIONS_PATH) || EXEMPTIONS_PATH;
let evidenceLedger;
try {
  evidenceLedger = loadLedger(EXEMPTIONS_PATH, "verify-dir-imports");
} catch (e) {
  failClosed(`verify-dir-imports | 豁免台账不可用：${e.message}`);
}
/**
 * 「本包无基线」登记的后缀：`<包名>:*`。与 `<包名>:<证据项>` 的区别是它不声称任何本次
 * 证据——正是为了给「这个包本来就没有基线可指」留一条能真正走通的通道：证据形态的键在
 * 无证据的包上永远过不了反向腐烂校验（零命中即失效），于是那条通道对触发它的包不可用。
 */
const NO_BASELINE_KEY_SUFFIX = ":*";
// 键形态校验放在这里而不是 loadLedger：台账是共享数据面，只有本闸知道自己的键长什么样。
// 形态不认识的键既不豁免任何东西、也不被任何判据看到——一条静默失效的放宽。
for (const key of evidenceLedger.keys()) {
  if (!/^[a-z0-9-]+:.+$/.test(key)) {
    failClosed(
      `verify-dir-imports | 豁免台账键形态非法：${key}（应为 <包名>:<证据项> 或 <包名>:*）`,
    );
  }
}
const ARGV = process.argv.slice(2);

/**
 * 适用包白名单：显式 `--package <name>`（可多次）累加；缺省仅 #664 重构包。
 *
 * 不合法一律 exit 2，不退化成任何一种「照常跑」：悬空的 `--package` 会得到空包集，零个包
 * 被分析仍打印 PASS；`--package=<name>` 不被认识，于是退回默认包——两种形态都让调用点以为
 * 自己切了范围。把「我什么都没扫」说成「全部通过」是本闸最不能有的失败方式。
 */
function parsePackageFlags(argv) {
  const names = [];
  let given = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--package=")) {
      failClosed(`verify-dir-imports | 参数形态不认识：${token}（请写成 --package <name>）`);
    }
    if (token !== "--package") continue;
    given = true;
    const value = argv[i + 1];
    if (value === undefined || !/^[a-z0-9-]+$/.test(value)) {
      failClosed(
        `verify-dir-imports | --package 缺少合法包名（实际 ${JSON.stringify(value)}）——空包集等于零个包被分析`,
      );
    }
    names.push(value);
    i += 1;
  }
  return given ? names : null;
}

const explicitPackages = parsePackageFlags(ARGV);
const failures = []; // 硬失败：规则违规（无基线时）或基线上升
const softViolations = []; // soft 模式软报告的跨模块直引违规
const summary = [];
const reports = []; // --zones / --graph 的明细段（最后统一打印）

/** 递归收集目录下全部 .ts/.tsx/.mts/.mjs 文件（绝对路径，from 侧扫描用）。 */
function collectTsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, acc);
    else if (/\.(?:ts|tsx|mts|mjs)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** 递归收集目录下全部文件（绝对路径，覆盖断言用）。 */
function collectAllFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectAllFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** 一个相对 import 目标的所有存在候选（支持 .ts/.tsx/.mjs/.mts/.d.ts/.d.mts 与目录 index 落点）。 */
function resolveCandidates(fromFile, spec) {
  if (!spec.startsWith(".") || isAbsolute(spec)) return [];
  const base = resolve(dirname(fromFile), spec);
  const cands = [];
  const tryAdd = (p) => {
    if (existsSync(p) && statSync(p).isFile()) cands.push(p);
  };
  tryAdd(base); // spec 自带后缀（如 "./opencode-go.mjs"）时字面命中
  for (const ext of [".ts", ".tsx", ".mts", ".mjs", ".d.ts", ".d.mts"]) tryAdd(base + ext);
  // TS/ESM 约定：源码写 `./foo.js` 而磁盘上是 `./foo.ts`。不做这步映射会把整条引用
  // 静默丢弃，等于给「改用 .js 后缀即可绕开门禁」留后门。
  if (/\.(?:js|mjs|cjs)$/.test(spec)) {
    const stem = base.replace(/\.(?:js|mjs|cjs)$/, "");
    for (const ext of [".ts", ".tsx", ".mts"]) tryAdd(stem + ext);
  }
  for (const name of [
    "index.ts",
    "index.tsx",
    "index.mts",
    "index.mjs",
    "index.d.ts",
    "index.d.mts",
  ]) {
    tryAdd(join(base, name));
  }
  return cands;
}

/** 解析一个相对 import 目标的绝对路径（取首个存在候选；无则 null）。 */
function resolveTarget(fromFile, spec) {
  return resolveCandidates(fromFile, spec)[0] ?? null;
}

/** 引号态内的单步推进；跨过转义对，并把收尾引号写回状态。 */
function stepQuoted(text, i, quote) {
  const ch = text[i];
  if (ch === "\\") return i + 2;
  if (ch === quote.current) quote.current = null;
  return i + 1;
}

/** 行注释跳到换行符（不含）为止；不是起点时返回 null。 */
function stepLineComment(text, i) {
  if (text[i] !== "/" || text[i + 1] !== "/") return null;
  while (i < text.length && text[i] !== "\n") i += 1;
  return i;
}

/** 块注释跳到闭合符之后；缺少闭合符时截到文本末尾。返回 null 表示不是块注释起点。 */
function stepBlockComment(text, i) {
  if (text[i] !== "/" || text[i + 1] !== "*") return null;
  i += 2;
  while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
  return Math.min(i + 2, text.length);
}

/**
 * 剥离注释，避免注释里的 import 示例被当成真实引用。
 *
 * 逐字符扫描而非「先正则剥块注释再剥行注释」：后者会把行注释里的 `/*` 与后续的块注释
 * 闭合符配成幻影块注释，连同中间的真实 import 一起吞掉（本仓实测 dsh-mcp-manager 与
 * dsh-provider-usage 各中一处）。故先判 `//` 再判 `/*`，并跟踪字符串状态，使字符串里的
 * `//`、`/*`（如 URL、glob 字面量）不成为注释起点。
 */
function stripComments(text) {
  let out = "";
  let i = 0;
  const quote = { current: null };
  while (i < text.length) {
    const start = i;
    if (quote.current !== null) {
      i = stepQuoted(text, i, quote);
      out += text.slice(start, i);
      continue;
    }
    if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      quote.current = text[i];
      i += 1;
      out += text.slice(start, i);
      continue;
    }
    const lineEnd = stepLineComment(text, i);
    if (lineEnd !== null) {
      i = lineEnd; // 行注释整段丢弃；停在换行符上，由下一轮普通字符分支保留它
      continue;
    }
    const blockEnd = stepBlockComment(text, i);
    if (blockEnd !== null) {
      i = blockEnd;
      out += " "; // 与旧实现一致：块注释折算成一个空格，行注释什么都不留
      continue;
    }
    i += 1;
    out += text.slice(start, i);
  }
  return out;
}

/**
 * 判定一个 import/export 子句是否**整句类型**（含内联 `type X` 逐符号修饰）。
 * 入参是 `from` 之前的子句（不含 import/export 关键字），故整句类型以 `type` 起头。
 */
function isTypeOnlyClause(clause) {
  if (/^type\b/.test(clause.trim())) return true;
  const brace = clause.match(/\{([^}]*)\}/);
  if (brace === null) return false;
  const names = brace[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return names.length > 0 && names.every((n) => /^type\s+/.test(n));
}

/**
 * 提取文件文本里的全部相对引用（spec + 是否类型位置）。
 *
 * 覆盖形态：`import|export ... from "spec"`、副作用 `import "spec"`、动态
 * `import("spec")`。特别注意 TS 的**类型查询** `import("spec").T` 与运行时动态导入
 * 同形：纯文本无法完全区分，而运行时形态必经 `await` 或 `.then/.catch`，故只在
 * 明确表达式上下文判值，其余按类型处理——否则纯类型代码会造出幻影值边与假值环。
 */
function extractRefs(text) {
  const out = [];
  // 子句部分不得跨过下一个 import/export 关键字：`export interface X { … }` 这类
  // 没有 from 的语句，否则会把后面某个 `export type { … } from "…"` 一并吃进来，
  // 于是整段被判成值引——一个纯类型的依赖声明面凭空多出一条值边。
  const staticRe =
    /(?:^|\n)[ \t]*(?:import|export)\s+((?:(?!\b(?:import|export)\b)[^'"])*?)\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = staticRe.exec(text)) !== null) {
    if (m[3] !== undefined)
      out.push({ spec: m[3], isType: false }); // 副作用导入仍是值依赖
    else out.push({ spec: m[2], isType: isTypeOnlyClause(m[1]) });
  }
  const dynRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 10);
    const isValue = /\bawait\s*$/.test(before) || /^\s*\.\s*(?:then|catch|finally)\b/.test(after);
    out.push({ spec: m[1], isType: !isValue });
  }
  return out;
}

/** 读一个成员并取其顶层键；判不出来（展开 / 计算属性 / 非标识符键）返回 null。 */
function memberKey(member) {
  if (member === "") return undefined;
  if (member.startsWith("...") || member.startsWith("[")) return null;
  const colon = member.indexOf(":");
  const key = (colon === -1 ? member : member.slice(0, colon)).trim().replace(/^['"]|['"]$/g, "");
  if (!/^[A-Za-z_$][\w$]*$/.test(key)) return null;
  return key;
}

/** 维护引号态：进引号 / 收引号；不涉及引号时返回 false。 */
function advanceQuote(text, cursor) {
  const ch = text[cursor.i];
  if (cursor.quote !== null) {
    if (ch === cursor.quote && text[cursor.i - 1] !== "\\") cursor.quote = null;
    return true;
  }
  if (ch === '"' || ch === "'" || ch === "`") {
    cursor.quote = ch;
    return true;
  }
  return false;
}

/** 按括号对称调整深度；闭合到零层表示对象字面量到此结束。不涉及括号时返回 null。 */
function advanceDepth(cursor, ch) {
  if (ch === "{" || ch === "(" || ch === "[") {
    cursor.depth += 1;
    return true;
  }
  if (ch === "}" || ch === ")" || ch === "]") {
    cursor.depth -= 1;
    return cursor.depth !== 0;
  }
  return null;
}

/**
 * 推进一个字符；对象字面量已闭合时返回 false（此时不再读成员）。
 *
 * 引号态优先于其它一切判定，故未收尾的引号会把整段（含分隔符与括号）吞掉——
 * 与逐字符扫描的语义一致。
 */
function scanMemberBounds(text, cursor) {
  if (advanceQuote(text, cursor)) return true;
  const ch = text[cursor.i];
  const closed = advanceDepth(cursor, ch);
  if (closed !== null) return closed;
  if ((ch === "," || ch === ";" || ch === "\n") && cursor.depth === 1) {
    // `;` 与换行是 interface 成员的合法分隔符，`,` 是对象字面量的；这个函数两者都要
    // 读——只在深度 1 切分，属性值跨行发生在更深层，不受影响。
    return cursor.take(cursor.i);
  }
  return true;
}

/**
 * 提取对象字面量 `{ … }` 的顶层键。入参从 `{` 开始。
 *
 * 遇到展开运算符、计算属性键或读不懂的成员一律返回 null——那是「判不出来」，调用方
 * 据此放弃判定，而不是当成空集：把判不出来当成合规，正是本门禁要防的假绿。
 */
function objectLiteralKeys(text) {
  if (text[0] !== "{") return null;
  const keys = [];
  // text[0] 即对象字面量的开括号（调用方 slice 从 { 开始，i = 1 跳过它）：顶层成员本就处在深度 1。
  // 初值 0 会让顶层 , / ; / 换行永不切分（depth === 1 才切），全靠收尾分支 push 首个冒号前的键——
  // 两侧同错时假绿（只比首字段），文本变化打破平衡即幻影失配（#767 rebase 筆2 installRuntime 误报 settingsSource）。
  const cursor = { depth: 1, quote: null, i: 1, start: 1 };
  cursor.take = (end) => {
    const key = memberKey(text.slice(cursor.start, end).trim());
    if (key === null) return false;
    if (key !== undefined) keys.push(key);
    cursor.start = end + 1;
    return true;
  };
  while (cursor.i < text.length) {
    if (!scanMemberBounds(text, cursor)) {
      // 收尾成员停在闭合符前，与分隔符处不在同一步，故这里单独读一次。
      const key = memberKey(text.slice(cursor.start, cursor.i).trim());
      if (key === null) return null;
      if (key !== undefined) keys.push(key);
      return keys;
    }
    cursor.i += 1;
  }
  return null;
}

/** 收 deps.ts 里每个导出 interface 的字段集（就地声明，字段名即 Port 名）。 */
function collectDepsFields(files) {
  const fieldsByType = new Map();
  for (const f of files.filter((x) => x.endsWith("deps.ts"))) {
    const text = stripComments(readFileSync(f, "utf8"));
    const re = /export\s+interface\s+([A-Za-z_$][\w$]*)\s*\{/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const keys = objectLiteralKeys(text.slice(m.index + m[0].length - 1));
      if (keys !== null) fieldsByType.set(m[1], keys);
    }
  }
  return fieldsByType;
}

/** 收 interface.ts 里 `installXxx(deps: XxxDeps)` 的 install → 依赖类型名映射。 */
function collectInstallDepsTypes(files) {
  const typeByInstall = new Map();
  for (const f of files.filter((x) => x.endsWith("interface.ts"))) {
    const text = stripComments(readFileSync(f, "utf8"));
    const re =
      /export\s+function\s+(install[A-Z]\w*)\s*\(\s*[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(text)) !== null) typeByInstall.set(m[1], m[2]);
  }
  return typeByInstall;
}

/**
 * 取调用实参的键集；实参不是可解析的对象字面量时 returned=null 且 problems 带判词
 * ——「判不出来」与「键集为空」对调用方是两种事实，故不用空集顶替。
 */
function collectInterfaceArguments(indexText, cursor, depsType) {
  let i = cursor;
  while (i < indexText.length && /\s/.test(indexText[i])) i += 1;
  const keys = indexText[i] === "{" ? objectLiteralKeys(indexText.slice(i)) : null;
  if (keys === null) {
    return { keys: null, problems: [`实参不是可解析的对象字面量，无法与 ${depsType} 对账`] };
  }
  return { keys, problems: [] };
}

/** 实参键集与声明字段集的对账：漏接在前、多接在后（与基线文案顺序一致）。 */
function compareDepsKeys(installName, depsType, fields, keys) {
  const out = [];
  for (const k of fields.filter((x) => !keys.includes(x)))
    out.push(`${installName}：漏接 "${k}"（${depsType} 声明了，组合根没给）`);
  for (const k of keys.filter((x) => !fields.includes(x)))
    out.push(`${installName}：多接 "${k}"（${depsType} 没有这个字段）`);
  return out;
}

/**
 * 注入面对账（#733 方案 C）。
 *
 * `deps.ts` 是**纯类型面**，「本域声明要什么」与「组合根递了什么」之间因此少了一层编译
 * 器兜底：漏给一个 Port 会编译报错，但**多给、给了已删字段、或某个域压根没接上**都只剩
 * 运行期空值——而它的症状与本插件毫无字面关联。这条规则把那份对照补回机器面。
 *
 * 判据：`installXxx(deps: XxxDeps)` 的实参键集 == `XxxDeps` 的字段集，任一侧多出即红。
 * 实参不是对象字面量时同样判红——否则「传个变量进来」就是绕过路径。
 */
function analyzeInjectionFaces(srcDir) {
  const files = collectTsFiles(srcDir);
  const indexFile = files.find((f) => rel(srcDir, f) === "index.ts");
  if (indexFile === undefined) return [];
  const fieldsByType = collectDepsFields(files);
  const typeByInstall = collectInstallDepsTypes(files);
  const out = [];
  const indexText = stripComments(readFileSync(indexFile, "utf8"));
  const callRe = /\b(install[A-Z]\w*)\s*\(/g;
  let m;
  while ((m = callRe.exec(indexText)) !== null) {
    const depsType = typeByInstall.get(m[1]);
    if (depsType === undefined) continue;
    const fields = fieldsByType.get(depsType);
    if (fields === undefined) continue;
    const args = collectInterfaceArguments(indexText, m.index + m[0].length, depsType);
    if (args.keys === null) {
      for (const problem of args.problems) out.push(`${m[1]}：${problem}`);
      continue;
    }
    out.push(...compareDepsKeys(m[1], depsType, fields, args.keys));
  }
  return out;
}

/** 解析 `A, B as C, type D` 形具名列表 → [{ exported, local }]（exported=对外名）。 */
function parseNameList(list) {
  const out = [];
  for (const raw of list.split(",")) {
    let name = raw.trim();
    if (name === "") continue;
    name = name.replace(/^type\s+/, ""); // 内联 `export { type A }` 形态
    const asIdx = name.indexOf(" as ");
    if (asIdx >= 0)
      out.push({ exported: name.slice(asIdx + 4).trim(), local: name.slice(0, asIdx).trim() });
    else out.push({ exported: name, local: name });
  }
  return out;
}

/** 把一个具名列表的每个 local 名并进符号集（`A, B as C, type D` 形）。 */
function addNameList(syms, list) {
  for (const n of parseNameList(list)) syms.add(n.local);
}

/** 沿 re-export 目标递归收集（声明文件与运行时文件同源时两侧都算）。 */
function collectViaExports(from, spec, seen, depth, syms) {
  for (const t of resolveCandidates(from, spec)) {
    for (const s of collectExports(t, seen, depth + 1)) syms.add(s);
  }
}

/** `export { … } from "spec"`：具名列表本身 + 目标文件的符号面。 */
function collectFromExports(file, text, seen, depth, syms) {
  const re = /^\s*export\s+(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    addNameList(syms, m[1]);
    collectViaExports(file, m[2], seen, depth, syms);
  }
}

/** `export * from "spec"`：整个目标符号面。 */
function collectStarExports(file, text, seen, depth, syms) {
  const re = /^\s*export\s*\*\s*from\s*['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(text)) !== null) collectViaExports(file, m[1], seen, depth, syms);
}

/** `export { … };`：无 from 的具名再导出，只并本地名。 */
function collectBareExports(text, syms) {
  const re = /^\s*export\s+(?:type\s*)?\{([^}]*)\}\s*;/gm;
  let m;
  while ((m = re.exec(text)) !== null) addNameList(syms, m[1]);
}

/**
 * 收集一个文件的具名导出符号集（就地声明 + re-export 链递归展开）。
 * 声明文件（.d.mts）与运行时文件（.mjs）同源并存时合并两侧符号
 * （如 adapters/ 的 .mjs + 相邻 .d.mts：类型只在声明文件、值只在运行时文件）。
 */
function collectExports(file, seen = new Set(), depth = 0) {
  if (depth > 10 || seen.has(file)) return new Set();
  seen.add(file);
  const syms = new Set();
  const files = [file];
  // .mjs 值面 + 同名 .d.mts 类型面合并（interface.ts 对 type 也 re-export 自 .mjs 路径）
  if (file.endsWith(".mjs")) {
    const decl = file.replace(/\.mjs$/, ".d.mts");
    if (existsSync(decl)) files.push(decl);
  }
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const declRe =
      /^\s*export\s+(?:declare\s+)?(?:abstract\s+|async\s+)?(?:const|let|var|function|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = declRe.exec(text)) !== null) syms.add(m[1]);
    // `export default` 是匿名默认导出，具名声明正则抓不到；规则 4 判定
    // `export { default as A } from "./impl.ts"` 时需要它在符号集里，否则假红。
    if (/^\s*export\s+default\b/m.test(text)) syms.add("default");
    collectFromExports(f, text, seen, depth, syms);
    collectStarExports(f, text, seen, depth, syms);
    collectBareExports(text, syms);
  }
  return syms;
}

/** interface.ts 的导出面（对外名 → 源符号名 + 引入途径：inline=就地声明 / from 目标文件列表）。 */
function collectInterfaceExports(file) {
  const out = [];
  const text = readFileSync(file, "utf8");
  const declRe =
    /^\s*export\s+(?:declare\s+)?(?:abstract\s+|async\s+)?(?:const|let|var|function|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = declRe.exec(text)) !== null) out.push({ exported: m[1], local: m[1], via: "inline" });
  const fromRe = /^\s*export\s+(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm;
  while ((m = fromRe.exec(text)) !== null) {
    const via = resolveCandidates(file, m[2]);
    for (const n of parseNameList(m[1])) out.push({ exported: n.exported, local: n.local, via });
  }
  const starRe = /^\s*export\s*\*\s*from\s*['"]([^'"]+)['"]/gm;
  while ((m = starRe.exec(text)) !== null) {
    const via = resolveCandidates(file, m[1]);
    for (const t of via) {
      for (const s of collectExports(t)) out.push({ exported: s, local: s, via });
    }
  }
  return out;
}

/**
 * 叶子模块表：递归全部含 interface.ts 的目录（顶层 client 子树整体豁免）。
 * 模块**必是目录**：`src/interface.ts` 这类根级同名文件不构成模块（它没有「对外引用面」
 * 语义——根文件的引用在规则 3 下本就放行），故根级 interface.ts 的导出符号不存在性
 * 也不进入规则 4 的检查对象（#710 F13 的显式声明）。
 */
function collectModules(srcDir) {
  const modules = new Map(); // 绝对目录 → 模块 id（相对 src 的 posix 路径）
  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // client 是包级（顶层）概念：判定面必须与 inClient 一致，否则深层同名目录
      // 会被这里跳过、却被 inClient 当作普通源码，产生自相矛盾的归属。
      if (depth === 0 && entry.name === "client") continue;
      const full = join(dir, entry.name);
      if (existsSync(join(full, "interface.ts")))
        modules.set(full, relative(srcDir, full).split(sep).join("/"));
      walk(full, depth + 1);
    }
  };
  walk(srcDir, 0);
  return modules;
}

/** *.json 拓扑 glob → 正则（`**` 跨目录，单个 `*` 不跨层；`**` 前缀可匹配零层目录）。 */
function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * 在值依赖图上跑三色 DFS，返回**环集合**（不是环个数）：节点集合排序去重后作 key，
 * 值为一条代表环路径。语义后果（#710 F16）：同一节点集合上的另一条同类路径不会让
 * 计数变化——本指标衡量「哪些节点互相纠缠」，不衡量「有几条回路」，增量基线据此只许降不许升。
 */
function findCycles(edges) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  const stack = [];
  const cycles = new Map();
  const visit = (node) => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const state = color.get(next) ?? WHITE;
      if (state === GRAY) {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const key = [...new Set(cycle)].sort().join("|");
        if (!cycles.has(key)) cycles.set(key, cycle);
      } else if (state === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };
  for (const node of edges.keys()) if ((color.get(node) ?? WHITE) === WHITE) visit(node);
  return cycles;
}

function edgeCount(map) {
  return [...map.values()].reduce((n, s) => n + s.size, 0);
}

function rel(base, p) {
  return relative(base, p).split(sep).join("/");
}

/**
 * I2① 的例外面：目标模块是不是**共享层**——包内 `server/shared/**`、跨端 `src/shared/**`
 * （模块 id 相对 `src/`，故形如 `shared` / `shared/…`）。仓库根 `shared/**` 落在包 src
 * 之外、根本不进叶子模块图，列在这里只为把 I2 的口径写全，不是可达分支。
 *
 * 为什么是「白名单 + 集合判据」而不是「值边 = 0」：指向共享层的值边是 I2 明确**允许**的
 * 出口（域消费共享实现），拿 `leafValueEdges` 当 I2① 的执法点会把合规写法判成违规
 * （notifier 的 7 条值边全指向 `shared/`，按「值边 = 0」读就是全红）。
 */
function isSharedLayerModule(id) {
  return (
    id === "shared" ||
    id.startsWith("shared/") ||
    id === "server/shared" ||
    id.startsWith("server/shared/")
  );
}

/**
 * 源码全覆盖断言的未覆盖清单：src 下每个文件必须落在 ∪mutate ∪ ∪excludes 内。
 *
 * 返回 `null` 表示「断言不适用」（包未登记变异面，含 $noMutationPackages 成员），
 * 空数组表示「可判定且零未覆盖」。但该区分**只在本函数内部成立**：analysis 边界用
 * `?? []` 归一，`null` 不会流到任何消费者——对外守卫是 `topologyRegistered` /
 * `noMutationReason`，不是这里的 `null`（#773 批 B 复核）。
 */
function collectUncoveredSrcFiles(srcDir, specs) {
  if (specs === null || specs.noMutation) return null;
  const covered = (relPath) =>
    specs.excludes.some((g) => globToRegExp(g).test(relPath)) ||
    specs.mutate.some((g) => globToRegExp(g).test(relPath));
  const out = [];
  for (const file of collectAllFiles(srcDir)) {
    const r = rel(ROOT, file);
    if (!covered(r)) out.push(r);
  }
  return out.sort();
}

/** 模块 id 的稳定排序（基线 diff 与矩阵列序都依赖它）。 */
function collectModuleIds(modules) {
  return [...modules.values()].sort();
}

/**
 * §5.3（#767 B0 切片 3a）：client 侧 import 面的**独立一遍扫描**——`src/client/**` 不得
 * import `src/server/**`。刻意不并入 analyzePackage 的主扫描：client 子树一旦进
 * scannedSrcFiles / leafValueEdges / fileValueEdges / crossModuleRefs，notifier 等包的既有
 * 基线会整体换号（这正是「新增独立一遍」的全部理由）。返回**包相对**路径的 `from|to` 证据
 * 集合，与 §5.3 登记的台账键同形。
 *
 * 面含 .d.ts：该判据管的是 client 的 import 面，而 .d.ts 正是类型耦合最容易藏身处；主扫描
 * 排 .d.ts 的理由是「不做运行时值图 from 侧」，本扫描不喂那些计数，故两个口径不同。
 */
function collectClientServerImports(srcDir) {
  const serverDir = join(srcDir, "server");
  const clientDir = join(srcDir, "client");
  if (!existsSync(clientDir)) return [];
  const pkgRel = (p) => rel(dirname(srcDir), p);
  const out = [];
  for (const fromFile of collectTsFiles(clientDir)) {
    const text = stripComments(readFileSync(fromFile, "utf8"));
    for (const { spec } of extractRefs(text)) {
      const target = resolveTarget(fromFile, spec);
      if (target === null) continue;
      if (target !== serverDir && !target.startsWith(serverDir + sep)) continue;
      out.push(`${pkgRel(fromFile)}|${pkgRel(target)}`);
    }
  }
  return [...new Set(out)].sort();
}

/**
 * I8① 的三类面外目标判据（#767 B0 切片 3b）：入参是相对**包根**的目标路径，命中返回
 * canonical 的证据目标，否则 null。
 *
 * 为什么只认这三类而不是「只允许 import 本域 impl」：§8.1 的表是单元层的**目标形态**
 * （`src/server/<域>/` 由 B1 才铺出来），把「同域」一并落成硬判据会在 notifier / provider-usage
 * 上判出大批既有合法用法（两包今天已按 `test/unit/<域>/` 组织，跨域取 `config/impl/model` 这类
 * 底层域是它们的既有形态）——那是 B1–B3 的搬迁面，不是本判据的面。三类的共同点是**方向必错**：
 * 组合根是装配面、`lib/` 是产物面、`src/client/` 是另一端，单元层取任何一个都不是白盒直连。
 *
 * 组合根目标归一成 `src/index.ts`：同一处的 `../src/index.js` 与 `../src/index.ts` 必须落成同一条
 * 证据，否则换个后缀就能造出「第二条证据」来绕基线。
 */
function unitImportFaceTarget(pkgRel) {
  if (pkgRel === "src" || /^src\/index\.(?:ts|tsx|mts|js|mjs|cjs|d\.ts|d\.mts)$/.test(pkgRel))
    return "src/index.ts";
  if (pkgRel === "lib" || pkgRel.startsWith("lib/")) return pkgRel;
  if (pkgRel === "src/client" || pkgRel.startsWith("src/client/")) return pkgRel;
  return null;
}

/**
 * I8① 的**裸包名自引用**映射（#767 B1.0 判据加固）：`spec` 恰好是本包名时目标即产物入口
 * `lib/index.js`，`<本包名>/<rest>` 时即 `lib/<rest>`——各包 `package.json` 的 `exports["."]`
 * 指向 `./lib/index.js`，NodeNext 下裸包名解析得到的就是产物面（可 `node --input-type=module -e
 * "console.log(import.meta.resolve('<包名>'))"` 亲验）。没有这层映射，`resolveCandidates` 的
 * 首行 `!spec.startsWith(".")` 对这种写法一个候选都不给、`resolveTarget` 返回 null，采集函数里
 * 的 fallback 得到 `<包>/test/unit/<包名>` 这种不存在的路径，`unitImportFaceTarget` 于是不匹配
 * 任何面——引用真实够到产物面，判据却零证据。返回**包相对**路径（与 `rel(pkgDir,
 * resolveTarget(…))` 同形，故两种写法落成同一条证据 id），非本包自引用返回 null。
 *
 * 为什么只在本采集函数内部补这一层、不放开 `resolveCandidates`：后者的口径是「相对说明符」，
 * 放开会顺带扩大 I2① / I2④ / §5.3 的判据面（那三条禁的是 `src/server/**` 与 `src/index.ts`，
 * 裸包名解析到 `lib/index.js` 不是同一件事的等价写法），而 I8① 本就把 `lib/**` 列为禁止面。
 */
function selfReferenceLibTarget(pkgName, spec) {
  if (pkgName === null || !spec.startsWith(pkgName)) return null;
  if (spec === pkgName) return "lib/index.js";
  if (spec.startsWith(`${pkgName}/`)) return `lib/${spec.slice(pkgName.length + 1)}`;
  return null;
}

/**
 * 读本包 `package.json` 的 `name`——I8① 的裸自引用面靠它，不内嵌包名常量。
 * 读不到时返回 null（该面按不可判定处理）：fixture 根可以没有 package.json，而真实包是
 * pnpm workspace 成员、必然有；在此凭空判红会让既有 fixture 全部换号，超出本刀范围。
 */
function readPackageName(pkgDir) {
  const manifestPath = join(pkgDir, "package.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const name = JSON.parse(readFileSync(manifestPath, "utf8")).name;
    return typeof name === "string" && name !== "" ? name : null;
  } catch {
    return null;
  }
}

/**
 * I8①（#767 B0 切片 3b）：单元层导入面判据——`test/unit/**` 下的文件不得 import 组合根
 * `src/index.ts`、产物面 `lib/**`、客户端面 `src/client/**`（口径与理由见 unitImportFaceTarget
 * 与文件头）。判据是**只许缩小**的集合（终态为空），故落质量证据面而不是结构型计数面。
 *
 * 返回**包相对**路径的 `from|to` 证据集合（与台账键 `<包名>:<证据项>` 同形）。抽成独立函数
 * 与 `collectClientServerImports` 同因：内联会把 analyzePackage 的认知复杂度推过门禁阈值。
 * `pkgName` 是本包 `package.json` 的 `name`（可为 null），只用于裸自引用映射。
 */
function collectUnitImportFaceViolations(pkgDir, pkgName) {
  const unitDir = join(pkgDir, "test", "unit");
  if (!existsSync(unitDir)) return [];
  const out = [];
  for (const fromFile of collectTsFiles(unitDir)) {
    const text = stripComments(readFileSync(fromFile, "utf8"));
    for (const { spec } of extractRefs(text)) {
      // 目标不存在时（`lib/**` 还没构建、`.js` 后缀映射不到 `.ts`）退回**字面路径**：判据管的是
      // 写下来的导入面，让「产物没构建」变成静默绕过才是这类门禁最典型的假绿。裸包名自引用先经
      // selfReferenceLibTarget 映射到产物面——与相对写法落成同一条证据 id，换写法换不掉证据。
      const target =
        selfReferenceLibTarget(pkgName, spec) ??
        rel(pkgDir, resolveTarget(fromFile, spec) ?? resolve(dirname(fromFile), spec));
      const hit = unitImportFaceTarget(target);
      if (hit !== null) out.push(`${rel(pkgDir, fromFile)}|${hit}`);
    }
  }
  return [...new Set(out)].sort();
}

/** 门面资格判定器：文件名是 interface.ts/deps.ts **且**所在目录就是一个模块目录。 */
function makeFacadeCheck(modules) {
  /**
   * 只看文件名会让 `../other/internal/deps.ts` 这类同名文件被当成合法出口放行
   * （interface.ts 天然保证同级目录即模块，deps.ts 没有这个前提）。
   */
  return (p) => {
    const b = basename(p);
    if (b !== "interface.ts" && b !== "deps.ts") return false;
    return modules.has(dirname(p));
  };
}

/** 叶子模块归属判定器：最近的含 interface.ts 的祖先目录；根文件/包外为 null。 */
function makeModuleOf(modules, srcDir) {
  return (file) => {
    let d = dirname(file);
    while (d === srcDir || d.startsWith(srcDir + sep)) {
      if (modules.has(d)) return modules.get(d);
      if (d === srcDir) break;
      d = dirname(d);
    }
    return null;
  };
}

/** 引用明细：非相对 spec 与 client 目标在此剔除，其余连归属一起记下。 */
function collectRefs(files, isInSrc, isInClient, moduleOf) {
  const refs = [];
  for (const fromFile of files) {
    const text = stripComments(readFileSync(fromFile, "utf8"));
    for (const { spec, isType } of extractRefs(text)) {
      const target = resolveTarget(fromFile, spec);
      if (target === null) continue; // 非相对/不存在（node_modules 等）跳过
      if (isInClient(target)) continue; // client 目标不参与门禁
      refs.push({
        fromFile,
        spec,
        target,
        targetFile: basename(target),
        isType,
        fromModule: moduleOf(fromFile),
        toModule: moduleOf(target),
        targetInSrc: isInSrc(target),
      });
    }
  }
  return refs;
}

/** 单包的扫描上下文：模块表、参与规则扫描的文件面、引用明细与三个归属判定器。 */
function scanPackageSources(srcDir) {
  const modules = collectModules(srcDir);
  const isInSrc = (p) => p === srcDir || p.startsWith(srcDir + sep);
  const isInClient = (p) => isInSrc(p) && rel(srcDir, p).split("/")[0] === "client";
  const isFacade = makeFacadeCheck(modules);
  const moduleOf = makeModuleOf(modules, srcDir);
  const allTsFiles = collectTsFiles(srcDir);
  // `.d.ts` / `.d.mts` 是声明文件：引用他域类型不构成运行时依赖，作为 from 侧会污染计数与
  // 规则判定（notifier `service.d.ts` 实测贡献 6 条 crossModuleRefs、2 条文件边）。
  const files = allTsFiles.filter(
    (f) => !isInClient(f) && !f.endsWith(".d.ts") && !f.endsWith(".d.mts"),
  );
  const refs = collectRefs(files, isInSrc, isInClient, moduleOf);
  return { modules, isFacade, allTsFiles, files, refs };
}

/** 「跨模块引用」口径：两个归属都存在且不同（双方均为根/包外不算跨模块）。 */
function isCrossModuleRef(r) {
  return r.fromModule !== r.toModule && !(r.fromModule === null && r.toModule === null);
}

/**
 * 规则 1/2：跨模块引用必须落到目标模块的 interface.ts / deps.ts；目标目录无
 * interface.ts（分组层或未登记目录）判缺门面。
 */
function collectRuleViolations(refs, srcDir, isFacade) {
  const missingInterface = [];
  const directImpl = [];
  for (const r of refs) {
    if (!isCrossModuleRef(r)) continue;
    if (r.toModule === null) {
      // 目标在 src 根（装配层）放行；目标在不含 interface.ts 的目录内即缺门面。
      const targetDir = dirname(r.target);
      if (!r.targetInSrc || targetDir === srcDir) continue;
      missingInterface.push(r);
      continue;
    }
    if (!isFacade(r.target)) directImpl.push(r);
  }
  return { missingInterface, directImpl };
}

/**
 * R-A 双口径（#690 D-2）：旧语义「impl 只 import 本目录」；新语义「impl 不得引用
 * 他域**实现文件**」（impl → 他域 interface.ts/deps.ts 合法）。
 */
function collectRaRefs(refs, isFacade) {
  const raLegacy = [];
  const raImpl = [];
  for (const r of refs) {
    if (r.fromModule === null || r.toModule === null || r.fromModule === r.toModule) continue;
    if (isFacade(r.fromFile)) continue; // interface/deps 走 R-B，不计入 R-A
    raLegacy.push(r);
    if (!isFacade(r.target)) raImpl.push(r);
  }
  return { raLegacy, raImpl };
}

/** 有向边累积（同一 from 的去重成一个 Set）。 */
function addEdge(map, from, to) {
  if (!map.has(from)) map.set(from, new Set());
  map.get(from).add(to);
}

/** 顶层域集合（client 子树不入历史对照口径）。 */
function collectTopDirs(srcDir) {
  const topDirSet = new Set();
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "client") topDirSet.add(join(srcDir, entry.name));
  }
  return topDirSet;
}

/**
 * 历史对照口径的原样复刻：起点与目标的**直接父目录**都必须是顶层目录，否则整条边
 * 丢弃——这正是嵌套目录依赖脱管的成因。
 */
function addHistoricalEdge(r, srcDir, topDirSet, topValueEdges) {
  const fromDir = dirname(r.fromFile);
  const targetDir = dirname(r.target);
  if (!topDirSet.has(fromDir) || !topDirSet.has(targetDir) || targetDir === fromDir) return;
  const fromName = relative(srcDir, fromDir).split(sep)[0];
  const toName = relative(srcDir, targetDir).split(sep)[0];
  if (fromName !== toName) addEdge(topValueEdges, fromName, toName);
}

/** 把一条**值**引用同时喂给三套口径的边集（历史对照 / 叶子模块 / 文件）。 */
function addValueEdges(r, srcDir, topDirSet, graphs) {
  addHistoricalEdge(r, srcDir, topDirSet, graphs.top);
  if (r.fromModule !== null && r.toModule !== null && r.fromModule !== r.toModule) {
    addEdge(graphs.leaf, r.fromModule, r.toModule);
  }
  if (r.targetInSrc && r.fromFile !== r.target)
    addEdge(graphs.file, rel(srcDir, r.fromFile), rel(srcDir, r.target));
}

/**
 * 三套值图：顶层域「历史对照口径」（复刻修复粒度前的算法：目标必须直接位于顶层
 * 目录下，因此嵌套目标整条边被丢弃——环检测曾因此静默归零）、叶子模块口径
 * （S0 门禁口径）、文件口径。
 */
function collectValueGraphs(refs, srcDir) {
  const topDirSet = collectTopDirs(srcDir);
  const graphs = { top: new Map(), leaf: new Map(), file: new Map() };
  for (const r of refs) {
    if (r.isType) continue;
    addValueEdges(r, srcDir, topDirSet, graphs);
  }
  return {
    top: { edges: graphs.top, cycles: findCycles(graphs.top) },
    leaf: { edges: graphs.leaf, cycles: findCycles(graphs.leaf) },
    file: { edges: graphs.file, cycles: findCycles(graphs.file) },
  };
}

/** 某模块 deps.ts 的值声明目标集；顺带交出「声明面混入值 import」的引用（一律判红）。 */
function collectIntendedTargets(depsFile, modId, refs) {
  const intended = new Set();
  const valueImports = [];
  for (const r of refs) {
    if (r.fromFile !== depsFile) continue;
    if (!r.isType) valueImports.push(r);
    if (r.toModule === null || r.toModule === modId) continue;
    if (r.isType) continue; // 类型面豁免：声明即完整性，不参与死声明计算
    intended.add(r.toModule);
  }
  return { intended, valueImports };
}

/** 本模块 deps.ts **之外**的文件实际依赖到的目标模块集（deps.ts 自身不能自证为事实）。 */
function collectActualTargets(modId, refs) {
  const actual = new Set();
  for (const r of refs) {
    if (r.fromModule !== modId || r.toModule === null || r.toModule === modId) continue;
    if (basename(r.fromFile) === "deps.ts") continue;
    actual.add(r.toModule);
  }
  return actual;
}

/**
 * 死声明（意图 - 事实）：deps.ts 声明依赖某模块，而本模块 deps.ts **之外**的
 * 实现/门面文件并无对应事实边。deps.ts 自身的边属意图声明，不能自证为事实。
 *
 * 口径（#733 M0a）：**值面判死、类型面豁免**。
 *   - 类型边（import type / export type）是「本域对上依赖的形状声明」，声明本身
 *     即完整性（供意图图对照），不构成可被判死的依赖承诺——跨域类型引用集中进
 *     deps.ts 后事实边从实现文件消失，按旧口径会报假死声明（sdk → stores 的唯一
 *     来源是 interface.ts 的 import type，迁入 deps.ts 后 actual 变空即误报）。
 *   - 值边是「本域真的要取用的运行时能力」，必须由本模块非 deps.ts 文件佐证。
 *   - 「改覆盖式」（把 deps.ts 自身的边并入 actual）会让 intended ⊆ actual 恒成立、
 *     指标恒 0——空判，明确不采用。
 *
 * 声明面混入的值依赖（depsValueImports）与死声明在同一次遍历里产出：前者不论目标
 * 模块（含同模块与 src 根）一律单独判红，故不能挪到模块级判据里。
 */
function findDeadDeclarations({ modules, refs }) {
  const deadDeclarations = [];
  const depsValueImports = [];
  for (const [modDir, modId] of modules) {
    const depsFile = join(modDir, "deps.ts");
    if (!existsSync(depsFile)) continue;
    const { intended, valueImports } = collectIntendedTargets(depsFile, modId, refs);
    depsValueImports.push(...valueImports);
    const actual = collectActualTargets(modId, refs);
    for (const target of intended) {
      if (!actual.has(target))
        deadDeclarations.push(`${modId}/deps.ts → ${target}（值声明有而事实无）`);
    }
  }
  return { deadDeclarations, depsValueImports };
}

/**
 * 单包全量分析：模块表、引用明细、三套依赖图、R-A 双口径、规则违例、变异覆盖。
 *
 * 分段函数只做搬运，不改判据与顺序：deploy 面（modules / refs / 规则 / R-A / 值图 /
 * 死声明）必须按此顺序求值，基线证据面的排序与去重依赖它。
 */
function analyzePackage(pkgName, topology) {
  const srcDir = join(ROOT, "packages", pkgName, "src");
  if (!existsSync(srcDir)) return null;
  const { modules, isFacade, allTsFiles, files, refs } = scanPackageSources(srcDir);
  const rules = collectRuleViolations(refs, srcDir, isFacade);
  const { raLegacy, raImpl } = collectRaRefs(refs, isFacade);
  const graphs = collectValueGraphs(refs, srcDir);
  const { deadDeclarations, depsValueImports } = findDeadDeclarations({ modules, refs });

  // I2①（#767 B0 切片 3a）：**目标非共享层**的叶子模块值边——「域与域之间不得发生运行时
  // 直接值引用」。读叶子模块口径边集 graphs.leaf.edges（S0 门禁口径；结构重组后不再有裸
  // leafValueEdges 变量）。它与结构型计数的区别是双重的：①剔除指向共享层的边（那是 I2 允许
  // 的出口，见 isSharedLayerModule）；②它是质量型**证据集合**（新增判红、只许缩小、终态
  // 为空），而结构型计数只判不升。
  const crossDomainValueEdges = [];
  for (const [from, targets] of graphs.leaf.edges) {
    for (const to of targets) {
      if (!isSharedLayerModule(to)) crossDomainValueEdges.push(`${from}|${to}`);
    }
  }
  crossDomainValueEdges.sort();

  // I2④（§0.1 第 5 条的「第三判据」）：域内文件**值引** src 根 index.ts。组合根是装配面，
  // 域取它的常量必然与根文件构成文件级值环——而这条形态原先只在不巧成环时才可见（根文件
  // 不回引时完全无判据）。`import type` 编译期擦除，不在此面（与 fileValueEdges 同口径）。
  const rootIndexImports = [
    ...new Set(
      refs
        .filter(
          (r) =>
            !r.isType &&
            r.targetInSrc &&
            r.fromFile !== r.target &&
            dirname(r.target) === srcDir &&
            basename(r.target) === "index.ts",
        )
        .map((r) => `${rel(srcDir, r.fromFile)}|index.ts`),
    ),
  ].sort();

  // §5.3（#767 B0 切片 3a）：client 侧 import 面的独立一遍扫描（见 collectClientServerImports）。
  // 抽成独立函数不只是可读性：它的分支若内联在这里，analyzePackage 的认知复杂度会越过
  // ESLint 复杂度门禁（sonarjs/cognitive-complexity），把无关的规则面一起拖红。
  const clientServerImportEvidence = collectClientServerImports(srcDir);

  // I8①（#767 B0 切片 3b）：单元层导入面（`test/unit/**` → 组合根 / lib / client）。
  // 包名从本包 package.json 现读（#767 B1.0）：裸包名自引用按它映射到产物面。
  const unitImportFaceEvidence = collectUnitImportFaceViolations(
    dirname(srcDir),
    readPackageName(dirname(srcDir)),
  );

  const specs = collectMutationSpecs(topology, pkgName);
  // 「不适用」与「空集」的区分只在本函数内部；metrics 统一落数组（?? []），
  // 对外判据是 topologyRegistered / noMutationReason。
  const uncoveredSrcFiles = collectUncoveredSrcFiles(srcDir, specs);

  const valueCount = raLegacy.filter((r) => !r.isType).length;
  return {
    package: pkgName,
    srcDir,
    modules,
    moduleIds: collectModuleIds(modules),
    refs,
    rules,
    raLegacy,
    raImpl,
    graphs: {
      topValueEdges: graphs.top.edges,
      leafValueEdges: graphs.leaf.edges,
      fileValueEdges: graphs.file.edges,
    },
    cycles: { top: graphs.top.cycles, leaf: graphs.leaf.cycles, file: graphs.file.cycles },
    deadDeclarations,
    depsValueImports,
    // #767 B0 切片 3a / 3b 的四类新证据（集合形态；metrics 里只放条数，消费方见
    // collectQualityEvidence）——I2① 域间值边 / I2④ 值引 src 根 index.ts / §5.3 client 面 /
    // I8① 单元层导入面。
    extraEvidence: {
      crossDomainValueEdges,
      rootIndexImports,
      clientServerImports: clientServerImportEvidence,
      unitImportFaceViolations: unitImportFaceEvidence,
    },
    // 覆盖断言可判定性：包未登记拓扑时 uncoveredSrcFiles 恒为空，若不显式区分，
    // 「从拓扑里删掉一个包」就成了让覆盖断言消失的绕过路径（已复现的假绿向量）。
    // $noMutationPackages 登记**不等于**可判定——它只是把「不适用」显式化，故
    // topologyRegistered 仍为 false，由 noMutationReason 承担另一条合法出口。
    topologyRegistered: specs !== null && !specs.noMutation,
    noMutationReason: specs?.noMutation === true ? specs.reason : null,
    // 覆盖排除面（testLayers.coverageExcludes）的形状问题由共享模块携带出来：形状不合法时
    // 条目会被取值处跳过，uncoveredSrcFiles 随之虚高，但真正该报的是形状本身——由主循环
    // 落成硬违规，fail-closed 且不抛栈（旧形状的失败形态是取值处 TypeError 崩掉 contract 段）。
    topologyProblems: specs?.problems ?? [],
    metrics: {
      modules: modules.size,
      // F14：两个口径必须自解释——scannedSrcFiles = 实际参与规则扫描的文件
      // （已排除 client 子树与 .d.ts 声明面）；allSrcTsFiles = src 下全部 TS 文件。
      scannedSrcFiles: files.length,
      allSrcTsFiles: allTsFiles.length,
      interfaceFacades: 0, // 主流程按被引用面填充
      topValueEdges: edgeCount(graphs.top.edges),
      topModuleCycles: graphs.top.cycles.size,
      leafValueEdges: edgeCount(graphs.leaf.edges),
      leafModuleCycles: graphs.leaf.cycles.size,
      fileValueEdges: edgeCount(graphs.file.edges),
      fileCycles: graphs.file.cycles.size,
      crossModuleRefs: refs.filter(isCrossModuleRef).length,
      raLegacy: raLegacy.length,
      raLegacyValue: valueCount,
      raLegacyType: raLegacy.length - valueCount,
      implToOtherImpl: raImpl.length,
      missingInterface: rules.missingInterface.length,
      directImpl: rules.directImpl.length,
      uncoveredSrcFiles: uncoveredSrcFiles ?? [],
      crossDomainValueEdges: crossDomainValueEdges.length,
      rootIndexImports: rootIndexImports.length,
      clientServerImports: clientServerImportEvidence.length,
      unitImportFaceViolations: unitImportFaceEvidence.length,
    },
  };
}

/**
 * 基线两类入库形态：结构型存**计数**，质量型存**证据**（#733 后续升级）。
 *
 * **结构型**（规模计数）：随新增源文件 / 模块目录 / 合法跨模块引用上升是结构演进的
 * 正常结果——它们的价值是跨期对照与「结构变更显式登记」，故 `--write-baseline` 更新。
 *
 * **质量型**（缺陷 / 债务事实）：入库的是 canonical 证据集合，不是计数。
 *   - leafModuleCycles / fileCycles：值环的规范化签名（findCycles 的键）
 *   - raLegacy / implToOtherImpl：跨域引用边 `<from>|<to>|<kind>`（raLegacy 描述
 *     `<域>/<impl>.ts` 直引他域文件的存量，ARCHITECTURE-METHOD §2 载体依赖表；
 *     implToOtherImpl 是 D-2 新口径下 impl 直引他域**实现文件**，目标 0）
 *   - missingInterface / directImpl：规则违例边 `<from>|<to>`
 *   - uncoveredSrcFiles：`src ⊆ ∪mutate ∪ ∪excludes` 的历史存量（相对路径）
 *
 * 为什么不是计数（#733 实证）：计数是「某一版计数器」的输出。一次**正确**的计数器
 * 修正会让整个存量换号，于是「修对了」等价于「永久判红」——基线没有任何合法出口
 * （extractRefs 正则消除幻影值边后，mcp-manager 的 raLegacyType 39→40 即此形态）。
 * 存事实与计数器实现解耦：新增事实判红、事实消失视为改善、kind 由 value→type 视为
 * 收口，三者都不依赖计数器怎么写。
 *
 * 放宽的唯一通道是 `scripts/data/gate-exemptions.json` 的登记条目（gate = `verify-dir-imports`，
 * path = `<包名>:<证据项>`）；否则 `--write-baseline` 只做「清理已消失的证据」，新增证据一律判红。
 */
const STRUCTURAL_METRICS = [
  "modules",
  "scannedSrcFiles",
  "allSrcTsFiles",
  "interfaceFacades",
  "leafValueEdges",
  "fileValueEdges",
  "crossModuleRefs",
];
/**
 * 质量型入库形态 = 证据集合（见 collectQualityEvidence）。
 *
 * 判据面只放**规则本身**能判的东西：`implToOtherImpl`（impl 不得引用他域实现文件）、环、虚导出、
 * 直接引实现、未覆盖源文件。`raLegacy`（R-A **旧口径**：impl → 他域任意文件）**不在其中**：
 * 它把「impl 直接引用共享层门面」这类**架构允许**的引用也记成待登记证据（本仓 168 条里 167 条
 * 是这种），于是合规写法反而要逐条开豁免——机制该默认放行的事，不该靠记录放行。
 * 它仍照常统计与展示（见 DERIVED_REPORT_ONLY_METRICS 与 summary/--graph）。
 *
 * #767 B0 切片 3a 新增三类（`crossDomainValueEdges` / `rootIndexImports` /
 * `clientServerImports`）：判据本身就是「这个集合只许缩小」，故只能落证据面，不能落计数面
 * （计数只判上升，而这三条的目标是**空集**）。它们与既有类的唯一差别在入库路径：基线里
 * **没有这个键**时按「证据类首次登记」写入存量（否则 mcp 的 33 条 I2① 存量会被逐条要求
 * 开豁免，把存量登记误当放宽通道）；键已存在时一切照旧——类内新增证据判红、不写入。
 */
const QUALITY_EVIDENCE_METRICS = [
  "leafModuleCycles",
  "fileCycles",
  "implToOtherImpl",
  "missingInterface",
  "directImpl",
  "uncoveredSrcFiles",
  // #767 B0 切片 3a：三条今天没有执法点的宪法判据的执法点（§二 I2①/④、§5.3）。
  // 三者都只判「这一集合有没有新增/是否为空」，不判计数升降——与结构型计数相反。
  "crossDomainValueEdges",
  "rootIndexImports",
  "clientServerImports",
  // #767 B0 切片 3b：I8① 单元层导入面（`test/unit/**` → src/index.ts / lib / src/client）。
  "unitImportFaceViolations",
];
/**
 * 仅作报告、**不入基线**的派生量：都能由结构计数或证据面重算，入库只会制造第二事实源。
 * 分类完备性在运行期对照 `Object.keys(analysis.metrics)` 校验（见主流程 fail-closed 段），
 * 故本清单不需要与 metrics 对象手工保持同步。
 */
const DERIVED_REPORT_ONLY_METRICS = [
  "raLegacy",
  "raLegacyValue",
  "raLegacyType",
  "topValueEdges",
  "topModuleCycles",
];
const CLASSIFIED_METRICS = new Set([
  ...STRUCTURAL_METRICS,
  ...QUALITY_EVIDENCE_METRICS,
  ...DERIVED_REPORT_ONLY_METRICS,
]);

/** 读取基线 JSON；缺失返回 null（调用方按 fail-closed 处理）。 */
function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch (e) {
    failures.push(`[baseline] 基线文件解析失败：${BASELINE_PATH}（${e.message}）`);
    return null;
  }
}

/** 证据条目的稳定标识与 kind：边型 `from|to|kind`，其它形态无 kind（kind 为 null）。 */
function splitEvidenceItem(metric, item) {
  if (metric === "raLegacy" || metric === "implToOtherImpl") {
    const parts = item.split("|");
    const kind = parts.pop();
    return { id: parts.join("|"), kind };
  }
  return { id: item, kind: null };
}

/**
 * 质量型的证据面：把一次分析里的事实压成 canonical 字符串集合（排序后入基线）。
 * 只取事实、不算聚合——聚合值需要时由证据现算（R-A 的值/类型条数即如此）。
 */
function collectQualityEvidence(analysis) {
  const { srcDir } = analysis;
  const edge = (r, withKind) => {
    const id = `${rel(srcDir, r.fromFile)}|${rel(srcDir, r.target)}`;
    return withKind ? `${id}|${r.isType ? "type" : "value"}` : id;
  };
  return {
    leafModuleCycles: [...analysis.cycles.leaf.keys()].sort(),
    fileCycles: [...analysis.cycles.file.keys()].sort(),
    implToOtherImpl: analysis.raImpl.map((r) => edge(r, true)).sort(),
    missingInterface: analysis.rules.missingInterface.map((r) => edge(r, false)).sort(),
    directImpl: analysis.rules.directImpl.map((r) => edge(r, false)).sort(),
    uncoveredSrcFiles: [...analysis.metrics.uncoveredSrcFiles].sort(),
    // #767 B0 切片 3a：三类新证据已在 analyzePackage 里算成 canonical 字符串集合并排好序
    // （模块 id 边、src 相对文件边、包相对文件边），此处只做拷贝入库。
    crossDomainValueEdges: [...analysis.extraEvidence.crossDomainValueEdges].sort(),
    rootIndexImports: [...analysis.extraEvidence.rootIndexImports].sort(),
    clientServerImports: [...analysis.extraEvidence.clientServerImports].sort(),
    unitImportFaceViolations: [...analysis.extraEvidence.unitImportFaceViolations].sort(),
  };
}

/** 结构型计数比对：基线未登记或当前值上升都进 rises。 */
function collectStructuralRises(metrics, pkgBase) {
  const rises = [];
  for (const key of STRUCTURAL_METRICS) {
    const cur = metrics[key];
    const base = pkgBase[key];
    if (typeof base !== "number") rises.push(`[结构型] ${key}: 基线未登记（当前 ${cur}）`);
    else if (cur > base)
      rises.push(`[结构型] ${key}: ${cur} > 基线 ${base}（结构变更未登记 → 跑 --write-baseline）`);
  }
  return rises;
}

/** 证据条目集合 → id → kind 索引（id 不含 kind，故 kind 必须另行比对）。 */
function indexById(items, key) {
  return new Map(
    items.map((i) => {
      const s = splitEvidenceItem(key, i);
      return [s.id, s.kind];
    }),
  );
}

/**
 * 单类证据的增量比对：新增证据 / type→value 降级进 rises，value→type 收口与证据消失进
 * improvements。kind 由 value→type 是改善，故两向不可合并成一次比较。
 */
function classifyEvidenceDeltas(key, baseById, curById, packageName) {
  const rises = [];
  const improvements = [];
  for (const [id, kind] of curById) {
    if (!baseById.has(id)) {
      rises.push(
        `[质量型] ${key}: 新增未登记证据 ${id}${kind === null ? "" : `（${kind}）`} —— 须修代码；确需放宽须登记到 gate-exemptions.json（gate=verify-dir-imports，path=${packageName}:${id}）`,
      );
    } else if (baseById.get(id) === "type" && kind === "value") {
      rises.push(`[质量型] ${key}: 类型面降级 type → value：${id}（跨域类型引用退化成运行时依赖）`);
    } else if (baseById.get(id) === "value" && kind === "type") {
      improvements.push(`${key}: ${id} 值 → 类型（收口）`);
    }
  }
  for (const id of baseById.keys()) if (!curById.has(id)) improvements.push(`${key}: ${id} 已消除`);
  return { rises, improvements };
}

/** 质量型证据面比对：逐类走 classifyEvidenceDeltas，汇总成 rises / improvements。 */
function compareQualityEvidence(pkgBase, evidence, packageName) {
  const rises = [];
  const improvements = [];
  for (const key of QUALITY_EVIDENCE_METRICS) {
    const baseById = indexById(pkgBase.quality?.[key] ?? [], key);
    const curById = indexById(evidence[key] ?? [], key);
    const deltas = classifyEvidenceDeltas(key, baseById, curById, packageName);
    rises.push(...deltas.rises);
    improvements.push(...deltas.improvements);
  }
  return { rises, improvements };
}

/**
 * 单调基线比对（#733 后续：结构型比计数、质量型比证据）。
 *
 * 返回 `{ mode, rises, improvements }`：
 *   - rises：结构计数上升 / 新增质量证据 / kind 降级（type → value）
 *   - improvements：证据消失 / kind 收口（value → type）——报告用，写基线时自动清理
 *   - 旧基线（缺 `quality` 段 = #733 M0b 的数字口径）判红并给出迁移指引：数字与证据
 *     不可比，静默按「首次登记」放行等于把未判定的存量洗成合规。
 */
function compareWithBaseline(analysis, baseline) {
  const pkgBase = baseline?.packages?.[analysis.package];
  if (pkgBase === undefined) return { mode: "absent", rises: [], improvements: [] };
  const rises = collectStructuralRises(analysis.metrics, pkgBase);
  const improvements = [];
  if (pkgBase.quality === undefined) {
    rises.push(
      "[质量型] 基线为旧计数口径（缺 quality 证据段）—— 数字与证据不可比，请运行 --write-baseline 完成迁移（diff 内可审阅）",
    );
    return { mode: "compared", rises, improvements };
  }
  const qualityDeltas = compareQualityEvidence(
    pkgBase,
    collectQualityEvidence(analysis),
    analysis?.package ?? "<包名>",
  );
  rises.push(...qualityDeltas.rises);
  improvements.push(...qualityDeltas.improvements);
  return { mode: "compared", rises, improvements };
}

/** 有基线时的存量违规明细（只作报告，判红交给单调基线）。 */
function reportBaselineLockedViolations(analysis) {
  const { package: pkgName, srcDir } = analysis;
  if (!SOFT && !VERBOSE) return;
  for (const r of analysis.rules.directImpl) {
    softViolations.push(
      `[${pkgName}] 存量直引实现文件（基线锁定）：${rel(srcDir, r.fromFile)} → ${rel(srcDir, r.target)}`,
    );
  }
  for (const r of analysis.rules.missingInterface) {
    softViolations.push(
      `[${pkgName}] 存量缺门面目录（基线锁定）：${rel(srcDir, r.fromFile)} → ${rel(srcDir, r.target)}`,
    );
  }
}

/**
 * 无基线时的规则违规台账：soft 落软报告，hard 落硬失败。
 *
 * `violations` 与 `line` 由调用方按违反的规则逐条给出——两类规则的文案不同，
 * 但「soft 进软报告 / hard 进硬失败」这条口径必须完全一致。
 */
function recordRuleViolations(violations, line) {
  for (const r of violations) {
    const text = line(r);
    if (SOFT) softViolations.push(text);
    else failures.push(text);
  }
}

/** 规则违规的判红入口：有基线则比基线，无基线则立即红（fail-closed）。 */
function registerRuleViolations(analysis, state) {
  const { package: pkgName, srcDir } = analysis;
  if (state.mode === "compared") {
    reportBaselineLockedViolations(analysis);
    return;
  }
  recordRuleViolations(
    analysis.rules.directImpl,
    (r) =>
      `[${pkgName}] ${rel(srcDir, r.fromFile)} → import "${r.spec}"：跨模块引用必须走目标模块 interface.ts/deps.ts`,
  );
  recordRuleViolations(
    analysis.rules.missingInterface,
    (r) =>
      `[${pkgName}] ${rel(srcDir, r.fromFile)} → import "${r.spec}"：目标目录缺少 interface.ts（该模块唯一对外面）`,
  );
}

/**
 * 无变异面登记（$noMutationPackages）的显式声明文案（#773 批 B / #710 §2-2）。
 * 主判据路径与 --write-baseline 报告共用同一份——两条路径的可观测性必须一致，
 * 否则「不适用」在写入路径上退化成一句无理由、无跟踪号的注脚。
 */
function noMutationDeclaration(pkgName, reason) {
  return `${pkgName}: 登记在 scripts/data/mutation-topology.json 的 $noMutationPackages（无变异面，理由：${reason}）—— 源码全覆盖断言不适用（跟踪 #690 S6/S8 / #773）`;
}

/** 渲染 --zones 段：叶子口径跨域引用明细 + R-A 双口径。 */
function renderZones(analysis) {
  const { package: pkgName, metrics, raLegacy, raImpl, srcDir } = analysis;
  const lines = [`zones ${pkgName}（叶子口径跨域引用明细）`];
  lines.push(
    `R-A 语义切换前（impl → 他域任意文件，旧口径）：${metrics.raLegacy} 条（值 ${metrics.raLegacyValue} / type ${metrics.raLegacyType}）`,
  );
  for (const r of raLegacy) {
    lines.push(
      `  ${rel(srcDir, r.fromFile)} → ${rel(srcDir, r.target)} [${r.isType ? "type" : "value"}]`,
    );
  }
  lines.push(`R-A 语义切换后（impl → 他域实现文件，D-2 批准口径）：${metrics.implToOtherImpl} 条`);
  for (const r of raImpl) {
    lines.push(
      `  ${rel(srcDir, r.fromFile)} → ${rel(srcDir, r.target)} [${r.isType ? "type" : "value"}]`,
    );
  }
  return lines;
}

/** 渲染 --graph 段：依赖矩阵 + 扇入扇出 + 模块级/文件级值环 + 死声明。 */
function renderGraph(analysis) {
  const {
    package: pkgName,
    moduleIds,
    graphs,
    cycles,
    deadDeclarations,
    depsValueImports,
    refs,
  } = analysis;
  const lines = [`graph ${pkgName}（叶子粒度依赖图）`];
  const cellType = (from, to) => {
    const hasV = (graphs.leafValueEdges.get(from) ?? new Set()).has(to);
    const hasT = refs.some((r) => r.fromModule === from && r.toModule === to && r.isType);
    if (hasV && hasT) return "B";
    if (hasV) return "V";
    if (hasT) return "T";
    return ".";
  };
  const short = (id) => id.split("/").pop();
  // 列宽按最长短名自适应：固定截断会让长名模块（orchestrator/runtime 等）在矩阵里
  // 变成无法区分的同名列。
  const shortNames = moduleIds.map(short);
  const colW = Math.max(1, ...shortNames.map((s) => s.length)) + 2;
  const rowW = Math.max(4, ...moduleIds.map((m) => m.length)) + 2;
  lines.push("依赖矩阵（行=from 模块，列=to 模块；V=值边 T=type 边 B=两者 .=无）：");
  lines.push(`  ${"from".padEnd(rowW)}${shortNames.map((s) => s.padEnd(colW)).join("")}`);
  for (const from of moduleIds) {
    const cells = moduleIds.map((to) => (from === to ? "-" : cellType(from, to)).padEnd(colW));
    lines.push(`  ${from.padEnd(rowW)}${cells.join("")}`);
  }
  lines.push("扇入/扇出（值边 / 类型边）：");
  for (const id of moduleIds) {
    const outV = (graphs.leafValueEdges.get(id) ?? new Set()).size;
    const outT = new Set(
      refs
        .filter((r) => r.fromModule === id && r.toModule && r.toModule !== id && r.isType)
        .map((r) => r.toModule),
    ).size;
    const inV = moduleIds.filter((m) => (graphs.leafValueEdges.get(m) ?? new Set()).has(id)).length;
    const inT = new Set(
      refs
        .filter((r) => r.toModule === id && r.fromModule && r.fromModule !== id && r.isType)
        .map((r) => r.fromModule),
    ).size;
    lines.push(`  ${id.padEnd(26)} 扇出 ${outV}/${outT}  扇入 ${inV}/${inT}`);
  }
  lines.push(
    `顶层域值环（历史对照口径，复刻修复粒度前算法，按节点集合去重的环集合数）：${cycles.top.size} 个`,
  );
  for (const c of cycles.top.values()) lines.push(`  ${c.join(" → ")}`);
  lines.push(
    `叶子模块级值环（门禁口径，按节点集合去重的环集合数，只许降不许升）：${cycles.leaf.size} 个`,
  );
  for (const c of cycles.leaf.values()) lines.push(`  ${c.join(" → ")}`);
  lines.push(`文件级值环（门禁口径，按节点集合去重的环集合数）：${cycles.file.size} 个`);
  for (const c of cycles.file.values()) lines.push(`  ${c.join(" → ")}`);
  lines.push(`死声明（意图 - 事实，只计 deps.ts 的值声明）：${deadDeclarations.length} 条`);
  for (const d of deadDeclarations) lines.push(`  ${d}`);
  lines.push(`deps.ts 值依赖声明（声明面混入值 import，硬判红）：${depsValueImports.length} 条`);
  for (const r of depsValueImports)
    lines.push(`  ${rel(analysis.srcDir, r.fromFile)} → import "${r.spec}"`);
  lines.push(
    "（意图图 = 各模块 deps.ts；类型边 import type/export type 是声明即完整性，豁免死声明判定）",
  );
  // #767 B0 切片 3a / 3b：四条新判据的明细。刻意排在全部既有段落之后——--graph 的既有
  // 消费者（自测按「叶子模块级值环…文件级值环」切段）不受新段落影响。
  const { crossDomainValueEdges, rootIndexImports, clientServerImports, unitImportFaceViolations } =
    analysis.extraEvidence;
  lines.push(
    `域间值边（I2①，目标非共享层的叶子模块值边，只许缩小）：${crossDomainValueEdges.length} 条`,
  );
  for (const e of crossDomainValueEdges) lines.push(`  ${e}`);
  lines.push(
    `值引 src 根 index.ts（I2④，域取组合根常量即文件级值环）：${rootIndexImports.length} 条`,
  );
  for (const e of rootIndexImports) lines.push(`  ${e}`);
  lines.push(
    `client 侧 import 面（§5.3，独立扫描、不入上方任何计数）：client → src/server ${clientServerImports.length} 条`,
  );
  for (const e of clientServerImports) lines.push(`  ${e}`);
  lines.push(
    `单元层导入面（I8①，test/unit 引组合根 src/index.ts / 产物 lib / 客户端 src/client，只许缩小）：${unitImportFaceViolations.length} 条`,
  );
  for (const e of unitImportFaceViolations) lines.push(`  ${e}`);
  return lines;
}

/**
 * 逐条走台账的新增质量证据放行：未登记的一律记入 `needs`（调用方据此中止写入），已登记
 * 的收进返回值并记入 `accepted`。首次登记与后续新增共用这条通道——「首次」只改提示口径，
 * 不是放宽通道。
 */
function acceptNewEvidence(packageName, metric, items, ledger, needs, accepted) {
  const kept = [];
  for (const item of items) {
    // 台账按「包名:证据 id」匹配（id 不含 kind）：kind 由 value→type 是收口、反向降级
    // 另有判据，故登记一条即覆盖该证据的形态漂移，不必随 kind 改台账。
    const key = `${packageName}:${splitEvidenceItem(metric, item).id}`;
    const entry = ledger.get(key);
    if (entry === undefined) {
      needs.push(`${key}（${metric}）`);
      continue;
    }
    kept.push(item);
    accepted.push(`${key}（${metric}，登记豁免 ${entry.trackingIssue}）`);
  }
  return kept;
}

/**
 * 首次登记的每类证据：逐条过台账后按当前证据写入。
 *
 * 直接把当前证据写库等于给「一次 --write-baseline 即洗白」留了后门，而首次登记恰恰
 * 是最容易夹带新证据的时点，故与增量路径共用同一条台账通道。
 */
function acceptFirstEvidence(pkgName, key, cur, ledger, sinks) {
  const kept = acceptNewEvidence(
    pkgName,
    key,
    cur,
    ledger,
    sinks.qualityNeedsAcceptance,
    sinks.qualityAccepted,
  );
  return { kept, count: kept.length };
}

/**
 * 已有证据面的每类证据：保留当前形态（kind 收口 value → type 是改善，直接采纳；反向
 * 降级已判红，不写入），并清理已消失的证据、把真正新增的交给台账通道。
 */
function reconcileEvidence(key, prevById, curById, cur, pkgName, ledger, sinks) {
  const kept = [];
  for (const [id] of prevById) {
    const curKind = curById.get(id);
    if (curKind === undefined) {
      sinks.qualityPruned.push(`${pkgName}.${key}: ${id}`);
      continue;
    }
    kept.push(curKind === null ? id : `${id}|${curKind}`);
  }
  const added = cur.filter((item) => !prevById.has(splitEvidenceItem(key, item).id));
  return kept.concat(
    acceptNewEvidence(
      pkgName,
      key,
      added,
      ledger,
      sinks.qualityNeedsAcceptance,
      sinks.qualityAccepted,
    ),
  );
}

/**
 * 质量证据段：整包无旧证据面（包级）走首次登记台账通道；单个证据键缺失（证据类级，
 * #767 B0 切片 3a）按当前事实写入存量并逐条点名——否则「新增一类证据」会被逐条判成
 * 「新增未登记证据」，逐条走台账等于把存量登记误当放宽通道。
 */
function buildPackageQuality(analysis, prevQuality, ledger, sinks) {
  const evidence = collectQualityEvidence(analysis);
  const quality = {};
  const rebuild = prevQuality === undefined;
  const classFirst = [];
  let firstCount = 0;
  for (const key of QUALITY_EVIDENCE_METRICS) {
    const cur = evidence[key] ?? [];
    if (rebuild) {
      const { kept, count } = acceptFirstEvidence(analysis.package, key, cur, ledger, sinks);
      quality[key] = kept.sort();
      firstCount += count;
      continue;
    }
    if (prevQuality[key] === undefined) {
      quality[key] = cur;
      firstCount += cur.length;
      classFirst.push(
        `${analysis.package}.${key}: 证据类首次登记（存量 ${cur.length} 条，按当前事实写入，须在 PR 内确认）`,
      );
      continue;
    }
    const prevById = indexById(prevQuality[key] ?? [], key);
    quality[key] = reconcileEvidence(
      key,
      prevById,
      indexById(cur, key),
      cur,
      analysis.package,
      ledger,
      sinks,
    ).sort();
  }
  return { quality, firstCount, classFirst };
}

/**
 * 生成基线 JSON 结构（稳定排序，便于 diff）。
 *
 * `--write-baseline` 的更新面（#733 后续）：
 *   - 结构型计数：按当前值登记（结构演进的显式留痕）。
 *   - 质量证据：只做两件事——**清理已消失的证据**（改善）、把 kind 收口
 *     （value → type）的条目更新为当前形态。**新增证据默认不写入**：只有已在
 *     `gate-exemptions.json`（gate = `verify-dir-imports`，key = `<包名>:<证据项>`）
 *     登记的条目才允许写入，其余中止写入并列出（exit 1）。
 *   - 首次登记有**两级**：①包级（旧基线无该包，或旧基线为数字口径 = 迁移）只走台账通道：
 *     证据缺登记即中止写入并列出，否则一次 `--write-baseline` 就能把新证据静默洗白成基线；
 *     ②证据**类**级（#767 B0 切片 3a：基线里没有这个证据键 = 本次新增了一类证据）：按当前
 *     证据写入存量并逐条点名（须在 PR 内确认），且只在键缺失的那一次生效——键一旦存在，
 *     类内新增证据仍走台账通道。类级是「新增一类判据」与「已有类里冒出新增证据」的分界：
 *     前者是存量登记（逐条开豁免会把存量误当放宽），后者仍一律中止写入。
 *
 * @returns `{ baseline, qualityPruned, qualityFirst, qualityNeedsAcceptance, qualityAccepted }`
 */
function buildBaseline(analyses, previous, ledger) {
  const packages = {};
  const qualityPruned = []; // 本次写入清理掉的已消失证据
  const qualityFirst = []; // 首次登记 / 数字口径迁移
  const qualityNeedsAcceptance = []; // 新增证据：未在台账登记时中止写入
  const qualityAccepted = []; // 本次按台账放行的新增证据
  const sinks = { qualityPruned, qualityNeedsAcceptance, qualityAccepted };
  for (const a of [...analyses].sort((x, y) => x.package.localeCompare(y.package))) {
    const m = a.metrics;
    const prev = previous?.packages?.[a.package];
    const entry = {};
    for (const key of STRUCTURAL_METRICS) entry[key] = m[key];
    const prevQuality = prev?.quality;
    const { quality, firstCount, classFirst } = buildPackageQuality(a, prevQuality, ledger, sinks);
    qualityFirst.push(...classFirst);

    entry.quality = quality;
    if (prevQuality === undefined) {
      // 首次登记与「数字口径 → 证据口径」迁移走同一条路径：两者都必须显式提示，
      // 否则「迁移」会退化成静默改写口径。
      qualityFirst.push(
        `${a.package}: 质量证据首次登记（${QUALITY_EVIDENCE_METRICS.length} 类，共 ${firstCount} 条）`,
      );
    }
    packages[a.package] = entry;
  }
  return {
    baseline: {
      // S0（#690 A 轨）门禁基线。结构型计数随新增文件/目录合法上升（--write-baseline 登记）；
      // 质量型入库的是**证据集合**而非计数（#733 后续）——新增证据判红、证据消失=改善、
      // kind 由 value→type 视为收口；放宽的唯一通道是 scripts/data/gate-exemptions.json
      // 的登记条目（gate = verify-dir-imports，key = <包名>:<证据项>）。
      // 口径：全部为**叶子模块粒度**实测（S0 起模块 = 递归含 interface.ts 的目录）。
      // 顶层域历史对照口径刻意不入库：它复刻的是有缺陷的旧算法（嵌套目标丢边），
      // 对它设阈值会让结构搬迁误红，并与叶子口径构成同一约束的双轨（§9 禁止双轨）。
      $comment:
        "S0 门禁基线（#690 / #733 后续）：结构型计数由 verify-dir-imports.mjs --write-baseline 登记；quality 段存质量型**证据集合**（边 from|to|kind、环签名、未覆盖源文件），新增证据判红、消失即清理、kind 降级（type→value）判红；放宽的唯一通道是 scripts/data/gate-exemptions.json 的登记条目（gate=verify-dir-imports，path=<包名>:<证据项> 或 <包名>:*（后者=本包无基线，不声称具体证据），必填 reason+trackingIssue，可选 reviewBy，条目失效由反向腐烂校验判红）。",
      version: 2,
      packages,
    },
    qualityPruned,
    qualityFirst,
    qualityNeedsAcceptance,
    qualityAccepted,
  };
}

/**
 * 解析本次要处理的包：显式 --package 优先；--write-baseline 缺省取**范围注册表里本闸的
 * 范围**（= cli 调用点并集，见 scripts/data/gate-scope-registry.json）。
 *
 * 为什么写基线不再「全量扫描 packages 下有 src 的目录」（#843 D15）：那个口径比调用点并集
 * 宽，每次全量写基线都会给「有 src、无调用点」的包落一条**死条目**——它永远不会被
 * `--package` 点到，条目却留在数据面冒充保护，而登记面的一致性由
 * scripts/test/gate-scope-registry.test.ts 的接线断言钉住（漂移即红）。写路径与判据路径
 * 同源后，全量写基线只会登记真正受判据管的包；要给新包登记基线，先给它加调用点。
 */
function resolvePackages() {
  if (explicitPackages !== null) return explicitPackages;
  if (WRITE_BASELINE) {
    // 范围读不到就不写：写出一份范围不明的基线等于把未知固化成「看起来已登记」。
    try {
      return scopePackages(ROOT, loadScopeRegistry(SCOPE_REGISTRY_PATH), GATE_NAME);
    } catch (e) {
      failClosed(`verify-dir-imports | 写基线的缺省范围无法解析：${e.message}`);
    }
  }
  return ["dsh-mcp-manager"];
}

/** 拓扑内容的可读形状名（形状非法时的判红文案用）。 */
function jsonShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  return typeof value;
}

let topology = null;
if (existsSync(TOPOLOGY_PATH)) {
  try {
    topology = JSON.parse(readFileSync(TOPOLOGY_PATH, "utf8"));
    // JSON.parse 对 null / 数组 / 标量同样成功，但这些形状承载不了段/层定义：此时下游
    // 「未登记」判据与全覆盖断言会被整体跳过（字面 null 连 `topology !== null` 守卫都过不去），
    // 故判红挂在**解析结果**上，并把 topology 归一为 null 使下游与缺失态一致——否则
    // 数组/标量还会额外触发「未登记」，红因从 1 条变 2 条。
    if (topology === null || typeof topology !== "object" || Array.isArray(topology)) {
      failures.push(
        `[topology] 变异拓扑顶层不是对象（单一事实源格式非法，实际 ${jsonShape(topology)}）：${TOPOLOGY_PATH} —— 无法判定源码全覆盖，fail-closed`,
      );
      topology = null;
    }
  } catch (e) {
    // 拓扑损坏时不能抛栈崩掉整个 contract 段：显式判红并保持其余检查可读。
    failures.push(`[topology] 变异拓扑解析失败：${TOPOLOGY_PATH}（${e.message}）`);
  }
} else {
  // 「文件缺失」与「解析失败」是两种不同事实，故不并入上面那条：缺失时无法区分
  // 「包未登记」与「拓扑整份丢失」，源码全覆盖断言随之整体失去判定依据（未覆盖清单
  // 恒为空），而调用点拿到的仍是一条干净的 PASS——正是本门禁宣称要防的假绿。
  failures.push(
    `[topology] 变异拓扑单一事实源缺失：${TOPOLOGY_PATH} —— 无法判定源码全覆盖，fail-closed`,
  );
}
const applyPackages = resolvePackages();
const analyses = [];
for (const pkgName of applyPackages) {
  const analysis = analyzePackage(pkgName, topology);
  if (analysis === null) {
    // fail-closed：`--package` 点名的包没有 src 目录（拼错 / 改名 / 退役）时必须判红。
    // 静默跳过 = 该包从此不受任何检查而门禁仍打印 PASS——这是一条已被复现的静默失覆盖
    // 向量（包改名后调用点未同步，门禁继续绿）。
    failures.push(
      `[${pkgName}] 包不存在或没有 src 目录（--package 点名但无法分析）—— 改名/退役请同步门禁调用点与 plugins-manifest，拼错请修正`,
    );
    continue;
  }
  // 被跨模块引用解析到的 interface.ts（任意层级）→ 符号存在性检查对象
  const referencedInterfaces = new Set();
  for (const r of analysis.refs) {
    // F12：判据是「目录不同」而不是「模块不同」。同模块内的子目录（a/sub/x.ts → ../interface.ts）
    // 同样是在引用该门面的对外符号，按模块比较会把这一面整块漏掉（#710 F12 实测向量）。
    if (r.targetFile === "interface.ts" && dirname(r.fromFile) !== dirname(r.target))
      referencedInterfaces.add(r.target);
  }
  for (const ifaceFile of referencedInterfaces) {
    for (const { exported, local, via } of collectInterfaceExports(ifaceFile)) {
      if (via === "inline") continue; // interface.ts 就地声明即自身实现
      const resolved = via.some((t) => collectExports(t).has(local));
      if (!resolved) {
        failures.push(
          `[${pkgName}] ${rel(analysis.srcDir, ifaceFile)} 导出符号 "${exported}"（源 ${local}）沿 re-export 链不可解析到实现（interface.ts 虚导出）`,
        );
      }
    }
  }
  // 注入面对账：deps.ts 是纯类型面，声明与装配之间没有编译器兜底（多给、给已删字段、
  // 漏装某个域都只剩运行期空值），这条把它补回机器面。
  for (const problem of analyzeInjectionFaces(analysis.srcDir)) {
    failures.push(`[${pkgName}] 注入面对账：${problem}`);
  }
  for (const problem of analysis.topologyProblems) {
    // 判词由 mutation-topology.mjs 的形状判据给出（包登记形态 / coverageExcludes 条目形态），
    // 这里只补出处：两类形状错误的修法在同一文件里，不需要在此复述其中一类。
    failures.push(
      `[${pkgName}] ${problem}（拓扑形状错误：判据见 scripts/gate/mutation-topology.mjs）`,
    );
  }
  analysis.metrics.interfaceFacades = referencedInterfaces.size;
  analyses.push(analysis);
}

// 指标分类完备性（fail-closed）：metrics 的每个字段必须落在「结构型计数 / 质量证据 /
// 仅报告派生量」三类之一，否则它既不被判红也不被登记（静默脱管）。这条在运行期对照
// 真实对象，故新增指标忘记分类会立刻红，不依赖手工清单同步。
for (const a of analyses) {
  for (const key of Object.keys(a.metrics)) {
    if (!CLASSIFIED_METRICS.has(key)) {
      failures.push(
        `[${a.package}] 指标 ${key} 未分类（结构型计数 / 质量证据 / 仅报告 三选一）—— 静默脱管`,
      );
    }
  }
}

// 本次真正分析过的包：台账判据只覆盖它们。缺省白名单只跑 mcp-manager，`--package X` 也只跑
// X；少了这条口径，任何子集运行都会把其余包的条目判成「已失效」——与 lint 那边基线棘轮被
// pre-commit 的 staged-only 运行误判是同一个坑。
const analyzedNames = new Set(analyses.map((a) => a.package));

/**
 * 「本包无基线」登记（`<包名>:*`）的反向腐烂：它只在基线确实没有该包条目时成立。包一旦
 * 落库基线，这条登记就成了对已不成立事实的声明——与质量证据的零命中条目同罪，必须在写基线
 * 时与下一次判据运行时都被点名，否则台账会永久留着一条什么都不再放宽的条目。
 */
function staleNoBaselineEntries(hasBaseline) {
  const stale = [];
  for (const [ledgerKey, entry] of evidenceLedger) {
    if (!ledgerKey.endsWith(NO_BASELINE_KEY_SUFFIX)) continue;
    const pkg = ledgerKey.slice(0, -NO_BASELINE_KEY_SUFFIX.length);
    if (!analyzedNames.has(pkg) || !hasBaseline(pkg)) continue;
    stale.push(
      `${ledgerKey} 是「本包无基线」登记，但基线已有该包条目（${BASELINE_PATH}）—— 已失效，应删除条目 ${entry.trackingIssue}`,
    );
  }
  return stale;
}

// 台账反向腐烂校验（#765）：登记的证据项必须仍在本次证据面里。证据消失后若无人清理条目，
// 台账就会累积「登记了但已不需要」的条目——与另两闸的零命中条目同罪。写入路径同样校验：
// 带着失效条目写基线，等于把「已不需要的放宽」固化下去。
{
  const seenEvidence = new Set();
  for (const a of analyses) {
    const evidence = collectQualityEvidence(a);
    for (const key of QUALITY_EVIDENCE_METRICS) {
      for (const item of evidence[key] ?? []) {
        seenEvidence.add(`${a.package}:${splitEvidenceItem(key, item).id}`);
      }
    }
  }
  for (const [ledgerKey, entry] of evidenceLedger) {
    // `<包名>:*` 不声称任何证据，故不走证据零命中判据；它的反向腐烂见 staleNoBaselineEntries。
    if (ledgerKey.endsWith(NO_BASELINE_KEY_SUFFIX)) continue;
    const pkg = ledgerKey.slice(0, ledgerKey.indexOf(":"));
    if (!analyzedNames.has(pkg)) continue;
    if (!seenEvidence.has(ledgerKey)) {
      failures.push(
        `[豁免台账] ${ledgerKey} 指向的质量证据本次零命中（已失效，应删除条目 ${entry.trackingIssue}）`,
      );
    }
  }
}

if (WRITE_BASELINE) {
  // 写基线前先拦阻断性错误（拓扑损坏 / interface.ts 虚导出）：静默落库会把
  // 「判不出来」固化成「看起来全覆盖」，正是本门禁要防的假绿。
  if (failures.length > 0) {
    console.log("verify-dir-imports | 写基线中止（存在阻断性错误）：");
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
  // 正在写基线 = 这些包马上就要有基线条目，「本包无基线」登记当场失效：先清台账再落库，
  // 否则写出来的基线会把一条已失效的放宽固化下去（与 :1670 的写入路径同口径）。
  const staleNoBaseline = staleNoBaselineEntries(() => true);
  if (staleNoBaseline.length > 0) {
    console.log("verify-dir-imports | 写基线中止：存在已失效的「本包无基线」登记");
    for (const note of staleNoBaseline) console.log(`  ${note}`);
    process.exit(1);
  }
  // 旧基线同时承担两个职责：质量型计数/未覆盖清单的**保留来源**（#733 M0b），以及
  // `--write-baseline --package X` 只写 X 时的其余包条目来源。
  let previous = null;
  if (existsSync(BASELINE_PATH)) {
    try {
      previous = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    } catch {
      // 旧基线不可解析时按「全量首次登记」处理：保留损坏内容只会延续问题。
      previous = null;
    }
  }
  const { baseline, qualityPruned, qualityFirst, qualityNeedsAcceptance, qualityAccepted } =
    buildBaseline(analyses, previous, evidenceLedger);
  if (qualityNeedsAcceptance.length > 0) {
    console.log("verify-dir-imports | 写基线中止：存在未登记的新增质量证据");
    for (const note of qualityNeedsAcceptance) console.log(`  ${note}`);
    console.log(
      `verify-dir-imports |   处置：优先修代码；确需放宽须在 ${EXEMPTIONS_DISPLAY} 登记条目（gate=verify-dir-imports，path=<包名>:<证据项>，必填 reason 与 trackingIssue）后重跑`,
    );
    process.exit(1);
  }
  // `--write-baseline --package X` 只应更新 X 的条目：直接整体覆盖会抹掉其他包的
  // 基线（随后它们全部落到 fail-closed），补救只能全量重写——那等于一键放宽。
  for (const [name, entry] of Object.entries(previous?.packages ?? {})) {
    if (!(name in baseline.packages)) baseline.packages[name] = entry;
  }
  // 键序也必须确定：`--write-baseline --package X` 把 X 排在前面、其余包按旧基线的顺序续在
  // 后面，于是「不同包各写一次」会产出不同的键序——跨 main 的 rebase 必然在同一个文件上冲突
  // （实测一次 rebase 为此反复解冲突 5 次）。全量写基线时 resolvePackages() 本就排序，单包写
  // 时不是；排序后两条路径的输出一致。
  baseline.packages = Object.fromEntries(
    Object.entries(baseline.packages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  console.log(`verify-dir-imports | 已写入基线 ${BASELINE_PATH}（${analyses.length} 个包）`);
  console.log(
    `verify-dir-imports |   结构型计数已更新（${STRUCTURAL_METRICS.length} 类，随新增文件/目录登记）：${STRUCTURAL_METRICS.join(" / ")}`,
  );
  console.log(
    `verify-dir-imports |   质量证据已对账（${QUALITY_EVIDENCE_METRICS.length} 类）：新增不写入、消失自动清理、kind 收口按当前形态更新`,
  );
  if (qualityPruned.length > 0) {
    console.log(`verify-dir-imports |   已清理消失的证据 ${qualityPruned.length} 条：`);
    for (const note of qualityPruned) console.log(`verify-dir-imports |     ${note}`);
  }
  if (qualityAccepted.length > 0) {
    console.log(
      `verify-dir-imports |   本次按台账放行的新增证据（条目在 ${EXEMPTIONS_DISPLAY}，理由须在 PR 内确认）：`,
    );
    for (const note of qualityAccepted) console.log(`verify-dir-imports |     ${note}`);
  }
  if (qualityFirst.length > 0) {
    console.log(
      "verify-dir-imports |   质量证据首次登记 / 数字口径迁移（按当前事实写入，须在 PR 内确认）：",
    );
    for (const note of qualityFirst) console.log(`verify-dir-imports |     ${note}`);
  }
  for (const a of analyses) {
    const coverNote =
      a.noMutationReason !== null
        ? "无变异面登记（$noMutationPackages，覆盖断言不适用）"
        : a.topologyRegistered
          ? `未覆盖 ${a.metrics.uncoveredSrcFiles.length} 个`
          : "未登记变异拓扑（覆盖断言不适用）";
    console.log(
      `verify-dir-imports |   ${a.package}: ${a.metrics.modules} 个叶子模块、值边 ${a.metrics.leafValueEdges} 条、${coverNote}`,
    );
    if (a.noMutationReason !== null) {
      console.log(`verify-dir-imports |   ${noMutationDeclaration(a.package, a.noMutationReason)}`);
    }
  }
  process.exit(0);
}

const baseline = loadBaseline();
if (baseline === null) {
  console.log(
    `verify-dir-imports | 未找到基线 ${BASELINE_PATH} —— fail-closed：规则违规 / 值环 / 未覆盖源文件均即刻判红（生成基线用 --write-baseline）`,
  );
}
for (const note of staleNoBaselineEntries((pkg) => baseline?.packages?.[pkg] !== undefined)) {
  failures.push(`[豁免台账] ${note}`);
}

for (const analysis of analyses) {
  const { package: pkgName, metrics } = analysis;
  const state =
    baseline === null ? { mode: "absent", rises: [] } : compareWithBaseline(analysis, baseline);
  registerRuleViolations(analysis, state);
  // deps.ts 是**依赖声明面**（本域对上依赖的形状），只能 import type / export type：
  // 出现值 import 即声明面混入了运行时依赖，跨域运行时能力必须经组合根注入
  // （ARCHITECTURE-METHOD §2「跨域运行时能力一律经 deps.ts 注入」），故硬判红且
  // 不受单调基线与 soft 模式影响（有基线也红——它不是存量计数而是结构缺陷）。
  for (const r of analysis.depsValueImports) {
    failures.push(
      `[${pkgName}] ${rel(analysis.srcDir, r.fromFile)} 出现值 import "${r.spec}"（deps.ts 只能声明类型依赖：改 import type / export type，运行时能力由组合根注入）`,
    );
  }
  if (!analysis.topologyRegistered && analysis.noMutationReason === null && topology !== null) {
    failures.push(
      `[${pkgName}] 未在 scripts/data/mutation-topology.json 登记（$noMutationPackages 亦无）—— 源码全覆盖断言无法判定（fail-closed：新增源文件会静默逃逸度量）`,
    );
  }
  if (analysis.noMutationReason !== null) {
    // 显式声明而非静默判绿（#773 批 B / #710 §2-2）：该包无变异面，源码全覆盖断言
    // 对本包不适用；基线里的 uncoveredSrcFiles: [] 是「未登记拓扑时该字段恒为空」的
    // 已知假绿，不代表已验证全覆盖，故必须在判绿输出里被点名。
    summary.push(noMutationDeclaration(pkgName, analysis.noMutationReason));
  }

  // 门禁口径（叶子模块）：S0 起模块 = 递归含 interface.ts 的目录，嵌套目标不再丢边。
  summary.push(
    `${pkgName}: 叶子模块 ${metrics.modules} 个、值边 ${metrics.leafValueEdges} 条、模块级值环 ${metrics.leafModuleCycles} 个、文件级值环 ${metrics.fileCycles} 个`,
  );
  summary.push(
    `${pkgName}: src 下 ${metrics.allSrcTsFiles} 个 TS 文件，其中 ${metrics.scannedSrcFiles} 个参与规则扫描（排除 client 与 .d.ts）、${metrics.interfaceFacades} 个 interface.ts 符号面`,
  );
  // 历史对照口径（顶层域，复刻修复粒度前的算法）：仅作跨期可比，不进基线。
  summary.push(
    `${pkgName}: 历史对照（顶层域口径，已退出门禁）：值边 ${metrics.topValueEdges} 条、环 ${metrics.topModuleCycles} 个`,
  );
  summary.push(
    `${pkgName}: R-A 语义切换前 ${metrics.raLegacy}（值 ${metrics.raLegacyValue} / type ${metrics.raLegacyType}）→ 切换后（impl 引用他域实现文件）${metrics.implToOtherImpl}`,
  );
  // #767 B0 切片 3a：三条新判据的存量条数（质量证据，目标都是空集；明细见 --graph）。
  summary.push(
    `${pkgName}: 域间值边（I2①，目标非共享层）${metrics.crossDomainValueEdges} 条、值引 src 根 index.ts（I2④）${metrics.rootIndexImports} 条、client → src/server import（§5.3）${metrics.clientServerImports} 条`,
  );
  // #767 B0 切片 3b：I8① 单元层导入面的存量条数（质量证据，目标为空集；明细见 --graph）。
  summary.push(
    `${pkgName}: 单元层导入面越界（I8①，test/unit → src/index.ts / lib / src/client）${metrics.unitImportFaceViolations} 条`,
  );

  if (state.mode === "compared") {
    if (state.rises.length === 0) {
      summary.push(
        `${pkgName}: 单调基线通过（结构型 ${STRUCTURAL_METRICS.length} 类计数 + 质量型 ${QUALITY_EVIDENCE_METRICS.length} 类证据：无新增、无降级）`,
      );
    } else {
      for (const rise of state.rises) failures.push(`[${pkgName}] 单调基线上升：${rise}`);
    }
    if (state.improvements.length > 0) {
      const head = state.improvements.slice(0, 3).join("；");
      summary.push(
        `${pkgName}: 质量证据改善 ${state.improvements.length} 条（--write-baseline 会清理入库）：${head}${state.improvements.length > 3 ? " …" : ""}`,
      );
    }
  } else {
    // fail-closed（#843 D15）：基线无本包条目 = 本包没有任何单调基线保护。旧实现在
    // 「违规计数恰好为零」时打印「基线无本包条目 —— fail-closed」却 exit 0——提示语与
    // 行为相反，且新包漏登 / 条目被删后该包静默脱离全部单调约束。故**无条目本身即红**；
    // 唯一放宽通道是台账里本包的 `<包名>:*`（无基线登记）或 `<包名>:<证据项>` 条目（与质量
    // 证据同一份台账、同一个校验器）。豁免只免「无条目」这一条：下面的违规/环/未覆盖照旧零容忍。
    const packageExempted = [...evidenceLedger.keys()].some((key) => key.startsWith(`${pkgName}:`));
    if (packageExempted) {
      summary.push(
        `${pkgName}: 基线无本包条目 —— 按台账豁免放行（条目见 ${EXEMPTIONS_DISPLAY}；违规/环/未覆盖仍零容忍）`,
      );
    } else {
      failures.push(
        `[${pkgName}] 基线无本包条目（${BASELINE_PATH}）—— 本包不在任何单调基线之下：先跑 --write-baseline 登记；确需放宽须在 ${EXEMPTIONS_DISPLAY} 登记 gate=verify-dir-imports、path=${pkgName}${NO_BASELINE_KEY_SUFFIX}（本包无基线，不声称具体证据）`,
      );
    }
    for (const [key, label] of [
      ["topModuleCycles", "顶层域值环"],
      ["leafModuleCycles", "叶子模块级值环"],
      ["fileCycles", "文件级值环"],
      ["implToOtherImpl", "impl 引用他域实现文件"],
      ["crossDomainValueEdges", "域间值边（目标非共享层）"],
      ["rootIndexImports", "值引 src 根 index.ts"],
      ["clientServerImports", "client → src/server import"],
      [
        "unitImportFaceViolations",
        "单元层导入面越界（test/unit → src/index.ts / lib / src/client）",
      ],
    ]) {
      if (metrics[key] > 0)
        failures.push(`[${pkgName}] 无基线 fail-closed：${label} ${metrics[key]} 个（应为 0）`);
    }
    for (const f of metrics.uncoveredSrcFiles) {
      failures.push(`[${pkgName}] 无基线 fail-closed：src 文件未被度量覆盖 ${f}`);
    }
  }

  if (ZONES) reports.push(renderZones(analysis));
  if (GRAPH) reports.push(renderGraph(analysis));
}

for (const line of summary) console.log(`verify-dir-imports | ${line}`);
for (const block of reports) {
  console.log(`verify-dir-imports | ${block[0]}`);
  for (const line of block.slice(1)) console.log(`  ${line}`);
}
if (softViolations.length > 0) {
  console.log(
    `verify-dir-imports | soft：${softViolations.length} 条跨模块直引（软报告，review 用，不判红）：`,
  );
  for (const v of softViolations) console.log(`  ${v}`);
}
if (failures.length > 0) {
  console.log(`verify-dir-imports | FAIL ${failures.length} 条硬违规：`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(
  "verify-dir-imports | PASS（跨模块引用全部走 interface.ts/deps.ts，符号存在性校验通过，基线未上升）",
);
process.exit(0);
