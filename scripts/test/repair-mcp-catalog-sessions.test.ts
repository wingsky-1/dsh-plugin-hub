#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * repair-mcp-catalog-sessions（#723）：历史会话 source 形态一次性修复的自测。
 *
 * 全部在 mkdtemp 隔离目录内造合成会话产物（产物零污染纪律 #218），不触碰真实
 * `~/.dsh`。回归底线：修复后的产物必须能被**宿主自己的** v0→v1→v2→v3 迁移链跑通
 * ——这正是修复前会抛 `cannot safely transform unclassified message source` 的那条链。
 * 宿主包不可达时（无网络 / 未装 dsh）端到端用例自动跳过，其余用例仍硬断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CATALOG_SECTION_NAME,
  CATALOG_SOURCE_PLUGIN,
  applyRepair,
  decodeLines,
  encodeFrames,
  isLegacyCatalogSource,
  migrationCandidate,
  parseArgs,
  planSession,
  rewriteRow,
  scanFrames,
  verifyRepaired,
} from '../maintenance/repair-mcp-catalog-sessions.mjs'

const LEGACY_SOURCE = { kind: 'mcp-catalog', form: 'catalog', entries: [{ name: 'playwright', text: 'browser automation' }] }
const NEW_SOURCE = { kind: 'plugin', plugin: CATALOG_SOURCE_PLUGIN, form: 'snapshot', sections: [{ name: CATALOG_SECTION_NAME, text: 'catalog' }] }
const CATALOG_TEXT = '<system-reminder>\n<available_mcp_servers>\n- `playwright`: browser automation\n</available_mcp_servers>\n</system-reminder>'

/** 造一份 v0 会话产物：header 一帧 + 事件一帧（与宿主写盘布局一致）。 */
function writeV0Log(dir, { spliced = false, source = LEGACY_SOURCE } = {}) {
  const header = { type: 'session', version: 0, id: 'session-test', createdAt: 1789101518091, delegationDepth: 0, cwd: '/tmp' }
  const message = { id: 'msg-1', role: 'user', content: [{ type: 'text', text: CATALOG_TEXT }], source }
  const rows = [
    header,
    { type: 'request/header', seq: 0, time: 1, data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    spliced
      ? { type: 'agent/inbox/spliced', seq: 2, time: 3, data: { target: 'next-turn', start: 0, inserted: [message] } }
      : { type: 'user/message', seq: 2, time: 3, data: message, surfaceOp: 'append' },
  ]
  const path = join(dir, 'session.jsonl.zstd')
  writeFileSync(path, encodeFrames(rows.map((row) => JSON.stringify(row))))
  return path
}

/** 隔离的 DSH_HOME + 单个会话目录。 */
function withSession(run) {
  const root = mkdtempSync(join(tmpdir(), 'repair-mcp-catalog-'))
  try {
    const sessionDir = join(root, 'sessions', '--tmp-proj--', 'session-test')
    mkdirSync(sessionDir, { recursive: true })
    return run({ root, sessionDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** 装载宿主迁移链所需的包；宿主不可达时返回 undefined（端到端用例跳过）。
 * 包在跑 dsh 的 node 前缀里（`<prefix>/lib/node_modules`），仓库 node_modules 里没有。 */
async function loadHostChain() {
  const candidates = [
    process.env.DSH_HOST_NODE_MODULES,
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules'),
    join(process.cwd(), 'node_modules'),
  ].filter((value) => typeof value === 'string' && value.length > 0)
  let base
  for (const candidate of candidates) {
    try {
      const require = createRequire(join(candidate, 'anchor.js'))
      base = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'node_modules', '@deepseek-ai')
      break
    } catch {
      continue
    }
  }
  if (base === undefined) return undefined
  const load = (name) => import(pathToFileURL(join(base, name, 'lib', 'index.js')).href)
  try {
    const [format, v0, v1, v2] = await Promise.all([
      load('dsh-session-format'),
      load('dsh-session-format-v0-to-v1'),
      load('dsh-session-format-v1-to-v2'),
      load('dsh-session-format-v2-to-v3'),
    ])
    return { format, v0, v1, v2 }
  } catch {
    return undefined
  }
}

/** 用宿主真实迁移链把 v0 行回放到 v3；失败时抛出宿主原始错误。 */
async function runHostMigration(chain, lines) {
  const [headerRow, ...eventRows] = lines.map((line) => JSON.parse(line))
  const decoded = new chain.format.SessionFormatEventCollector()
  const ctx = { emitEvent: (event) => decoded.emitEvent(event), emitRun: (run) => decoded.emitRun(run) }
  const decoder = chain.v0.releasedV0SessionFormatCodec.createDecoder(headerRow, 'strict')
  for (const row of eventRows) decoder.decodeRow(row, ctx)
  const cut = decoder.finish(ctx)
  let header = { version: 0, id: headerRow.id, createdAt: headerRow.createdAt, cwd: headerRow.cwd, isSeeded: false, delegationDepth: 0 }
  let events = decoded.values
  for (const migration of [chain.v0.sessionFormatV0ToV1, chain.v1.sessionFormatV1ToV2, chain.v2.sessionFormatV2ToV3]) {
    const out = new chain.format.SessionFormatEventCollector()
    const outCtx = { emitEvent: (event) => out.emitEvent(event), emitRun: (run) => out.emitRun(run) }
    const stage = migration.createStage({ sourceHeader: header, targetHeader: migration.migrateHeader(header), sourceInheritedEventCount: cut, sourceKind: 'decoded' })
    for (const event of events) stage.transformEvent(event, outCtx)
    stage.finish(outCtx)
    header = migration.migrateHeader(header)
    events = out.values
  }
  return events
}

test('scanFrames/encodeFrames：多帧容器往返，损坏输入判红', () => {
  const buffer = encodeFrames(['{"type":"session"}', '{"seq":1}'])
  assert.equal(scanFrames(buffer).length, 2)
  assert.deepEqual(decodeLines(buffer), ['{"type":"session"}', '{"seq":1}'])
  assert.throws(() => scanFrames(Buffer.from([1, 2, 3, 4, 5])), /invalid frame magic/)
})

test('rewriteRow：user/message 路径改写，正文照抄原消息正文', () => {
  const { row, changed } = rewriteRow({ type: 'user/message', data: { source: LEGACY_SOURCE, content: [{ type: 'text', text: CATALOG_TEXT }] } })
  assert.equal(changed, true)
  assert.deepEqual(row.data.source, {
    kind: 'plugin',
    plugin: CATALOG_SOURCE_PLUGIN,
    form: 'snapshot',
    sections: [{ name: CATALOG_SECTION_NAME, text: CATALOG_TEXT }],
  })
})

test('rewriteRow：agent/inbox/spliced 路径改写', () => {
  const { row, changed } = rewriteRow({
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', start: 0, inserted: [{ id: 'm', content: [{ type: 'text', text: CATALOG_TEXT }], source: LEGACY_SOURCE }] },
  })
  assert.equal(changed, true)
  assert.equal(row.data.inserted[0].source.kind, 'plugin')
  assert.equal(row.data.inserted[0].source.sections[0].text, CATALOG_TEXT)
})

test('rewriteRow：非目录消息与已改写形态零改动（幂等）', () => {
  assert.equal(rewriteRow({ type: 'user/message', data: { source: { kind: 'user' } } }).changed, false)
  assert.equal(rewriteRow({ type: 'user/message', data: { source: NEW_SOURCE } }).changed, false)
  assert.equal(isLegacyCatalogSource(NEW_SOURCE), false)
  assert.equal(isLegacyCatalogSource(LEGACY_SOURCE), true)
})

test('migrationCandidate：取版本最高且 < 3 的日志', () => {
  assert.deepEqual(migrationCandidate(['session.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.lock']), { file: 'session.v2.jsonl.zstd', version: 2 })
  assert.deepEqual(migrationCandidate(['session.v0.jsonl.zstd']), { file: 'session.v0.jsonl.zstd', version: 0 })
  assert.equal(migrationCandidate(['session.v3.jsonl.zstd', 'session.lock']), undefined)
})

test('planSession/applyRepair：干跑不动盘、落盘带备份、再跑幂等', () => {
  withSession(({ sessionDir }) => {
    const path = writeV0Log(sessionDir)
    const before = readFileSync(path)
    const plan = planSession(sessionDir)
    assert.equal(plan.status, 'needs-repair')
    assert.equal(plan.sources, 1)
    assert.deepEqual(readFileSync(path), before, '干跑不得改动产物')

    applyRepair(sessionDir, plan.file, plan.rows)
    const after = readFileSync(path)
    assert.notDeepEqual(after, before, 'apply 后产物应更新')
    assert.equal(decodeLines(after).filter((line) => line.includes('"kind":"mcp-catalog"')).length, 0)

    const backups = readdirSync(sessionDir).filter((name) => name.startsWith('session.jsonl.zstd.bak-'))
    assert.equal(backups.length, 1)
    assert.deepEqual(readFileSync(join(sessionDir, backups[0])), before, '备份必须与修复前逐字节一致')

    assert.equal(planSession(sessionDir).status, 'clean', '已修复的产物不得再次命中')
  })
})

test('verifyRepaired：遗留旧 kind 判红', () => {
  assert.throws(() => verifyRepaired(encodeFrames(['{"type":"session"}', '{"source":{"kind":"mcp-catalog"}}'])), /still carries 1 legacy catalog source/)
  assert.equal(verifyRepaired(encodeFrames(['{"type":"session"}', '{"source":{"kind":"plugin"}}'])).rows, 2)
})

test('parseArgs：默认 dry-run，支持 --apply/--session/--home', () => {
  assert.equal(parseArgs([]).apply, false)
  assert.equal(parseArgs(['--apply']).apply, true)
  assert.equal(parseArgs(['--session', 'session-x']).session, 'session-x')
  assert.equal(parseArgs(['--home=/tmp/h']).home, '/tmp/h')
  assert.throws(() => parseArgs(['--nope']), /unknown argument/)
})

test('端到端：修复前宿主迁移被拒，修复后同一条链跑通（user/message）', async (t) => {
  const chain = await loadHostChain()
  if (chain === undefined) return t.skip('宿主 @deepseek-ai/dsh 不可达')
  const root = mkdtempSync(join(tmpdir(), 'repair-e2e-'))
  {
    try {
      const path = writeV0Log(root)
      const before = decodeLines(readFileSync(path))
      await assert.rejects(() => runHostMigration(chain, before), /unclassified message source/)

      const stats = { sources: 0 }
      const repaired = before.map((line) => JSON.stringify(rewriteRow(JSON.parse(line), stats).row))
      assert.equal(stats.sources, 1)

      const events = await runHostMigration(chain, repaired)
      assert.ok(events.length >= 3, '修复后迁移应产出 v3 事件')
      const catalogEvent = events.find((event) => event.type === 'user/message')
      assert.equal(catalogEvent.data.source.kind, 'plugin')
      assert.equal(catalogEvent.data.source.plugin, CATALOG_SOURCE_PLUGIN)
      assert.equal(catalogEvent.data.source.form, 'snapshot')
      assert.equal(catalogEvent.data.source.sections[0].text, CATALOG_TEXT)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('端到端：修复前宿主迁移被拒，修复后同一条链跑通（agent/inbox/spliced）', async (t) => {
  const chain = await loadHostChain()
  if (chain === undefined) return t.skip('宿主 @deepseek-ai/dsh 不可达')
  const root = mkdtempSync(join(tmpdir(), 'repair-e2e-spliced-'))
  try {
    const path = writeV0Log(root, { spliced: true })
    const before = decodeLines(readFileSync(path))
    await assert.rejects(() => runHostMigration(chain, before), /unclassified message source/)

    const stats = { sources: 0 }
    const repaired = before.map((line) => JSON.stringify(rewriteRow(JSON.parse(line), stats).row))
    assert.equal(stats.sources, 1)

    const events = await runHostMigration(chain, repaired)
    const spliced = events.find((event) => event.type === 'agent/inbox/spliced')
    assert.equal(spliced.data.inserted[0].source.kind, 'plugin')
    assert.equal(spliced.data.inserted[0].source.sections[0].text, CATALOG_TEXT)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
