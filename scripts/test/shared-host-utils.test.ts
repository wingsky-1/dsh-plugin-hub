#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * shared/host-utils.js sseData 字面量契约单测（issue #472）。
 *
 * 锚定 sseData 对各类 payload 的输出字面量（防 shared 实现未来被改坏）：
 * 三包历史实现逐字同构 `data: ${JSON.stringify(payload)}\n\n`，收敛后由
 * shared 单一事实源承载。undefined 用例为对齐历史、非承诺契约（现状三处
 * 均无调用点传 undefined，若未来收紧不视为破坏兼容——见 shared/host-utils.js jsdoc）。
 *
 * 运行：node --test scripts/test/shared-host-utils.test.ts（或 pnpm test:scripts）
 * 载体：CI ci.yml 的 pnpm test:scripts 步骤（根 pnpm test 不含 scripts/test）。
 * 零落盘：纯内存行为测试，无任何文件写入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sseData } from '../../shared/host-utils.js'

test('sseData：object payload 输出紧凑 JSON data 帧', () => {
  assert.equal(sseData({ type: 'ping' }), 'data: {"type":"ping"}\n\n')
  assert.equal(sseData({ type: 'ui-config-changed' }), 'data: {"type":"ui-config-changed"}\n\n')
  assert.equal(sseData({ a: 1 }), 'data: {"a":1}\n\n')
})

test('sseData：数组 payload 输出 JSON 数组 data 帧', () => {
  assert.equal(sseData([1, 2, 3]), 'data: [1,2,3]\n\n')
  assert.equal(sseData([]), 'data: []\n\n')
})

test('sseData：字符串 payload 带引号与转义', () => {
  assert.equal(sseData('hello'), 'data: "hello"\n\n')
  assert.equal(sseData('a"b\\c'), 'data: "a\\"b\\\\c"\n\n', '引号与反斜杠按 JSON 转义')
})

test('sseData：null payload', () => {
  assert.equal(sseData(null), 'data: null\n\n')
})

test('sseData：空串 payload', () => {
  assert.equal(sseData(''), 'data: ""\n\n')
})

test('sseData：payload 含真实换行 → 输出 JSON 转义字面 \\n，不拆多行 data 帧', () => {
  // payload 实参 "a\nb" 是含真实换行的字符串（JS 源码写单反斜杠）；
  // 期望输出串中 JSON 转义后的 \n 必须写 "\\n"（双反斜杠 = 字面反斜杠+n 两字符）。
  assert.equal(sseData({ msg: 'a\nb' }), 'data: {"msg":"a\\nb"}\n\n')
})

test('sseData：undefined payload 输出 data: undefined（对齐历史，非承诺契约）', () => {
  // JSON.stringify(undefined) 返回 undefined，模板串拼接为 "undefined" 字面。
  // 现状三处（mcp-manager / notifier / provider-usage）均无调用点传 undefined，
  // 本行为仅为对齐历史、不额外兜底，非承诺契约——若未来 shared 收紧（抛错/省略）
  // 不视为破坏兼容（需单开决策）。
  assert.equal(sseData(undefined), 'data: undefined\n\n')
})
