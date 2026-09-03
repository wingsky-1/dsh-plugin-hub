#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * plugins-manifest-lib — 插件清单单一事实源（issue #36）的纯函数库。
 *
 * `scripts/data/plugins-manifest.json` 是「某插件是否参与聚合/发布校验」的唯一声明处：
 *   - aggregate.ts / pack-check.ts / contract-check.ts / verify-npm-layout.ts 共读；
 *   - 断言逻辑只有本文件一份，入口脚本只喂数据（对齐 client-contract-lib 的
 *     「stub/实现同源」纪律，防两处内嵌实现漂移）。
 * schema 说明与 opt-in 设计动机见 docs/DEVELOPMENT.md §4「插件清单单一来源」。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const AGGREGATE_NAME = 'dsh-plugins-all'
export const NPM_SCOPE = '@wingsky-1/'
export const MANIFEST_PATH_SEGMENTS = ['scripts', 'data', 'plugins-manifest.json']
const NAME_RE = /^dsh-[a-z0-9-]+$/

/**
 * 枚举 packages/ 下的插件目录：仅目录（isDirectory 过滤，防同名文件裸栈）、
 * dsh- 前缀、排除聚合包、稳定排序。四个枚举入口共用此实现。
 */
export function listPluginDirs(root) {
  return readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dsh-') && e.name !== AGGREGATE_NAME)
    .map((e) => e.name)
    .sort()
}

/** packages/ 下非 dsh- 前缀的目录警告（如 Dsh-Foo / dsh_foo 会被静默忽略，使其可见）。 */
export function warnUnknownEntries(root) {
  for (const e of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('dsh-') && e.name !== AGGREGATE_NAME) {
      console.error(`[plugins-manifest] 警告：packages/ 下存在非 dsh- 前缀目录 ${e.name}，不参与插件清单`)
    }
  }
}

/**
 * 从物理目录集中剔除 manifest.retired 名（T1：#397 退役包目录残留致 contract /
 * verify-npm-layout 等按 package.json 读包的消费方裸 ENOENT 崩门禁）。
 * listPluginDirs 保持「物理目录事实源」语义不变（checkAggregateConsistency 双向
 * 校验依赖它：新目录必须登记 / 登记项必须存在）；本函数仅供「按 package.json 逐包
 * 消费」的入口过滤退役残留目录——出队顺序 = 物理枚举序，仅做名集过滤。
 */
export function filterOutRetiredDirs(dirNames, manifest) {
  const retiredNames = new Set((manifest.retired ?? []).map((r) => r.name))
  const kept = []
  const skipped = []
  for (const d of dirNames) {
    if (retiredNames.has(d)) skipped.push(d)
    else kept.push(d)
  }
  return { kept, skipped }
}

function fail(msg) {
  throw new Error(`scripts/data/plugins-manifest.json 解析失败：${msg}（schema 见 docs/DEVELOPMENT.md §4 插件清单）`)
}

function checkName(name, where) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    fail(`${where} 含非法名字 ${JSON.stringify(name)}（须匹配 ${NAME_RE}）`)
  }
}

/**
 * 读取并校验 manifest。自洽校验：数组内重复、active∩retired∩standalone 重名、
 * 名字合规。IO/形状错误抛单行友好错误（调用方 catch 后 exit 非 0），
 * 禁止裸 SyntaxError 栈。
 */
export function loadManifest(root) {
  let raw
  try {
    raw = readFileSync(join(root, ...MANIFEST_PATH_SEGMENTS), 'utf8')
  } catch (e) {
    fail(`无法读取文件：${e.message}`)
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch (e) {
    fail(`JSON 语法错误：${e.message}`)
  }
  if (typeof json !== 'object' || json === null || !Array.isArray(json.active)) {
    fail('缺 active 数组')
  }
  if (!Array.isArray(json.retired)) {
    fail('缺 retired 数组')
  }
  // standalone：独立发包、不进聚合包的插件（demo 演进等）；可选，缺省空集。
  const standalone = Array.isArray(json.standalone) ? json.standalone : []
  const seenActive = new Set()
  for (const name of json.active) {
    checkName(name, 'active')
    if (seenActive.has(name)) fail(`active 数组重复项：${name}`)
    seenActive.add(name)
  }
  const seenStandalone = new Set()
  for (const name of standalone) {
    checkName(name, 'standalone')
    if (seenStandalone.has(name)) fail(`standalone 数组重复项：${name}`)
    if (seenActive.has(name)) fail(`${name} 同时出现在 active 与 standalone`)
    seenStandalone.add(name)
  }
  const seenRetired = new Set()
  for (const item of json.retired) {
    if (typeof item !== 'object' || item === null) fail('retired 数组含非对象项')
    checkName(item.name, 'retired')
    if (seenRetired.has(item.name)) fail(`retired 数组重复项：${item.name}`)
    seenRetired.add(item.name)
    if (seenActive.has(item.name)) fail(`${item.name} 同时出现在 active 与 retired`)
    if (seenStandalone.has(item.name)) fail(`${item.name} 同时出现在 standalone 与 retired`)
  }
  return { active: [...seenActive], standalone: [...seenStandalone], retired: json.retired.map((r) => ({ ...r })) }
}

/**
 * 聚合一致性断言集（problems[] 风格对齐 pack-check）。
 * @param {string[]} dirNames       packages/ 实际插件目录集（listPluginDirs 结果）
 * @param {{active: string[], retired: Array<{name: string}>}} manifest
 * @param {Record<string, string>} [aggDeps]     聚合包 package.json dependencies（缺省跳过 deps 段）
 * @param {string[]} [aggPatchIds]               聚合 cordis.patch.yml 的 insert id 集（缺省跳过 patch 段）
 * @param {string[]} [expectedPatchIds]          期望的聚合 insert id 集；缺省回退「ui-<dir>」约定
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function checkAggregateConsistency({ dirNames, manifest, aggDeps, aggPatchIds, expectedPatchIds }) {
  const problems = []
  const actual = new Set(dirNames)
  // 目录集语义：active（进聚合）∪ standalone（独立发包）都必须真实存在；
  // retired 包目录应删除，不在此列——残留目录（T1）属清理债：告警不判红，
  // 但仍强制「新目录必须登记」守卫（见方向 B retired 豁免）。
  const expected = new Set([...manifest.active, ...(manifest.standalone ?? [])])
  const retiredNames = new Set(manifest.retired.map((r) => r.name))

  // #1 目录集 == active ∪ standalone 集（双向）：新目录必须登记；登记项必须真实存在
  for (const d of [...manifest.active, ...(manifest.standalone ?? [])]) {
    if (!actual.has(d)) {
      const where = manifest.active.includes(d) ? 'active' : 'standalone'
      problems.push(`manifest.${where} 引用了不存在的目录: ${d} —— 退役请移入 retired 并删除目录`)
    }
  }
  for (const d of dirNames) {
    // T1：#397 退役包残留目录（无 package.json）不再判红——已登记 retired 即属
    // 已知清理债，方向 B 豁免；新插件目录（非 active/standalone/retired 名）仍 fail。
    if (retiredNames.has(d)) {
      console.warn(`[plugins-manifest] 警告：packages/ 存在已退役包残留目录 ${d}（manifest.retired 已登记），请清理删除`)
      continue
    }
    if (!expected.has(d)) problems.push(`packages/ 存在 dsh-* 子包但未登记 manifest: ${d} —— 新插件必须加入 scripts/data/plugins-manifest.json 的 active 或 standalone`)
  }

  // #2 聚合包 dependencies 键集 == active 映射集（双向；只比键集合不比值——
  //    开发态 workspace:*、发布时 pnpm 替换版本号，存在即认可）。第三方依赖不归本校验管。
  if (aggDeps !== undefined) {
    const own = Object.keys(aggDeps).filter((k) => k.startsWith(NPM_SCOPE))
    const expectedDeps = new Set(manifest.active.map((d) => NPM_SCOPE + d))
    const standaloneNames = new Set(manifest.standalone ?? [])
    for (const dep of own) {
      if (expectedDeps.has(dep)) continue
      const short = dep.slice(NPM_SCOPE.length)
      if (standaloneNames.has(short)) {
        problems.push(`deps 多出独立发包 ${dep} —— standalone 插件不进聚合包，请删除该依赖行`)
      } else if (retiredNames.has(short)) {
        problems.push(`deps 多出已退役包 ${dep} —— 请删除该依赖行`)
      } else {
        problems.push(`deps 多出未收录包 ${dep} —— 既不在 active/standalone 也不在 retired，请检查拼写或在 manifest 登记`)
      }
    }
    for (const dep of expectedDeps) {
      if (!own.includes(dep)) problems.push(`deps 缺少 active 插件 ${dep} —— 请补 workspace:* 依赖行`)
    }
  }

  // #3 聚合 patch insert id 集 == 期望集（双向）。期望集显式传入时以其为准
  // （pack-check 读各 active 子包 patch 的实际 insert id——客户端插件 ui-<dir>、
  // 纯宿主插件如 dsh-verify-isolated 用 skill- 前缀）；缺省回退历史「ui-<dir>」
  // 约定（防「门禁假设所有插件都有客户端」的过强断言）。
  if (aggPatchIds !== undefined) {
    // 重复行检测（Set 去重会吞掉「同 id 多行」漂移，单独比对长度闭合该缺口）
    const dupIds = aggPatchIds.filter((id, i) => aggPatchIds.indexOf(id) !== i)
    if (dupIds.length > 0) problems.push(`聚合 patch 存在重复 id 行: ${[...new Set(dupIds)].join(', ')}`)
    const expectedIds = new Set(expectedPatchIds ?? manifest.active.map((d) => `ui-${d}`))
    const actualIds = new Set(aggPatchIds)
    for (const id of expectedIds) {
      if (!actualIds.has(id)) problems.push(`聚合 patch 缺 ${id}（active 在册但无聚合行）`)
    }
    for (const id of aggPatchIds) {
      if (!expectedIds.has(id)) problems.push(`聚合 patch 多出未知 id ${id}`)
    }
  }

  return problems
}
