#!/usr/bin/env node
/**
 * export-surface-snapshot — 包导出面快照门禁（架构重构 PR1，M6 落地；#669）。
 *
 * 动机：目录重构（文件搬家/interface.ts 收口）期最容易出现的静默破坏是「导出
 * 面漂移」——符号被意外删除/改名，或同名符号的定义被改写。tsc --declaration
 * 产物是包对外契约的编译期镜像，本脚本把它固化为入库基线：重构前后零 diff
 * 即机器证据（重构不得改变包导出面）。
 *
 * 粒度（双保险，均对「文件搬移/语句组织」免疫、对「符号/定义变更」敏感）：
 *  1. 顶层导出符号集（name + isType 标记）——增删改导出符号都会红；
 *  2. 全部声明块多重集——遍历 emitDeclaration 产出的全部 .d.ts，提取每个
 *     `export declare ...` 顶层声明块（interface/class 整块、type/const/
 *     function/enum 单行），空白归一化后做多重集比较——任何被导出定义的
 *     内容改写（类型结构/签名/泛型/联合）都会红；声明块搬去哪个文件不影响
 *     （它是「集合」不是「路径树」）。
 *
 * 用法：
 *   node scripts/gate/export-surface-snapshot.mjs --package dsh-notifier --snapshot  # 生成/更新基线
 *   node scripts/gate/export-surface-snapshot.mjs --package dsh-notifier             # 与基线比对（--check 同义）
 *
 * 基线文件：scripts/data/<package>-export-surface.json（入库；重构后合入 PR）。
 * 接入：scripts/gate/contract-check.ts（PR1 起对 dsh-notifier 强制）。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const pkgDir = join(ROOT, "packages", pkgName);
const tsconfigPath = tsconfigIdx >= 0 ? ARGV[tsconfigIdx + 1] : join(pkgDir, "tsconfig.json");

/** 提取顶层导出符号集（index.d.ts 产物形态：re-export 块 + declare 声明）。 */
function extractExports(text) {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  const out = [];
  // export { A, B as C } from "./x.js"; 与 export type { ... } from ...
  const blockRe = /export\s+(type\s+)?\{([^}]*)\}\s*(?:from\s*"[^"]*")?;/gu;
  for (const m of noComments.matchAll(blockRe)) {
    const isType = m[1] !== undefined;
    for (const raw of m[2].split(",")) {
      const name = raw.trim();
      if (name.length === 0) continue;
      const asIdx = name.indexOf(" as ");
      out.push({ name: (asIdx >= 0 ? name.slice(asIdx + 4) : name).trim(), isType });
    }
  }
  // export declare const/function/interface/class/type/enum Name
  const declRe = /export\s+declare\s+(?:type\s+)?(?:abstract\s+)?(const|function|interface|class|type|enum)\s+([A-Za-z_$][\w$]*)/gu;
  for (const m of noComments.matchAll(declRe)) {
    const isType = m[1] === "interface" || m[1] === "type" || m[1] === "enum";
    out.push({ name: m[2], isType });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // 同名字符串去重（值与类型同名共存的形态罕见，快照内保留首见）
  const seen = new Set();
  return out.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
}

/** 提取单个 d.ts 文本的全部顶层 `export declare ...` 声明块（含多行 interface/class）。 */
function extractDeclBlocks(text) {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  const blocks = [];
  for (let i = 0; i < noComments.length; i += 1) {
    if (!noComments.startsWith("export declare", i)) continue;
    // 声明起点：从 export declare 之后扫描到块结束（; 或匹配的 }）
    let j = i + "export declare".length;
    let depth = 0;
    for (; j < noComments.length; j += 1) {
      const ch = noComments[j];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          if (noComments[j] === ";") j += 1;
          break;
        }
      } else if (ch === ";" && depth === 0) {
        j += 1;
        break;
      }
    }
    blocks.push(noComments.slice(i, j).replace(/\s+/gu, " ").trim());
    i = j - 1;
  }
  blocks.sort();
  return blocks;
}

function collectDts(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectDts(full, acc);
    else if (entry.name.endsWith(".d.ts")) acc.push(full);
  }
  return acc;
}

/** 用包自身 tsc（declaration: true 基座）在临时目录产出全部 .d.ts 声明。 */
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
  const dtsFiles = collectDts(outDir);
  const indexDts = join(outDir, "index.d.ts");
  if (!existsSync(indexDts)) {
    rmSync(outDir, { recursive: true, force: true });
    console.error(`[export-surface-snapshot] ${pkgName} 未产出 index.d.ts（装配层入口缺失？）`);
    process.exit(1);
  }
  const indexText = readFileSync(indexDts, "utf8");
  const declBlocks = [];
  for (const f of dtsFiles) declBlocks.push(...extractDeclBlocks(readFileSync(f, "utf8")));
  declBlocks.sort();
  rmSync(outDir, { recursive: true, force: true });
  return { indexText, declBlocks };
}

const { indexText, declBlocks } = emitDeclarations();
const surface = {
  package: pkgName,
  exports: extractExports(indexText),
  declBlocks,
};

if (isSnapshot) {
  writeFileSync(baselinePath, JSON.stringify(surface, null, 2) + "\n", "utf8");
  console.log(`[export-surface-snapshot] 基线已写入 ${baselinePath}（${surface.exports.length} 个导出符号、${surface.declBlocks.length} 个声明块）`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(`[export-surface-snapshot] 基线不存在：${baselinePath} — 先跑 --snapshot 生成`);
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

const problems = [];
if (JSON.stringify(baseline.exports) !== JSON.stringify(surface.exports)) {
  const base = new Map(baseline.exports.map((e) => [`${e.isType ? "type " : ""}${e.name}`, e]));
  const cur = new Map(surface.exports.map((e) => [`${e.isType ? "type " : ""}${e.name}`, e]));
  for (const key of base.keys()) if (!cur.has(key)) problems.push(`  缺失导出（基线有、现在无）：${key}`);
  for (const key of cur.keys()) if (!base.has(key)) problems.push(`  新增导出（现在有、基线无）：${key}`);
  for (const key of base.keys()) {
    if (cur.has(key) && base.get(key).isType !== cur.get(key).isType) problems.push(`  导出形态变化（值⇄类型）：${key}`);
  }
}

/**
 * 只比对「包导出面符号」的定义块（按符号名对齐）：域间经 interface.ts 传递的
 * 模块级公共符号（pipeline 判定/投递工厂等）不出现在包导出面，不属于快照契约；
 * 它们由 verify-dir-imports 与测试锁定。某导出符号的定义被改写（类型结构/签名
 * /泛型变化）→ 同名块的文本变化 → 红。
 */
function declMapFor(declBlocks, exportNames) {
  const map = new Map();
  for (const block of declBlocks) {
    const m = /^export declare (?:type |abstract )?(?:const|function|interface|class|type|enum) ([A-Za-z_$][\w$]*)/u.exec(block);
    if (m && exportNames.has(m[1])) map.set(m[1], block);
  }
  return map;
}
{
  const exportNames = new Set(surface.exports.map((e) => e.name));
  const baseMap = declMapFor(baseline.declBlocks, exportNames);
  const curMap = declMapFor(surface.declBlocks, exportNames);
  for (const name of exportNames) {
    const missingInBase = !baseMap.has(name);
    const missingInCur = !curMap.has(name);
    if (missingInBase && missingInCur) continue; // 两端都无定义（re-export 自外部域，如 shared）
    if (missingInBase) problems.push(`  导出符号 ${name} 基线无定义块（基线侧异常）`);
    else if (missingInCur) problems.push(`  导出符号 ${name} 现在无定义块（定义被删除或未导出）`);
    else if (baseMap.get(name) !== curMap.get(name)) problems.push(`  导出符号 ${name} 定义被改写：\n   基线 ${baseMap.get(name).slice(0, 200)}\n   现在 ${curMap.get(name).slice(0, 200)}`);
  }
}

if (problems.length > 0) {
  console.log(`[export-surface-snapshot] FAIL ${pkgName} 导出面与基线有 ${problems.length} 处差异：`);
  for (const p of problems) console.log(p);
  console.log("  若为有意变更（PR2 行为重构等），先更新基线：node scripts/gate/export-surface-snapshot.mjs --package dsh-notifier --snapshot");
  process.exit(1);
}
if (verbose) console.log(`[export-surface-snapshot] ${surface.exports.length} 个导出符号、${surface.declBlocks.length} 个声明块与基线一致`);
console.log(`[export-surface-snapshot] PASS ${pkgName} 导出面与基线零 diff`);
process.exit(0);