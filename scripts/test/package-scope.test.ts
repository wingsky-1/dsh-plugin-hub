#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * 产物闸包级切片（#722 门禁分层）的回归。
 *
 * 为什么存在：切片让 PR 只验命中包，代价是「包面写错」会静默漏检——这是比不切片更
 * 危险的失败形态。故未知包名必须判红、空列表必须合法（纯文档 PR 无产物闸对象），
 * 两条语义在纯函数层锁死，避免各闸脚本各自解释。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolvePackageScope } from '../lib/package-scope.ts'

const KNOWN = ['dsh-notifier', 'dsh-lan-proxy', 'dsh-plugins-all']

test('resolvePackageScope：不带 --packages 即不切片（全仓口径）', () => {
  assert.deepEqual(resolvePackageScope([], KNOWN), { packages: null })
  assert.deepEqual(resolvePackageScope(['--check'], KNOWN), { packages: null })
})

test('resolvePackageScope：逗号/空白/等号三种写法等价，重复项去重', () => {
  assert.deepEqual(resolvePackageScope(['--packages', 'dsh-notifier,dsh-lan-proxy'], KNOWN).packages, ['dsh-notifier', 'dsh-lan-proxy'])
  assert.deepEqual(resolvePackageScope(['--packages=dsh-notifier,dsh-lan-proxy'], KNOWN).packages, ['dsh-notifier', 'dsh-lan-proxy'])
  assert.deepEqual(resolvePackageScope(['--packages', 'dsh-notifier dsh-lan-proxy'], KNOWN).packages, ['dsh-notifier', 'dsh-lan-proxy'])
  assert.deepEqual(resolvePackageScope(['--packages', 'dsh-notifier,dsh-notifier'], KNOWN).packages, ['dsh-notifier'])
})

test('resolvePackageScope：空列表合法（纯文档/meta 改动的产物闸对象为空）', () => {
  assert.deepEqual(resolvePackageScope(['--packages', ''], KNOWN).packages, [])
  assert.deepEqual(resolvePackageScope(['--packages='], KNOWN).packages, [])
})

test('resolvePackageScope：未知包名抛错（fail-closed，防包面写错静默漏检）', () => {
  assert.throws(() => resolvePackageScope(['--packages', 'notifier'], KNOWN), /未知包名 notifier/)
  assert.throws(() => resolvePackageScope(['--packages', 'dsh-notifier,nope'], KNOWN), /未知包名 nope/)
})
