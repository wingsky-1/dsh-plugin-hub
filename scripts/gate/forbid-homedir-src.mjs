#!/usr/bin/env node
/**
 * B5 门禁（#517）：packages 各插件 src 禁直连 HOME 来源 API（AST 扫描，fail-closed）。
 *
 * 背景：DSH_HOME 语义收敛（#525 接缝 shared/dsh-home）后，插件 src 直连
 * `os.homedir()` / `process.env.HOME` / `untildify()` 会绕过 DSH_HOME 隔离语义，
 * 导致隔离验证（dsh-verify-isolated）与真实写面审计（B4）出现盲区。src 需要
 * home 路径时应走 `shared/dsh-home.js` 的 `dshHome()`；确属「DSH_HOME 域之外」
 * 的合法场景（外部工具凭据、用户输入 `~` 展开、展示层脱敏）须逐调用点豁免。
 *
 * 检测语义（AST 级，防 text 扫描绕过）：
 *   - `homedir()` / `import { homedir as hd }` 别名调用（来自 node:os / os）；
 *   - `os.homedir` / `os["homedir"]`（命名空间 import，含中括号混淆形态与值引用）；
 *   - `os.userInfo()`（homedir 的别名通道：`.homedir` 字段同为 HOME 来源）；
 *   - `process.env.HOME` / `process.env["HOME"]`；
 *   - `untildify(...)`（default import，含别名）；
 *   - 动态 import 命名空间形态：`const os = await import("node:os")` → `os.homedir()`
 *     （F3，含 `(await import("node:os")).homedir()` 直接形态）。
 * 已知局限（不为此增加复杂度，本仓无此形态；新增豁免机制兜底）：named 解构
 * `const { homedir } = await import("node:os")`、`const { HOME } = process.env`
 * 解构形态、`const f = untildify` 值传递别名。
 * 遮蔽免疫依赖 esbuild transform 对遮蔽绑定的自动重命名（同名 import 的参数/
 * 局部 const 会被改为 homedir2/os2 等，名称级检测不误报）——由自测中
 * 遮蔽回归用例锁定，若 esbuild 升级改变此行为，自测会先行暴露（F4）。
 *
 * 豁免双源（缺一判红，三态输出）：
 *   1. 调用点紧邻注释：命中行行尾或上一行 `// dsh-gate:allow-homedir <理由含 #NNN>`；
 *   2. 本文件 WHITELIST 清单（文件级，版本化）。
 *   三态：无命中（OK）/ 双源齐备豁免（OK，汇总输出）/ 违规或不合法豁免（FAIL）。
 *
 * 解析器：typescript 7 已移除经典 JS AST API（createSourceFile 等），故用
 * esbuild（既有 devDep）剥类型 + acorn（既有 devDep）estree 解析 + node:module
 * SourceMap 行映射回 TS 原文行号。豁免注释匹配 TS 原文（transform 会剥离注释）。
 *
 * 扫描范围：packages 下各 dsh-* 包 src 目录的 .ts/.mts/.mjs（含未跟踪文件；
 * .d.mts 类型声明、*.test.* 跳过——§1 测试义务用 homedir 锁默认路径契约是合法的）。
 * fail-closed：任何文件解析失败直接判红。
 * 用法：node scripts/gate/forbid-homedir-src.mjs [--root <dir>]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { transform } from "esbuild";
import * as acorn from "acorn";
import { SourceMap } from "node:module";

const ROOT = join(import.meta.dirname, "../..");

/** 豁免清单（文件级，双源之二）。值 = 豁免理由（须含 issue 号）。 */
const WHITELIST_V = 1;
const WHITELIST = new Map([
  // #525/#517：opencode 外部凭据路径——DSH_HOME 域之外的第三方工具自身写面
  ["packages/dsh-provider-usage/src/provider-config.ts", "#525 opencode 外部凭据"],
  // #517：展示层脱敏（诊断文本把 home 前缀折叠为 ~），不产生读写面
  ["packages/dsh-provider-usage/src/apply.ts", "#517 展示层脱敏"],
  // #87：用户输入 `~` 前缀展开（untildify 业界标准实现），目标由用户指定
  ["packages/dsh-provider-usage/src/path-resolve.ts", "#87 用户路径 ~ 展开"],
  ["packages/dsh-web-file-preview/src/git.ts", "#87 用户路径 ~ 展开"],
  ["packages/dsh-web-file-preview/src/routes.ts", "#87 用户路径 ~ 展开"],
]);

const EXEMPT_MARK = "dsh-gate:allow-homedir";
const EXEMPT_RE = new RegExp(`\\s*${EXEMPT_MARK}\\s+([^\\n]*#\\d+[^\\n]*)`);

/**
 * 提取行内的「真实」行注释文本——跳过字符串字面量中的 `//`（F1：纯文本正则
 * 会把 `const msg = "// dsh-gate:allow-homedir #999 伪造"` 误判为豁免标记，
 * 使白名单文件内“逐调用点”粒度失效）。轻量词法：跟踪单/双引号与反引号
 * （含转义；模板字符串内不做嵌套插值解析，本仓豁免注释行不依赖该场景）。
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
    if (ch === "/" && line[i + 1] === "/") {
      return line.slice(i + 2);
    }
    i++;
  }
  return null;
}

/** 递归收集各包 src 目录下全部 .ts/.mts/.mjs（含未跟踪；跳过 d.mts 与 test 文件）。 */
function collectSrcFiles(root) {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在：packages/*/src 命名约定下静默跳过，命中计数兜底
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.(ts|mts|mjs)$/.test(e.name) && !/\.d\.(ts|mts)$/.test(e.name) && !/\.test\./.test(e.name)) {
        hits.push(p);
      }
    }
  };
  const packagesDir = join(root, "packages");
  let pkgEntries;
  try {
    pkgEntries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    console.error(`forbid-homedir-src: 无法读取 ${packagesDir}（fail-closed）`);
    process.exit(1);
  }
  for (const e of pkgEntries) {
    if (e.isDirectory() && e.name.startsWith("dsh-")) walk(join(packagesDir, e.name, "src"));
  }
  return hits;
}

/**
 * 从 estree AST 收集 HOME 来源 API 的本地绑定名。
 * 返回 { homedirNamed, userInfoNamed, untildifyNamed, osNamespaces }。
 */
function collectImports(ast) {
  const homedirNamed = new Set();
  const userInfoNamed = new Set();
  const untildifyNamed = new Set();
  const osNamespaces = new Set();
  for (const node of ast.body) {
    if (node.type !== "ImportDeclaration") continue;
    const src = node.source.value;
    const isOs = src === "node:os" || src === "os";
    const isUntildify = src === "untildify";
    if (!isOs && !isUntildify) continue;
    for (const spec of node.specifiers) {
      if (spec.type === "ImportNamespaceSpecifier" && isOs) {
        osNamespaces.add(spec.local.name);
      } else if (spec.type === "ImportDefaultSpecifier" && isUntildify) {
        untildifyNamed.add(spec.local.name);
      } else if (spec.type === "ImportSpecifier") {
        const imported = spec.imported.name ?? spec.imported.value;
        if (isOs && imported === "homedir") homedirNamed.add(spec.local.name);
        if (isOs && imported === "userInfo") userInfoNamed.add(spec.local.name);
        if (isUntildify && imported === "untildify") untildifyNamed.add(spec.local.name);
      }
    }
  }
  return { homedirNamed, userInfoNamed, untildifyNamed, osNamespaces };
}

/** 成员访问的静态属性名（`a.b` → "b"；`a["b"]` → "b"；动态 → null）。 */
function staticProp(member) {
  if (!member.computed) return member.property.name ?? null;
  if (member.property.type === "Literal" && typeof member.property.value === "string") {
    return member.property.value;
  }
  return null;
}

/**
 * 在单个 estree AST 上检测 HOME 来源 API 使用。
 * 返回 [{ generatedLine, generatedColumn, api, text }]（0-based 生成码坐标）。
 */
function detectInAst(ast) {
  const { homedirNamed, userInfoNamed, untildifyNamed, osNamespaces } = collectImports(ast);
  const dynOsNamespaces = new Set(); // F3：const os = await import("node:os") 动态绑定
  const hits = [];
  const push = (node, api) => hits.push({ generatedLine: node.loc.start.line - 1, generatedColumn: node.loc.start.column, api, text: "" });
  /** 提取动态 import 的模块源（import("x") / await import("x")），非动态形态返回 null。 */
  const dynSource = (node) => {
    let inner = node;
    if (inner?.type === "AwaitExpression") inner = inner.argument;
    if (inner?.type === "ImportExpression") return inner.source?.value ?? null;
    if (inner?.type === "CallExpression" && inner.callee?.type === "Import") return inner.arguments[0]?.value ?? null;
    return null;
  };
  (function walk(node) {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) {
      const src = dynSource(node.init);
      if (src === "node:os" || src === "os") dynOsNamespaces.add(node.id.name);
    }
    if (node.type === "MemberExpression") {
      const prop = staticProp(node);
      // 动态 import 直接形态：os.homedir()（F3）
      const dynSrc = dynSource(node.object);
      if (dynSrc !== null && (prop === "homedir" || prop === "userInfo")) push(node, `os.${prop}`);
      // os.homedir / os["homedir"] / os.userInfo / os["userInfo"]（值引用与调用同罪）
      if (node.object.type === "Identifier" && (osNamespaces.has(node.object.name) || dynOsNamespaces.has(node.object.name)) && (prop === "homedir" || prop === "userInfo")) {
        push(node, `os.${prop}`);
      }
      // process.env.HOME / process.env["HOME"]
      if (
        prop === "HOME" &&
        node.object.type === "MemberExpression" &&
        staticProp(node.object) === "env" &&
        node.object.object.type === "Identifier" &&
        node.object.object.name === "process"
      ) {
        push(node, "process.env.HOME");
      }
    } else if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      const name = node.callee.name;
      if (homedirNamed.has(name)) push(node, `${name}()（node:os homedir 别名调用）`);
      else if (userInfoNamed.has(name)) push(node, `${name}()（node:os userInfo 别名调用）`);
      else if (untildifyNamed.has(name)) push(node, `${name}()（untildify 别名调用）`);
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c.type === "string") walk(c);
      } else if (child && typeof child.type === "string") {
        walk(child);
      }
    }
  })(ast);
  return hits;
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

/** 解析单个文件并检测。fail-closed：解析异常直接抛给调用方判红。 */
async function scanFile(file) {
  const content = readFileSync(file, "utf8");
  const tsLines = content.split("\n");
  const isMjs = file.endsWith(".mjs");
  // 单次 transform 同时取 code 与 sourcemap（sourcemap 仅在有命中时才解析）
  let js = content;
  let mapJson = null;
  if (!isMjs) {
    const t = await transform(content, { loader: "ts", sourcemap: true, sourcefile: file });
    js = t.code;
    mapJson = t.map;
  }
  const ast = acorn.parse(js, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const rawHits = detectInAst(ast);
  if (rawHits.length === 0) return { hits: [], tsLines };
  // 映射回 TS 原文行号（.mjs 本身即原文）
  const map = mapJson ? new SourceMap(JSON.parse(mapJson)) : null;
  const hits = rawHits.map((h) => {
    let lineIdx = h.generatedLine;
    if (map) {
      const entry = map.findEntry(h.generatedLine, h.generatedColumn);
      if (entry?.originalLine !== undefined) lineIdx = entry.originalLine;
    }
    const text = (tsLines[lineIdx] ?? "").trim().slice(0, 90);
    return { line: lineIdx + 1, api: h.api, text };
  });
  return { hits, tsLines };
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
    console.error("forbid-homedir-src: 未发现任何扫描目标（packages/*/src 空，fail-closed）");
    process.exit(1);
  }
  const violations = [];
  const badExemptions = [];
  const legitExemptions = [];
  const parseFailures = [];
  const hitRels = new Set(); // 本次确有命中的 WHITELIST 文件（F2：反向校验判定面）
  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    let result;
    try {
      result = await scanFile(file);
    } catch (e) {
      parseFailures.push(`${rel}: ${String(e.message).slice(0, 120)}`);
      continue;
    }
    const { hits, tsLines } = result;
    if (hits.length > 0 && WHITELIST.has(rel)) hitRels.add(rel);
    const whitelisted = WHITELIST.has(rel);
    for (const h of hits) {
      const reason = hasExemption(tsLines, h.line - 1);
      if (reason && whitelisted) {
        legitExemptions.push(`${rel}:${h.line} [${h.api}] 豁免理由：${reason}`);
      } else if (reason && !whitelisted) {
        badExemptions.push(`${rel}:${h.line} [${h.api}] 有豁免注释但文件不在 WHITELIST（v${WHITELIST_V}）`);
      } else if (!reason && whitelisted) {
        violations.push(`${rel}:${h.line} [${h.api}] 在 WHITELIST 但该调用点缺紧邻豁免注释 ${EXEMPT_MARK}`);
      } else {
        violations.push(`${rel}:${h.line} [${h.api}] ${h.text}`);
      }
    }
  }
  // WHITELIST 反向校验（防清单腐烂，F2）：磁盘上存在、且本次**确有命中**的文件
  // 才算「活的」豁免条目——文件不存在（--root fixture / 包已整体移除）不判腐烂；
  // 文件存在但本次零命中 = 条目已失效（豁免调用点已删/重构而清单未清），报非法豁免。
  for (const k of WHITELIST.keys()) {
    const onDisk = existsSync(join(root, k));
    if (onDisk && !hitRels.has(k)) badExemptions.push(`${k}: WHITELIST 条目指向的文件本次零命中（已腐烂，应删除条目）`);
  }

  const fail = violations.length > 0 || badExemptions.length > 0 || parseFailures.length > 0;
  if (parseFailures.length > 0) {
    console.error("forbid-homedir-src: 解析失败（fail-closed，一律判红）：");
    for (const p of parseFailures) console.error(`  - ${p}`);
  }
  if (badExemptions.length > 0) {
    console.error("forbid-homedir-src: 存在豁免但不合法（三态之 FAIL）：");
    for (const b of badExemptions) console.error(`  - ${b}`);
  }
  if (violations.length > 0) {
    console.error(`forbid-homedir-src: 发现 ${violations.length} 处 HOME 来源 API 直连（应走 shared/dsh-home 或逐点豁免）：`);
    for (const v of violations) console.error(`  - ${v}`);
  }
  if (fail) {
    console.error(`forbid-homedir-src: FAIL（扫描 ${files.length} 文件，违规 ${violations.length} / 非法豁免 ${badExemptions.length} / 解析失败 ${parseFailures.length}）`);
    process.exit(1);
  }
  if (legitExemptions.length > 0) {
    console.log(`forbid-homedir-src: OK（扫描 ${files.length} 文件，合法豁免 ${legitExemptions.length} 处，WHITELIST v${WHITELIST_V}）：`);
    for (const l of legitExemptions) console.log(`  - ${l}`);
  } else {
    console.log(`forbid-homedir-src: OK（扫描 ${files.length} 文件，无 HOME 来源 API 直连）`);
  }
}

main().catch((e) => {
  console.error(`forbid-homedir-src: 运行异常（fail-closed）：${e?.stack ?? e}`);
  process.exit(1);
});
