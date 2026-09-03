#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * shared-dts-lib — shared 声明副本随包断言的共享库（issue #461 L2）。
 *
 * 机制：bundle-host d.ts X1（2b 段）把仓库 shared/ 下全部 *.d.ts（递归，含
 * 子目录 client/ 等）复制进包内 shared/ 随包发布。此前 pack-check 只硬编码
 * 断言单文件，新增 shared d.ts（如 client/i18n.d.ts）
 * 漏打包时静默放行——「机制保证」没有「断言保证」兜底。
 *
 * 本库把断言升级为「仓库 shared/ 枚举清单 与 tarball 内 shared/ 副本逐一比对」：
 *   - listSharedDts(root)：枚举仓库 shared/ 下全部 .d.ts 相对路径（与
 *     bundle-host 2b 复制谓词同源，walk-files 单一事实源）；
 *   - assertSharedDtsPresent(pkgSharedDir, expected)：tarball 缺哪个文件报哪个（查缺）；
 *   - assertSharedDtsNoExtras(pkgSharedDir, expected)：报包内 shared/ 中期望清单之外
 *     的残留 .d.ts（查多，issue #478：retired 模块移除后旧副本不得残留在包内）。
 * 未来 shared 新增子目录/文件自动纳入断言，无需再改 pack-check。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { walkFiles } from './walk-files.ts'

/**
 * 枚举仓库 shared/ 下全部声明文件（.d.ts，递归含子目录），返回相对路径列表。
 * 谓词与 bundle-host d.ts X1 2b 复制段完全一致（walk-files 共享实现）。
 * @param {string} root 仓库根（含 shared/ 目录）
 * @returns {string[]} 相对路径，如 ['client/i18n.d.ts', 'loopback.d.ts', ...]
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

/**
 * 查多：返回包内 shared/ 中「期望清单之外」的残留 .d.ts（相对路径列表，空 = 无残留）。
 *
 * retired 残留场景（issue #478）：shared 模块退休（DEPRECATED 两步走 → 移除）后，旧
 * 声明副本残留在包内 shared/——包根 shared/ 不入 git，clean-lib 只清 lib/ 不清包根
 * shared/，bundle-host 每次构建覆盖写入新副本但从不清理已移除者；files 白名单
 * shared/glob 双星 .d.ts 仍会把它带进发布 tarball（过期声明随包发布，陈旧类型面）。
 * assertSharedDtsPresent 只查「缺」不查「多」——本出口补「多」向，pack-check 接入后
 * 残留 fail-loud。
 */
export function assertSharedDtsNoExtras(pkgSharedDir, expected) {
  const expectedSet = new Set(expected)
  const out = []
  const visit = (cur) => {
    for (const f of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, f.name)
      if (f.isDirectory()) { visit(abs); continue }
      if (!f.name.endsWith('.d.ts')) continue
      // 包内目录相对 shared/ 根的路径（walkFiles 同款归一：relative + / 分隔）
      const rel = relative(pkgSharedDir, abs).split(sep).join('/')
      if (!expectedSet.has(rel)) out.push(rel)
    }
  }
  if (existsSync(pkgSharedDir) && statSync(pkgSharedDir).isDirectory()) visit(pkgSharedDir)
  return out
}