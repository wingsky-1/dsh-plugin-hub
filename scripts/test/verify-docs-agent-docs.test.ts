#!/usr/bin/env node
// @ts-nocheck
/**
 * verify-docs 的 agent 规则文档链接面自测（#693）。
 *
 * 为什么存在：根 AGENTS.md / 包级 AGENTS.md / .dsh/skills/ / agents/ 此前**完全在
 * 门禁面之外**（verify-docs 只查各包 README），这正是过期规则（worktree 路径、
 * 已 CLOSED 的 issue 引用、指向已删小节的链接）能长期存活的机制性原因。
 *
 * 本面比 README 面更严：README 面只认 `./` / `../` 前缀（isRelLink），而 agent 规则
 * 文档里最常用的是**裸相对路径**（`docs/DEVELOPMENT.md`、`agents/_protocol.md`）。
 * 故 fixture 刻意使用裸路径——若实现退回只认带前缀的写法，本测试立刻红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = join(import.meta.dirname, '../..')
const GATE = join(ROOT, 'scripts/gate/verify-docs.ts')

/** 构造最小 fixture 仓库：packages/dsh-fake 一个包 + 可选 agent 规则文件。 */
function fixture({ agentFiles = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-docs-agent-'))
  mkdirSync(join(dir, 'packages/dsh-fake'), { recursive: true })
  writeFileSync(join(dir, 'packages/dsh-fake/README.md'), '# fake\n')
  writeFileSync(
    join(dir, 'packages/dsh-fake/package.json'),
    JSON.stringify({ name: '@wingsky-1/dsh-fake', description: 'fixture' }),
  )
  for (const [rel, content] of Object.entries(agentFiles)) {
    const p = join(dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  return dir
}

function run(root, extraArgs = []) {
  try {
    return spawnSync(process.execPath, [GATE, '--root', root, ...extraArgs], { encoding: 'utf8' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('正例：裸相对路径全部有效 → exit 0，且计入扫描计数', () => {
  const dir = fixture({
    agentFiles: {
      'AGENTS.md': '# root\n\n见 [docs](docs/DEVELOPMENT.md) 与 [协议](agents/_protocol.md)。\n',
      'docs/DEVELOPMENT.md': '# dev\n',
      'agents/_protocol.md': '# protocol\n',
      '.dsh/skills/demo/SKILL.md': '# skill\n\n见 [dev](../../../docs/DEVELOPMENT.md)。\n',
    },
  })
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
  // 3 个 agent 规则文档：根 AGENTS.md + skill + agents/_protocol.md（docs/DEVELOPMENT.md 不算）
  assert.match(r.stdout, /\+ 3 个 agent 规则文档/)
})

test('反例：根 AGENTS.md 的**裸相对路径**失效 → exit 1（README 面认不出的形态）', () => {
  const dir = fixture({ agentFiles: { 'AGENTS.md': '见 [没了](docs/NOPE.md)。\n' } })
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /AGENTS\.md: 相对链接目标缺失 docs\/NOPE\.md/)
})

test('反例：包级 AGENTS.md 链接失效也被覆盖', () => {
  const dir = fixture({ agentFiles: { 'packages/dsh-fake/AGENTS.md': '见 [x](docs/NOPE.md)。\n' } })
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /AGENTS\.md: 相对链接目标缺失 docs\/NOPE\.md/)
})

test('反例：.dsh/skills 深层 SKILL.md 也被覆盖（inSkills 递归下传）', () => {
  const dir = fixture({ agentFiles: { '.dsh/skills/a/b/SKILL.md': '见 [x](deep/NOPE.md)。\n' } })
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /SKILL\.md: 相对链接目标缺失 deep\/NOPE\.md/)
})

test('反例：相对文件与相对仓库根都不存在才判红（GitHub 裸路径语义）', () => {
  const dir = fixture({ agentFiles: { '.dsh/skills/x/SKILL.md': '见 [x](docs/NOPE.md)。\n' } })
  assert.equal(run(dir).status, 1)
})

test('不误报：锚点 / 绝对 URL / 正则示例文本都不算链接', () => {
  const dir = fixture({
    agentFiles: {
      'AGENTS.md': [
        '见 [节](docs/DEVELOPMENT.md#sec) · [外](https://example.com/a.md) · [锚](#top)',
        '',
        '锁版形如 `@deepseek-ai/[a-z0-9-]+|cordis|schemastery` 的写法。',
        '',
      ].join('\n'),
      'docs/DEVELOPMENT.md': '# dev\n',
    },
  })
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
})

test('覆盖面自锁：真实仓库上 agent 规则文档数 > 0（防 walk 条件被改窄成空转）', () => {
  const r = spawnSync(process.execPath, [GATE, '--strict-en'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const m = r.stdout.match(/\+ (\d+) 个 agent 规则文档/)
  assert.ok(m, `输出缺少 agent 规则文档计数：${r.stdout}`)
  assert.ok(Number(m[1]) >= 20, `真实仓库应扫到 ≥20 个 agent 规则文档，实际 ${m[1]}——walk 条件疑似被改窄`)
})
