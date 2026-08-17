#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * contract-check — 客户端契约语义校验（浏览器端真实契约的 Node 侧同构模拟）。
 *
 * 核心契约（与 @deepseek-ai/dsh-client-modules 的浏览器半区一致，非自拟）：
 *   1. boot manifest 的 row.id = entry.name = 完整 npm 包名；
 *   2. arrive(row) 拉取 /plugins/<包名>/client.js 后校验 factories.has(包名)；
 *   3. materialize 后 exports.apply 为函数、exports.inject 为数组。
 *
 * 因此本脚本对每个包的 lib/client.js 产物做「执行产物断言」：
 *   - vm 沙箱执行真实 IIFE 产物（stub 浏览器全局）→ 捕获 __ModuleLoader__.load 注册；
 *   - 断言注册 id === package.json 的 name（完整包名，含 scope）；
 *   - materialize（factory(require)）后断言 exports.apply / exports.inject 形态。
 *
 * 历史教训：旧契约「client id 与包名短名一致」是对 scoped 包名的错误适配，
 * 且裸正则匹配产物首个 `id:` 字面量会假 PASS/假 FAIL——已废弃，改为执行产物断言。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(ROOT, 'packages')

/** 浏览器全局 stub（最小可执行集；每包独立沙箱隔离）。 */
function makeSandbox(calls, factories) {
  const noop = () => {}
  const el = () => {
    const node = {
      style: {}, classList: { add: noop, remove: noop, toggle: noop }, dataset: {},
      children: [], appendChild: noop, removeChild: noop, insertBefore: noop,
      setAttribute: noop, removeAttribute: noop, addEventListener: noop,
      removeEventListener: noop, contains: () => false, focus: noop, click: noop,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }),
      querySelector: () => null, querySelectorAll: () => [],
    }
    return node
  }
  const doc = {
    addEventListener: noop, removeEventListener: noop,
    createElement: el, createElementNS: el,
    body: { appendChild: noop, removeChild: noop, insertBefore: noop, contains: () => false, querySelector: () => null },
    head: { appendChild: noop }, documentElement: { style: {} },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  }
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Symbol, Object, Array, JSON, Math, Date, Promise, String, Number, Boolean,
    Map, Set, WeakMap, WeakSet, RegExp, Error, TypeError, RangeError, Proxy, Reflect,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    document: doc,
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return [] } },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    Notification: { requestPermission: () => Promise.resolve('default'), permission: 'default' },
    navigator: { userAgent: '', language: 'zh-CN', clipboard: { writeText: () => Promise.resolve() } },
    location: { href: '', protocol: 'http:', host: 'localhost', pathname: '/', search: '', hash: '', origin: 'http://localhost', assign: noop, reload: noop },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
    AudioContext: function () { this.destination = {}; this.currentTime = 0; this.createOscillator = () => ({ connect: noop, start: noop, stop: noop, frequency: {} }); this.createGain = () => ({ connect: noop, gain: {} }); },
    requestAnimationFrame: (cb) => setTimeout(cb, 16),
    cancelAnimationFrame: clearTimeout,
    Event: class {}, CustomEvent: class {},
    HTMLElement: function () {}, HTMLCanvasElement: function () {},
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  sandbox.top = sandbox
  sandbox.parent = sandbox
  sandbox.__ModuleLoader__ = {
    load: (handoff) => {
      calls.push(handoff)
      factories.set(handoff.id, handoff.factory)
    },
  }
  return sandbox
}

/** 执行产物并返回 { calls, factories, error }——同构于浏览器 arrive() 的注册侧。 */
function executeClient(code) {
  const calls = []
  const factories = new Map()
  const sandbox = makeSandbox(calls, factories)
  vm.createContext(sandbox)
  try {
    vm.runInContext(code, sandbox)
    return { calls, factories, error: null }
  } catch (e) {
    return { calls, factories, error: e }
  }
}

/** materialize：factory(require) → 返回值即 module.exports（与真实 ModuleLoader 一致）；require 走安全 stub。 */
function materialize(factory) {
  const stubRequire = (spec) => {
    if (spec === 'react') return { createElement: () => null, useState: () => [], useEffect: () => {}, useRef: () => ({ current: null }), Fragment: null }
    return {}
  }
  try {
    const exports = factory(stubRequire)
    return { exports, error: null }
  } catch (e) {
    return { exports: null, error: e }
  }
}

const pluginDirs = readdirSync(packagesDir)
  .filter((d) => d.startsWith('dsh-') && d !== 'dsh-plugins-all')

let failed = 0
let checked = 0
for (const p of pluginDirs) {
  const pkgDir = join(packagesDir, p)
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const clientPath = join(pkgDir, 'lib', 'client.js')
  const hasClientSource = existsSync(join(pkgDir, 'src', 'client.ts'))
  const declaresClient = !!pkg.dsh?.client

  // 联动断言：dsh.client 声明 ⇒ exports["./client"] 必须存在（宿主 resolveMeta 缺它会整包拒载）
  const clientExportOk = !declaresClient || (pkg.exports && typeof pkg.exports['./client'] === 'string' && pkg.exports['./client'].length > 0)
  // 联动断言：有 src/client.ts 必有构建产物
  const productOk = !hasClientSource || existsSync(clientPath)

  if (!declaresClient && !hasClientSource) {
    if (!clientExportOk || !productOk) {
      failed++
      console.log(`FAIL ${pkg.name} | 声明联动断言失败（clientExportOk=${clientExportOk} productOk=${productOk}）`)
    }
    continue
  }
  if (!existsSync(clientPath)) {
    failed++
    console.log(`FAIL ${pkg.name} | 缺 lib/client.js 产物（dsh.client 声明或 src/client.ts 存在）`)
    continue
  }

  checked++
  const code = readFileSync(clientPath, 'utf8')
  const { calls, factories, error } = executeClient(code)

  const checks = {
    '执行无异常': error === null,
    'load恰好一次': calls.length === 1,
    'load id === 完整包名(含scope)': calls.length === 1 && calls[0].id === pkg.name,
    'factories可被arrive解析': factories.has(pkg.name),
  }
  let applyOk = false
  let injectOk = false
  if (checks['factories可被arrive解析']) {
    const factory = factories.get(pkg.name)
    const { exports: mod, error: matErr } = materialize(factory)
    applyOk = matErr === null && typeof mod.apply === 'function'
    injectOk = matErr === null && Array.isArray(mod.inject)
  }
  checks['materialize后exports.apply为函数'] = applyOk
  checks['materialize后exports.inject为数组'] = injectOk
  checks['dsh.client⇒exports["./client"]声明'] = clientExportOk
  checks['src/client.ts⇒lib/client.js产物'] = productOk

  const ok = Object.values(checks).every(Boolean)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${pkg.name} | ${Object.entries(checks).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`)
  if (!ok && error) console.log(`     执行错误: ${error.message}`)
}

// 件数断言：凡 packages/dsh-* 目录都应被检查覆盖（防漏检）
console.log(`\n检查覆盖：${checked}/${pluginDirs.length} 个客户端插件包（其余为纯宿主包或聚合包）`)
if (checked === 0) {
  console.log('（当前无带客户端插件的包）')
}
console.log(failed === 0 ? '客户端契约：全部通过' : `客户端契约：${failed} 个失败`)
process.exit(failed === 0 ? 0 : 1)
