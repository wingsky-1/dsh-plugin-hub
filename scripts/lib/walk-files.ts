#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * walk-files — 递归收集目录下满足谓词的文件（返回相对路径列表，不含目录）。
 *
 * 单一事实源：从 bundle-host.ts 私有实现提取，构建复制（d.ts X1 2b 段）与
 * pack-check 随包断言（shared-dts-lib）共用同一实现，杜绝两处枚举逻辑漂移
 * （机制保证 → 断言保证的前提是「同一个谓词、同一套遍历」）。
 */
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** 递归收集 dir 下满足 predicate(文件名) 的文件，返回相对路径（/ 分隔，不含目录）。 */
export function walkFiles(dir, predicate) {
  const out = []
  const visit = (cur) => {
    for (const f of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, f.name)
      if (f.isDirectory()) visit(abs)
      else if (predicate(f.name)) out.push(relative(dir, abs).split(sep).join('/'))
    }
  }
  visit(dir)
  return out
}