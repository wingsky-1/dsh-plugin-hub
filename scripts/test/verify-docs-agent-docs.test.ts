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

test('不误报：绝对 URL 与正则示例文本都不算链接；锚点有目标即通过', () => {
  const dir = fixture({
    agentFiles: {
      'AGENTS.md': [
        '<a id="top"></a>',
        '见 [节](docs/DEVELOPMENT.md#sec) · [外](https://example.com/a.md) · [锚](#top)',
        '',
        '锁版形如 `@deepseek-ai/[a-z0-9-]+|cordis|schemastery` 的写法。',
        '',
      ].join('\n'),
      'docs/DEVELOPMENT.md': '<a id="sec"></a>\n## sec\n',
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

test('命令存在性：文档里写不存在的 pnpm 命令 → exit 1 且点名（#693）', () => {
  // 防「文档写出不存在的门禁命令」——human 与 agent 都会照抄。
  const dir = fixture({ agentFiles: { 'AGENTS.md': '跑 `pnpm gate:does-not-exist` 即可。\n' } })
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /引用了不存在的 pnpm 命令 gate:does-not-exist/)
})

test('命令存在性：真实命令与 pnpm 自带子命令都不误报', () => {
  const dir = fixture({
    agentFiles: {
      'AGENTS.md': '跑 `pnpm build`；安装用 `pnpm install`；发版用 `pnpm publish`；`pnpm test:scripts` 亦真。\n',
    },
  })
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
})

test('命令存在性：docs/ 下的引用同样被校验（门禁命令最常写在这里）', () => {
  const dir = fixture({ agentFiles: { 'docs/GUIDE.md': '见 `pnpm nope:cmd`。\n' } })
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /GUIDE\.md: 引用了不存在的 pnpm 命令 nope:cmd/)
})

test('锚点：裸 slug href 判红——GitHub 会给标题 id 加 user-content- 前缀（#693 实测）', () => {
  // 这正是 AGENTS.md #0-构建总览 / #1-宿主端srcindexts规范 三处断链的成因
  const dir = fixture({
    agentFiles: { 'AGENTS.md': '见 [§1](docs/DEVELOPMENT.md#1-宿主端规范)。\n', 'docs/DEVELOPMENT.md': '## 1. 宿主端规范\n' },
  })
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /锚点 #1-宿主端规范 在 docs\/DEVELOPMENT\.md 中不存在/)
})

test('锚点：显式双锚（含 user-content- 形态）可解析 → 通过', () => {
  const dir = fixture({
    agentFiles: {
      'AGENTS.md': '见 [§1](docs/DEVELOPMENT.md#1-宿主端规范) 与 [§5](docs/DEVELOPMENT.md#user-content-5-smoke)。\n',
      'docs/DEVELOPMENT.md':
        '<a id="1-宿主端规范"></a><a id="user-content-1-宿主端规范"></a>\n## 1. 宿主端规范\n\n' +
        '<a id="5-smoke"></a><a id="user-content-5-smoke"></a>\n## 5. Smoke\n',
    },
  })
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
})

test('锚点：标题 slug 推导（user-content-<slug>）也算有效', () => {
  const dir = fixture({
    agentFiles: {
      'AGENTS.md': '见 [机制](docs/A.md#user-content-通用机制)。\n',
      'docs/A.md': '## 通用机制\n',
    },
  })
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
})

test('锚点：同文件锚点（含 HTML href 写法）同样被校验', () => {
  const broken = fixture({ agentFiles: { 'docs/A.md': '见 [x](#不存在)。\n' } })
  const r1 = run(broken)
  assert.equal(r1.status, 1)
  assert.match(r1.stderr, /锚点 #不存在 在\s*本文件\s*中不存在/)

  const htmlBroken = fixture({ agentFiles: { 'docs/A.md': '<a href="#也没有">看</a>\n' } })
  assert.equal(run(htmlBroken).status, 1, 'HTML href 形态必须纳入发现面')

  const ok = fixture({ agentFiles: { 'docs/A.md': '<a id="通用机制"></a>\n## 通用机制\n\n见 [x](#通用机制)。\n' } })
  assert.equal(run(ok).status, 0)
})
