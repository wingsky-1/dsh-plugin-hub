#!/usr/bin/env node
// @ts-nocheck
'use strict'

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
 *     既有 devDep，self-cov / crap-check 同款）——AST 按 key.name 取键，
 *     对中文 \uXXXX 转义、模板串、z.object().default({...}) 嵌套一律免疫。
 *
 * 全部函数**文件路径 / 文本参数化**（不读仓库全局路径），保证负向自测可对
 * mkdtemp 副本注入并复用同一门禁逻辑（副本等效性：矩阵输入仅源文本，无
 * import 解析 / 无运行时）。
 *
 * 矩阵语义（对齐 issue #471 v2 方案，P1-2/P2 裁决）：
 *   - lan-proxy：Config / FILE_CONFIG_VALIDATORS / SETTING_FIELD_HINTS 三表
 *     全等（16 键）；客户端 DEFAULTS ⊆ schema，差集 == 豁免白名单
 *     {host,targetHost,targetPort,wsDeflatePolicy}（每条豁免带原因注释，≤8）；
 *   - notifier：DEFAULT_CONFIG / SETTING_VALIDATORS / SETTING_HINTS 全等
 *     （19 键）；CONFIG_KEYS == DEFAULT_CONFIG 全部布尔键（10）；normalizeConfig
 *     分支目标键 ⊇ DEFAULT_CONFIG（CONFIG_KEYS ∪ 显式分支 ∪ M2 三键）；
 *     客户端 UI 引用键 ⊆ SETTING_VALIDATORS，反向差集 == 豁免白名单
 *     {allowKinds}；
 *   - 豁免白名单收敛三条件：服务端/组合层键或客户端不渲染键 + 单包 ≤8 + 每条
 *     带原因注释（缺失即红）。
 */
import { transformSync } from 'esbuild'
import * as acorn from 'acorn'
import { readFileSync } from 'node:fs'

/** esbuild transform + acorn parse（含 loc），返回 AST 程序节点。 */
export function parseTs(text) {
  const js = transformSync(text, { loader: 'ts', format: 'esm' }).code
  return acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
}

/** 从源码文本定位声明行号（1-based）：`[(export )](const|var|let) NAME` / `function NAME`。
 *  行首空白只允许空格/制表（\s 会跨行吞空行致行号错位）。 */
export function sourceLineOf(text, name) {
  const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:const|var|let)[ \\t]+${name}\\b|^[ \\t]*(?:export[ \\t]+)?(?:async[ \\t]+)?function[ \\t]+${name}\\b`, 'm')
  const m = text.match(re)
  if (!m) return null
  let line = 1
  for (let i = 0; i < m.index; i += 1) if (text[i] === '\n') line += 1
  return line
}

/** 顶层 VariableDeclaration 中名为 name 的声明 init 节点（esbuild 提升后覆盖
 *  模块级 var——客户端 apply 内 var 亦在顶层）。 */
export function findTopVar(ast, name) {
  for (const n of ast.body) {
    if (n.type !== 'VariableDeclaration') continue
    for (const d of n.declarations) {
      if (d.id?.type === 'Identifier' && d.id.name === name) return d.init ?? null
    }
  }
  return null
}

/** 顶层名为 name 的函数节点（FunctionDeclaration / var fn = function / export fn）。 */
export function findTopFn(ast, name) {
  for (const n of ast.body) {
    if (n.type === 'FunctionDeclaration' && n.id?.name === name) return n
    if (n.type === 'VariableDeclaration') {
      for (const d of n.declarations) {
        if (d.id?.type === 'Identifier' && d.id.name === name
          && (d.init?.type === 'FunctionExpression' || d.init?.type === 'ArrowFunctionExpression')) return d.init
      }
    }
    if (n.type === 'ExportNamedDeclaration' && n.declaration) {
      const d = n.declaration
      if (d.type === 'FunctionDeclaration' && d.id?.name === name) return d
    }
  }
  return null
}

/** 递归剥壳（CallExpression 下钻第一实参 / TSAs / TSSatisfies / Paren）后取对象
 *  字面量键（保序，去重）。z.object({...})、z.record(...)、as const 包装均免疫。 */
export function objectKeysOf(node) {
  let cur = node
  for (let i = 0; i < 12; i += 1) {
    if (!cur) return []
    if (cur.type === 'ObjectExpression') break
    if (cur.type === 'ParenthesizedExpression') { cur = cur.expression; continue }
    if (cur.type === 'TSAsExpression' || cur.type === 'TSSatisfiesExpression' || cur.type === 'TypeCastExpression') { cur = cur.expression; continue }
    if (cur.type === 'CallExpression') { cur = cur.arguments?.[0] ?? null; continue }
    return []
  }
  if (cur?.type !== 'ObjectExpression') return []
  const out = []
  for (const p of cur.properties) {
    if (p.type !== 'Property') continue
    const k = p.key?.type === 'Identifier' ? p.key.name : p.key?.type === 'Literal' ? String(p.key.value) : null
    if (k !== null && !out.includes(k)) out.push(k)
  }
  return out
}

/** 一维字符串数组字面量键（CONFIG_KEYS 形态：readonly string[] + as const）。 */
export function arrayStringKeys(node) {
  if (node?.type !== 'ArrayExpression') return []
  const out = []
  for (const e of node.elements) {
    if (e?.type === 'Literal' && typeof e.value === 'string') out.push(e.value)
  }
  return out
}

/** 二维字符串数组首列键（notifier 客户端 EVENT_KEYS：[["notifyAsk","evtAsk"],…]）。 */
export function arrayFirstColKeys(node) {
  if (node?.type !== 'ArrayExpression') return []
  const out = []
  for (const e of node.elements) {
    if (e?.type === 'ArrayExpression' && e.elements[0]?.type === 'Literal' && typeof e.elements[0].value === 'string') {
      out.push(e.elements[0].value)
    }
  }
  return out
}

/** 便捷入口：按 shape 提取名为 name 的顶层声明键集（'object' | 'arrayStrings' |
 *  'arrayFirstCol'）。文件缺失/声明缺失返回 { found:false } 而非抛错——门禁侧
 *  fail-loud 报「声明缺失」。 */
export function extractNamedKeys(text, name, shape = 'object') {
  const ast = parseTs(text)
  const init = findTopVar(ast, name)
  if (init === null) return { found: false, keys: [] }
  if (shape === 'object') return { found: true, keys: objectKeysOf(init) }
  if (shape === 'arrayStrings') return { found: true, keys: arrayStringKeys(init) }
  if (shape === 'arrayFirstCol') return { found: true, keys: arrayFirstColKeys(init) }
  return { found: false, keys: [] }
}

/**
 * normalizeConfig 分支目标键收集（P1-1 第 3 条：不收集全函数任意字符串，防
 * object/boolean/string 等类型串误报）。目标键 = 函数体内对局部源对象
 * （src / base / qh / out）的 MemberExpression 成员键 ∪ `=== "字面量"` 判定键
 * （透传排除表）。CONFIG_KEYS 经 for..of 遍历属运行时索引，静态不可见——由
 * 调用方另行并入 CONFIG_KEYS 键集（本模块返回结构含 bases 供矩阵侧组合）。
 */
export function collectNormalizeBranchKeys(fnNode) {
  const members = new Map() // 基名 → Set(键)
  const eqLiterals = new Set()
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'MemberExpression' && !n.computed && n.property?.type === 'Identifier'
      && n.object?.type === 'Identifier' && ['src', 'base', 'qh', 'out'].includes(n.object.name)) {
      if (!members.has(n.object.name)) members.set(n.object.name, new Set())
      members.get(n.object.name).add(n.property.name)
    }
    if (n.type === 'BinaryExpression' && n.operator === '===') {
      // typeof X === "object"/"boolean"/"string" 的类型串判定不属于「配置键排除表」——
      // 排除表形态是 key === "配置键名"（Identifier 与 Literal 比较）
      const isTypeofSide = (s) => s?.type === 'UnaryExpression' && s.operator === 'typeof'
      if (!isTypeofSide(n.left) && !isTypeofSide(n.right)) {
        for (const side of [n.left, n.right]) {
          if (side?.type === 'Literal' && typeof side.value === 'string') eqLiterals.add(side.value)
        }
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue
      const v = n[k]
      if (Array.isArray(v)) { for (const c of v) walk(c) } else if (v && typeof v.type === 'string') walk(v)
    }
  }
  walk(fnNode)
  const union = new Set()
  for (const set of members.values()) for (const k of set) union.add(k)
  for (const k of eqLiterals) union.add(k)
  return {
    union: [...union],
    members: Object.fromEntries([...members.entries()].map(([k, s]) => [k, [...s]])),
    eqLiterals: [...eqLiterals],
  }
}

/**
 * 客户端 UI 引用键收集（notifier 形态；lan-proxy 由 DEFAULTS 单表承载不适用）：
 *  = 顶层 EVENT_KEYS 二维数组首列（事件开关渲染）
 *  ∪ builtinCard("…") / switchControl("…") 调用首参字符串（内置卡/行为参数）
 *  ∪ patch({…}) 字面量对象键（顶层配置键增量提交；chPatch 为 Bark 频道子键，
 *    刻意不收——与 SETTING_VALIDATORS 顶层键不同面）
 *  ∪ settings.<静态键> MemberExpression（渲染/读取面）。
 * 覆盖全模块（esbuild 提升后 var 已顶层；函数内 var settings 仍可被遍历到——
 *  全树扫描不依赖作用域分析，收集的是「键引用面」而非绑定语义）。
 */
export function collectClientUiKeys(ast) {
  const keys = new Set()
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier') {
      const callee = n.callee.name
      if ((callee === 'builtinCard' || callee === 'switchControl') && n.arguments[0]?.type === 'Literal' && typeof n.arguments[0].value === 'string') {
        keys.add(n.arguments[0].value)
      }
      if (callee === 'patch' && n.arguments[0]?.type === 'ObjectExpression') {
        for (const p of n.arguments[0].properties) {
          if (p.key?.type === 'Identifier') keys.add(p.key.name)
        }
      }
    }
    if (n.type === 'MemberExpression' && n.object?.type === 'Identifier' && n.object.name === 'settings'
      && !n.computed && n.property?.type === 'Identifier') {
      keys.add(n.property.name)
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue
      const v = n[k]
      if (Array.isArray(v)) { for (const c of v) walk(c) } else if (v && typeof v.type === 'string') walk(v)
    }
  }
  for (const n of ast.body) {
    // 顶层 EVENT_KEYS 二维首列
    if (n.type === 'VariableDeclaration') {
      for (const d of n.declarations) {
        if (d.id?.type === 'Identifier' && d.id.name === 'EVENT_KEYS') {
          for (const k of arrayFirstColKeys(d.init)) keys.add(k)
        }
      }
    }
  }
  walk(ast)
  return [...keys]
}

/** 矩阵行级差异（保序、可读）：缺键（base 有、table 无）与多键（table 有、
 *  base 无）。 */
export function diffKeys(base, table) {
  const b = new Set(base)
  const t = new Set(table)
  return {
    missing: [...b].filter((k) => !t.has(k)),
    extra: [...t].filter((k) => !b.has(k)),
  }
}

/**
 * 读文件并提取表键（容错：文件缺失/声明缺失不抛——返回 err 由调用方报红）。
 * @returns {{ err?: string, keys?: string[], line?: number|null }}
 */
export function readTableKeys(filePath, name, shape = 'object', label = name) {
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return { err: `文件不可读: ${filePath}` }
  }
  const line = sourceLineOf(text, name)
  const { found, keys } = extractNamedKeys(text, name, shape)
  if (!found) {
    return { err: `${label} 声明缺失（找不到顶层声明 ${name}，文件 ${filePath}${line ? `:${line}` : ''}）` }
  }
  if (keys.length === 0) {
    return { err: `${label} 键集为空（提取器可能失效或表被掏空，文件 ${filePath}:${line}）` }
  }
  return { keys, line }
}

/** 从 DEFAULT_CONFIG 对象值推断「布尔键」：值字面量为 true/false 的键。 */
export function booleanKeysOfObject(initNode) {
  let cur = initNode
  for (let i = 0; i < 12; i += 1) {
    if (!cur) return []
    if (cur.type === 'ObjectExpression') break
    if (cur.type === 'ParenthesizedExpression') { cur = cur.expression; continue }
    if (cur.type === 'TSAsExpression' || cur.type === 'TSSatisfiesExpression' || cur.type === 'TypeCastExpression') { cur = cur.expression; continue }
    if (cur.type === 'CallExpression') { cur = cur.arguments?.[0] ?? null; continue }
    return []
  }
  if (cur?.type !== 'ObjectExpression') return []
  const out = []
  for (const p of cur.properties) {
    if (p.type !== 'Property') continue
    const val = p.value?.type === 'Literal' && typeof p.value.value === 'boolean' ? p.value.value : null
    if (val === null) continue
    const k = p.key?.type === 'Identifier' ? p.key.name : p.key?.type === 'Literal' ? String(p.key.value) : null
    if (k !== null) out.push(k)
  }
  return out
}
