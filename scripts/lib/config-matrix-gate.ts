#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * config-matrix-gate — 配置平行事实源「字段覆盖矩阵」门禁编排（issue #471）。
 *
 * runConfigMatrix({ root }) 对两包真实 src 文件执行全部矩阵断言，返回结构化
 * 结果 { pass, problems: string[], lines: string[] }——不直接 console/exit，
 * 由调用方（contract-check.ts 追加段 / 负向自测）决定输出与退出码；文件树以
 * root 参数化，负向测试可对 mkdtemp 副本注入后复用同一逻辑（副本等效性：
 * 矩阵输入仅 src/config.ts / src/client/index.ts 文本，无 import 解析、
 * 无 lib 产物依赖）。
 *
 * 断言清单（对齐 issue #471 v2 验收 2/3/4/5/6/7）：
 *   L1 lan-proxy：Config / FILE_CONFIG_VALIDATORS / SETTING_FIELD_HINTS 三表
 *      键集全等（双向，现 16）
 *   L2 lan-proxy：client DEFAULTS ⊆ schema；schema − DEFAULTS 差集 ==
 *      LAN_PROXY_UI_EXEMPT；豁免带原因注释 + 单包 ≤8；豁免残留（键已 UI 化）
 *      亦红
 *   N1 notifier：DEFAULT_CONFIG / SETTING_VALIDATORS / SETTING_HINTS 全等
 *      （双向，现 19）
 *   N2 notifier：CONFIG_KEYS == DEFAULT_CONFIG 全部布尔键（现 10/10）
 *   N3 notifier：normalizeConfig 分支目标键（显式分支 ∪ qh 子键 ∪ 排除表
 *      判定 ∪ CONFIG_KEYS）⊇ DEFAULT_CONFIG；quietHours 嵌套子键
 *      enabled/start/end/allowKinds ∈ 分支目标
 *   N4 notifier：客户端 UI 引用键 ⊆ SETTING_VALIDATORS；反向差集 ==
 *      NOTIFIER_UI_EXEMPT（豁免带注释 + ≤8；豁免残留亦红）
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseTs, findTopVar, findTopFn, objectKeysOf, booleanKeysOfObject,
  collectNormalizeBranchKeys, collectClientUiKeys, diffKeys, sourceLineOf,
  extractReadmeConfigKeys,
} from './config-matrix-lib.ts'

// 豁免白名单（P1-2 三条件收敛：服务端/组合层键或客户端不渲染键；单包 ≤8；
// 每条带「文件:行 + 理由」原因注释——结构自检缺失即红）。
export const LAN_PROXY_UI_EXEMPT = {
  // 原因: 组合层装配键（绑定地址默认取 DEFAULT_OPTIONS.host，见 config.ts:80）；
  //   GUI 卡片不渲染绑定地址，README 安全模型说明。
  host: 'packages/dsh-lan-proxy/src/config.ts:80 组合层装配键（绑定地址），GUI 卡片不编辑',
  // 原因: 组合层装配键（回环上游主机；转发安全红线仅允许回环，见 config.ts:96）。
  targetHost: 'packages/dsh-lan-proxy/src/config.ts:96 组合层装配键（回环上游），GUI 卡片不编辑',
  // 原因: 组合层装配键（上游端口缺省随 web 端口，见 config.ts:97-102 注释）。
  targetPort: 'packages/dsh-lan-proxy/src/config.ts:102 组合层装配键（上游端口随 web 端口），GUI 卡片不编辑',
  // 原因: 服务端 WS 压缩协商策略键（browser/uaDeny 子结构，见 config.ts:119）；
  //   GUI 无对应控件（wsCompressPaths 白名单已可编辑）。
  wsDeflatePolicy: 'packages/dsh-lan-proxy/src/config.ts:119 服务端策略键（协商子结构），GUI 无控件',
}

// notifier：顶层 allowKinds 由 POST /kinds 确认流服务端管理（动态 kind 清单），
// 设置卡不直接渲染/编辑该顶层键（quietHours.allowKinds 子键在客户端免打扰块内
// 编辑，属 quietHours 内部不作顶层断言）。唯一豁免，条数 ≤8 满足。
export const NOTIFIER_UI_EXEMPT = {
  allowKinds: 'packages/dsh-notifier/src/config.ts:139 服务端动态 kind 确认清单（POST /kinds 管理），客户端不直接渲染顶层键',
}

/** 豁免白名单结构自检：≤8 键 + 每条原因注释（含「文件:行」+ 一句理由）。 */
function checkExempts(pkg, exempt) {
  const problems = []
  if (Object.keys(exempt).length > 8) {
    problems.push(`${pkg} 豁免白名单 ${Object.keys(exempt).length} 键 > 8（超限即红，强制走评审）`)
  }
  for (const [k, reason] of Object.entries(exempt)) {
    if (typeof reason !== 'string' || reason.length === 0 || !/:\d+/.test(reason)) {
      problems.push(`${pkg} 豁免键 ${k} 缺原因注释（须含「文件:行 + 一句理由」）`)
    }
  }
  return problems
}

/** 读取表键（容错返回 err；附带 text/ast/init/line 供下游派生断言）。 */
function loadTable(filePath, name, shape) {
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (e) {
    return { err: `文件不可读: ${filePath}（${e.message}）` }
  }
  const line = sourceLineOf(text, name)
  const ast = parseTs(text)
  const init = findTopVar(ast, name)
  if (init === null) {
    return { err: `${name} 声明缺失 @ ${filePath}${line ? `:${line}` : ''}（提取器失效或声明被删）` }
  }
  let keys
  if (shape === 'object') {
    keys = objectKeysOf(init)
  } else {
    keys = init.type === 'ArrayExpression'
      ? init.elements.filter((e) => e && e.type === 'Literal' && typeof e.value === 'string').map((e) => e.value)
      : []
  }
  if (keys.length === 0) {
    return { err: `${name} 键集为空 @ ${filePath}:${line}（提取器可能失效或表被掏空）` }
  }
  return { text, ast, init, keys, line }
}

/** 差集 → 缺/多键报错行。 */
function diffProblems(scope, tableName, filePath, line, d, hint = '') {
  const out = []
  for (const k of d.missing) out.push(`${scope} ${tableName} 缺键（相对基准）: ${k} @ ${filePath}:${line}${hint ? `（${hint}）` : ''}`)
  for (const k of d.extra) out.push(`${scope} ${tableName} 多键（基准之外）: ${k} @ ${filePath}:${line}${hint ? `（${hint}）` : ''}`)
  return out
}

/** lan-proxy 矩阵；返回 { problems, lines }。 */
function runLanProxy(root) {
  const problems = []
  const lines = []
  const cfgPath = join(root, 'packages/dsh-lan-proxy/src/config.ts')
  const clientPath = join(root, 'packages/dsh-lan-proxy/src/client/index.ts')

  const schema = loadTable(cfgPath, 'Config', 'object')
  const validators = loadTable(cfgPath, 'FILE_CONFIG_VALIDATORS', 'object')
  const hints = loadTable(cfgPath, 'SETTING_FIELD_HINTS', 'object')
  const defaults = loadTable(clientPath, 'DEFAULTS', 'object')
  const failed = [schema, validators, hints, defaults].filter((t) => t.err)
  if (failed.length > 0) {
    for (const t of failed) problems.push(t.err)
    return { problems, lines }
  }

  // L1：三表两两全等（16 键）
  const pairs = [
    ['Config', schema, 'FILE_CONFIG_VALIDATORS', validators],
    ['Config', schema, 'SETTING_FIELD_HINTS', hints],
    ['FILE_CONFIG_VALIDATORS', validators, 'SETTING_FIELD_HINTS', hints],
  ]
  for (const [na, ta, nb, tb] of pairs) {
    problems.push(...diffProblems('lan-proxy', nb, cfgPath, tb.line, diffKeys(ta.keys, tb.keys), `与 ${na} 不一致`))
    problems.push(...diffProblems('lan-proxy', na, cfgPath, ta.line, diffKeys(tb.keys, ta.keys), `与 ${nb} 不一致`))
  }

  // L2：DEFAULTS ⊆ schema；schema − DEFAULTS == 豁免；豁免结构自检
  const exempt = LAN_PROXY_UI_EXEMPT
  problems.push(...checkExempts('lan-proxy', exempt))
  const exemptKeys = Object.keys(exempt)
  const d = diffKeys(schema.keys, defaults.keys)
  // DEFAULTS 出现 schema 外键 → 红（客户端提交未知键被宿主白名单静默丢弃）
  for (const k of d.extra) problems.push(`lan-proxy client DEFAULTS 多键（Config 之外）: ${k} @ ${clientPath}:${defaults.line}`)
  // schema − DEFAULTS 缺键必须恰为豁免集合（新增可编辑键漏 UI → 红）
  for (const k of d.missing) {
    if (!exemptKeys.includes(k)) problems.push(`lan-proxy client DEFAULTS 缺键（相对 Config，非豁免）: ${k} @ ${clientPath}:${defaults.line}（新增可编辑键漏 UI）`)
  }
  // 豁免残留：豁免键出现在客户端 DEFAULTS 中 = 键已 UI 化但白名单未删
  // （注意判据是「∈ DEFAULTS」而非「∉ 差集」——豁免键从 schema 删除时差集自然
  // 不含它，此时不算残留）
  for (const k of exemptKeys) {
    if (defaults.keys.includes(k)) problems.push(`lan-proxy 豁免键 ${k} 已在客户端 DEFAULTS 中（豁免残留，应移除豁免或改豁免原因）`)
  }

  lines.push(`lan-proxy ${schema.keys.length} 键 × [schema/validators/hints] 全等 + client DEFAULTS ${defaults.keys.length}(豁免 ${exemptKeys.length})`)

  // 量级 #12：README 配置表键集一致性——代码键缺文档仅 warn 不判红（防文档漂移提示）
  const warnings = []
  const readmePath = join(root, 'packages/dsh-lan-proxy/README.md')
  let readmeText = null
  try { readmeText = readFileSync(readmePath, 'utf8') } catch { readmeText = null }
  if (readmeText !== null) {
    const { keys: docKeys } = extractReadmeConfigKeys(readmeText, 'lan-proxy')
    for (const k of diffKeys(schema.keys, docKeys).missing) {
      warnings.push(`lan-proxy README 配置表缺文档键: ${k}（docs/README 与代码键集不一致，仅提示）`)
    }
  }
  return { problems, warnings, lines }
}

/** notifier 矩阵；返回 { problems, lines }。 */
function runNotifier(root) {
  const problems = []
  const lines = []
  const cfgPath = join(root, 'packages/dsh-notifier/src/config.ts')
  const clientPath = join(root, 'packages/dsh-notifier/src/client/index.ts')

  const def = loadTable(cfgPath, 'DEFAULT_CONFIG', 'object')
  const validators = loadTable(cfgPath, 'SETTING_VALIDATORS', 'object')
  const hints = loadTable(cfgPath, 'SETTING_HINTS', 'object')
  const configKeys = loadTable(cfgPath, 'CONFIG_KEYS', 'arrayStrings')
  const failed = [def, validators, hints, configKeys].filter((t) => t.err)
  if (failed.length > 0) {
    for (const t of failed) problems.push(t.err)
    return { problems, lines }
  }
  const base = def.keys

  // N1：三表两两全等（19 键）
  const pairs = [
    ['DEFAULT_CONFIG', def, 'SETTING_VALIDATORS', validators],
    ['DEFAULT_CONFIG', def, 'SETTING_HINTS', hints],
    ['SETTING_VALIDATORS', validators, 'SETTING_HINTS', hints],
  ]
  for (const [na, ta, nb, tb] of pairs) {
    problems.push(...diffProblems('notifier', nb, cfgPath, tb.line, diffKeys(ta.keys, tb.keys), `与 ${na} 不一致`))
    problems.push(...diffProblems('notifier', na, cfgPath, ta.line, diffKeys(tb.keys, ta.keys), `与 ${nb} 不一致`))
  }

  // N2：CONFIG_KEYS == DEFAULT_CONFIG 全部布尔键（从 DEFAULT_CONFIG 字面量推导）
  const boolKeys = booleanKeysOfObject(def.init)
  const d2a = diffKeys(boolKeys, configKeys.keys)
  for (const k of d2a.missing) problems.push(`notifier CONFIG_KEYS 漏布尔键: ${k} @ ${cfgPath}:${configKeys.line}（新增布尔键忘进 CONFIG_KEYS）`)
  for (const k of d2a.extra) problems.push(`notifier CONFIG_KEYS 多键（非布尔键）: ${k} @ ${cfgPath}:${configKeys.line}`)
  const d2b = diffKeys(configKeys.keys, boolKeys)
  for (const k of d2b.missing) problems.push(`notifier DEFAULT_CONFIG 布尔键未入 CONFIG_KEYS: ${k} @ ${cfgPath}:${def.line}`)

  // N3：normalizeConfig 分支目标键 ⊇ DEFAULT_CONFIG（CONFIG_KEYS ∪ 显式分支 ∪ M2）
  const fnNode = findTopFn(def.ast, 'normalizeConfig')
  const normalizeLine = sourceLineOf(def.text, 'normalizeConfig')
  if (!fnNode) {
    problems.push(`notifier normalizeConfig 声明缺失 @ ${cfgPath}${normalizeLine ? `:${normalizeLine}` : ''}`)
  } else {
    const branch = collectNormalizeBranchKeys(fnNode)
    // 归一化「真实发生」的静态证据 = base.<key> 赋值键（显式分支把归一化结果写回
    // base）∪ CONFIG_KEYS（布尔键经 base[key]=src[key] 动态索引，静态只见键数组）。
    // src.<key> 读取与排除表 === 字面量只证明「读过/排除过」，不证明归一化赋值——
    // 不作为覆盖证据（防删归一化行仍假绿），仅用于下方孤儿键诊断。
    const baseKeys = new Set(branch.members.base ?? [])
    const target = new Set([...baseKeys, ...configKeys.keys])
    const d3 = diffKeys(base, [...target])
    for (const k of d3.missing) {
      problems.push(`notifier normalizeConfig 漏分支键: ${k} @ ${cfgPath}:${normalizeLine ?? '?'}（base.<key> 归一化赋值 ∪ CONFIG_KEYS 未覆盖该键）`)
    }
    // 排除表孤儿键：=== "键" 判定列出的**配置键名**（∈ DEFAULT_CONFIG 全集，typeof
    // 类型串 object/boolean/string 天然不在键集内不参与）既不在 base 赋值也不在
    // CONFIG_KEYS = 该键已不再归一化却仍在排除表（会被丢弃而非透传），属行为级洞
    const baseSet = new Set(base)
    for (const k of branch.eqLiterals) {
      if (!baseSet.has(k)) continue // 非配置键名的 === 字面量（typeof 判定等）忽略
      if (!baseKeys.has(k) && !configKeys.keys.includes(k)) {
        problems.push(`notifier normalizeConfig 透传排除表孤儿键: ${k} @ ${cfgPath}:${normalizeLine ?? '?'}（排除表列了不再归一化的键）`)
      }
    }
    // quietHours 嵌套子键不变量（enabled/start/end/allowKinds 均须有 qh 分支目标）
    const qhMembers = branch.members.qh ?? []
    for (const q of ['enabled', 'start', 'end', 'allowKinds']) {
      if (!qhMembers.includes(q)) problems.push(`notifier normalizeConfig quietHours 漏子键分支: ${q} @ ${cfgPath}:${normalizeLine ?? '?'}`)
    }
  }

  // N4：客户端 UI 引用键 ⊆ SETTING_VALIDATORS；反向差集 == 豁免（allowKinds）
  let clientText
  try {
    clientText = readFileSync(clientPath, 'utf8')
  } catch (e) {
    problems.push(`notifier 客户端文件不可读: ${clientPath}（${e.message}）`)
    return { problems, lines }
  }
  const cAst = parseTs(clientText)
  const uiKeys = collectClientUiKeys(cAst)
  const exempt = NOTIFIER_UI_EXEMPT
  problems.push(...checkExempts('notifier', exempt))
  const exemptKeys = Object.keys(exempt)
  // 客户端出现 validators 之外键（新增客户端键忘进服务端表）→ 红
  const d4 = diffKeys(validators.keys, uiKeys)
  for (const k of d4.extra) {
    problems.push(`notifier 客户端 UI 引用键不在 SETTING_VALIDATORS: ${k} @ ${clientPath}（新增客户端键须同步服务端表）`)
  }
  // validators 键未在客户端引用：除豁免外 → 红（漏 UI 化/渲染）
  const missingUi = diffKeys(validators.keys, uiKeys).missing
  for (const k of missingUi) {
    if (!exemptKeys.includes(k)) problems.push(`notifier 客户端 UI 未引用配置键 ${k} @ ${clientPath}（非豁免键漏渲染/编辑面）`)
  }
  // 豁免残留：豁免键已在客户端引用 → 红
  for (const k of exemptKeys) {
    if (!missingUi.includes(k)) problems.push(`notifier 豁免键 ${k} 已在客户端引用（豁免残留，应移除）`)
  }

  const summary = `notifier ${base.length} 键 × [default/validators/hints] 全等 + CONFIG_KEYS ${configKeys.keys.length}/${boolKeys.length} + normalize 覆盖 + client UI 覆盖 ${uiKeys.length}(豁免 ${exemptKeys.length})`
  lines.push(summary)

  // 量级 #12：README JSON 样例键集一致性——代码键缺文档仅 warn 不判红
  const warnings = []
  const readmePath = join(root, 'packages/dsh-notifier/README.md')
  let readmeText = null
  try { readmeText = readFileSync(readmePath, 'utf8') } catch { readmeText = null }
  if (readmeText !== null) {
    const { keys: docKeys } = extractReadmeConfigKeys(readmeText, 'notifier')
    for (const k of diffKeys(base, docKeys).missing) {
      warnings.push(`notifier README JSON 样例缺文档键: ${k}（docs/README 与代码键集不一致，仅提示）`)
    }
  }
  return { problems, warnings, lines }
}

/**
 * 运行两包矩阵门禁（root 参数化：真实仓库根或 mkdtemp 副本根）。
 * @returns {{ pass: boolean, problems: string[], warnings: string[], lines: string[] }}
 */
export function runConfigMatrix(root) {
  const problems = []
  const warnings = []
  const lines = []
  for (const run of [runLanProxy, runNotifier]) {
    const r = run(root)
    problems.push(...r.problems)
    warnings.push(...(r.warnings ?? []))
    lines.push(...r.lines)
  }
  return { pass: problems.length === 0, problems, warnings, lines }
}
