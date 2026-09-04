#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * shared/dsh-home.js 行为契约单测（#517 C10 接缝）。
 *
 * 锚定 DSH home 解析的统一语义：非空 env 原样采用 / 未设置回落 ~/.dsh /
 * **空串视同未设置**（P2-2 评审结论——收敛前 `??` 形态空串解析为 cwd 相对
 * 路径，mcp-manager manager.ts 形态则回落默认，行为分裂由本模块统一）。
 * 默认形态路径与历史实现逐字节一致（join(homedir(), ".dsh")，不 resolve）。
 *
 * 运行：node --test scripts/test/shared-dsh-home.test.ts（或 pnpm test:scripts）
 * 零落盘：纯内存行为测试（homedir 断言基于当前用户 home 计算，无文件写入）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { dshHome } from '../../shared/dsh-home.js'

test('dshHome：未设置 DSH_HOME 时回落 ~/.dsh（默认形态逐字节不变）', () => {
  const prev = process.env.DSH_HOME
  delete process.env.DSH_HOME
  try {
    assert.equal(dshHome(), join(homedir(), '.dsh'))
  } finally {
    if (prev !== undefined) process.env.DSH_HOME = prev
  }
})

test('dshHome：非空 DSH_HOME 原样采用（不 resolve、不规范化、不展开 ~）', () => {
  const prev = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/dsh-home-contract'
    assert.equal(dshHome(), '/tmp/dsh-home-contract')
    // 带冗余分隔符/点段的值原样保留——本模块不做路径规范化
    process.env.DSH_HOME = '/tmp/dsh-home//x/.'
    assert.equal(dshHome(), '/tmp/dsh-home//x/.')
    // ~ 前缀原样返回（不展开——官方在 resolve 层做 expandHomePath，插件拼 base 不展开；
    // 锁定防后续「顺手对齐官方」加展开时无回归锁）
    process.env.DSH_HOME = '~/x'
    assert.equal(dshHome(), '~/x')
  } finally {
    if (prev !== undefined) process.env.DSH_HOME = prev
    else delete process.env.DSH_HOME
  }
})

test('dshHome：空串与纯空白视同未设置（对齐官方 resolveDshHome，回落 ~/.dsh）', () => {
  const prev = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = ''
    assert.equal(dshHome(), join(homedir(), '.dsh'))
    assert.ok(isAbsolute(dshHome()), '结果为绝对路径（非 cwd 相对）')
    process.env.DSH_HOME = '   '
    assert.equal(dshHome(), join(homedir(), '.dsh'), '纯空白同样视同未设置')
  } finally {
    if (prev !== undefined) process.env.DSH_HOME = prev
    else delete process.env.DSH_HOME
  }
})

test('dshHome：env 恢复纪律（finally 后还原测试前状态）', () => {
  // 前面用例各自 finally 恢复；此处锚定恢复语义本身：恢复后 dshHome() 必须与
  // 「prev 按本模块语义解析的结果」一致（prev 为空白串时视同未设置，故不能
  // 断言 dshHome() === prev——那会与空白语义自相矛盾，评审 P1-1 实证假失败）。
  const prev = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/probe'
    assert.equal(dshHome(), '/tmp/probe')
  } finally {
    if (prev !== undefined) process.env.DSH_HOME = prev
    else delete process.env.DSH_HOME
  }
  const expected = prev !== undefined && prev.trim().length > 0 ? prev : join(homedir(), '.dsh')
  assert.equal(dshHome(), expected)
})
