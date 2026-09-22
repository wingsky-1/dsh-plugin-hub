#!/usr/bin/env node
"use strict";

/**
 * config-matrix-lib — 配置平行事实源「字段覆盖矩阵」门禁的共享提取器与纯逻辑
 * （issue #471）。
 *
 * 背景：lan-proxy / notifier 的配置键存在多张平行维护表（schema / validators /
 * hints / normalize 分支 / 客户端渲染面），表间没有任何程序化同一性保证——
 * 新增配置键漏改一表即不一致。本模块从**源码 AST** 提取各表键集并做一致性
 * 断言（不 import 包 src、不依赖 lib/ 产物）。
 *
 * 提取管线（P1-1 裁决，弃纯正则）：
 *   1. esbuild.transformSync(src, { loader: 'ts' })（仓库既有 devDep）——TS →
 *     JS，实测会把带类型注解的 `export const Config: z<...> = z.object({...})`
 *     拆成「普通 const + 文件尾 export list」，因此收集器面向任意顶层
 *     VariableDeclaration（含 var/const/let，含 esbuild 提升后的模块级 var，
 *     客户端 apply 内的 var 在 transform 后亦提升到模块顶层）；
 *   2. acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'module' })（仓库
 *     既有 devDep，crap-check 同款）——AST 按 key.name 取键，
 *     对中文 \uXXXX 转义、模板串、z.object().default({...}) 嵌套一律免疫。
 *
 * 全部函数**文件路径 / 文本参数化**（不读仓库全局路径），保证负向自测可对
 * mkdtemp 副本注入并复用同一门禁逻辑（副本等效性：矩阵输入仅源文本，无
 * import 解析 / 无运行时）。
 *
 * 矩阵语义（对齐 issue #471 v2 方案，P1-2/P2 裁决）：
 *   - lan-proxy：Config / FILE_CONFIG_VALIDATORS / SETTING_FIELD_HINTS 三表
 *     全等（19 键，#911 加 tlsCaCertFile）；客户端 DEFAULTS ⊆ schema，差集 == 豁免白名单
 *     {host,targetHost,targetPort,wsDeflatePolicy}（每条豁免带原因注释，≤8）；
 *   - notifier：DEFAULT_CONFIG / SETTING_VALIDATORS / SETTING_HINTS 全等
 *     （19 键）；CONFIG_KEYS == DEFAULT_CONFIG 全部布尔键（10）；normalizeConfig
 *     分支目标键 ⊇ DEFAULT_CONFIG（CONFIG_KEYS ∪ 显式分支 ∪ M2 三键）；
 *     客户端 UI 引用键 ⊆ SETTING_VALIDATORS，反向差集 == 豁免白名单
 *     {allowKinds}；
 *   - 豁免白名单收敛三条件：服务端/组合层键或客户端不渲染键 + 单包 ≤8 + 每条
 *     带原因注释（缺失即红）。
 */
import { transformSync, type Loader } from "esbuild";
import * as acorn from "acorn";
import { readFileSync } from "node:fs";

/** esbuild transform + acorn parse（含 loc），返回 AST 程序节点。
 *  loader 缺省 'ts'；客户端源码为 .tsx 时传 'tsx'（esbuild 原生 JSX 编译为
 *  createElement 调用后再 parse——issue #584 阶段一基建缺口补齐：#597 只覆盖
 *  bundle-host/tsconfig 的 TSX 构建，未覆盖本门禁的源码 AST 解析面）。 */
export type AstNode = {
  type: string;
  body?: AstNode[];
  declarations?: AstNode[];
  declaration?: AstNode | null;
  id?: AstNode | null;
  init?: AstNode | null;
  expression?: AstNode | null;
  arguments?: AstNode[];
  properties?: AstNode[];
  elements?: (AstNode | null)[];
  key?: AstNode | null;
  value?: unknown;
  name?: string;
  operator?: string;
  left?: AstNode | null;
  right?: AstNode | null;
  object?: AstNode | null;
  property?: AstNode | null;
  callee?: AstNode | null;
  computed?: boolean;
} & Record<string, unknown>;
export interface AstProgram {
  body: AstNode[];
}
export function parseTs(text: string, loader: Loader = "ts"): AstProgram {
  const js = transformSync(text, { loader, format: "esm" }).code;
  return acorn.parse(js, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
  }) as unknown as AstProgram;
}

/** 从源码文本定位声明行号（1-based）：`[(export )](const|var|let) NAME` / `function NAME`。
 *  行首空白只允许空格/制表（\s 会跨行吞空行致行号错位）。 */
export function sourceLineOf(text: string, name: string): number | null {
  const re = new RegExp(
    `^[ \\t]*(?:export[ \\t]+)?(?:const|var|let)[ \\t]+${name}\\b|^[ \\t]*(?:export[ \\t]+)?(?:async[ \\t]+)?function[ \\t]+${name}\\b`,
    "m",
  );
  const m = text.match(re);
  if (!m) return null;
  let line = 1;
  for (let i = 0; i < m.index!; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/** 顶层 VariableDeclaration 中名为 name 的声明 init 节点（esbuild 提升后覆盖
 *  模块级 var——客户端 apply 内 var 亦在顶层）。 */
export function findTopVar(ast: AstProgram, name: string): AstNode | null {
  for (const n of ast.body) {
    if (n.type !== "VariableDeclaration") continue;
    for (const d of n.declarations ?? []) {
      const id = d.id;
      if (id?.type === "Identifier" && id.name === name) return d.init ?? null;
    }
  }
  return null;
}

function isFnDeclarationNamed(n: AstNode, name: string): boolean {
  return n.type === "FunctionDeclaration" && n.id?.name === name;
}

function fnInitInVarDecl(n: AstNode, name: string): AstNode | null {
  for (const d of n.declarations ?? []) {
    const id = d.id;
    const init = d.init;
    if (
      id?.type === "Identifier" &&
      id.name === name &&
      (init?.type === "FunctionExpression" || init?.type === "ArrowFunctionExpression")
    )
      return init;
  }
  return null;
}

function exportedFnDecl(n: AstNode, name: string): AstNode | null {
  const d = n.declaration;
  if (d?.type === "FunctionDeclaration" && d.id?.name === name) return d;
  return null;
}

function findFnNodeInBodyItem(n: AstNode, name: string): AstNode | null {
  if (isFnDeclarationNamed(n, name)) return n;
  if (n.type === "VariableDeclaration") return fnInitInVarDecl(n, name);
  if (n.type === "ExportNamedDeclaration" && n.declaration) return exportedFnDecl(n, name);
  return null;
}

/** 顶层名为 name 的函数节点（FunctionDeclaration / var fn = function / export fn）。 */
export function findTopFn(ast: AstProgram, name: string): AstNode | null {
  for (const n of ast.body) {
    const fn = findFnNodeInBodyItem(n, name);
    if (fn) return fn;
  }
  return null;
}

/** 单步剥壳：CallExpression 下钻第一实参 / TSAs / TSSatisfies / TypeCast / Paren。 */
function peelWrappingNode(node: AstNode): AstNode | null {
  if (node.type === "ParenthesizedExpression") return node.expression!;
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TypeCastExpression"
  ) {
    return node.expression!;
  }
  if (node.type === "CallExpression") return node.arguments?.[0] ?? null;
  return null;
}

/** 反复剥壳后取对象字面量节点；剥不到返回 null。
 *  迭代上界防病态包装链（自引用 AST）把下钻拖成死循环。 */
function unwrapObjectLiteral(node: AstNode | null): AstNode | null {
  let cur = node;
  for (let i = 0; i < 12; i += 1) {
    if (!cur) return null;
    if (cur.type === "ObjectExpression") return cur;
    const next = peelWrappingNode(cur);
    if (next === null) return null;
    cur = next;
  }
  if (cur?.type !== "ObjectExpression") return null;
  return cur;
}

function propertyKeyName(p: AstNode): string | null {
  return p.key?.type === "Identifier"
    ? p.key.name!
    : p.key?.type === "Literal"
      ? String((p.key as AstNode).value)
      : null;
}

function booleanPropertyValue(p: AstNode): boolean | null {
  const v = p.value as AstNode | null | undefined;
  return v?.type === "Literal" && typeof v.value === "boolean" ? (v.value as boolean) : null;
}

/** 递归剥壳（CallExpression 下钻第一实参 / TSAs / TSSatisfies / Paren）后取对象
 *  字面量键（保序，去重）。z.object({...})、z.record(...)、as const 包装均免疫。 */
export function objectKeysOf(node: AstNode | null): string[] {
  const obj = unwrapObjectLiteral(node);
  if (obj === null) return [];
  const out: string[] = [];
  for (const p of obj.properties!) {
    if (p.type !== "Property") continue;
    const k = propertyKeyName(p);
    if (k !== null && !out.includes(k)) out.push(k);
  }
  return out;
}

/** 一维字符串数组字面量键（CONFIG_KEYS 形态：readonly string[] + as const）。 */
export function arrayStringKeys(node: AstNode | null | undefined): string[] {
  if (node?.type !== "ArrayExpression") return [];
  const out: string[] = [];
  for (const e of node.elements!) {
    if (e?.type === "Literal" && typeof e.value === "string") out.push(e.value as string);
  }
  return out;
}

/** 二维字符串数组首列键（notifier 客户端 EVENT_KEYS：[["notifyAsk","evtAsk"],…]）。 */
export function arrayFirstColKeys(node: AstNode | null | undefined): string[] {
  if (node?.type !== "ArrayExpression") return [];
  const out: string[] = [];
  for (const e of node.elements!) {
    if (
      e?.type === "ArrayExpression" &&
      e.elements![0]?.type === "Literal" &&
      typeof e.elements![0]!.value === "string"
    ) {
      out.push(e.elements![0]!.value as string);
    }
  }
  return out;
}

/** 便捷入口：按 shape 提取名为 name 的顶层声明键集（'object' | 'arrayStrings' |
 *  'arrayFirstCol'）。文件缺失/声明缺失返回 { found:false } 而非抛错——门禁侧
 *  fail-loud 报「声明缺失」。 */
export function extractNamedKeys(
  text: string,
  name: string,
  shape: string = "object",
): { found: boolean; keys: string[] } {
  const ast = parseTs(text);
  const init = findTopVar(ast, name);
  if (init === null) return { found: false, keys: [] };
  if (shape === "object") return { found: true, keys: objectKeysOf(init) };
  if (shape === "arrayStrings") return { found: true, keys: arrayStringKeys(init) };
  if (shape === "arrayFirstCol") return { found: true, keys: arrayFirstColKeys(init) };
  return { found: false, keys: [] };
}

/**
 * normalizeConfig 分支目标键收集（P1-1 第 3 条：不收集全函数任意字符串，防
 * object/boolean/string 等类型串误报）。目标键 = 函数体内对局部源对象
 * （src / base / qh / out）的 MemberExpression 成员键 ∪ `=== "字面量"` 判定键
 * （透传排除表）。CONFIG_KEYS 经 for..of 遍历属运行时索引，静态不可见——由
 * 调用方另行并入 CONFIG_KEYS 键集（本模块返回结构含 bases 供矩阵侧组合）。
 */
function collectSourceMemberKey(n: AstNode, members: Map<string, Set<string>>): void {
  if (
    n.type === "MemberExpression" &&
    !n.computed &&
    n.property?.type === "Identifier" &&
    n.object?.type === "Identifier" &&
    ["src", "base", "qh", "out"].includes(n.object.name!)
  ) {
    if (!members.has(n.object.name!)) members.set(n.object.name!, new Set<string>());
    members.get(n.object.name!)!.add(n.property.name!);
  }
}

function collectExclusionLiteralKey(n: AstNode, eqLiterals: Set<string>): void {
  if (n.type === "BinaryExpression" && n.operator === "===") {
    // typeof X === "object"/"boolean"/"string" 的类型串判定不属于「配置键排除表」——
    // 排除表形态是 key === "配置键名"（Identifier 与 Literal 比较）
    const isTypeofSide = (s: AstNode | null | undefined): boolean =>
      s?.type === "UnaryExpression" && s.operator === "typeof";
    if (!isTypeofSide(n.left) && !isTypeofSide(n.right)) {
      for (const side of [n.left, n.right]) {
        if (side?.type === "Literal" && typeof side.value === "string")
          eqLiterals.add(side.value as string);
      }
    }
  }
}

function isAstPositionKey(key: string): boolean {
  return key === "loc" || key === "start" || key === "end" || key === "range";
}

function forEachChildNode(n: AstNode, visit: (c: AstNode) => void): void {
  for (const k of Object.keys(n)) {
    if (isAstPositionKey(k)) continue;
    const v: unknown = n[k];
    if (Array.isArray(v)) {
      for (const c of v) visit(c as AstNode);
    } else if (v && typeof (v as AstNode).type === "string") visit(v as AstNode);
  }
}

function walkNormalizeBranchNode(
  n: AstNode | null | undefined,
  members: Map<string, Set<string>>,
  eqLiterals: Set<string>,
): void {
  if (!n || typeof n.type !== "string") return;
  collectSourceMemberKey(n, members);
  collectExclusionLiteralKey(n, eqLiterals);
  forEachChildNode(n, (c) => walkNormalizeBranchNode(c, members, eqLiterals));
}

export function collectNormalizeBranchKeys(fnNode: AstNode): {
  union: string[];
  members: Record<string, string[]>;
  eqLiterals: string[];
} {
  const members = new Map<string, Set<string>>(); // 基名 → Set(键)
  const eqLiterals = new Set<string>();
  walkNormalizeBranchNode(fnNode, members, eqLiterals);
  const union = new Set<string>();
  for (const set of members.values()) for (const k of set) union.add(k);
  for (const k of eqLiterals) union.add(k);
  return {
    union: [...union],
    members: Object.fromEntries([...members.entries()].map(([k, s]) => [k, [...s]])),
    eqLiterals: [...eqLiterals],
  };
}

function addPatchObjectKeys(properties: AstNode[], keys: Set<string>): void {
  for (const p of properties) {
    if (p.key?.type === "Identifier") keys.add(p.key.name!);
  }
}

function addSwitchControlKey(callee: string, n: AstNode, keys: Set<string>): void {
  if (
    callee === "switchControl" &&
    n.arguments![0]?.type === "Literal" &&
    typeof n.arguments![0]!.value === "string"
  ) {
    keys.add(n.arguments![0]!.value as string);
  }
}

function collectCallExpressionKeys(n: AstNode, keys: Set<string>): void {
  if (n.type === "CallExpression" && n.callee?.type === "Identifier") {
    const callee = n.callee.name!;
    addSwitchControlKey(callee, n, keys);
    if (callee === "patch" && n.arguments![0]?.type === "ObjectExpression") {
      addPatchObjectKeys(n.arguments![0]!.properties!, keys);
    }
  }
}

function addSettingsMemberKey(n: AstNode, keys: Set<string>): void {
  if (
    n.type === "MemberExpression" &&
    n.object?.type === "Identifier" &&
    n.object.name === "settings" &&
    !n.computed &&
    n.property?.type === "Identifier"
  ) {
    keys.add(n.property.name!);
  }
}

function walkClientUiNode(n: AstNode | null | undefined, keys: Set<string>): void {
  if (!n || typeof n.type !== "string") return;
  collectCallExpressionKeys(n, keys);
  addSettingsMemberKey(n, keys);
  forEachChildNode(n, (c) => walkClientUiNode(c, keys));
}

function addEventKeysFromDecl(n: AstNode, keys: Set<string>): void {
  for (const d of n.declarations!) {
    if (d.id?.type === "Identifier" && d.id.name === "EVENT_KEYS") {
      for (const k of arrayFirstColKeys(d.init ?? null)) keys.add(k);
    }
  }
}

/**
 * 客户端 UI 引用键收集（notifier 形态；lan-proxy 由 DEFAULTS 单表承载不适用）：
 *  = 顶层 EVENT_KEYS 二维数组首列（事件开关渲染）
 *  ∪ switchControl("…") 调用参数字符串（顶层设置键的行为参数）
 *  ∪ patch({…}) 字面量对象键（顶层配置键增量提交；chPatch 为频道子键，
 *    刻意不收——与 SETTING_VALIDATORS 顶层键不同面）
 *  ∪ settings.<静态键> MemberExpression（渲染/读取面）。
 * 覆盖全模块（esbuild 提升后 var 已顶层；函数内 var settings 仍可被遍历到——
 *  全树扫描不依赖作用域分析，收集的是「键引用面」而非绑定语义）。
 *
 * 内置频道卡不再贡献键面：它们的开关与声音住在 `channels` 的两条内置条目里，卡片按条目渲染
 * （`builtinCard(index, ch, label)` 的实参是下标与对象，没有配置键字面量可收）。
 */
export function collectClientUiKeys(ast: AstProgram): string[] {
  const keys = new Set<string>();
  for (const n of ast.body) {
    // 顶层 EVENT_KEYS 二维首列
    if (n.type === "VariableDeclaration") {
      addEventKeysFromDecl(n, keys);
    }
  }
  walkClientUiNode(ast as unknown as AstNode, keys);
  return [...keys];
}

/** 矩阵行级差异（保序、可读）：缺键（base 有、table 无）与多键（table 有、
 *  base 无）。 */
export function diffKeys(base: string[], table: string[]): { missing: string[]; extra: string[] } {
  const b = new Set<string>(base);
  const t = new Set<string>(table);
  return {
    missing: [...b].filter((k: string) => !t.has(k)),
    extra: [...t].filter((k: string) => !b.has(k)),
  };
}

/**
 * 读文件并提取表键（容错：文件缺失/声明缺失不抛——返回 err 由调用方报红）。
 * @returns {{ err?: string, keys?: string[], line?: number|null }}
 */
export function readTableKeys(
  filePath: string,
  name: string,
  shape: string = "object",
  label: string = name,
): { err?: string; keys?: string[]; line?: number | null } {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return { err: `文件不可读: ${filePath}` };
  }
  const line = sourceLineOf(text, name);
  const { found, keys } = extractNamedKeys(text, name, shape);
  if (!found) {
    return {
      err: `${label} 声明缺失（找不到顶层声明 ${name}，文件 ${filePath}${line ? `:${line}` : ""}）`,
    };
  }
  if (keys.length === 0) {
    return { err: `${label} 键集为空（提取器可能失效或表被掏空，文件 ${filePath}:${line}）` };
  }
  return { keys, line };
}

/** 从 DEFAULT_CONFIG 对象值推断「布尔键」：值字面量为 true/false 的键。 */
export function booleanKeysOfObject(initNode: AstNode | null): string[] {
  const obj = unwrapObjectLiteral(initNode);
  if (obj === null) return [];
  const out: string[] = [];
  for (const p of obj.properties!) {
    if (p.type !== "Property") continue;
    const val = booleanPropertyValue(p);
    if (val === null) continue;
    const k = propertyKeyName(p);
    if (k !== null) out.push(k);
  }
  return out;
}

/** 截取「## 配置」节正文行（到下一个二级/三级标题止）；无该节返回 null。 */
function lanProxyConfigSection(text: string): string[] | null {
  // 逐行截「## 配置」节（到下一个二级/三级标题止），避免 JS 正则无 \Z 的坑
  const lines: string[] = text.split("\n");
  const start = lines.findIndex((l) => /^## 配置[ \t]*$/.test(l));
  if (start === -1) return null;
  const secLines: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{2,3}[ \t]/.test(lines[i])) break;
    secLines.push(lines[i]);
  }
  return secLines;
}

function tableRowKeys(line: string, keys: string[]): void {
  // 取表格行首列（第一个 | 与第二个 | 之间），支持合并键 `a` / `b`
  const tm = line.match(/^\|\s*([^|]+?)\s*\|/);
  if (!tm) return;
  for (const span of tm[1].matchAll(/`([^`]+)`/g)) {
    for (const part of span[1].split("/")) {
      const k = part.trim();
      if (/^[a-z][A-Za-z0-9]*$/.test(k) && !keys.includes(k)) keys.push(k);
    }
  }
}

function lanProxyReadmeKeys(text: string): { keys: string[]; section: string | null } {
  const secLines = lanProxyConfigSection(text);
  if (secLines === null) return { keys: [], section: null };
  const keys: string[] = [];
  for (const line of secLines) tableRowKeys(line, keys);
  return { keys, section: "## 配置" };
}

function notifierReadmeKeys(text: string): { keys: string[]; section: string | null } {
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  if (!m) return { keys: [], section: "```json" };
  const keys: string[] = [];
  for (const line of m[1].split("\n")) {
    const km = line.match(/^\s*"([a-z][A-Za-z0-9]*)":/);
    if (km && !keys.includes(km[1])) keys.push(km[1]);
  }
  return { keys, section: "```json" };
}

/**
 * README 配置节键提取（量级 #12：键集一致性仅 warn 不判红）。包形态不同：
 *   - lan-proxy：markdown 表格（`## 配置` 节），行首 `` | `key` | `` 或
 *     `` | `a` / `b` | ``（斜杠合并多键）；
 *   - notifier：首个 ```json 样例块顶层键。
 * 只取「代码表键形态」（camelCase token），防 GET/api/true 等非键 token 误收。
 * @returns { keys: string[], section: string|null } section=定位到的节（诊断用）。
 */
export function extractReadmeConfigKeys(
  text: string,
  pkg: string,
): { keys: string[]; section: string | null } {
  if (pkg === "lan-proxy") return lanProxyReadmeKeys(text);
  if (pkg === "notifier") return notifierReadmeKeys(text);
  return { keys: [], section: null };
}
