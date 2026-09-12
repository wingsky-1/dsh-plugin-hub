#!/usr/bin/env node
/**
 * export-surface-snapshot — 包导出面快照门禁（架构重构 PR1，M6 落地；#669）。
 *
 * 动机：目录重构（文件搬家/interface.ts 收口）期最容易出现的静默破坏是「导出
 * 面漂移」——符号被意外删除/改名，或同名符号的定义被改写。tsc --declaration
 * 产物是包对外契约的编译期镜像，本脚本把它固化为入库基线：重构前后零 diff
 * 即机器证据（重构不得改变包导出面）。
 *
 * 粒度（逐入口双保险，均对「文件搬移/语句组织」免疫、对「符号/定义变更」敏感）：
 *  1. 每个入口的顶层导出符号集（name + isType 标记）——增删改导出符号都会红；
 *  2. 每个入口内**导出面符号的定义块**——遍历该入口前缀所辖全部 .d.ts，提取顶层
 *     `export declare ...` 声明块（空白归一化），按该入口导出面符号名逐名过滤后比
 *     块**多重集**——任何被导出定义的内容改写（签名/泛型/联合）都会红；声明块搬去
 *     哪个文件不影响。**该集合不是「全部声明块」**：打印的总数是全部 .d.ts 的顶层
 *     声明块数，判据比对的只是其中「名字在该入口导出面」的块，两者不要求相等。
 *
 * 入口模型（#733 M2c 后续 N0(B)，逐条钉死；模型本身即是判据，勿读作实现细节）：
 *  - **入口集 E** := `package.json` 的 `exports` 中**带 `types` 条件的子路径键**
 *    （显式排除 `./package.json` 这类无 `types` 的子路径）。
 *  - **`typesTarget(e)`** := `exports[e].types` 去掉 `./lib/` 前缀后的 emit 相对路径
 *    （如 `index.d.ts` / `client/index.d.ts`）。**解析根 = emit 产物，不是包目录**——
 *    门禁自己跑 `tsc --declaration`，与是否已 build 无关。该文件必须在本次 emit
 *    产物中存在，否则判红。
 *  - **`prefix(e)`** := `dirname(typesTarget(e))`（根入口 → `""`）；每个 emit `.d.ts`
 *    按**最长前缀**归属；**同长度多命中判红**（归属不唯一）；**未被任何 prefix 归属
 *    的文件判红**（不得静默丢弃）。
 *  - **每入口至少辖 1 个 `.d.ts`、至少 1 条声明块**，否则判红；**各入口 `typesTarget`
 *    互不相同**，否则判红。
 *  这四条是**可判且可达**的：实测若在 `exports` 里新增 `./server`
 *  （types=`./lib/server/index.d.ts`），旧写法会把 4 个 `server/*.d.ts` 静默吸收进 `.`
 *  且无判据发声；新写法要求 `./server` 成为独立入口并各自非空。
 *
 * 修复的判据缺陷（#733 M2c 复核对抗实测，均已在门禁自述与 §9 登记）：
 *  - **F-1**：旧 `extractExports()` 只读 `index.d.ts` ⇒ `./client` 入口导出面**零判据**；
 *  - **F-2（同名归属）**：旧 `declMapFor` 用 `Map.set(name, block)` ⇒ 同名多块只留排序
 *    末块。包入口 `apply`（宿主）与 `./client` 的 `apply` 同名 ⇒ 改**宿主** `apply`
 *    签名 exit=0（漏判），改客户端块才红（归属错误）。逐入口后两边各归各入口比对。
 *
 * 已登记残留（如实登记为**已知类**，不是本轮新增）：
 *  - **盲区①**：tsc 对 interface/type 产出 `export interface`/`export type`（无
 *    `declare`，进不了本提取器）——类型体由 test/integration/consumer-types.test.ts
 *    的类型体锚兜住；
 *  - **盲区②**：不在包导出面的域内符号不参与比对——实测四条门禁与包内 1790 条测试全绿；
 *  - **盲区③**：导出面里两侧都没有定义块的名字被跳过（100 个里 32 个，其中 28 个是
 *    interface/type，另 4 个是**值符号** readBody/writeJson/errorMessage/
 *    isLoopbackRequest，re-export 自 shared/）——其签名改动无任何判据覆盖；
 *  - **盲区④（按名过滤的域内残块）**：前缀内但不在**该入口导出面**内的块不参与按名
 *    比对——当前实例 = `client/locales.d.ts` 的 `en`/`zh`（`./client` 4 块里的 2 块）。
 *    它属盲区②的一个实例，不是新增类；若要覆盖需改为「不按 exports 过滤」（会显著
 *    收紧，须另裁决）。
 *  - **同入口同名多块分支当前不构成判据**：实测 `.` 101 块、`./client` 4 块，各自块名
 *    无重复 ⇒ 该分支（同一入口内同名符号有多块时按多重集全量比对）当前恒真。跨入口
 *    同名（`apply`/`inject`）才是本修复的核心收益，由 fixture 反向验证锁定。
 *
 * 自洽断言（常驻，防双源漂移）：兼容字段 `exports` 必须等于 `entries["."].exports`；
 * `declBlocks`（全部 .d.ts 顶层声明块）必须等于各入口块的**多重集并集**（逐条相等，
 * 禁止用 Set——实测逐字重复块 = `export declare const inject: string[];`）。
 *
 * 用法：
 *   node scripts/gate/export-surface-snapshot.mjs --package dsh-notifier --snapshot  # 生成/更新基线
 *   node scripts/gate/export-surface-snapshot.mjs --package dsh-notifier             # 与基线比对（--check 同义）
 *
 * 除基线比对外，同一次 `emitDeclarations()` 产物还喂「导出面分类登记」准入判据
 *（#733 宪法第 3 条 / M2a-3.5：包导出面 ⊆ 安装面 ∪ 配置面 ∪ 契约面）——新增导出
 * 必须在 scripts/data/<pkg>-export-faces.json 的 faces 显式登记三类面之一，未登记判红。
 * 判据实现见 scripts/lib/export-faces-lib.ts（**同一实现**被门禁与 fixture 自测复用，
 * §9 禁止双轨）；`--snapshot` 只写基线、不碰登记文件，故「更新基线」不会顺手把新符号
 * 变成合法导出——分类登记始终是一次显式动作。
 * **faces 判据的论域 = 主入口（`.`）的导出面**：`./client` 只进基线比对，不喂
 * checkExportFaces。理由是 #733 宪法第 3 条指 SDK 面；客户端入口首次出现独有导出
 * （UI 组件/类型）时无法归入三类面，只能塞 `legacy`，与 M2b「legacy 归零」冲突。
 * 该分工同写在 docs/ARCHITECTURE-METHOD.md §6 三层裁定与 scripts/lib/export-faces-lib.ts
 * 的论域陈述里。
 *
 * 基线文件：scripts/data/<package>-export-surface.json（入库；重构后合入 PR）。
 * 基线形态 v2（兼容形态，两个既有消费者零改动）：
 *   { package, exports: [...], declBlocks: [...],            // 兼容字段，语义与 v1 完全一致
 *     entries: { ".": { types, exports: [...], blocks: { name: [块…] } }, "./client": {…} } }
 *   - 兼容字段 `exports` = **主入口（`.`）**的导出面（consumer-types.test.ts 依赖它枚举
 *     28 条类型锚；export-faces-admission.test.ts 依赖 legacy.length === exports.length）；
 *   - 兼容字段 `declBlocks` = **全部块的多重集**（verbose 打印的「当前/基线」即此值）；
 *   - `entries[e].exports` := 对该入口 `typesTarget(e)` 所指 `.d.ts` 跑 extractExports 的
 *     结果（实测 `.` → 100 条；`./client` → apply/inject 2 条）。**不是**「该入口前缀所辖
 *     全部文件的导出名并集」（实测 152 ≠ 100）；
 *   - `entries[e].blocks` := 该入口前缀所辖**全部** emit `.d.ts` 的块多重集（`.` → 101 条 /
 *     `./client` → 4 条）。
 *
 * 接入：scripts/gate/contract-check.ts（PR1 起对 dsh-notifier 强制）。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkExportFaces, loadExportFaces } from "../lib/export-faces-lib.ts";
import { attributeEmitFiles, declBlockName, extractDeclBlocks, extractExports } from "../lib/surface-extract-lib.ts";
import { listExportTypesEntries, stripLibPrefix } from "../lib/exports-types-lib.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARGV = process.argv.slice(2);
const isSnapshot = ARGV.includes("--snapshot");
const verbose = ARGV.includes("--verbose");
const pkgName = ARGV[ARGV.indexOf("--package") + 1];
if (!pkgName) {
  console.error("[export-surface-snapshot] 缺少 --package <name>");
  process.exit(2);
}

const tsconfigIdx = ARGV.indexOf("--tsconfig");
const baselineIdx = ARGV.indexOf("--baseline");
const baselinePath = baselineIdx >= 0 ? ARGV[baselineIdx + 1] : join(ROOT, "scripts", "data", `${pkgName}-export-surface.json`);
const facesIdx = ARGV.indexOf("--faces");
const facesPath = facesIdx >= 0 ? ARGV[facesIdx + 1] : join(ROOT, "scripts", "data", `${pkgName}-export-faces.json`);
const pkgDir = join(ROOT, "packages", pkgName);
const tsconfigPath = tsconfigIdx >= 0 ? ARGV[tsconfigIdx + 1] : join(pkgDir, "tsconfig.json");

/** 无名声明块的兜底分组键（fail-loud 同时用它保住并集自洽断言，不留静默丢块）。 */
const UNNAMED_BLOCK_KEY = "\u0000unnamed";

function collectDts(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectDts(full, acc);
    else if (entry.name.endsWith(".d.ts")) acc.push(full);
  }
  return acc;
}

/**
 * 用包自身 tsc（declaration: true 基座）在临时目录产出全部 .d.ts 声明。
 * @returns {{ perFile: Map<string, { text: string, blocks: string[] }> }} 键 = emit 相对路径（POSIX）
 */
function emitDeclarations() {
  const outDir = mkdtempSync(join(tmpdir(), "export-surface-"));
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const res = spawnSync(process.execPath, [tsc, "-p", tsconfigPath, "--declaration", "--emitDeclarationOnly", "--outDir", outDir], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    rmSync(outDir, { recursive: true, force: true });
    console.error(`[export-surface-snapshot] tsc --declaration 失败：\n${res.stdout}${res.stderr}`);
    process.exit(1);
  }
  const perFile = new Map();
  for (const f of collectDts(outDir)) {
    const text = readFileSync(f, "utf8");
    perFile.set(relative(outDir, f).split(sep).join("/"), { text, blocks: extractDeclBlocks(text) });
  }
  rmSync(outDir, { recursive: true, force: true });
  return { perFile };
}

/** 块列表 → `{ 声明名: [块…] }`（同名多块保留全部——多重集语义）。 */
function groupBlocks(blocks) {
  const out = {};
  for (const block of blocks) {
    const name = declBlockName(block);
    (out[name ?? UNNAMED_BLOCK_KEY] ??= []).push(block);
  }
  return out;
}

/** 按该入口导出面名字集过滤块分组 → 排序后的块多重集（禁止 Set：重复块是真实信号）。 */
function filterBlocksByName(blocksByName, names) {
  const out = [];
  for (const [name, list] of Object.entries(blocksByName)) {
    if (names.has(name)) out.push(...list);
  }
  return out.sort();
}

/** 多重集差 a − b（保留重复计数）。 */
function multisetDiff(a, b) {
  const counts = new Map();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  for (const x of b) {
    const c = counts.get(x) ?? 0;
    if (c > 0) counts.set(x, c - 1);
  }
  const out = [];
  for (const [x, c] of counts) for (let i = 0; i < c; i += 1) out.push(x);
  return out;
}

// ---------------------------------------------------------------- emit 产物 → 入口 → 快照

const { perFile } = emitDeclarations();
const allFiles = [...perFile.keys()].sort();
const declBlocks = allFiles.flatMap((f) => perFile.get(f).blocks).sort();
const problems = [];
const entries = {};

const entrySpecs = [];
for (const { subpath, types } of listExportTypesEntries(pkgDir)) {
  const typesTarget = stripLibPrefix(types);
  if (typesTarget === null) {
    problems.push(`入口 ${subpath} 的 types 不在 ./lib/ 下（无法定位 emit 产物）：${types}`);
    continue;
  }
  const dir = posix.dirname(typesTarget);
  entrySpecs.push({ subpath, types, typesTarget, prefix: dir === "." ? "" : dir });
}
if (entrySpecs.length === 0) problems.push("包 exports 无任何带 types 条件的子路径——入口模型退化为「无约束」，拒绝放行");
{
  const seenTarget = new Map();
  for (const e of entrySpecs) {
    if (seenTarget.has(e.typesTarget)) {
      problems.push(`入口 ${e.subpath} 与 ${seenTarget.get(e.typesTarget)} 的 typesTarget 相同（${e.typesTarget}）——入口归属有歧义`);
    } else {
      seenTarget.set(e.typesTarget, e.subpath);
    }
  }
}
const { byEntry, orphans, conflicts } = attributeEmitFiles(allFiles, entrySpecs.map((e) => ({ subpath: e.subpath, prefix: e.prefix })));
for (const o of orphans) problems.push(`emit 产物未被任何入口前缀归属（不得静默丢弃）：${o}`);
for (const c of conflicts) problems.push(`emit 产物入口归属不唯一（同长度多命中）：${c}`);

for (const e of entrySpecs) {
  const owned = byEntry[e.subpath] ?? [];
  if (owned.length === 0) problems.push(`入口 ${e.subpath} 未辖任何 emit .d.ts（typesTarget=${e.typesTarget}）`);
  const file = perFile.get(e.typesTarget);
  if (file === undefined) {
    problems.push(`入口 ${e.subpath} 的 typesTarget 不在本次 emit 产物中：${e.typesTarget}`);
  }
  const blocks = owned.flatMap((f) => perFile.get(f).blocks);
  if (blocks.length === 0) problems.push(`入口 ${e.subpath} 辖内声明块为 0（前缀 ${e.prefix === "" ? "<根>" : e.prefix}）`);
  const exportList = file === undefined ? [] : extractExports(file.text);
  if (exportList.length === 0) problems.push(`入口 ${e.subpath} 的导出面为空（typesTarget=${e.typesTarget}）`);
  const grouped = groupBlocks(blocks);
  if (UNNAMED_BLOCK_KEY in grouped) {
    problems.push(`入口 ${e.subpath} 辖内有无法识别声明名的块（提取器与 tsc 产物形态脱节）：${grouped[UNNAMED_BLOCK_KEY][0].slice(0, 120)}`);
  }
  entries[e.subpath] = { types: e.types, exports: exportList, blocks: grouped };
}

// 兼容字段口径（v1 语义逐字不变）：exports = 主入口导出面；declBlocks = 全部块多重集。
const mainEntry = entries["."];
if (mainEntry === undefined) problems.push('包 exports 缺主入口（"." 无 types 条件）——兼容字段 exports 无从取值');
const surface = {
  package: pkgName,
  exports: mainEntry === undefined ? [] : mainEntry.exports,
  declBlocks,
  entries,
};

// 自洽断言（常驻）：两个口径必须同源，否则「兼容字段」会与实际判据面静默漂移。
{
  const union = Object.values(entries)
    .flatMap((e) => Object.values(e.blocks).flat())
    .sort();
  if (JSON.stringify(union) !== JSON.stringify(surface.declBlocks)) {
    problems.push("自洽断言失败：各入口块的多重集并集 ≠ declBlocks（归属丢块/重复）——双源漂移");
  }
  if (mainEntry !== undefined && JSON.stringify(surface.exports) !== JSON.stringify(mainEntry.exports)) {
    problems.push('自洽断言失败：兼容字段 exports ≠ entries["."].exports——双源漂移');
  }
}

if (isSnapshot) {
  if (problems.length > 0) {
    console.log(`[export-surface-snapshot] 拒绝写入基线：入口模型/自洽断言未通过（${problems.length} 处）`);
    for (const p of problems) console.log(`  ${p}`);
    process.exit(1);
  }
  writeFileSync(baselinePath, JSON.stringify(surface, null, 2) + "\n", "utf8");
  console.log(
    `[export-surface-snapshot] 基线已写入 ${baselinePath}（${surface.exports.length} 个导出符号、${surface.declBlocks.length} 个声明块、${Object.keys(surface.entries).length} 个入口）`,
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(`[export-surface-snapshot] 基线不存在：${baselinePath} — 先跑 --snapshot 生成`);
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
if (baseline.entries === undefined) {
  console.error("[export-surface-snapshot] 基线为 v1 形态（无 entries）——入口模型无法比对，请先跑 --snapshot 重冻结基线");
  process.exit(2);
}

// ---------------------------------------------------------------- 逐入口比对（符号集 + 块多重集）

/** 入口的导出符号集比对（缺失/新增/值⇄类型形态变化）。 */
function compareExportSet(baseExports, curExports, subpath) {
  const base = new Map(baseExports.map((e) => [`${e.isType ? "type " : ""}${e.name}`, e]));
  const cur = new Map(curExports.map((e) => [`${e.isType ? "type " : ""}${e.name}`, e]));
  for (const key of base.keys()) if (!cur.has(key)) problems.push(`  入口 ${subpath} 缺失导出（基线有、现在无）：${key}`);
  for (const key of cur.keys()) if (!base.has(key)) problems.push(`  入口 ${subpath} 新增导出（现在有、基线无）：${key}`);
  for (const key of base.keys()) {
    if (cur.has(key) && base.get(key).isType !== cur.get(key).isType) problems.push(`  入口 ${subpath} 导出形态变化（值⇄类型）：${key}`);
  }
}

for (const e of entrySpecs) {
  const cur = entries[e.subpath];
  const base = baseline.entries[e.subpath];
  if (base === undefined) {
    problems.push(`  入口 ${e.subpath} 不在基线内（新增入口须重冻结基线：--snapshot）`);
    continue;
  }
  compareExportSet(base.exports ?? [], cur.exports, e.subpath);
  // 按**该入口**导出面名字集过滤后比块多重集：域内/非导出面符号不参与（盲区②④），
  // 跨入口同名符号（apply/inject）各归各入口——这是本修复的核心收益。
  const baseFiltered = filterBlocksByName(base.blocks ?? {}, new Set((base.exports ?? []).map((x) => x.name)));
  const curFiltered = filterBlocksByName(cur.blocks, new Set(cur.exports.map((x) => x.name)));
  for (const b of multisetDiff(baseFiltered, curFiltered)) problems.push(`  入口 ${e.subpath} 声明块丢失：${b.slice(0, 200)}`);
  for (const b of multisetDiff(curFiltered, baseFiltered)) problems.push(`  入口 ${e.subpath} 声明块新增：${b.slice(0, 200)}`);
}
for (const key of Object.keys(baseline.entries)) {
  if (entries[key] === undefined) problems.push(`  入口 ${key} 在基线内、现在无（入口被删除）`);
}

// 导出面分类登记准入判据（#733 M2a-3.5）：与基线比对共用同一次 emitDeclarations() 产物。
// 登记文件缺失即抛（判据的输入不能静默降级为「无约束」）——用 --faces 覆盖仅用于 fixture 自测。
// 论域 = 主入口导出面（见文件头自述：客户端入口独有导出无法归入三类面）。
{
  const registry = loadExportFaces(facesPath);
  if (registry.package !== undefined && registry.package !== pkgName) {
    problems.push(`分类登记文件的 package 字段（${registry.package}）与 --package（${pkgName}）不一致`);
  }
  for (const p of checkExportFaces({
    exports: surface.exports.map((e) => e.name),
    faces: registry.faces,
    legacy: registry.legacy,
    registryPath: `scripts/data/${pkgName}-export-faces.json`,
  })) {
    problems.push(`  [导出面分类登记] ${p}`);
  }
}

if (problems.length > 0) {
  console.log(`[export-surface-snapshot] FAIL ${pkgName} 导出面与基线有 ${problems.length} 处差异：`);
  for (const p of problems) console.log(p);
  console.log("  若为有意变更（PR2 行为重构等），先更新基线：node scripts/gate/export-surface-snapshot.mjs --package dsh-notifier --snapshot");
  process.exit(1);
}
// 门禁自述必须与事实一致（#733 M2c R4-2）：declBlocks 是「全部 .d.ts 的顶层声明块」
// 计数，而上面的比对逐入口按该入口导出面符号名取块——两侧计数本就不同源（实测基线
// 96 / 现网 105），把当前值写成「与基线一致」是自述与事实相反。
if (verbose) {
  console.log(
    `[export-surface-snapshot] ${surface.exports.length} 个导出符号；声明块 当前 ${surface.declBlocks.length} / 基线 ${baseline.declBlocks.length}` +
      "（该计数是全部 .d.ts 的顶层声明块数，不等于判据实际比对的块集合——比对逐入口按该入口导出面符号名取块；两者不要求相等）",
  );
}
console.log(`[export-surface-snapshot] PASS ${pkgName} 导出面与基线零 diff`);
process.exit(0);
