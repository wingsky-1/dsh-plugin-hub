#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * config-matrix-negative 负向自测（issue #471 P1-3：漏表方向注入 → 门禁红 +
 * 报错含键名）。
 *
 * 负向用例对**真实 src/config.ts / src/client/index.ts 的 mkdtemp 副本**注入
 * （删键 / 加假键），再跑与 contract-check 同一 runConfigMatrix(root)——副本
 * 等效性论证：矩阵提取器输入仅源文本（无 import 解析、无运行时、无 lib 产物
 * 依赖），复制文件即等价于真实文件；注入后断言矩阵 pass=false 且 problems
 * 含被注入键名。零污染：临时目录随测试结束 rmSync（#218 纪律）。
 *
 * 覆盖方向（每方向至少一例，合计 ≥6）：
 *   lan-proxy ① 删 FILE_CONFIG_VALIDATORS 一键 → 红 ② DEFAULTS 增 schema 外键
 *     → 红 ③ 删 Config schema 键 → 红 ④ DEFAULTS 删非豁免键 → 红
 *   notifier ⑤ 删 DEFAULT_CONFIG 一键 → 红 ⑥ SETTING_HINTS 加假键 → 红
 *     ⑦ CONFIG_KEYS 漏布尔键 → 红 ⑧ normalizeConfig 漏归一化分支 → 红
 *     ⑨ 客户端 EVENT_KEYS 删事件键 → 红 ⑩ 客户端渲染 validators 外键 → 红
 *     ⑪ 客户端引用豁免键（豁免残留）→ 红
 * 另含「纯副本不改动 → pass」正对照（防注入函数自身破坏文件）。
 *
 * 运行：node --test scripts/test/config-matrix-negative.test.ts（随 pnpm test:scripts）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runConfigMatrix } from '../lib/config-matrix-gate.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** mkdtemp 副本仓库：复制两包 src/config.ts + src/client/index.ts（仅矩阵输入面）。 */
function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cfgmtx-'))
  try {
    for (const pkg of ['dsh-lan-proxy', 'dsh-notifier']) {
      mkdirSync(join(root, 'packages', pkg, 'src', 'client'), { recursive: true })
    }
    const srcs = [
      ['dsh-lan-proxy', 'config.ts'],
      ['dsh-lan-proxy', 'client/index.ts'],
      ['dsh-notifier', 'config.ts'],
      ['dsh-notifier', 'client/index.ts'],
    ]
    for (const [pkg, rel] of srcs) {
      cpSync(join(ROOT, 'packages', pkg, 'src', rel), join(root, 'packages', pkg, 'src', rel))
    }
  } catch (e) {
    rmSync(root, { recursive: true, force: true })
    throw e
  }
  return root
}

function edit(root, pkg, rel, fn) {
  const f = join(root, 'packages', pkg, 'src', rel)
  writeFileSync(f, fn(readFileSync(f, 'utf8')))
}

/** 通用断言：注入后矩阵红 + problems 含 expectKey；若 expectKey 为数组则逐一断言。 */
function assertRed(label, mutate, expectKeys) {
  const root = fakeRepo()
  try {
    mutate(root)
    const r = runConfigMatrix(root)
    assert.equal(r.pass, false, `${label}: 注入后门禁应红`)
    const joined = r.problems.join('\n')
    for (const k of (Array.isArray(expectKeys) ? expectKeys : [expectKeys])) {
      assert.ok(joined.includes(k), `${label}: 报错应含键名 ${k}。实际: ${r.problems[0] ?? '(无)'}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('正对照：纯副本不改动矩阵 pass', () => {
  const root = fakeRepo()
  try {
    const r = runConfigMatrix(root)
    assert.equal(r.pass, true, '真实文件副本矩阵应绿（存量 16/19 无洞）')
    assert.ok(r.lines.some((l) => l.includes('lan-proxy 16 键')), 'lan-proxy 摘要含 16 键计数')
    assert.ok(r.lines.some((l) => l.includes('notifier 19 键')), 'notifier 摘要含 19 键计数')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- lan-proxy 方向 ----

test('lan-proxy: 删 FILE_CONFIG_VALIDATORS 一键 → 红且报错含键名', () => {
  assertRed('lan-proxy 删 validators.enabled', (root) => {
    edit(root, 'dsh-lan-proxy', 'config.ts', (s) => s.replace(/  enabled: \(v\) => typeof v === "boolean",\n/, ''))
  }, 'enabled')
})

test('lan-proxy: DEFAULTS 增 schema 外键 → 红且报错含键名', () => {
  assertRed('lan-proxy DEFAULTS 加 fakeKey', (root) => {
    edit(root, 'dsh-lan-proxy', 'client/index.ts', (s) =>
      s.replace('  var DEFAULTS: Record<string, any> = {', '  var DEFAULTS: Record<string, any> = {\n    fakeKey: 1,'))
  }, 'fakeKey')
})

test('lan-proxy: 删 Config schema 键 → 红且报错含键名', () => {
  assertRed('lan-proxy 删 schema.host', (root) => {
    edit(root, 'dsh-lan-proxy', 'config.ts', (s) => s.replace(/  host: z\.string\(\)\.default\(DEFAULT_OPTIONS\.host\),\n/, ''))
  }, 'host')
})

test('lan-proxy: DEFAULTS 删非豁免可编辑键 → 红且报错含键名', () => {
  assertRed('lan-proxy DEFAULTS 删 tlsCertFile', (root) => {
    edit(root, 'dsh-lan-proxy', 'client/index.ts', (s) => s.replace(/    tlsCertFile: "",\n/, ''))
  }, 'tlsCertFile')
})

// ---- notifier 方向 ----

test('notifier: 删 DEFAULT_CONFIG 一键 → 红且报错含键名', () => {
  assertRed('notifier 删 DEFAULT_CONFIG.maxConnections', (root) => {
    edit(root, 'dsh-notifier', 'config.ts', (s) => s.replace(/  maxConnections: 16,\n/, ''))
  }, 'maxConnections')
})

test('notifier: SETTING_HINTS 加假键 → 红且报错含键名', () => {
  assertRed('notifier SETTING_HINTS 加 bogusKey', (root) => {
    edit(root, 'dsh-notifier', 'config.ts', (s) =>
      s.replace('const SETTING_HINTS: Record<string, string> = {', 'const SETTING_HINTS: Record<string, string> = {\n  bogusKey: "x",'))
  }, 'bogusKey')
})

test('notifier: CONFIG_KEYS 漏布尔键 → 红且报错含键名', () => {
  assertRed('notifier CONFIG_KEYS 删 notifySound', (root) => {
    edit(root, 'dsh-notifier', 'config.ts', (s) => s.replace(/,\s*"notifySound"\]/, ']'))
  }, 'notifySound')
})

test('notifier: normalizeConfig 漏归一化分支 → 红且报错含键名', () => {
  assertRed('notifier normalize 漏 channels', (root) => {
    edit(root, 'dsh-notifier', 'config.ts', (s) =>
      s.replace(/  if \(Array\.isArray\(src\.channels\)\) base\.channels = normalizeBarkChannels\(src\.channels\);\n/, ''))
  }, 'channels')
})

test('notifier: normalizeConfig 漏安静时段内嵌子键分支 → 红', () => {
  assertRed('notifier normalize 漏 qh.start 子键', (root) => {
    edit(root, 'dsh-notifier', 'config.ts', (s) => {
      // 整行删除：以 base.quietHours.start 赋值 + 前导行片段为锚
      const lines = s.split('\n')
      const idx = lines.findIndex((l) => l.includes('base.quietHours.start = qh.start'))
      assert.notEqual(idx, -1, 'fixture 应含 quietHours.start 归一化行')
      lines.splice(idx, 1)
      return lines.join('\n')
    })
  }, 'start')
})

test('notifier: 客户端 EVENT_KEYS 删事件键 → 红且报错含键名', () => {
  assertRed('notifier 客户端删 notifyTurnEnd', (root) => {
    edit(root, 'dsh-notifier', 'client/index.ts', (s) => s.replace(/    \["notifyTurnEnd", "evtTurnEnd"\],\n/, ''))
  }, 'notifyTurnEnd')
})

test('notifier: 客户端渲染 validators 外键 → 红且报错含键名', () => {
  assertRed('notifier 客户端 settings.ghostKey', (root) => {
    edit(root, 'dsh-notifier', 'client/index.ts', (s) =>
      s.replace('    var qh = settings.quietHours || {};', '    var ghost = settings.ghostKey || {};\n    var qh = settings.quietHours || {};'))
  }, 'ghostKey')
})

test('notifier: 客户端引用豁免键（豁免残留）→ 红且报错含豁免键名', () => {
  assertRed('notifier 客户端引用 allowKinds', (root) => {
    edit(root, 'dsh-notifier', 'client/index.ts', (s) =>
      s.replace('    var qh = settings.quietHours || {};', '    var ak = settings.allowKinds || [];\n    var qh = settings.quietHours || {};'))
  }, 'allowKinds')
})
