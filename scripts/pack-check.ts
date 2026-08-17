#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * pack-check — 发布打包冒烟：pnpm pack 每个插件 → 解包校验 tarball 内容，
 * 防发布断链（含 lib/.d.ts/README/LICENSE、无 ../../shared 残留）。
 */
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugins = readdirSync(join(ROOT, 'packages')).filter(d => d.startsWith('dsh-') && d !== 'dsh-plugins-all')

/** 浏览器全局 stub（与 contract-check 同构）：仅捕获 __ModuleLoader__.load 注册。 */
function makeSandbox(factories) {
  const noop = () => {}
  const el = () => ({
    style: {}, classList: { add: noop, remove: noop, toggle: noop }, dataset: {},
    children: [], appendChild: noop, removeChild: noop, setAttribute: noop,
    addEventListener: noop, removeEventListener: noop, contains: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }),
    querySelector: () => null, querySelectorAll: () => [],
  })
  const doc = {
    addEventListener: noop, removeEventListener: noop, createElement: el, createElementNS: el,
    body: { appendChild: noop, removeChild: noop, contains: () => false, querySelector: () => null },
    head: { appendChild: noop }, documentElement: { style: {} },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  }
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Symbol, Object, Array, JSON, Math, Date, Promise, String, Number, Boolean,
    Map, Set, WeakMap, WeakSet, RegExp, Error, TypeError, Proxy, Reflect,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    document: doc,
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return [] } },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop },
    Notification: { requestPermission: () => Promise.resolve('default'), permission: 'default' },
    navigator: { userAgent: '', language: 'zh-CN' },
    location: { href: '', protocol: 'http:', host: 'localhost', pathname: '/', origin: 'http://localhost' },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
    requestAnimationFrame: (cb) => setTimeout(cb, 16), cancelAnimationFrame: clearTimeout,
    Event: class {}, CustomEvent: class {}, HTMLElement: function () {},
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  sandbox.__ModuleLoader__ = { load: (h) => factories.set(h.id, h.factory) }
  return sandbox
}

let failed = 0
for (const p of plugins) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
  const name = JSON.parse(readFileSync(join(ROOT, 'packages', p, 'package.json'), 'utf8')).name
  try {
    // pnpm pack 到临时目录
    execFileSync('pnpm', ['--filter', name, 'pack', '--pack-destination', tmp], { cwd: ROOT, stdio: 'pipe' })
    const tgz = readdirSync(tmp).find(f => f.endsWith('.tgz'))
    const unpack = join(tmp, 'unpack')
    execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp])
    const pkgRoot = join(tmp, 'package')

    const problems = []
    if (!existsSync(join(pkgRoot, 'lib', 'index.js'))) problems.push('缺 lib/index.js')
    if (!readdirSync(join(pkgRoot, 'lib')).some(f => f.endsWith('.d.ts'))) problems.push('缺 lib/*.d.ts')
    for (const f of ['README.md', 'LICENSE', 'cordis.patch.yml']) {
      if (!existsSync(join(pkgRoot, f))) problems.push(`缺 ${f}`)
    }
    const idx = readFileSync(join(pkgRoot, 'lib', 'index.js'), 'utf8')
    // 只匹配 import 语句中的仓库外相对引用（esbuild 模块注释含路径文本，不算断链）
    const outsideRef = /(?:from|import)\s*["']\.\.\/\.\.\/(?:shared|types)/.test(idx)
    if (outsideRef) problems.push('lib 残留 ../../shared|types 运行时引用')
    if (!idx.includes('isLoopbackRequest')) problems.push('内联后缺 isLoopbackRequest 导出')

    // client id 契约（tarball 内产物）：load id 必须 === 完整包名——浏览器 arrive()
    // 校验 factories.has(包名) 的同构模拟；防「打包/裁剪后产物与包名脱钩」再犯。
    const clientPath = join(pkgRoot, 'lib', 'client.js')
    if (existsSync(clientPath)) {
      const factories = new Map()
      const sandbox = makeSandbox(factories)
      try {
        vm.createContext(sandbox)
        vm.runInContext(readFileSync(clientPath, 'utf8'), sandbox)
        if (!factories.has(name)) {
          problems.push(`client load id 与包名不一致（注册: ${[...factories.keys()].join(',') || '无'}，期望: ${name}）`)
        }
      } catch (e) {
        problems.push(`client 产物执行失败: ${String(e.message).split('\n')[0]}`)
      }
    }

    // 运行时资源完整性：src/ 下非代码资源（bundle-host 复制进 lib/，如 toast.ps1）
    // 必须随 tarball 发布——files 白名单规范化时最容易静默丢这类资源。
    const srcDir = join(ROOT, 'packages', p, 'src')
    if (existsSync(srcDir)) {
      const missingResources = readdirSync(srcDir)
        .filter((f) => !/\.(ts|tsx|js|mjs|cjs)$/.test(f) && existsSync(join(srcDir, f)))
        .filter((f) => !existsSync(join(pkgRoot, 'lib', f)))
      if (missingResources.length > 0) problems.push(`运行时资源未随包发布: ${missingResources.join(', ')}`)
    }

    if (problems.length > 0) failed++
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'} ${name} | ${problems.join('; ') || 'tarball 完整'}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${name} | ${String(e.message).split('\n')[0]}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
console.log(failed === 0 ? '\npack-check：全部通过' : `\npack-check：${failed} 个失败`)
process.exit(failed === 0 ? 0 : 1)
