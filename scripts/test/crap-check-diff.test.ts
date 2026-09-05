#!/usr/bin/env node
// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  parseGitDiff,
  mapNewToOldLine,
  mapOldToNewLine,
  isFunctionTouched,
  findBaseFunction,
  functionsOf,
  complexityOf,
} from '../gate/crap-check.mjs'

const ROOT = join(import.meta.dirname, '../..')
const SCRIPT = join(ROOT, 'scripts/gate/crap-check.mjs')

// ── 单元测试：Diff 解析与行号映射算法 ──────────────────────────────

test('parseGitDiff: 正确解析 unified diff hunk 并提取变更行号集合', () => {
  const diffSample = `
diff --git a/packages/fake/lib/index.js b/packages/fake/lib/index.js
index 1111111..2222222 100644
--- a/packages/fake/lib/index.js
+++ b/packages/fake/lib/index.js
@@ -10,3 +10,5 @@
 funcA()
`
  const diffMap = parseGitDiff(diffSample.trim())
  assert.ok(diffMap.has('packages/fake/lib/index.js'))
  const entry = diffMap.get('packages/fake/lib/index.js')
  assert.equal(entry.hunks.length, 1)
  assert.deepEqual(entry.hunks[0], { oldStart: 10, oldCount: 3, newStart: 10, newCount: 5 })
  // newChangedLines: 10, 11, 12, 13, 14
  assert.equal(entry.newChangedLines.size, 5)
  assert.ok(entry.newChangedLines.has(10))
  assert.ok(entry.newChangedLines.has(14))
  assert.ok(!entry.newChangedLines.has(15))
  // oldChangedLines: 10, 11, 12
  assert.equal(entry.oldChangedLines.size, 3)
  assert.ok(entry.oldChangedLines.has(10))
  assert.ok(entry.oldChangedLines.has(12))
})

test('mapNewToOldLine & mapOldToNewLine: 准确处理增删与行号偏移', () => {
  // 场景：在第 5 行替换了 2 行为 4 行（行数净增 2 行）
  const hunks = [{ oldStart: 5, oldCount: 2, newStart: 5, newCount: 4 }]

  // 1. hunk 前的行号映射一致
  assert.equal(mapNewToOldLine(1, hunks), 1)
  assert.equal(mapNewToOldLine(4, hunks), 4)
  assert.equal(mapOldToNewLine(1, hunks), 1)
  assert.equal(mapOldToNewLine(4, hunks), 4)

  // 2. hunk 内部的改动行映射为 null
  assert.equal(mapNewToOldLine(5, hunks), null)
  assert.equal(mapNewToOldLine(8, hunks), null)
  assert.equal(mapOldToNewLine(5, hunks), null)
  assert.equal(mapOldToNewLine(6, hunks), null)

  // 3. hunk 之后的行号精准偏移（new 行 9 对应 old 行 7；old 行 7 对应 new 行 9）
  assert.equal(mapNewToOldLine(9, hunks), 7)
  assert.equal(mapOldToNewLine(7, hunks), 9)
})

test('isFunctionTouched: 仅触及范围内的函数返回 true，其余豁免', () => {
  const fileDiff = {
    isNew: false,
    newChangedLines: new Set([20, 21, 22]),
    hunks: [{ oldStart: 20, oldCount: 1, newStart: 20, newCount: 3 }],
  }

  // 函数 A：行 1~10（在改动之前，未触及）
  assert.equal(isFunctionTouched({ startLine: 1, endLine: 10 }, fileDiff), false)

  // 函数 B：行 18~25（改动行 20~22 落在函数内，触及）
  assert.equal(isFunctionTouched({ startLine: 18, endLine: 25 }, fileDiff), true)

  // 函数 C：行 30~40（在改动之后，未触及）
  assert.equal(isFunctionTouched({ startLine: 30, endLine: 40 }, fileDiff), false)

  // 新增文件一律触及
  assert.equal(isFunctionTouched({ startLine: 1, endLine: 5 }, { isNew: true, hunks: [] }), true)
})

test('findBaseFunction: 支持行号映射与同名函数查找', () => {
  const baseFns = [
    { name: 'foo', startLine: 10, endLine: 20, comp: 5 },
    { name: 'bar', startLine: 30, endLine: 40, comp: 8 },
  ]
  const hunks = [{ oldStart: 5, oldCount: 2, newStart: 5, newCount: 4 }] // 偏移 +2

  // 1. 行号映射命中（new 行 32 对应 old 行 30）
  const matchA = findBaseFunction({ name: 'bar', startLine: 32, endLine: 42 }, baseFns, hunks)
  assert.ok(matchA)
  assert.equal(matchA.name, 'bar')

  // 2. 声明行被修改但名称相同命中
  const matchB = findBaseFunction({ name: 'foo', startLine: 7, endLine: 20 }, baseFns, hunks)
  assert.ok(matchB)
  assert.equal(matchB.name, 'foo')

  // 3. 全新函数返回 null
  const matchC = findBaseFunction({ name: 'brandNewFunc', startLine: 50, endLine: 60 }, baseFns, hunks)
  assert.equal(matchC, null)
})

// ── 端到端测试辅助：搭建临时 Git Fixture ────────────────────────────

function setupGitFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'crap-diff-test-'))

  // 初始化 git 仓库
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'test-bot'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'test@bot.local'], { cwd: dir, stdio: 'pipe' })

  mkdirSync(join(dir, 'scripts/data'), { recursive: true })
  mkdirSync(join(dir, 'coverage'), { recursive: true })
  mkdirSync(join(dir, 'packages/fake/lib'), { recursive: true })

  // 写入默认配置：threshold=16, strict=false
  writeFileSync(join(dir, 'scripts/data/gauntlet.config.json'), JSON.stringify({ crap: { threshold: 16, strict: false } }))

  return dir
}

// ── 端到端集成测试：拦截与放行逻辑 ──────────────────────────────

test('#592 crap-check --diff: 新增函数 CRAP 超标拦截（exit 1）', () => {
  const dir = setupGitFixture()
  try {
    const pkgLib = join(dir, 'packages/fake/lib/index.js')
    writeFileSync(pkgLib, 'function baseFunc() { return 1; }\nbaseFunc();\n')
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, stdio: 'pipe' })

    // 在 PR 中新增超标函数（复杂度为 5，未覆盖，CRAP = 5^2 * 1 + 5 = 30 > 16）
    const newCode = `function baseFunc() { return 1; }
baseFunc();

function complexNew(a, b, c, d) {
  if (a) return 1;
  if (b) return 2;
  if (c) return 3;
  if (d) return 4;
  return 0;
}
`
    writeFileSync(pkgLib, newCode)
    writeFileSync(join(dir, 'coverage/coverage-final.json'), JSON.stringify({
      [pkgLib]: {
        fnMap: {
          '0': { loc: { start: { line: 1, column: 0 } } },
          '1': { loc: { start: { line: 4, column: 0 } } },
        },
        f: { '0': 1, '1': 0 }, // complexNew 未覆盖
      },
    }))

    const res = spawnSync(process.execPath, [SCRIPT, '--diff', 'HEAD'], { cwd: dir, encoding: 'utf8' })
    assert.equal(res.status, 1, `新增超标函数必须 exit 1，实际输出：${res.stdout} ${res.stderr}`)
    assert.match(res.stderr, /\[新增超标\]/)
    assert.match(res.stderr, /complexNew/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#592 crap-check --diff: 新增函数 CRAP 合规放行（exit 0）', () => {
  const dir = setupGitFixture()
  try {
    const pkgLib = join(dir, 'packages/fake/lib/index.js')
    writeFileSync(pkgLib, 'function baseFunc() { return 1; }\nbaseFunc();\n')
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, stdio: 'pipe' })

    // 在 PR 中新增合规函数（复杂度 2，未覆盖，CRAP = 2^2 * 1 + 2 = 6 <= 16）
    const newCode = `function baseFunc() { return 1; }
baseFunc();

function simpleNew(a) {
  if (a) return 1;
  return 0;
}
`
    writeFileSync(pkgLib, newCode)
    writeFileSync(join(dir, 'coverage/coverage-final.json'), JSON.stringify({
      [pkgLib]: {
        fnMap: {
          '0': { loc: { start: { line: 1, column: 0 } } },
          '1': { loc: { start: { line: 4, column: 0 } } },
        },
        f: { '0': 1, '1': 0 },
      },
    }))

    const res = spawnSync(process.execPath, [SCRIPT, '--diff', 'HEAD'], { cwd: dir, encoding: 'utf8' })
    assert.equal(res.status, 0, `新增合规函数必须 exit 0，实际输出：${res.stdout} ${res.stderr}`)
    assert.match(res.stdout, /OK - base=HEAD/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#592 crap-check --diff: 修改存量超标函数导致复杂度恶化拦截（exit 1）', () => {
  const dir = setupGitFixture()
  try {
    const pkgLib = join(dir, 'packages/fake/lib/index.js')
    // base: 存量超标函数，复杂度 4，未覆盖，CRAP = 4^2 + 4 = 20 > 16
    const baseCode = `function legacyHeavy(a, b, c) {
  if (a) return 1;
  if (b) return 2;
  if (c) return 3;
  return 0;
}
legacyHeavy();
`
    writeFileSync(pkgLib, baseCode)
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, stdio: 'pipe' })

    // PR 修改该函数，增加了分支，复杂度从 4 提升到 5（CRAP 恶化为 30）
    const regressedCode = `function legacyHeavy(a, b, c, d) {
  if (a) return 1;
  if (b) return 2;
  if (c) return 3;
  if (d) return 4;
  return 0;
}
legacyHeavy();
`
    writeFileSync(pkgLib, regressedCode)
    writeFileSync(join(dir, 'coverage/coverage-final.json'), JSON.stringify({
      [pkgLib]: {
        fnMap: { '0': { loc: { start: { line: 1, column: 0 } } } },
        f: { '0': 0 }, // 未覆盖
      },
    }))

    const res = spawnSync(process.execPath, [SCRIPT, '--diff', 'HEAD'], { cwd: dir, encoding: 'utf8' })
    assert.equal(res.status, 1, `存量恶化必须 exit 1，实际输出：${res.stdout} ${res.stderr}`)
    assert.match(res.stderr, /\[存量恶化\]/)
    assert.match(res.stderr, /legacyHeavy/)
    assert.match(res.stderr, /CRAP 恶化: 20 -> 30/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#592 crap-check --diff: 修改存量超标函数但复杂度降低/持平放行（exit 0）', () => {
  const dir = setupGitFixture()
  try {
    const pkgLib = join(dir, 'packages/fake/lib/index.js')
    // base: 存量超标函数，复杂度 5，未覆盖，CRAP = 5^2 + 5 = 30 > 16
    const baseCode = `function legacyHeavy(a, b, c, d) {
  if (a) return 1;
  if (b) return 2;
  if (c) return 3;
  if (d) return 4;
  return 0;
}
legacyHeavy();
`
    writeFileSync(pkgLib, baseCode)
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, stdio: 'pipe' })

    // PR 重构该函数，减少了分支，复杂度从 5 降为 4（CRAP 从 30 降为 20，虽仍 > 16 但防劣化放行）
    const improvedCode = `function legacyHeavy(a, b, c) {
  if (a) return 1;
  if (b) return 2;
  if (c) return 3;
  return 0;
}
legacyHeavy();
`
    writeFileSync(pkgLib, improvedCode)
    writeFileSync(join(dir, 'coverage/coverage-final.json'), JSON.stringify({
      [pkgLib]: {
        fnMap: { '0': { loc: { start: { line: 1, column: 0 } } } },
        f: { '0': 0 },
      },
    }))

    const res = spawnSync(process.execPath, [SCRIPT, '--diff', 'HEAD'], { cwd: dir, encoding: 'utf8' })
    assert.equal(res.status, 0, `存量优化必须 exit 0 放行，实际输出：${res.stdout} ${res.stderr}`)
    assert.match(res.stdout, /全部合规放行/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#592 crap-check --diff: 未触及的存量超标函数全部豁免报警（exit 0）', () => {
  const dir = setupGitFixture()
  try {
    const pkgLib = join(dir, 'packages/fake/lib/index.js')
    // base 包含一个严重超标的存量函数和一个普通函数
    const baseCode = `function untouchedHeavy(a, b, c, d, e) {
  if (a) return 1;
  if (b) return 2;
  if (c) return 3;
  if (d) return 4;
  if (e) return 5;
  return 0;
}

function touchedSmall(x) {
  return x + 1;
}
untouchedHeavy();
touchedSmall(1);
`
    writeFileSync(pkgLib, baseCode)
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, stdio: 'pipe' })

    // PR 只修改了 touchedSmall（未触及 untouchedHeavy）
    const newCode = `function untouchedHeavy(a, b, c, d, e) {
  if (a) return 1;
  if (b) return 2;
  if (c) return 3;
  if (d) return 4;
  if (e) return 5;
  return 0;
}

function touchedSmall(x) {
  if (x > 0) return x + 2;
  return 0;
}
untouchedHeavy();
touchedSmall(1);
`
    writeFileSync(pkgLib, newCode)
    writeFileSync(join(dir, 'coverage/coverage-final.json'), JSON.stringify({
      [pkgLib]: {
        fnMap: {
          '0': { loc: { start: { line: 1, column: 0 } } },
          '1': { loc: { start: { line: 10, column: 0 } } },
        },
        f: { '0': 0, '1': 1 }, // touchedSmall covered (comp=2, CRAP=2 <= 16)
      },
    }))

    const res = spawnSync(process.execPath, [SCRIPT, '--diff', 'HEAD'], { cwd: dir, encoding: 'utf8' })
    assert.equal(res.status, 0, `未触及的存量超标函数必须豁免 exit 0，实际输出：${res.stdout} ${res.stderr}`)
    assert.match(res.stdout, /全部合规放行/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#592 crap-check --diff: 无相关代码变更时放行（exit 0）', () => {
  const dir = setupGitFixture()
  try {
    writeFileSync(join(dir, 'README.md'), '# Initial README\n')
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, stdio: 'pipe' })

    // 仅修改 README
    writeFileSync(join(dir, 'README.md'), '# Updated README\n')

    const res = spawnSync(process.execPath, [SCRIPT, '--diff', 'HEAD'], { cwd: dir, encoding: 'utf8' })
    assert.equal(res.status, 0, `无相关变更必须 exit 0，实际输出：${res.stdout} ${res.stderr}`)
    assert.match(res.stdout, /未检测到插件包编译产物/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
