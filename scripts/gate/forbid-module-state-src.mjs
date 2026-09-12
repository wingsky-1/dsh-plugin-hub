#!/usr/bin/env node
/**
 * N2a 门禁（#733 M2c 后续）：packages/<pkg>/src 禁**模块级可变状态**。
 *
 * 背景（#733 宪法第 1 条）：状态必须收进闭包 / 实例（工厂返回值或类字段），模块级
 * `let`/`var` 让状态跨 apply()、跨实例共享——同一进程内两次挂载互相污染，且与
 * 「单刻快照 / 注入面」的域纪律相抵。实证缺陷：dsh-notifier 的
 * `src/server/system-notifier.ts` 曾用模块级 `let lastSystemOutcome` 透传节流窗口内的
 * 「上一次决议」，两个 SystemNotifier 实例因此共享该状态。
 *
 * 检测语义（AST 级，口径 = 行首顶格形态）：**Program 顶层的** `let` / `var` 声明
 * （含 `export let` / `export var` 形态）**且该声明在源码里顶格**（`/^(?:export\s+)?(let|var)\s/`）
 * 即命中。AST 负责排除字符串/注释中的伪形态；顶格条件就是本判据的口径（见下「盲区」）。
 * 函数体内的 `let`/`var` 是正常局部状态，不命中；`declare let` 是环境声明（无运行时状态），
 * 经 esbuild 剥类型后不产生声明节点，不命中。
 *
 * **盲区（如实登记，不判红但可观测）**：**缩进的**模块级声明不在判据面内——实测
 * `packages/dsh-notifier/src/client/index.tsx` 有 22 处缩进的模块级 `var`（历史形态，
 * 迁移自旧 IIFE 包装时保留了缩进）。它们是真的模块级可变状态，但：① 本判据的口径
 * 源自 #733 宪法（宿主端状态收进闭包/实例），客户端业务改动不在本轮范围；② 把它们纳入
 * 会让门禁在存量树上直接红 22 处。门禁每次运行都会打印该口径外计数（`口径外…` 行），
 * 使这个绕过口可观测；要纳入须另裁决（一次显式收紧 + 客户端整改）。
 *
 * 解析器与解析失败策略同 forbid-homedir-src.mjs：typescript 7 已移除经典 JS AST API，
 * 故用 esbuild（既有 devDep）剥类型 + acorn（既有 devDep）estree 解析 + node:module
 * SourceMap 行映射回 TS 原文行号。
 *
 * 扫描面（版本化常量，**按包限定**）：实测存量（顶格口径）notifier 1 / dsh-mcp-manager 1 /
 * dsh-lan-proxy 3 / dsh-provider-usage 18 / dsh-web-file-preview 0 —— 本判据源自 #733
 * 宪法且当前只对 dsh-notifier 生效；对其它包生效会一上来就红，且不在 #733 宪法范围内。
 * 扩包是一次显式改动（PACKAGES 常量 + 该包存量清零）。
 *
 * 豁免双源（缺一判红，三态输出）：
 *   1. 调用点紧邻注释：命中行行尾或上一行 `// dsh-gate:allow-module-state #NNN <理由>`；
 *   2. 本文件 WHITELIST 清单（文件级，版本化；初始为空）。
 *   三态：无命中（OK）/ 双源齐备豁免（OK，汇总输出）/ 违规或不合法豁免（FAIL）。
 *
 * fail-closed：任何文件解析失败直接判红。
 * 用法：node scripts/gate/forbid-module-state-src.mjs [--root <dir>]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { transform } from "esbuild";
import * as acorn from "acorn";
import { SourceMap } from "node:module";

const ROOT = join(import.meta.dirname, "../..");

/** 扫描面（版本化常量）：只扫这些包的 src。 */
const PACKAGES_V = 1;
const PACKAGES = ["dsh-notifier"];

/** 豁免清单（文件级，双源之二）。值 = 豁免理由（须含 issue 号）。 */
const WHITELIST_V = 1;
const WHITELIST = new Map([]);

const EXEMPT_MARK = "dsh-gate:allow-module-state";
const EXEMPT_RE = new RegExp(`\\s*${EXEMPT_MARK}\\s+([^\\n]*#\\d+[^\\n]*)`);

/** 判据口径：模块级声明必须**顶格**（含 `export let`/`export var` 形态）。 */
const TOP_LEVEL_FORM = /^(?:export\s+)?(?:let|var)\s/;

/**
 * 提取行内的「真实」行注释文本——跳过字符串字面量中的 `//`（纯文本正则会把
 * `const msg = "// dsh-gate:allow-module-state #999 伪造"` 误判为豁免标记）。
 * 行内无字符串外的 `//` 注释 → 返回 null。
 */
function lineCommentText(line) {
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < n) {
        if (line[i] === "\\") { i += 2; continue; }
        if (line[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") return line.slice(i + 2);
    i++;
  }
  return null;
}

/** 递归收集扫描面内全部 .ts/.tsx/.mts/.mjs（含未跟踪；跳过 .d.ts 与 test 文件）。 */
function collectSrcFiles(root) {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在：包命名约定下静默跳过，命中计数兜底
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.(ts|tsx|mts|mjs)$/.test(e.name) && !/\.d\.(ts|mts)$/.test(e.name) && !/\.test\./.test(e.name)) {
        hits.push(p);
      }
    }
  };
  for (const pkg of PACKAGES) walk(join(root, "packages", pkg, "src"));
  return hits;
}

/** 顶层 `let`/`var` 声明（含 export 包裹）→ [{ generatedLine, generatedColumn, kind, names }]。 */
function detectInAst(ast) {
  const hits = [];
  for (const node of ast.body) {
    let decl = node;
    if (node.type === "ExportNamedDeclaration" && node.declaration !== null && node.declaration !== undefined) {
      decl = node.declaration;
    }
    if (decl.type !== "VariableDeclaration" || (decl.kind !== "let" && decl.kind !== "var")) continue;
    const names = decl.declarations
      .map((d) => (d.id.type === "Identifier" ? d.id.name : d.id.type === "ObjectPattern" ? "{…}" : "[…]"))
      .join(", ");
    hits.push({ generatedLine: decl.loc.start.line - 1, generatedColumn: decl.loc.start.column, kind: decl.kind, names });
  }
  return hits;
}

/** 解析单个文件并检测。fail-closed：解析异常直接抛给调用方判红。 */
async function scanFile(file) {
  const content = readFileSync(file, "utf8");
  const tsLines = content.split("\n");
  const isMjs = file.endsWith(".mjs");
  let js = content;
  let mapJson = null;
  if (!isMjs) {
    const loader = file.endsWith(".tsx") ? "tsx" : "ts";
    const t = await transform(content, { loader, sourcemap: true, sourcefile: file });
    js = t.code;
    mapJson = t.map;
  }
  const ast = acorn.parse(js, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const rawHits = detectInAst(ast);
  if (rawHits.length === 0) return { hits: [], outOfScope: [], tsLines };
  const map = mapJson ? new SourceMap(JSON.parse(mapJson)) : null;
  const hits = [];
  const outOfScope = [];
  for (const h of rawHits) {
    let lineIdx = h.generatedLine;
    if (map) {
      const entry = map.findEntry(h.generatedLine, h.generatedColumn);
      if (entry?.originalLine !== undefined) lineIdx = entry.originalLine;
    }
    const raw = tsLines[lineIdx] ?? "";
    const record = { line: lineIdx + 1, kind: h.kind, names: h.names, text: raw.trim().slice(0, 90) };
    // 顶格条件即口径：缩进的模块级声明进「口径外」计数（可观测但不判红，见自述盲区）
    if (TOP_LEVEL_FORM.test(raw)) hits.push(record);
    else outOfScope.push(record);
  }
  return { hits, outOfScope, tsLines };
}

/** 命中行的豁免注释匹配：命中 TS 行行尾或上一行的**真实**注释含合法豁免标记。 */
function hasExemption(tsLines, lineIdx) {
  const near = [tsLines[lineIdx], tsLines[lineIdx - 1]].filter((l) => l !== undefined);
  for (const line of near) {
    const comment = lineCommentText(line);
    if (comment === null) continue;
    const m = comment.match(EXEMPT_RE);
    if (m) return m[1].trim();
  }
  return null;
}

async function main() {
  const argv = process.argv;
  const eq = argv.find((a) => a.startsWith("--root="));
  const spacedIdx = argv.indexOf("--root");
  const root = eq
    ? eq.slice("--root=".length)
    : spacedIdx !== -1
      ? argv[spacedIdx + 1]
      : ROOT;
  const files = collectSrcFiles(root);
  if (files.length === 0) {
    console.error(`forbid-module-state-src: 未发现任何扫描目标（${PACKAGES.join(", ")} 的 src 空，fail-closed）`);
    process.exit(1);
  }
  const violations = [];
  const badExemptions = [];
  const legitExemptions = [];
  const parseFailures = [];
  const outOfScopeByFile = new Map();
  const hitRels = new Set();
  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    let result;
    try {
      result = await scanFile(file);
    } catch (e) {
      parseFailures.push(`${rel}: ${String(e.message).slice(0, 120)}`);
      continue;
    }
    const { hits, outOfScope, tsLines } = result;
    if (outOfScope.length > 0) outOfScopeByFile.set(rel, outOfScope.length);
    if (hits.length > 0 && WHITELIST.has(rel)) hitRels.add(rel);
    const whitelisted = WHITELIST.has(rel);
    for (const h of hits) {
      const reason = hasExemption(tsLines, h.line - 1);
      const label = `模块级 ${h.kind}（${h.names}）`;
      if (reason && whitelisted) {
        legitExemptions.push(`${rel}:${h.line} [${label}] 豁免理由：${reason}`);
      } else if (reason && !whitelisted) {
        badExemptions.push(`${rel}:${h.line} [${label}] 有豁免注释但文件不在 WHITELIST（v${WHITELIST_V}）`);
      } else if (!reason && whitelisted) {
        violations.push(`${rel}:${h.line} [${label}] 在 WHITELIST 但该调用点缺紧邻豁免注释 ${EXEMPT_MARK}`);
      } else {
        violations.push(`${rel}:${h.line} [${label}] ${h.text}`);
      }
    }
  }
  // WHITELIST 反向校验（防清单腐烂）：磁盘上存在、且本次**确有命中**的文件才算「活的」
  // 豁免条目——文件不存在（--root fixture / 包已整体移除）不判腐烂。
  for (const k of WHITELIST.keys()) {
    const onDisk = existsSync(join(root, k));
    if (onDisk && !hitRels.has(k)) badExemptions.push(`${k}: WHITELIST 条目指向的文件本次零命中（已腐烂，应删除条目）`);
  }

  const fail = violations.length > 0 || badExemptions.length > 0 || parseFailures.length > 0;
  // 口径外计数（盲区可观测化）：缩进的模块级声明不判红，但每次运行都打印——静默的
  // 绕过口比已知的绕过口危险（自述里已登记该盲区与它的裁决边界）。
  if (outOfScopeByFile.size > 0) {
    const total = [...outOfScopeByFile.values()].reduce((a, b) => a + b, 0);
    console.log(`forbid-module-state-src: 口径外（缩进的模块级声明，不判红；见门禁自述「盲区」）：${total} 处`);
    for (const [f, n] of outOfScopeByFile) console.log(`  - ${f}: ${n} 处`);
  }
  if (parseFailures.length > 0) {
    console.error("forbid-module-state-src: 解析失败（fail-closed，一律判红）：");
    for (const p of parseFailures) console.error(`  - ${p}`);
  }
  if (badExemptions.length > 0) {
    console.error("forbid-module-state-src: 存在豁免但不合法（三态之 FAIL）：");
    for (const b of badExemptions) console.error(`  - ${b}`);
  }
  if (violations.length > 0) {
    console.error(`forbid-module-state-src: 发现 ${violations.length} 处模块级可变状态（应收进闭包/实例，或逐点豁免）：`);
    for (const v of violations) console.error(`  - ${v}`);
  }
  if (fail) {
    console.error(`forbid-module-state-src: FAIL（扫描 ${files.length} 文件，违规 ${violations.length} / 非法豁免 ${badExemptions.length} / 解析失败 ${parseFailures.length}）`);
    process.exit(1);
  }
  if (legitExemptions.length > 0) {
    console.log(`forbid-module-state-src: OK（扫描 ${files.length} 文件，合法豁免 ${legitExemptions.length} 处，WHITELIST v${WHITELIST_V}）：`);
    for (const l of legitExemptions) console.log(`  - ${l}`);
  } else {
    console.log(`forbid-module-state-src: OK（扫描 ${files.length} 文件，包 ${PACKAGES.join(", ")}（v${PACKAGES_V}）无模块级可变状态）`);
  }
}

main().catch((e) => {
  console.error(`forbid-module-state-src: 运行异常（fail-closed）：${e?.stack ?? e}`);
  process.exit(1);
});
