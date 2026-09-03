#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * shared-dts-lib — shared 声明副本随包断言的共享库（issue #461 L2）。
 *
 * 机制：bundle-host d.ts X1（2b 段）把仓库 shared/ 下全部 *.d.ts（递归，含
 * 子目录 host/ client/）复制进包内 shared/ 随包发布。此前 pack-check 只硬编码
 * 断言 plugin-skeleton.d.ts 一个文件，新增 shared d.ts（如 client/i18n.d.ts）
 * 漏打包时静默放行——「机制保证」没有「断言保证」兜底。
 *
 * 本库把断言升级为「仓库 shared/ 枚举清单 与 tarball 内 shared/ 副本逐一比对」：
 *   - listSharedDts(root)：枚举仓库 shared/ 下全部 .d.ts 相对路径（与
 *     bundle-host 2b 复制谓词同源，walk-files 单一事实源）；
 *   - assertSharedDtsPresent(pkgSharedDir, expected)：tarball 缺哪个文件报哪个。
 * 未来 shared 新增子目录/文件自动纳入断言，无需再改 pack-check。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { walkFiles } from './walk-files.ts'

/**
 * 枚举仓库 shared/ 下全部声明文件（.d.ts，递归含子目录），返回相对路径列表。
 * 谓词与 bundle-host d.ts X1 2b 复制段完全一致（walk-files 共享实现）。
 * @param {string} root 仓库根（含 shared/ 目录）
 * @returns {string[]} 相对路径，如 ['client/i18n.d.ts', 'host/plugin-skeleton.d.ts', ...]
 */
export function listSharedDts(root) {
  return walkFiles(join(root, 'shared'), (f) => f.endsWith('.d.ts'))
}

/**
 * 断言 tarball 内 shared/ 副本覆盖期望清单。
 * @param {string} pkgSharedDir tarball 解包后的 shared/ 目录
 * @param {string[]} expected listSharedDts 结果（相对路径清单）
 * @returns {string[]} 缺失文件相对路径列表（空 = 完整）
 */
export function assertSharedDtsPresent(pkgSharedDir, expected) {
  return expected.filter((rel) => !existsSync(join(pkgSharedDir, rel)))
}