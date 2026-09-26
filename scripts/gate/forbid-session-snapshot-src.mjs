#!/usr/bin/env node
/**
 * forbid-session-snapshot-src — 会话快照面禁自建镜像 / 禁幻觉字段（#1028 防复发门禁）。
 *
 * 事故背景：DSH 0.1.7-rc.2 从客户端会话列表快照上删掉了 `current` 字段（官方
 * `SessionListState` 现为 `{ids, byId, phase, projectionsBySession}`，`ISessions` 也没有任何
 * 「当前会话」访问器；官方自己判定当前会话的口径是 `retainedBy.mainView > 0`）。本仓两处客户端
 * 仍读 `snapshot.current`，恒得 undefined，于是「跟随当前会话」整条链静默失配。
 * 一次字段删除能静默打穿本仓，说明缺的不是这次修复而是**判据**：镜像形状与幻觉字段此前都
 * 没有任何闸看着。
 *
 * 两条判据（判据面 = 登记范围内的 `packages/<pkg>/src/client/**`；宿主端不持有会话快照）：
 *
 *   A（判红，零误报优先）会话快照上的 `.current` 成员读取。
 *     判据是**派生关系**而不是名字：先找出「由快照读取口（`getSnapshot()`）派生」的值
 *     （含局部绑定的不动点传播），再在这些值上找 `.current` / `?.current` / `["current"]`。
 *     由此 React ref 一律不命中（`alive.current`、`settingsRef.current` 的接收者与快照无关），
 *     而历史三处（`const snapshot = list.getSnapshot(); snapshot?.current`、
 *     `ctx?.sessions?.list?.getSnapshot?.()?.current`）全部命中。
 *     为什么不用「同文件 import 了官方类型」当判据：那种写法加一行
 *     `import type { Context } from "@deepseek-ai/cordis"` 就能整体击穿，与镜像事实无因果关系。
 *
 *   B（warn，一轮校准后再议是否判红）本地 interface / type 的**成员名**与官方会话类型成员名
 *     交集 >= 2 且含语义敏感名时提示。判据同样落在派生关系上——**自建形状**（interface 体 /
 *     对象字面量别名）才判；`extends` / `Pick<>` / `typeof` 这类「从官方类型取成员」的写法不判。
 *     先 warn 是因为存量校准需要一份可比的清单，判红则等清单收敛后再切（切换是一次显式 diff）。
 *
 * 检测语义（纯 AST / 词法，无文本扫描）：A 腿走 esbuild 剥类型 + acorn AST（`.current` 与
 * `getSnapshot()` 都是运行期构造，剥类型不影响）；B 腿走 lib/ts-lex.ts 的词法流——interface /
 * type 声明会被 esbuild 整条擦除，只剩 AST 的判据对 B 恒零命中（同 lib/ts-lex.ts 文件头）。
 *
 * 扫描面：由 `scripts/data/gate-scope-registry.json` 声明（本闸 scopeFrom = registry），脚本内
 * 不硬编码包名——范围是治理数据，改范围应当是一次显式且可审的数据 diff。
 *
 * 豁免的单一事实源：`scripts/data/gate-exemptions.json`（只取 gate 等于本门禁名的条目），
 * 条目是**文件级**的；机制在 `scripts/lib/exemption-gate.ts`，本文件只提供扫描器与策略。
 * A 腿当前零豁免（存量已在 #1028 本轮清零），机制先挂着：日后确有合法例外时，登记是一次
 * 可审的 diff，而不是在闸内开一个隐式出口。
 *
 * fail-closed：范围/豁免机制失效、扫描面为空、源码不可判（词法化或 AST 解析失败）一律 exit 2
 * （门禁故障，不可信）；命中判词 exit 1；全绿 exit 0。
 * 用法：node scripts/gate/forbid-session-snapshot-src.mjs [--root <dir>] [--exemptions <file>] [--registry <file>]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SourceMap } from "node:module";
import { transformSync } from "esbuild";
import * as acorn from "acorn";
import { failClosed } from "../lib/gate-exit.mjs";
import { loadScopeRegistry, scopePackages } from "../lib/gate-scope-registry.ts";
import {
  argValue,
  collectSrcFiles,
  hasExemptionMarker,
  judgeHit,
  loadLedger,
  relPath,
  rotDetails,
} from "../lib/exemption-gate.ts";
import { scanSource } from "../lib/ts-lex.ts";

const ROOT = join(import.meta.dirname, "../..");
const GATE_NAME = "forbid-session-snapshot-src";
const LEDGER_DISPLAY = "scripts/data/gate-exemptions.json";
const EXEMPTIONS_PATH = join(ROOT, "scripts", "data", "gate-exemptions.json");
const REGISTRY_PATH = join(ROOT, "scripts", "data", "gate-scope-registry.json");

/** 判据面：会话快照只在客户端面（宿主端不读会话列表快照）。 */
const CLIENT_FACE = "/src/client/";
/** 快照读取口：uSES 观察源的取快照方法名（官方会话列表与仓内其它观察源同款）。 */
const SNAPSHOT_ACCESSOR = "getSnapshot";
/** rc.2 已从会话快照删除、本仓此前的自建字段。 */
const FORBIDDEN_MEMBER = "current";
/** 官方会话类型的成员名（SessionListState 四项 + SessionSummary 一族）。 */
const OFFICIAL_MEMBERS = new Set([
  "ids",
  "byId",
  "phase",
  "projectionsBySession",
  "retainedBy",
  "cwd",
  "blank",
  "title",
  "id",
  "running",
  "updatedAt",
  "origin",
  "parentId",
]);
/** 语义敏感名：与官方判据同源的那几个（当前会话 / 行表 / 阶段 / 保留者 / 工作区 / 空白 / 观察源动作）。 */
const SENSITIVE_MEMBERS = new Set([
  "current",
  "byId",
  "ids",
  "phase",
  "retainedBy",
  "cwd",
  "blank",
  "getSnapshot",
  "subscribe",
]);
/** 成员交集下限：低于它判据噪声大（同名成员在无关类型里太常见）。 */
const MIN_OFFICIAL_OVERLAP = 2;
/** interface / type 体的成员名位置：标识符后（可隔一个 `?`）跟这些记号之一。 */
const MEMBER_HEAD_PUNCT = new Set(["?", ":", "(", "<", ";", ",", "}", "="]);

/** 豁免策略：登记**必需**、调用点 marker 非必需（marker 写在被扫源码里，客户端源码不是可动面）。 */
const POLICY = {
  gate: GATE_NAME,
  mark: "dsh-gate:allow-session-snapshot",
  markerRequired: false,
  ledgerDisplay: LEDGER_DISPLAY,
};

const AST_SKIP_KEYS = new Set(["type", "start", "end", "loc", "range"]);

/** 是不是一个 AST 节点对象（数组与原始值不是）。 */
function isNode(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 子节点值（跳过 start/end/loc/range 等标量字段：遍历它们没有意义还拖慢全树）。 */
function childValues(node) {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (AST_SKIP_KEYS.has(key)) continue;
    out.push(value);
  }
  return out;
}

/** 节点树遍历（不引 acorn-walk：本闸只要几类节点，手写遍历比新依赖便宜）。 */
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isNode(node)) return;
  if (typeof node.type === "string") visit(node);
  for (const child of childValues(node)) walk(child, visit);
}

/** 节点里出现的全部标识符名（污点传播的过近似：属性键也算，代价是零漏、偶尔偏宽）。 */
function identifierNames(node, acc = new Set()) {
  walk(node, (n) => {
    if (n.type === "Identifier" && typeof n.name === "string") acc.add(n.name);
  });
  return acc;
}

/** 是否是 `X.getSnapshot(...)` / `getSnapshot(...)` 形态的调用（TS 的 `!` 被剥类型吃掉）。 */
function isSnapshotCall(node) {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee === null || callee === undefined) return false;
  if (callee.type === "Identifier") return callee.name === SNAPSHOT_ACCESSOR;
  const property = callee.property;
  return (
    (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") &&
    property !== null &&
    property !== undefined &&
    property.name === SNAPSHOT_ACCESSOR
  );
}

/** 子树里是否有快照读取口调用。 */
function containsSnapshotCall(node) {
  let found = false;
  walk(node, (n) => {
    if (isSnapshotCall(n)) found = true;
  });
  return found;
}

/** 表达式是否被污染：含快照读取口调用，或引用了已污染的名字，或挂在被污染对象上。 */
function isSnapshotDerived(node, tainted) {
  if (containsSnapshotCall(node)) return true;
  for (const name of identifierNames(node)) {
    if (tainted.has(name)) return true;
  }
  return false;
}

/** 作用域节点：污点传播的分界（与 currentMemberHits 遍历用的作用域集合同形）。 */
const SCOPE_NODES = new Set([
  "Program",
  "BlockStatement",
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/**
 * 作用域**自己**声明的变量（不下钻嵌套作用域）。
 * 这一步是「污点不跨作用域」的全部实现：若把嵌套函数体里的声明也算进外层，外层就会拿
 * 另一个函数里的同名局部变量当快照——那是可避免的误报来源。
 */
function ownDeclarators(scope) {
  const acc = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isNode(node)) return;
    if (node !== scope && SCOPE_NODES.has(node.type)) return;
    if (isDeclarator(node)) acc.push(node);
    for (const child of childValues(node)) visit(child);
  };
  visit(scope);
  return acc;
}

/** 变量声明节点（带绑定名的那种；解构声明的 id 不是 Identifier，不参与污点传播）。 */
function isDeclarator(node) {
  return node.type === "VariableDeclarator" && node.id !== null && node.id !== undefined;
}

/** 作用域内被污染的局部绑定名（不动点传播；上界取声明数 + 1，防病态自引用）。 */
function taintedNames(scope) {
  const tainted = new Set();
  const declarators = ownDeclarators(scope);
  for (let round = 0; round <= declarators.length; round += 1) {
    let changed = false;
    for (const decl of declarators) {
      const name = decl.id?.name;
      if (typeof name !== "string" || tainted.has(name) || decl.init === null) continue;
      if (isSnapshotDerived(decl.init, tainted)) {
        tainted.add(name);
        changed = true;
      }
    }
    if (!changed) return tainted;
  }
  return tainted;
}

/** 成员访问的成员名（`x.current` / `x?.current` / `x["current"]`）。 */
function memberNameOf(node) {
  const property = node.property;
  if (property === null || property === undefined) return null;
  if (node.computed === true) return typeof property.value === "string" ? property.value : null;
  return typeof property.name === "string" ? property.name : null;
}

const MEMBER_NODES = new Set(["MemberExpression", "OptionalMemberExpression"]);

/**
 * A 腿：会话快照上的 `.current` 读取点。
 * 逐个作用域（函数体 / 模块顶层）单独做污点传播——文件级按名字传播会把另一个函数里同名的
 * 局部变量也当成快照，那是可避免的误报来源。
 */
function currentMemberHits(ast) {
  const hits = new Map();
  const scopes = [];
  walk(ast, (n) => {
    if (n.type === "Program") scopes.push(ast);
    else if (n.type === "BlockStatement") scopes.push(n);
  });
  for (const scope of scopes) {
    const tainted = taintedNames(scope);
    walk(scope, (n) => {
      if (!MEMBER_NODES.has(n.type)) return;
      if (memberNameOf(n) !== FORBIDDEN_MEMBER) return;
      if (!isSnapshotDerived(n.object, tainted)) return;
      // 同一节点会被外层作用域再遍历一次（Program / 各层块），按位置去重：
      // 命中与否取决于「**任一**包含它的作用域」把接收者判成快照派生。
      const key = `${n.loc.start.line}:${n.loc.start.column}`;
      hits.set(key, { line: n.loc.start.line - 1, column: n.loc.start.column });
    });
  }
  return [...hits.values()];
}

const OPEN_BRACKETS = new Set(["(", "[", "{"]);
const CLOSE_BRACKETS = new Set([")", "]", "}"]);
/**
 * 声明头部允许出现的记号：泛型参数表与等号。**`extends` 刻意不在其中**——接口一旦
 * `extends`（含 `extends Pick<官方, …>`）就说明作者在接官方类型，属派生形态，不判镜像。
 */
const HEAD_PUNCT = new Set(["=", "<", ">", ","]);
/** 顶层声明语句的前置记号（排除 `const type = …` 这类把 type 当变量名的写法）。 */
const DECL_PREFIX = new Set(["export", "declare", ";", "}"]);

/**
 * interface / type 声明解析结果：`body` 是成员体左花括号的 token 下标；不是自建形状返回 null。
 *
 * 声明头是**扁平**记号序列（`Name` / 泛型参数表 / `extends …` / `=`），其中不会出现圆括号与
 * 方括号，所以不需要括号深度跟踪：扫到第一个 `{` 即成员体，扫到任何不在 HEAD_PUNCT 里的记号
 * （`extends` 走的就是这条）即判成「派生」返回 null。
 */
function readTypeDecl(tokens, at, kind) {
  const name = declName(tokens, at, kind);
  if (name === null) return null;
  for (let i = at + 2; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok.text === "{") {
      if (kind === "type" && tokens[i - 1]?.text !== "=") return null;
      return { kind, name, line: tokens[at + 1].line, body: i };
    }
    if (!HEAD_PUNCT.has(tok.text)) return null;
  }
  return null;
}

/** 声明名；`type` 还要求前置记号是声明关键字（排除 `const type = …` 这类写法）。 */
function declName(tokens, at, kind) {
  const name = tokens[at + 1];
  if (name === undefined || name.text === "{" || name.text === "=") return null;
  if (kind !== "type") return name.text;
  const prev = tokens[at - 1];
  if (prev === undefined || !(DECL_PREFIX.has(prev.text) || prev.lineStart)) return null;
  return name.text;
}

/** 顶层（深度 0）的 interface / type 声明：extends 与非对象字面量别名都在此处被判成「派生」。 */
function topLevelTypeDecls(tokens) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (OPEN_BRACKETS.has(tok.text)) depth += 1;
    else if (CLOSE_BRACKETS.has(tok.text)) depth -= 1;
    else if (depth === 0 && (tok.text === "interface" || tok.text === "type")) {
      const decl = readTypeDecl(tokens, i, tok.text);
      if (decl !== null) out.push(decl);
    }
  }
  return out;
}

/** 成员体（花括号内深度 1）里的成员名：标识符后跟成员起始记号。 */
function memberNames(tokens, openIndex) {
  const names = new Set();
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (OPEN_BRACKETS.has(tok.text)) {
      depth += 1;
      continue;
    }
    if (CLOSE_BRACKETS.has(tok.text)) {
      depth -= 1;
      if (depth === 0) return names;
      continue;
    }
    if (depth !== 1) continue;
    const next = tokens[i + 1];
    if (tok.label === "name" && next !== undefined && MEMBER_HEAD_PUNCT.has(next.text)) {
      names.add(tok.text);
    }
  }
  return names;
}

/**
 * B 腿判词：自建形状的本地类型，成员名与官方会话类型高度重合且含语义敏感名。
 * 派生形态（extends / Pick<> / typeof / 非对象字面量别名）已在上游被排除。
 */
function mirrorWarnings(decls, tokens) {
  const out = [];
  for (const decl of decls) {
    const names = [...memberNames(tokens, decl.body)];
    const official = names.filter((n) => OFFICIAL_MEMBERS.has(n));
    const sensitive = names.filter((n) => SENSITIVE_MEMBERS.has(n));
    if (official.length < MIN_OFFICIAL_OVERLAP || sensitive.length === 0) continue;
    out.push({
      line: decl.line,
      label: `${decl.kind} ${decl.name}`,
      official,
      sensitive,
    });
  }
  return out;
}

/** 单文件扫描：两条腿各取所需事实；任一步失败即抛给调用方 fail-closed。 */
function scanFile(file) {
  const content = readFileSync(file, "utf8");
  const loader = file.endsWith(".tsx") ? "tsx" : "ts";
  const built = transformSync(content, { loader, sourcemap: true, sourcefile: file });
  const ast = acorn.parse(built.code, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
  });
  const map = new SourceMap(JSON.parse(built.map));
  const tokens = scanSource(content).tokens;
  const lines = content.split("\n");
  const hits = currentMemberHits(ast).map((hit) => {
    const entry = map.findEntry(hit.line, hit.column);
    const line = (entry?.originalLine ?? hit.line - 1) + 1;
    return { line, text: (lines[line - 1] ?? "").trim().slice(0, 90) };
  });
  return { hits, mirrors: mirrorWarnings(topLevelTypeDecls(tokens), tokens) };
}

/** 解析扫描范围；范围/机制失效即 fail-closed（不得退化成零违规）。 */
function resolvePackages(root, registryPath) {
  try {
    return scopePackages(root, loadScopeRegistry(registryPath), GATE_NAME);
  } catch (e) {
    failClosed(`${GATE_NAME}: ${e.message} —— 范围机制失效`);
  }
}

function loadExemptionLedger(exemptionsPath) {
  try {
    return loadLedger(exemptionsPath, GATE_NAME);
  } catch (e) {
    failClosed(`${GATE_NAME}: ${e.message} —— 豁免机制失效`);
  }
}

/** 判据面内的文件（客户端面）；空面即 fail-closed（空面 = 判据失效，不是零违规）。 */
function resolveFiles(root, packages) {
  const all = collectSrcFiles(root, packages);
  const files = all.filter((file) => relPath(root, file).includes(CLIENT_FACE));
  if (files.length === 0) {
    failClosed(`${GATE_NAME}: 扫描面为空（${packages.join(", ")} 的 src/client 下没有可扫文件）`);
  }
  return files;
}

function collectFindings(root, files, ledger) {
  const buckets = { violations: [], badExemptions: [], legitExemptions: [], unreadable: [] };
  const mirrors = [];
  const hitFiles = new Set();
  for (const file of files) {
    const rel = relPath(root, file);
    let result;
    try {
      result = scanFile(file);
    } catch (e) {
      buckets.unreadable.push(`${rel}: ${String(e.message).slice(0, 140)}`);
      continue;
    }
    const lines = readFileSync(file, "utf8").split("\n");
    for (const hit of result.hits) {
      hitFiles.add(rel);
      const note = hasExemptionMarker(lines, hit.line - 1, POLICY.mark);
      const detail = `${rel}:${hit.line} [快照上的 .${FORBIDDEN_MEMBER}]`;
      const verdict = judgeHit(POLICY, ledger, rel, note, detail, hit.text);
      if (verdict.kind === "legit") buckets.legitExemptions.push(verdict.detail);
      else if (verdict.kind === "bad") buckets.badExemptions.push(verdict.detail);
      else buckets.violations.push(verdict.detail);
    }
    for (const mirror of result.mirrors) {
      mirrors.push(
        `${rel}:${mirror.line} [${mirror.label}] 官方成员 ${mirror.official.join(", ")} ` +
          `∩ 敏感成员 ${mirror.sensitive.join(", ")}`,
      );
    }
  }
  buckets.badExemptions.push(...rotDetails(POLICY, ledger, root, hitFiles));
  return { ...buckets, mirrors };
}

function printList(header, items) {
  console.error(header);
  for (const item of items) console.error(`  - ${item}`);
}

function reportClean(packages, fileCount, legitExemptions, mirrorCount) {
  const suffix = mirrorCount > 0 ? `；自建镜像 warn ${mirrorCount} 处（见上方 warn 行）` : "";
  if (legitExemptions.length > 0) {
    console.log(
      `${GATE_NAME}: OK（扫描 ${fileCount} 文件，包 ${packages.join(", ")}，登记豁免 ${legitExemptions.length} 处${suffix}）：`,
    );
    for (const l of legitExemptions) console.log(`  - ${l}`);
    return;
  }
  console.log(
    `${GATE_NAME}: OK（扫描 ${fileCount} 文件，包 ${packages.join(", ")} 快照面无 .${FORBIDDEN_MEMBER} 读取${suffix}）`,
  );
}

function reportFindings(findings, fileCount, packages) {
  const { violations, badExemptions, legitExemptions, unreadable, mirrors } = findings;
  for (const mirror of mirrors) console.warn(`warn ${GATE_NAME} | ${mirror}`);
  if (unreadable.length > 0) {
    // 源码不可判 = 门禁不可信（不是「改动不达标」）：按三态语义走 fail-closed，不得退化成放行。
    printList(`${GATE_NAME}: 源码不可判（门禁故障）：`, unreadable);
    failClosed(`${unreadable.length} 个扫描面文件无法判定（词法化 / AST 解析失败）`);
  }
  if (badExemptions.length > 0) {
    printList(`${GATE_NAME}: 存在豁免但不合法：`, badExemptions);
  }
  if (violations.length > 0) {
    printList(
      `${GATE_NAME}: 发现 ${violations.length} 处会话快照上的 .${FORBIDDEN_MEMBER} 读取（rc.2 已删除该字段；` +
        `官方判据是 retainedBy.mainView > 0，或在 ${LEDGER_DISPLAY} 登记文件级豁免）：`,
      violations,
    );
  }
  if (violations.length > 0 || badExemptions.length > 0 || unreadable.length > 0) {
    console.error(
      `${GATE_NAME}: FAIL（扫描 ${fileCount} 文件，违规 ${violations.length} / 非法豁免 ${badExemptions.length} / 不可判 ${unreadable.length}）`,
    );
    return 1;
  }
  reportClean(packages, fileCount, legitExemptions, mirrors.length);
  return 0;
}

function main() {
  const root = argValue(process.argv, "--root", ROOT);
  const exemptionsPath = argValue(process.argv, "--exemptions", EXEMPTIONS_PATH);
  const registryPath = argValue(process.argv, "--registry", REGISTRY_PATH);
  const packages = resolvePackages(root, registryPath);
  const ledger = loadExemptionLedger(exemptionsPath);
  const files = resolveFiles(root, packages);
  const findings = collectFindings(root, files, ledger);
  process.exit(reportFindings(findings, files.length, packages));
}

try {
  main();
} catch (e) {
  failClosed(`${GATE_NAME}: 运行异常 —— ${e?.stack ?? e}`);
}
