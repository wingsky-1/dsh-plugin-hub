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
 *   N1 notifier：configSurfaces 声明的 defaults 导出必须是非空对象（声明驱动，取代旧
 *      硬编码路径 src/config/{config,validators,normalize}.ts——#733 配置域搬到
 *      src/server/config/impl/** 后那三条路径全部 ENOENT，路径硬编码本身就是红因）
 *   N2 notifier：normalizeConfig({}) 的键集**双向等于** DEFAULT_CONFIG 键集
 *      （丢键 / 凭空造键都红）——本包当前唯一有实质约束力的行为断言
 *   N3 notifier：README 配置键集一致性，缺键仅 warn（量级 #12）
 * 旧 N2（CONFIG_KEYS == 布尔键）与旧 N4（客户端 UI ⊆ SETTING_VALIDATORS）在新树上
 * 已无输入：CONFIG_KEYS 现在是 Object.keys(DEFAULT_CONFIG) 的同义反复，
 * SETTING_VALIDATORS/SETTING_HINTS 只存在于旧门禁。BOOLEAN_KEYS/COUNT_LIMITS 未导出，
 * 运行时取不到——该缺口如实登记在 runNotifier 的注释里，不假装门禁比实际强。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  parseTs, findTopVar, objectKeysOf, diffKeys, sourceLineOf,
  extractReadmeConfigKeys,
} from './config-matrix-lib.ts'
import { loadManifest } from './plugins-manifest-lib.ts'

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

/**
 * 按 configSurfaces 声明加载一个配置面并取真实导出值。任何失败都转成 problem 并返回
 * undefined（fail-closed）。require 锚点放在 root 内，使各包 package.json 的 type 字段
 * 参与解析（各包是 type: module，走 Node 的 require(esm)＋原生类型剥离，
 * 故这里能同步拿到 .ts 模块的导出）。同一 root 只加载一次；负例测试每次用新的 mkdtemp
 * 路径，ESM loader 缓存不串味。
 */
function loadSurfaceExport(root, face, label, problems) {
  if (typeof face?.module !== 'string' || typeof face.export !== 'string') {
    problems.push(`notifier configSurfaces.${label} 声明结构不合法（须含 module/export 字符串）`)
    return undefined
  }
  try {
    const req = createRequire(join(root, 'scripts', 'data', 'plugins-manifest.json'))
    const mod = req(join(root, face.module))
    if (mod === null || mod === undefined || mod[face.export] === undefined) {
      problems.push(`notifier configSurfaces.${label} 声明的导出不存在: ${face.module} → ${face.export}`)
      return undefined
    }
    return mod[face.export]
  } catch (e) {
    problems.push(`notifier configSurfaces.${label} 模块加载失败: ${face.module}（${String(e.message).split('\n')[0]}）`)
    return undefined
  }
}

/**
 * notifier 矩阵：**声明驱动 + 运行时取值**（#733 计划项 3.1.1）。
 *
 * 旧实现在这里硬编码三条包内路径并从源码文本抠字面量；#733 把配置域搬到
 * src/server/config/impl/** 之后那三条路径全部 ENOENT，门禁以「文件不可读」判红——
 * 路径硬编码本身就是这次红因。现改为从 plugins-manifest.json 的 configSurfaces 取模块
 * specifier、加载模块取真实导出值：键集从运行时派生，包内结构再调整也不必改门禁。
 *
 * 断言集随事实源重建（旧 N1/N2/N3 的输入在新树上已不存在，不是「放宽」而是重建）：
 *   N1 声明的 defaults 导出必须是非空对象；
 *   N2 normalizeConfig({}) 的键集双向等于 DEFAULT_CONFIG 键集（丢键 / 凭空造键都红）；
 *   N3 README 配置表缺键仅 warn（量级 #12，保留）。
 *
 * N3 BOOLEAN_KEYS 的每个键都是真实配置键，且其在 DEFAULT_CONFIG 中的默认值是布尔
 *    （反向不成立：browserSound / systemSound 的默认值也是 true，但类型是
 *    boolean | SoundId，不属于「只接受布尔值」，故不做双向断言）；
 * N4 COUNT_LIMITS 的每个键都是真实配置键、上界是非负整数，且 DEFAULT_CONFIG 的默认值
 *    不超过该上界。
 * 这两层约束在 #733 重写后一度无法执行（那两个清单当时未导出，曾在门禁注释里如实登记为
 * 缺口）；notifier 侧导出后由声明驱动恢复，缺口随之关闭。
 */
function runNotifier(root, surface) {
  const problems = []
  const warnings = []
  const lines = []

  if (!surface) {
    problems.push('notifier 未在 scripts/data/plugins-manifest.json 的 configSurfaces 声明配置面（#733 计划项 3.1.1：未登记即红）')
    return { problems, warnings, lines }
  }

  const defaults = loadSurfaceExport(root, surface.defaults, 'defaults', problems)
  const normalizer = loadSurfaceExport(root, surface.normalizer, 'normalizer', problems)
  if (defaults === undefined || normalizer === undefined) return { problems, warnings, lines }

  const base = Object.keys(defaults)
  if (base.length === 0) {
    problems.push(`notifier configSurfaces.defaults 的导出键集为空：${surface.defaults.module} → ${surface.defaults.export}`)
    return { problems, warnings, lines }
  }

  let normalized
  try {
    normalized = normalizer({})
  } catch (e) {
    problems.push(`notifier normalizeConfig({}) 执行失败：${String(e.message).split('\n')[0]}`)
    return { problems, warnings, lines }
  }
  const d2 = diffKeys(base, Object.keys(normalized ?? {}))
  for (const k of d2.missing) {
    problems.push(`notifier normalizeConfig 丢键: ${k}（DEFAULT_CONFIG 有该键，normalizeConfig({}) 结果里没有）`)
  }
  for (const k of d2.extra) {
    problems.push(`notifier normalizeConfig 多键: ${k}（不在 DEFAULT_CONFIG 中——归一化凭空造键）`)
  }

  // N3/N4：布尔键清单与计数上界清单（两张清单的导出由 notifier 侧补齐后恢复执行）
  const booleanKeys = loadSurfaceExport(root, surface.booleanKeys, 'booleanKeys', problems)
  const countLimits = loadSurfaceExport(root, surface.countLimits, 'countLimits', problems)
  if (booleanKeys === undefined || countLimits === undefined) return { problems, warnings, lines }

  const baseSet = new Set(base)
  if (!Array.isArray(booleanKeys)) {
    problems.push(`notifier configSurfaces.booleanKeys 的导出不是数组（${surface.booleanKeys.export}）`)
  } else {
    for (const k of booleanKeys) {
      if (!baseSet.has(k)) {
        problems.push(`notifier BOOLEAN_KEYS 含非配置键: ${k}（不在 DEFAULT_CONFIG 中）`)
      } else if (typeof defaults[k] !== 'boolean') {
        problems.push(`notifier BOOLEAN_KEYS 含非布尔键: ${k}（DEFAULT_CONFIG 里的默认值是 ${typeof defaults[k]}）`)
      }
    }
  }

  if (countLimits === null || typeof countLimits !== 'object' || Array.isArray(countLimits)) {
    problems.push(`notifier configSurfaces.countLimits 的导出不是对象（${surface.countLimits.export}）`)
  } else {
    for (const [k, limit] of Object.entries(countLimits)) {
      if (!baseSet.has(k)) {
        problems.push(`notifier COUNT_LIMITS 含非配置键: ${k}（不在 DEFAULT_CONFIG 中）`)
        continue
      }
      if (!Number.isInteger(limit) || limit < 0) {
        problems.push(`notifier COUNT_LIMITS.${k} 的上界不是非负整数: ${JSON.stringify(limit)}`)
      }
      const fallback = defaults[k]
      if (!Number.isInteger(fallback) || fallback < 0) {
        problems.push(`notifier COUNT_LIMITS 覆盖的键 ${k} 在 DEFAULT_CONFIG 里不是非负整数: ${JSON.stringify(fallback)}`)
      } else if (Number.isInteger(limit) && fallback > limit) {
        problems.push(`notifier DEFAULT_CONFIG.${k} = ${fallback} 超过 COUNT_LIMITS.${k} 上界 ${limit}（默认值本身越界）`)
      }
    }
  }

  // 摘要里的计数用安全取值：类型不合法时上面已判红，这里不能再抛（报告要完整）。
  const boolCount = Array.isArray(booleanKeys) ? booleanKeys.length : '?'
  const limitCount =
    countLimits !== null && typeof countLimits === 'object' && !Array.isArray(countLimits)
      ? Object.keys(countLimits).length
      : '?'
  lines.push(
    `notifier ${base.length} 键 × [defaults → normalizeConfig] 运行时取值全等 + BOOLEAN_KEYS ${boolCount} + COUNT_LIMITS ${limitCount}`,
  )

  // 量级 #12：README JSON 样例键集一致性——代码键缺文档仅 warn 不判红
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
  // 配置面声明来自 manifest（#733 计划项 3.1.1）：读不到/结构不合法即红——
  // 声明是门禁的输入面，它坏掉不能退化成「没有声明就跳过 notifier 段」。
  let surfaces = []
  try {
    surfaces = loadManifest(root).configSurfaces ?? []
  } catch (e) {
    problems.push(`读取 configSurfaces 声明失败（scripts/data/plugins-manifest.json）：${e.message}`)
  }
  const results = [
    runLanProxy(root),
    runNotifier(root, surfaces.find((s) => s.package === 'dsh-notifier')),
  ]
  for (const r of results) {
    problems.push(...r.problems)
    warnings.push(...(r.warnings ?? []))
    lines.push(...r.lines)
  }
  return { pass: problems.length === 0, problems, warnings, lines }
}
