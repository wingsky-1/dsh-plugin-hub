#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * shared/client/i18n.js 活绑定单测（issue #378 阶段 1）。
 *
 * 覆盖三件契约（与三包既有行为一致，迁移后由 shared 单一事实源承载）：
 *   1. 未装配：t 回落 key 本体（header 注释「行为零变化」锚点）；
 *   2. bindLocale(mock)：t 命中 mock 返回；
 *   3. 重绑：同一模块作用域内调用方（import 侧）即时可见新绑定（ESM 活绑定语义）。
 *
 * 运行：node --test scripts/test/shared-client-i18n.test.ts（或 pnpm test:scripts）
 * 零落盘：纯内存行为测试，无任何文件写入。
 * ⚠️ 串行依赖：本文件用例共享模块级活绑定状态（export let t），用例顺序即
 * 语义（未装配 → 装配 → 重绑 → 保持），依赖 node:test 默认同文件串行执行；
 * 勿开启该文件的 --test-concurrency。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { t, bindLocale } from '../../shared/client/i18n.js'

// 模拟调用方：经共享模块活绑定引用翻译函数（对齐各包 client 文件的 import 侧形态）
function readT(key, params) {
  return t(key, params)
}

test('未装配时 t 回落 key 本体', () => {
  assert.equal(typeof t, 'function')
  assert.equal(readT('some.key'), 'some.key')
  assert.equal(readT('a.key', { name: 'x' }), 'a.key', 'params 被忽略（未装配回落）')
})

test('bindLocale(mock) 后 t 命中 mock', () => {
  const calls = []
  const bound = (key, params) => {
    calls.push([key, params])
    return `TRANSLATED:${key}`
  }
  bindLocale({ bind: () => bound }, 'test-ns')
  assert.equal(readT('hello'), 'TRANSLATED:hello')
  assert.deepEqual(calls[0], ['hello', undefined])
})

test('重绑后调用方即时可见（活绑定语义）', () => {
  bindLocale({ bind: () => (key) => `FIRST:${key}` }, 'ns-a')
  const first = readT('k')
  bindLocale({ bind: () => (key) => `SECOND:${key}` }, 'ns-b')
  assert.equal(first, 'FIRST:k', '首次绑定生效')
  assert.equal(readT('k'), 'SECOND:k', '重绑后同一函数引用即时指向新绑定（ESM 活绑定）')
})

test('bindLocale 传 undefined / 无 bind 方法时保持既有 t 不变', () => {
  bindLocale(undefined, 'ns')
  assert.equal(typeof t, 'function', 'undefined locale 不破坏 t')
  const before = readT('kept')
  bindLocale({}, 'ns')
  assert.equal(readT('kept'), before, '无 bind 方法时 t 不被覆写')
})

test('bindLocale(locale 有 bind 但非函数) 保持既有 t', () => {
  bindLocale({ bind: 'not-a-function' }, 'ns')
  assert.equal(typeof t, 'function')
})