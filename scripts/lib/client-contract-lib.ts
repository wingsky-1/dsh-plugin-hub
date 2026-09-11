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
import { builtinModules } from 'node:module'

/** Node 内置模块名（裸名与 `node:` 前缀两种写法都要认）。 */
const NODE_BUILTIN_NAMES = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

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
 * 客户端产物禁止泄漏的宿主侧标识符（issue #690 S1）。
 *
 * 为什么需要单独一道：`node:` 前缀依赖已被 build-client 的 browser 平台硬失败拦住，
 * 但**只含 node 全局**的宿主值（`process.env` / `__dirname` / `Buffer`）会构建全绿并
 * 进入产物，直到浏览器运行时才 ReferenceError——门禁必须在产物层兜住。
 * 清单集中在此一处，避免各门禁各写一份导致口径漂移。
 *
 * 为什么 process/Buffer 不带 `\.` 限定：`process["env"]`、`const B = Buffer;`、
 * `globalThis.process` 这类写法会绕开带点的匹配（已实测漏报）。产物里出现这些
 * 标识符必然来自宿主全局，故按 fail-closed 只匹配名字本身。
 */
const FORBIDDEN_CLIENT_TOKENS = [
  ['node: 内置模块', /\bnode:[a-z]/],
  ['process 全局', /\bprocess\b/],
  ['__dirname', /\b__dirname\b/],
  ['__filename', /\b__filename\b/],
  ['Buffer 全局', /\bBuffer\b/],
]

/**
 * external 外壳：`require("<bare>")` 是构建器对宿主提供依赖（react 等）的合法形态。
 * 三条约束缺一不可：
 *   - lookbehind 排除标识符前缀——`__require("fs")` 这类别名不该被当外壳放行；
 *   - 排除以 `.` / `/` 开头的 specifier——相对与绝对路径是真实依赖，不是宿主注入；
 *   - 捕获 specifier 供 node 内置名二次判定——裸名 `require("fs")` 同样是宿主依赖
 *     泄漏，不能因为「是 bare」就放行（构建器把顶层 bare import 一律当 external，
 *     `node:` 前缀会被 browser 平台拦下，裸名不会）。
 */
const EXTERNAL_REQUIRE_RE = /(?<![A-Za-z0-9_$])require\(\s*['"]([^.'"/][^'"]*)['"]\s*\)/g

/** 剥离 external 外壳后仍出现的 `require(`（含 `__require(` 等别名）即判红。 */
const REMAINING_REQUIRE_RE = /require\s*\(/g

/** 扫描客户端产物的宿主侧标识符泄漏，返回可读违例清单（空数组 = 干净）。 */
export function findClientLeaks(code) {
  const leaks = []
  for (const [label, re] of FORBIDDEN_CLIENT_TOKENS) {
    // 每次新建带 g 的正则：清单里的字面量正则复用会残留 lastIndex，且非全局
    // 匹配拿不到真实命中次数（违例文案会恒报「1 处」而误导排查）。
    const hit = code.match(new RegExp(re.source, 'g'))
    if (hit) leaks.push(`${label}（${hit.length} 处，如 ${JSON.stringify(hit[0])}）`)
  }
  const externals = []
  const withoutExternal = code.replace(EXTERNAL_REQUIRE_RE, (_m, spec) => {
    externals.push(spec)
    return ''
  })
  const req = withoutExternal.match(REMAINING_REQUIRE_RE)
  if (req) leaks.push(`require( 非 external 形态（${req.length} 处）`)
  for (const spec of externals) {
    if (NODE_BUILTIN_NAMES.has(spec)) leaks.push(`external 外壳引用了 node 内置模块 ${JSON.stringify(spec)}`)
  }
  return leaks
}

/**
 * 客户端契约断言（执行产物后）。返回 { ok, checks, error, leaks }。
 * checks 键：执行无异常 / load恰好一次 / load id === 完整包名(含scope) /
 *           factories可被arrive解析 / materialize后exports.apply为函数 /
 *           materialize后exports.inject为数组 / 无宿主侧标识符泄漏。
 */
export function assertClientContract(pkgName, code) {
  const { calls, factories, error } = executeClient(code)
  const leaks = findClientLeaks(code)
  const checks = {
    '执行无异常': error === null,
    'load恰好一次': calls.length === 1,
    'load id === 完整包名(含scope)': calls.length === 1 && calls[0].id === pkgName,
    'factories可被arrive解析': factories.has(pkgName),
    '无宿主侧标识符泄漏': leaks.length === 0,
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
  return { ok: Object.values(checks).every(Boolean), checks, error, leaks }
}
