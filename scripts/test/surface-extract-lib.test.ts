#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * surface-extract-lib 自测（#733 M2c 后续 N0(B)）：提取器 + 入口归属的正反 fixture。
 *
 * 为什么必须有：门禁的入口模型（最长前缀归属 / 未归属判红 / 同长度多命中判红）
 * 直接决定「改哪个入口的签名会不会红」。#733 M2c 复核对抗实测的两条判据缺陷——
 * F-1（`./client` 入口零判据）与 F-2（同名多块只留排序末块 ⇒ 改宿主 apply 不红）
 * ——正是旧实现把提取与归属内联在 .mjs 里、没有任何 fixture 能直接断言它造成的。
 * 本文件对**同一实现**（scripts/lib/surface-extract-lib.ts）做双向断言，门禁与
 * 自测不各写一份（§9 禁止双轨）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { attributeEmitFiles, declBlockName, extractDeclBlocks, extractExports } from '../lib/surface-extract-lib.ts'

// ---------------------------------------------------------------- extractExports

test('extractExports：re-export 块（含 as 重命名与 export type）解析为符号集', () => {
  const text = [
    'export { alpha, beta as gamma } from "./x.js";',
    'export type { Shape, Deep as DeepShape } from "./y.js";',
    'export declare const delta: number;',
    'export declare function epsilon(): void;',
  ].join('\n')
  // 排序按名字字典序（ASCII 大写在前）；beta 被 as 重命名为 gamma 故不出现
  assert.deepEqual(extractExports(text), [
    { name: 'DeepShape', isType: true },
    { name: 'Shape', isType: true },
    { name: 'alpha', isType: false },
    { name: 'delta', isType: false },
    { name: 'epsilon', isType: false },
    { name: 'gamma', isType: false },
  ])
})

test('extractExports：`export interface`（无 declare）不进导出面——盲区①的机器事实', () => {
  // tsc 对 interface/type 产出 `export interface`/`export type`（无 declare），进不了
  // 本提取器：其类型体由 consumer-types.test.ts 的类型体锚兜住。此断言若变红，说明
  // 提取器口径已变，须同步门禁自述的盲区①与 DEVELOPMENT 的导出面段。
  assert.deepEqual(extractExports('export interface Uncaught { a: 1 }\nexport type AlsoUncaught = 1;\n'), [])
})

test('extractExports：注释里的伪导出形态不计入（块注释与行注释均剥离）', () => {
  const text = [
    '/* export declare const ghostA: 1; */',
    '// export declare const ghostB: 2;',
    'export declare const real: 3;',
  ].join('\n')
  assert.deepEqual(extractExports(text), [{ name: 'real', isType: false }])
})

test('extractExports：const enum 的 kind 与名字不被可选前缀吃掉（原实现读成 kind=const、名字="enum"）', () => {
  assert.deepEqual(extractExports('export declare const enum E { A }'), [{ name: 'E', isType: true }])
})

// ---------------------------------------------------------------- extractDeclBlocks / declBlockName

test('extractDeclBlocks：多行 interface/class 的块边界按花括号配对（含成员分号不截断）', () => {
  const text = [
    'export declare interface Big {',
    '    a: number;',
    '    b: { c: string; };',
    '}',
    'export declare function small(): void;',
  ].join('\n')
  // 提取器对块数组排序（多重集下顺序无关，排序让输出稳定）
  assert.deepEqual(extractDeclBlocks(text), [
    'export declare function small(): void;',
    'export declare interface Big { a: number; b: { c: string; }; }',
  ])
})

test('extractDeclBlocks：空白归一化让「换行/缩进差异」不产生 diff，重复块逐条保留（多重集）', () => {
  const a = extractDeclBlocks('export declare const  dup:   string[];\nexport declare const dup: string[];\n')
  assert.deepEqual(a, ['export declare const dup: string[];', 'export declare const dup: string[];'])
  const b = extractDeclBlocks('export declare const dup: string[];\n')
  // 重复块是真实信号（实测现网存在逐字重复块）：用 Set 会掩盖丢失
  assert.equal(a.length, 2)
  assert.equal(b.length, 1)
})

test('declBlockName：各声明形态取名，非声明块返回 null', () => {
  assert.equal(declBlockName('export declare const x: 1;'), 'x')
  assert.equal(declBlockName('export declare function f(): void;'), 'f')
  assert.equal(declBlockName('export declare abstract class C {}'), 'C')
  assert.equal(declBlockName('export declare type T = 1;'), 'T')
  assert.equal(declBlockName('export declare const enum E { A }'), 'E')
  assert.equal(declBlockName('declare const hidden: 1;'), null)
})

// ---------------------------------------------------------------- attributeEmitFiles

const ENTRIES = [
  { subpath: '.', prefix: '' },
  { subpath: './client', prefix: 'client' },
]

test('归属：按最长前缀——client/index.d.ts 归 ./client，而非被根入口吸收（F-1 修复点）', () => {
  const { byEntry, orphans, conflicts } = attributeEmitFiles(
    ['client/index.d.ts', 'client/locales.d.ts', 'index.d.ts', 'server/routes.d.ts'],
    ENTRIES,
  )
  assert.deepEqual(byEntry, {
    '.': ['index.d.ts', 'server/routes.d.ts'],
    './client': ['client/index.d.ts', 'client/locales.d.ts'],
  })
  assert.deepEqual(orphans, [])
  assert.deepEqual(conflicts, [])
})

test('归属：前缀只匹配目录形态——同名顶层文件 client.d.ts 不被 "client" 前缀吃掉', () => {
  const { byEntry } = attributeEmitFiles(['client.d.ts', 'client/index.d.ts'], ENTRIES)
  assert.deepEqual(byEntry['.'], ['client.d.ts'])
  assert.deepEqual(byEntry['./client'], ['client/index.d.ts'])
})

test('归属：未被任何前缀覆盖的文件进 orphans（调用方判红，不得静默丢弃）', () => {
  const { byEntry, orphans } = attributeEmitFiles(['a.d.ts', 'b.d.ts'], [{ subpath: './client', prefix: 'client' }])
  assert.deepEqual(byEntry['./client'], [])
  assert.deepEqual(orphans, ['a.d.ts', 'b.d.ts'])
})

test('归属：同长度多命中进 conflicts（归属不唯一 ⇒ 调用方判红）', () => {
  const { conflicts, byEntry } = attributeEmitFiles(
    ['client/a.d.ts'],
    [
      { subpath: './client', prefix: 'client' },
      { subpath: './c2', prefix: 'client' },
    ],
  )
  assert.equal(conflicts.length, 1)
  assert.match(conflicts[0], /client\/a\.d\.ts（命中 \.\/client 前缀 "client"、\.\/c2 前缀 "client"）/)
  assert.deepEqual(byEntry['./client'], [])
  assert.deepEqual(byEntry['./c2'], [])
})

test('归属：前缀相同的根入口不会与目录入口互相吞并（空前缀是兜底，非最长命中）', () => {
  const { byEntry } = attributeEmitFiles(['client/index.d.ts', 'config/x.d.ts'], [
    { subpath: '.', prefix: '' },
    { subpath: './config', prefix: 'config' },
  ])
  assert.deepEqual(byEntry['.'], ['client/index.d.ts'])
  assert.deepEqual(byEntry['./config'], ['config/x.d.ts'])
})
