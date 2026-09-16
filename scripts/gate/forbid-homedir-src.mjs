#!/usr/bin/env node
/**
 * B5 门禁（#517）：packages 各插件 src 禁直连 HOME 来源 API（AST 扫描，fail-closed）。
 *
 * 背景：DSH_HOME 语义收敛（#525 接缝 shared/dsh-home）后，插件 src 直连
 * `os.homedir()` / `process.env.HOME` / `untildify()` 会绕过 DSH_HOME 隔离语义，
 * 导致隔离验证（dsh-verify-isolated）与真实写面审计（B4）出现盲区。src 需要
 * home 路径时应走 `shared/dsh-home.js` 的 `dshHome()`。
 *
 * 本闸**没有豁免通道**（#765）：命中即违规。此前的双源豁免（台账登记 + 调用点
 * `// dsh-gate:allow-homedir` 注释）在本面收口到零豁免后，连同机制一起删除——留一个零命中的
 * 豁免入口，只会让下一处命中默认「先开豁免」而不是「先看接缝」。确有「DSH_HOME 域之外」的
 * 合法场景时，不要在闸内复活豁免常量或注释词法：那是「要不要重建豁免机制」的决策，先走 #765。
 *
 * 检测语义（AST 级，防 text 扫描绕过）：
 *   - `homedir()` / `import { homedir as hd }` 别名调用（来自 node:os / os）；
 *   - `os.homedir` / `os["homedir"]`（命名空间 import，含中括号混淆形态与值引用）；
 *   - `os.userInfo()`（homedir 的别名通道：`.homedir` 字段同为 HOME 来源）；
 *   - `process.env.HOME` / `process.env["HOME"]`；
 *   - `untildify(...)`（default import，含别名）；
 *   - 动态 import 命名空间形态：`const os = await import("node:os")` → `os.homedir()`
 *     （F3，含 `(await import("node:os")).homedir()` 直接形态）。
 * 已知局限（不为此增加复杂度，本仓无此形态）：named 解构
 * `const { homedir } = await import("node:os")`、`const { HOME } = process.env`
 * 解构形态、`const f = untildify` 值传递别名——出现即按正常流程补检测，不走豁免。
 * 遮蔽免疫依赖 esbuild transform 对遮蔽绑定的自动重命名（同名 import 的参数/
 * 局部 const 会被改为 homedir2/os2 等，名称级检测不误报）——由自测中
 * 遮蔽回归用例锁定，若 esbuild 升级改变此行为，自测会先行暴露（F4）。
 *
 * 扫描范围：由 `scripts/data/gate-scope-registry.json` 声明（本闸 scopeFrom = registry，当前为
 * packages 下各 dsh-* 包），脚本内不再自行枚举——范围是治理数据。扫描面为这些包 src 目录的
 * .ts/.tsx/.mts/.mjs（含未跟踪文件；
 * `.d.ts`/`.d.mts` 类型声明、`*.test.*` 跳过——§1 测试义务用 homedir 锁默认路径契约
 * 是合法的）。**`.tsx` 自 3.2.2 起纳入**：旧过滤漏掉它，而客户端入口基本都是 `.tsx`
 * （仓内 10 个），那是一处潜伏盲区（当前实测零命中，纳入即净收紧）。
 * fail-closed：任何文件解析失败直接判红。
 * 用法：node scripts/gate/forbid-homedir-src.mjs [--root <dir>] [--registry <file>]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transform } from "esbuild";
import * as acorn from "acorn";
import { SourceMap } from "node:module";
import { loadScopeRegistry, scopePackages } from "../lib/gate-scope-registry.ts";
import { argValue, collectSrcFiles, relPath } from "../lib/exemption-gate.ts";

const ROOT = join(import.meta.dirname, "../..");
const GATE_NAME = "forbid-homedir-src";
const REGISTRY_PATH = join(ROOT, "scripts", "data", "gate-scope-registry.json");

/** 具名 import 的归类：只有本闸关心的三个名字进集合。 */
function classifyNamedImport(imported, localName, isOs, isUntildify, acc) {
  if (isOs && imported === "homedir") acc.homedirNamed.add(localName);
  if (isOs && imported === "userInfo") acc.userInfoNamed.add(localName);
  if (isUntildify && imported === "untildify") acc.untildifyNamed.add(localName);
}

/** 单个 specifier 的绑定归类：命名空间 / 默认 / 具名三形态互斥，非本闸关注的形态直接跳过。 */
function classifySpecifier(spec, isOs, isUntildify, acc) {
  if (spec.type === "ImportNamespaceSpecifier" && isOs) {
    acc.osNamespaces.add(spec.local.name);
    return;
  }
  if (spec.type === "ImportDefaultSpecifier" && isUntildify) {
    acc.untildifyNamed.add(spec.local.name);
    return;
  }
  if (spec.type !== "ImportSpecifier") return;
  const imported = spec.imported.name ?? spec.imported.value;
  classifyNamedImport(imported, spec.local.name, isOs, isUntildify, acc);
}

/**
 * 从 estree AST 收集 HOME 来源 API 的本地绑定名。
 * 返回 { homedirNamed, userInfoNamed, untildifyNamed, osNamespaces }。
 */
function collectImports(ast) {
  const acc = {
    homedirNamed: new Set(),
    userInfoNamed: new Set(),
    untildifyNamed: new Set(),
    osNamespaces: new Set(),
  };
  for (const node of ast.body) {
    if (node.type !== "ImportDeclaration") continue;
    const src = node.source.value;
    const isOs = src === "node:os" || src === "os";
    const isUntildify = src === "untildify";
    if (!isOs && !isUntildify) continue;
    for (const spec of node.specifiers) classifySpecifier(spec, isOs, isUntildify, acc);
  }
  return acc;
}

/** 成员访问的静态属性名（`a.b` → "b"；`a["b"]` → "b"；动态 → null）。 */
function staticProp(member) {
  if (!member.computed) return member.property.name ?? null;
  if (member.property.type === "Literal" && typeof member.property.value === "string") {
    return member.property.value;
  }
  return null;
}

/** 深度优先遍历 estree 子节点；`visit` 为节点访问器。 */
function walkChildren(node, visit) {
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === "string") visit(c);
    } else if (child && typeof child.type === "string") {
      visit(child);
    }
  }
}

/** `import("x")` 调用形态的模块源（import 作为 callee），非此形态返回 null。 */
function dynamicImportCalleeSource(node) {
  if (node?.type !== "CallExpression" || node.callee?.type !== "Import") return null;
  return node.arguments[0]?.value ?? null;
}

/** 提取动态 import 的模块源（import("x") / await import("x")），非动态形态返回 null。 */
function dynSource(node) {
  let inner = node;
  if (inner?.type === "AwaitExpression") inner = inner.argument;
  if (inner?.type === "ImportExpression") return inner.source?.value ?? null;
  return dynamicImportCalleeSource(inner);
}

/**
 * 在单个 estree AST 上检测 HOME 来源 API 使用。
 * 返回 [{ generatedLine, generatedColumn, api }]（0-based 生成码坐标）。
 */
function detectInAst(ast) {
  const { homedirNamed, userInfoNamed, untildifyNamed, osNamespaces } = collectImports(ast);
  const dynOsNamespaces = new Set(); // F3：const os = await import("node:os") 动态绑定
  const hits = [];
  const push = (node, api) =>
    hits.push({
      generatedLine: node.loc.start.line - 1,
      generatedColumn: node.loc.start.column,
      api,
    });
  const bindDynamicOsNamespace = (node) => {
    if (node.type !== "VariableDeclarator") return;
    if (node.id.type !== "Identifier" || !node.init) return;
    const src = dynSource(node.init);
    if (src === "node:os" || src === "os") dynOsNamespaces.add(node.id.name);
  };
  // 动态 import 直接形态：os.homedir()（F3）
  const isDynamicImportMember = (node, prop) =>
    (prop === "homedir" || prop === "userInfo") && dynSource(node.object) !== null;
  // os.homedir / os["homedir"] / os.userInfo / os["userInfo"]（值引用与调用同罪）
  const isOsNamespaceMember = (node, prop) =>
    node.object.type === "Identifier" &&
    (prop === "homedir" || prop === "userInfo") &&
    (osNamespaces.has(node.object.name) || dynOsNamespaces.has(node.object.name));
  // process.env.HOME / process.env["HOME"]
  const isProcessEnvHome = (node, prop) =>
    prop === "HOME" &&
    node.object.type === "MemberExpression" &&
    staticProp(node.object) === "env" &&
    node.object.object.type === "Identifier" &&
    node.object.object.name === "process";
  // 三个形态互斥，故首个命中即唯一命中；下面的 callApi 同理
  const memberApi = (node) => {
    const prop = staticProp(node);
    if (isDynamicImportMember(node, prop)) return `os.${prop}`;
    if (isOsNamespaceMember(node, prop)) return `os.${prop}`;
    if (isProcessEnvHome(node, prop)) return "process.env.HOME";
    return null;
  };
  const callApi = (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return null;
    const name = node.callee.name;
    if (homedirNamed.has(name)) return `${name}()（node:os homedir 别名调用）`;
    if (userInfoNamed.has(name)) return `${name}()（node:os userInfo 别名调用）`;
    if (untildifyNamed.has(name)) return `${name}()（untildify 别名调用）`;
    return null;
  };
  (function walk(node) {
    if (!node || typeof node.type !== "string") return;
    bindDynamicOsNamespace(node);
    const api = node.type === "MemberExpression" ? memberApi(node) : callApi(node);
    if (api !== null) push(node, api);
    walkChildren(node, walk);
  })(ast);
  return hits;
}

/** 解析单个文件并检测，返回 [{ line, api, text }]（行号已映射回 TS 原文）。fail-closed：解析异常抛给调用方。 */
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
  if (rawHits.length === 0) return [];
  // 映射回 TS 原文行号（.mjs 本身即原文）
  const map = mapJson ? new SourceMap(JSON.parse(mapJson)) : null;
  return rawHits.map((h) => {
    let lineIdx = h.generatedLine;
    if (map) {
      const entry = map.findEntry(h.generatedLine, h.generatedColumn);
      if (entry?.originalLine !== undefined) lineIdx = entry.originalLine;
    }
    const text = (tsLines[lineIdx] ?? "").trim().slice(0, 90);
    return { line: lineIdx + 1, api: h.api, text };
  });
}

/** 解析扫描范围；范围失效即 fail-closed。 */
function resolvePackages(root, registryPath) {
  try {
    return scopePackages(root, loadScopeRegistry(registryPath), GATE_NAME);
  } catch (e) {
    console.error(`forbid-homedir-src: ${e.message} —— 扫描范围失效，fail-closed`);
    process.exit(1);
  }
}

/** 全量扫描：单个文件解析异常只记账，由调用方统一判红。 */
async function scanTargets(root, files) {
  const violations = [];
  const parseFailures = [];
  for (const file of files) {
    const rel = relPath(root, file);
    let hits;
    try {
      hits = await scanFile(file);
    } catch (e) {
      parseFailures.push(`${rel}: ${String(e.message).slice(0, 120)}`);
      continue;
    }
    for (const h of hits) violations.push(`${rel}:${h.line} [${h.api}] ${h.text}`);
  }
  return { violations, parseFailures };
}

/** 三段输出的先后顺序即 CI 日志里的可读顺序，与是否判红无关，故不随失败提前返回。 */
function reportFindings(violations, parseFailures, fileCount) {
  if (parseFailures.length > 0) {
    console.error("forbid-homedir-src: 解析失败（fail-closed，一律判红）：");
    for (const p of parseFailures) console.error(`  - ${p}`);
  }
  if (violations.length > 0) {
    console.error(
      `forbid-homedir-src: 发现 ${violations.length} 处 HOME 来源 API 直连（应走 shared/dsh-home 的 dshHome() 接缝）：`,
    );
    for (const v of violations) console.error(`  - ${v}`);
  }
  if (violations.length > 0 || parseFailures.length > 0) {
    console.error(
      `forbid-homedir-src: FAIL（扫描 ${fileCount} 文件，违规 ${violations.length} / 解析失败 ${parseFailures.length}）`,
    );
    return true;
  }
  console.log(`forbid-homedir-src: OK（扫描 ${fileCount} 文件，无 HOME 来源 API 直连）`);
  return false;
}

async function main() {
  const root = argValue(process.argv, "--root", ROOT);
  const registryPath = argValue(process.argv, "--registry", REGISTRY_PATH);

  const packages = resolvePackages(root, registryPath);
  const files = collectSrcFiles(root, packages);
  if (files.length === 0) {
    console.error("forbid-homedir-src: 未发现任何扫描目标（packages/*/src 空，fail-closed）");
    process.exit(1);
  }
  const { violations, parseFailures } = await scanTargets(root, files);
  if (reportFindings(violations, parseFailures, files.length)) process.exit(1);
}

main().catch((e) => {
  console.error(`forbid-homedir-src: 运行异常（fail-closed）：${e?.stack ?? e}`);
  process.exit(1);
});
