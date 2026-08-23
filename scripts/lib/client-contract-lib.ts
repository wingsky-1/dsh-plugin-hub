// @ts-nocheck
'use strict'

/**
 * client-contract-lib — 客户端契约校验共享库（唯一事实源）。
 *
 * 浏览器端真实契约（与 @deepseek-ai/dsh-client-modules 一致，非自拟）：
 *   1. boot manifest 的 row.id = entry.name = 完整 npm 包名；
 *   2. arrive(row) 拉取 /plugins/<包名>/client.js 后校验 factories.has(包名)；
 *   3. materialize 后 exports.apply 为函数、exports.inject 为数组。
 *
 * 因此统一按「执行产物断言」实现：
 *   - makeBrowserSandbox()：完整浏览器全局 stub（唯一一份，超集）——历史教训：
 *     contract-check 与 pack-check 曾各自内嵌 makeSandbox（pack-check 版缺
 *     AudioContext / navigator.clipboard 等），未来 client 变化会误报；
 *   - executeClient(code)：vm 执行 → { calls, factories, error }；
 *   - materialize(factory)：factory(require) → module.exports 形态；
 *   - assertClientContract(pkgName, code)：完整契约断言（load id === 包名 +
 *     apply/inject 形态 + load 恰好一次）。
 *
 * 消费方：contract-check.ts（逐包断言）、pack-check.ts（tarball 内断言）。
 *
 * ⚠️ 沙箱仅用于「可执行性隔离」：模拟浏览器执行本仓库自建构建产物（受信输入）。
 * node:vm 不是安全边界（沙箱可达宿主 Function），不得用于执行不可信/第三方代码。
 */
import vm from 'node:vm'

/** 浏览器全局 stub（最小可执行集；每包独立沙箱隔离）。 */
export function makeBrowserSandbox(calls, factories) {
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
export function executeClient(code) {
  const calls = []
  const factories = new Map()
  const sandbox = makeBrowserSandbox(calls, factories)
  vm.createContext(sandbox)
  try {
    vm.runInContext(code, sandbox)
    return { calls, factories, error: null }
  } catch (e) {
    return { calls, factories, error: e }
  }
}

/** materialize：factory(require) → 返回值即 module.exports（与真实 ModuleLoader 一致）；require 走安全 stub。 */
export function materialize(factory) {
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

/**
 * 客户端契约断言（执行产物后）。返回 { ok, checks, error }。
 * checks 键：执行无异常 / load恰好一次 / load id === 完整包名(含scope) /
 *           factories可被arrive解析 / materialize后exports.apply为函数 /
 *           materialize后exports.inject为数组。
 */
export function assertClientContract(pkgName, code) {
  const { calls, factories, error } = executeClient(code)
  const checks = {
    '执行无异常': error === null,
    'load恰好一次': calls.length === 1,
    'load id === 完整包名(含scope)': calls.length === 1 && calls[0].id === pkgName,
    'factories可被arrive解析': factories.has(pkgName),
  }
  let applyOk = false
  let injectOk = false
  if (checks['factories可被arrive解析']) {
    const factory = factories.get(pkgName)
    const { exports: mod, error: matErr } = materialize(factory)
    applyOk = matErr === null && typeof mod.apply === 'function'
    injectOk = matErr === null && Array.isArray(mod.inject)
  }
  checks['materialize后exports.apply为函数'] = applyOk
  checks['materialize后exports.inject为数组'] = injectOk
  return { ok: Object.values(checks).every(Boolean), checks, error }
}
