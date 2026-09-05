#!/usr/bin/env node
// @ts-nocheck
/** forbid-homedir-src.mjs 自测（#517 B5）：正反例 + 三态 + fail-closed 全组合。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = join(import.meta.dirname, '../..')
const SCRIPT = join(ROOT, 'scripts/gate/forbid-homedir-src.mjs')

/** 构造最小 fixture 仓库（--root 注入）。pkgFiles: [{ rel, content }] */
function fixture(pkgFiles) {
  const dir = mkdtempSync(join(tmpdir(), 'forbid-homedir-src-test-'))
  mkdirSync(join(dir, 'packages/dsh-fake/src'), { recursive: true })
  for (const { rel, content } of pkgFiles) {
    const p = join(dir, 'packages/dsh-fake/src', rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  return dir
}

function run(root) {
  try {
    return spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('正例：干净 src（无任何 HOME 来源 API）→ exit 0', () => {
  const dir = fixture([{ rel: 'a.ts', content: 'export const a = 1\n' }])
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /OK（扫描 1 文件，无 HOME 来源 API 直连）/)
})

test('正例：shared/dsh-home 式合法接缝不受影响（dshHome 内部实现在 packages 外）', () => {
  const dir = fixture([{
    rel: 'a.ts',
    // 插件 src 调 dshHome()（从 shared 导入）而非 homedir——门禁不命中
    content: 'import { dshHome } from "../../shared/dsh-home.js"\nexport const p = dshHome()\n',
  }])
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
})

test('反例：os.homedir 直连（named import）→ exit 1', () => {
  const dir = fixture([{
    rel: 'a.ts',
    content: 'import { homedir } from "node:os"\nexport const p = join(homedir(), ".dsh")\n',
  }])
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /homedir\(\)（node:os homedir 别名调用）/)
  assert.match(r.stderr, /FAIL（扫描 1 文件，违规 1 /)
})

test('反例：别名 import { homedir as hd } 逃逸 → exit 1', () => {
  const dir = fixture([{
    rel: 'a.ts',
    content: 'import { homedir as hd } from "os"\nexport const p = hd()\n',
  }])
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /hd\(\)（node:os homedir 别名调用）/)
})

test('反例：os["homedir"] 中括号混淆形态 → exit 1', () => {
  const dir = fixture([{
    rel: 'a.ts',
    content: 'import * as os from "node:os"\nexport const p = os["homedir"]()\n',
  }])
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /os\.homedir/)
})

test('反例：process.env.HOME 直连（含中括号形态）→ exit 1', () => {
  const dir = fixture([{
    rel: 'a.ts',
    content: 'export const h = process.env["HOME"]\n',
  }])
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /process\.env\.HOME/)
})

test('反例：os.userInfo()（homedir 别名通道）→ exit 1', () => {
  const dir = fixture([{
    rel: 'a.ts',
    content: 'import * as os from "node:os"\nexport const u = os.userInfo().homedir\n',
  }])
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /os\.userInfo/)
})

test('反例：untildify 直连 → exit 1', () => {
  const dir = fixture([{
    rel: 'a.ts',
    content: 'import untildify from "untildify"\nexport const p = untildify("~/x")\n',
  }])
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /untildify\(\)（untildify 别名调用）/)
})

test('反例：.mjs 文件同样受扫（adapters 旁路防护）→ exit 1', () => {
  const dir = fixture([{
    rel: 'a.mjs',
    content: 'import { homedir } from "node:os"\nexport const p = homedir()\n',
  }])
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /homedir\(\)（node:os homedir 别名调用）/)
})

test('豁免三态：有注释但不在 WHITELIST → FAIL（不合法豁免）', () => {
  const dir = fixture([{
    rel: 'a.ts',
    content: 'import { homedir } from "node:os"\n// dsh-gate:allow-homedir #999 测试理由\nexport const p = homedir()\n',
  }])
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /有豁免注释但文件不在 WHITELIST/)
})

test('豁免三态：豁免注释缺 issue 号 → 不算合法豁免，按违规报', () => {
  const dir = fixture([{
    rel: 'a.ts',
    content: 'import { homedir } from "node:os"\n// dsh-gate:allow-homedir 随手一豁\nexport const p = homedir()\n',
  }])
  const r = run(dir)
  assert.equal(r.status, 1)
  // 无 #NNN → hasExemption 返回 null → 该命中不在 WHITELIST → 违规
  assert.match(r.stderr, /违规 1 /)
})

test('F1：字符串字面量里的伪豁免注释不生效（真实注释词法识别）→ 判违规', () => {
  const dir = fixture([{
    rel: 'a.ts',
    content: 'import { homedir } from "node:os"\nconst msg = "// dsh-gate:allow-homedir #999 字符串伪造"\nexport const p = homedir()\n',
  }])
  const r = run(dir)
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stderr, /违规 1 /)
  assert.ok(!r.stderr.includes('字符串伪造'), '字符串内容不得被当作豁免理由')
})

test('F2：WHITELIST 条目文件存在但本次零命中 → 报已腐烂（非死代码）', () => {
  // 构造与真实 WHITELIST 相对路径同形的文件，但内容无任何 HOME API 命中
  const dir = mkdtempSync(join(tmpdir(), 'forbid-homedir-rot-'))
  mkdirSync(join(dir, 'packages/dsh-provider-usage/src'), { recursive: true })
  writeFileSync(join(dir, 'packages/dsh-provider-usage/src/apply.ts'),
    'export const clean = 1\n') // WHITELIST 含此文件，但零命中
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8' })
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /已腐烂，应删除条目/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F3：dynamic import 命名空间形态（await import("node:os")）→ 判违规', () => {
  const dir = fixture([{
    rel: 'a.ts',
    content: 'export async function g() {\n  const os = await import("node:os")\n  return os.homedir()\n}\n',
  }])
  const r = run(dir)
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stderr, /os\.homedir/)
})

test('F4：参数/局部同名遮蔽不误报（esbuild 自动重命名，锁定行为）', () => {
  const dir = fixture([{
    rel: 'a.ts',
    content: 'import { homedir } from "node:os"\nimport * as os from "node:os"\n'
      + 'export function g(homedir: () => string) { return homedir() }\n'
      + 'export const x = () => { const os = { homedir: () => "x" }; return os.homedir() }\n',
  }])
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /无 HOME 来源 API 直连/)
})

test('P3：--root=<path> 等号形态可用', () => {
  const dir = fixture([{ rel: 'a.ts', content: 'export const a = 1\n' }])
  try {
    const r = spawnSync(process.execPath, [SCRIPT, `--root=${dir}`], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /OK（扫描 1 文件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fail-closed：语法损坏文件（TS 不可解析）→ exit 1 且指明解析失败', () => {
  const dir = fixture([{
    rel: 'broken.ts',
    content: 'export const a = (((\n',
  }])
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /解析失败（fail-closed，一律判红）/)
})

test('本仓真实快照：7 处合法豁免全部识别 → exit 0 且台账一致', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /合法豁免 7 处/)
  for (const f of [
    'packages/dsh-provider-usage/src/apply.ts',
    'packages/dsh-provider-usage/src/path-resolve.ts',
    'packages/dsh-provider-usage/src/provider-config.ts',
    'packages/dsh-web-file-preview/src/git.ts',
    'packages/dsh-web-file-preview/src/routes.ts',
  ]) assert.ok(r.stdout.includes(f), `${f} 应在合法豁免台账中`)
})
