#!/usr/bin/env node
/**
 * forbid-raw-exit2 — 门禁故障码不得绕开唯一出口（#843 P-2 的否定判据）。
 *
 * 判据：`scripts/gate/**` 与 `scripts/release/**` 内的源码不得直接写裸 `process.exit(2)` /
 * `process.exitCode = 2` / `exitCode = 2`，它们必须经 `scripts/lib/gate-exit.mjs` 的
 * `failClosed()`。理由：exit 2 的语义是「门禁自己坏了」，而它的说服力全在判词可检索上；多一个
 * 绕过口就多一份自写判词，事故当下又只能翻日志去猜。
 *
 * 为什么是否定判据而不是白名单：这里拦的是**新增**绕道。全仓 22 处存量已在引入本判据的同一个
 * PR 内全部迁到 failClosed，"除该 lib 外不得出现" 因此可以逐字成立——不需要存量基线，也就不存
 * 在"基线里还挂着 20 处、谁都不会去清"的中间态。
 *
 * **显式排除 `return 2`（本判据不覆盖，勿读成漏判）**：那是"把退出码经返回值交给调用方"的
 * 形态，全仓 22 处（`threshold-monotonic.mjs` / `crap-check.mjs` 的 `{ exitCode: 2 }` 与各
 * 闸的 `return 2`）。它们的契约归一属已登记的 L3「退出码契约归一」，本 PR 不动——同一批次的
 * 判据只覆盖与本批次同源的那一半，避免用一条判据顺手改写二十处函数的返回语义。
 *
 * 检测走 AST：注释与字符串里的同形文本天然不命中——本文件自己的文档、以及 `gate-exit.mjs` 里
 * 那段"曾经有三种写法"的说明都逐字含这些形态，文本扫描会把它们判成违规。
 * 本文件自身同样扫描：模式描述不是出口 AST，不能成为无条件免扫的理由。
 *
 * 行号必须是**原文件的行**：JS 家族直接交给 acorn；`.ts` 先经 esbuild 剥类型，再用 sourcemap
 * 把生成行映回原行——esbuild 会丢掉注释，不映射就会让"注释在命中之前"的文件报出偏小的行号
 * （实测三行探针文件报成第 2 行）。
 *
 * 用法：node scripts/gate/forbid-raw-exit2.mjs [--root <dir>]
 * 退出码：0 = 无裸出口；1 = 存在裸出口；2 = 判据自身无法覆盖扫描面（fail-closed）
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { SourceMap } from "node:module";

import { transformSync } from "esbuild";
import * as acorn from "acorn";

import { failClosed } from "../lib/gate-exit.mjs";

const ROOT = join(import.meta.dirname, "../..");
const SCAN_DIRS = ["scripts/gate", "scripts/release"];
/** 扫描面只认这几种扩展名；新扩展名（如 .mts）不静默放过——空面即 fail-closed。 */
const SCAN_EXTENSIONS = [".mjs", ".cjs", ".js", ".ts"];
/** 唯一出口的展示路径（判词里要能一眼指到修法）。 */
const GATE_EXIT_DISPLAY = "scripts/lib/gate-exit.mjs";
/** acorn 解析选项：ESM + 位置信息（行号是判词的一部分）。 */
const PARSE_OPTIONS = { ecmaVersion: "latest", sourceType: "module", locations: true };

/** `--flag value` 取值；未给出用 fallback（与仓内其余判据同形）。 */
function argValue(argv, flag, fallback) {
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] !== undefined ? argv[idx + 1] : fallback;
}

/** 成员属性名：`process.exitCode` 与 `process["exitCode"]` 同判。 */
function memberName(node) {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  if (node.computed && node.property?.type === "Literal") return String(node.property.value);
  return null;
}

/**
 * 单节点是否是一处裸出口；命中返回可检索的形态名。
 * 三种形态都与判据口径逐字对应（含 `exitCode = 2` 的裸标识符赋值），其余退出码不在这里判——
 * 那是判红（1）与正常收尾（0）的事。
 */
function rawExitOf(node) {
  if (node.type === "CallExpression") {
    const callee = node.callee;
    const [arg] = node.arguments ?? [];
    if (
      callee?.type === "MemberExpression" &&
      callee.object?.name === "process" &&
      memberName(callee) === "exit" &&
      arg?.type === "Literal" &&
      arg.value === 2
    ) {
      return "process.exit(2)";
    }
    return null;
  }
  if (node.type === "AssignmentExpression" && node.operator === "=") {
    const target = node.left?.type === "MemberExpression" ? memberName(node.left) : node.left?.name;
    if (target === "exitCode" && node.right?.type === "Literal" && node.right.value === 2) {
      return "exitCode = 2";
    }
  }
  return null;
}

/** 递归访问全部节点；loc / range 这类旁挂字段不进遍历，避免重复访问与环。 */
function walkAst(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walkAst(item, visit);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (typeof value.type === "string") visit(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
    if (child !== null && typeof child === "object") walkAst(child, visit);
  }
}

/** 扫描面内的全部源码文件（递归）；目录不可读由调用方 fail-closed。 */
function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(abs));
    else if (SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(abs);
  }
  return out;
}

/** 解析源码：JS 家族直解（行号即原行）；`.ts` 先剥类型，再把生成行映回原行的映射一并带回。 */
function parseSource(text, file, rel) {
  try {
    if (!file.endsWith(".ts")) return { ast: acorn.parse(text, PARSE_OPTIONS), map: null };
    const out = transformSync(text, {
      loader: "ts",
      format: "esm",
      sourcemap: true,
      sourcefile: file,
    });
    return { ast: acorn.parse(out.code, PARSE_OPTIONS), map: new SourceMap(JSON.parse(out.map)) };
  } catch (e) {
    failClosed(`${rel} 解析失败（${String(e.message).split("\n")[0]}）—— 判据无法覆盖该文件`);
  }
}

/** 该节点在原文件里的行号（1-based）；只有 `.ts` 需要经 sourcemap 校正。 */
function originalLineOf(node, map) {
  const generated = node.loc?.start;
  if (generated === undefined) return "?";
  if (map === null) return generated.line;
  const entry = map.findEntry(generated.line - 1, generated.column);
  return entry?.originalLine === undefined ? generated.line : entry.originalLine + 1;
}

/** 解析单个文件；读不到或解析不了都不算「无违规」，一律 fail-closed。 */
function hitsInFile(file, rel) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    failClosed(`读取 ${rel} 失败（${e.code ?? e.message}）—— 判据无法覆盖该文件`);
  }
  const { ast, map } = parseSource(text, file, rel);
  const hits = [];
  walkAst(ast, (node) => {
    const form = rawExitOf(node);
    if (form !== null) {
      hits.push(
        `${rel}:${originalLineOf(node, map)} 裸 ${form}（改为 ${GATE_EXIT_DISPLAY} 的 failClosed(why)）`,
      );
    }
  });
  return hits;
}

function main() {
  const root = argValue(process.argv, "--root", ROOT);
  const files = [];
  for (const dir of SCAN_DIRS) {
    try {
      files.push(...collectFiles(join(root, dir)));
    } catch (e) {
      failClosed(`扫描面 ${dir} 不可读（${e.code ?? e.message}）—— 判据无法证明「无裸出口」`);
    }
  }
  // 空面不判绿：提取口径坏掉时 files 会变空，那时「零命中」是假绿（本闸最不能有的失败方式）。
  if (files.length === 0) {
    failClosed(
      `扫描面为空（${SCAN_DIRS.join(", ")} 下无源码文件）—— 提取口径失效，不是「没有裸出口」`,
    );
  }
  const violations = [];
  for (const file of files) {
    violations.push(...hitsInFile(file, relative(root, file).split(sep).join("/")));
  }
  if (violations.length > 0) {
    console.error(
      `forbid-raw-exit2: 发现 ${violations.length} 处裸 exit 2（必须经 ${GATE_EXIT_DISPLAY} 的 failClosed()，判词才是可检索的单一形态）：`,
    );
    for (const v of violations) console.error(`  - ${v}`);
    console.error(`forbid-raw-exit2: FAIL（扫描 ${files.length} 文件）`);
    return 1;
  }
  console.log(
    `forbid-raw-exit2: OK（扫描 ${files.length} 文件，${SCAN_DIRS.join(" + ")} 无裸 exit 2）`,
  );
  return 0;
}

process.exit(main());
