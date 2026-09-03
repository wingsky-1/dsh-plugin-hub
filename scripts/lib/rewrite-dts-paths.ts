#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * rewrite-dts-paths — bundle-host d.ts X1 2a 段「shared 相对引用改写」共享库（issue #478）。
 *
 * 从 bundle-host.ts 私有函数提纯（#463 walkFiles 先例）：bundle-host 运行时产物语义
 * 零变化，本库只承载字符串改写 + 目录遍历两层纯逻辑，供测试直接 import。
 *
 * 语义：tsc 从 src/ 原样写入声明的 shared 相对引用（`../../shared/` 等）指向仓库外
 * shared/——发布后断链。2a 把 `(?:\\.\\.\\/)+shared/` 前缀整体吞掉后，按当前 d.ts
 * 在 lib/ 下的目录深度归一为 `'../'.repeat(depth + 1)shared/`：
 *   - 顶层 lib/x.d.ts（depth 0）→ ../shared/
 *   - 子目录 lib/a/b.d.ts（depth 2）→ ../../../shared/
 * 引用里的 `../` 深度与文件所在目录深度无关（极端输入也按文件深度归一）。
 *
 * 顺带（issue #276）：rewriteRelativeImportExtensions 只回写 JS emit 的 .ts 后缀
 * import，声明文件不回写——源码 .ts 后缀原样进入 lib/*.d.ts 会指向包内不存在的
 * 文件，统一改回 .js（未启用该 flag 的包无匹配，天然无操作）。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 改写单份 d.ts 文本：shared 相对引用按文件目录深度归一 + 相对 .ts 后缀回写 .js。
 * @param {string} text 原始 .d.ts 文本
 * @param {number} depth 该文件在 lib/ 下的目录深度（顶层 0，子目录逐级 +1）
 * @returns {string} 改写后文本
 */
export function rewriteDtsText(text, depth) {
  const prefix = '../'.repeat(depth + 1)
  // rewriteRelativeImportExtensions 的 d.ts 缺口修正（#276 方案 A）：TS（5.9/7.x
  // 实测一致）只把相对 .ts 后缀 specifier 回写到 JS emit，声明文件不回写——
  // 源码 .ts 后缀原样进入 lib/*.d.ts，会指向发布包内不存在的文件。统一改回 .js。
  // 对未启用该 flag / 未迁移的包无匹配，天然无操作。
  const TS_SUFFIX = /(from\s+|import\s*\(\s*)(["'])(\.\.?\/[^"'\s]+)\.ts\2/g
  return text
    .replace(/(?:\.\.\/)+shared\//g, `${prefix}shared/`)
    .replace(TS_SUFFIX, '$1$2$3.js$2')
}

/**
 * 递归遍历目录改写全部 *.d.ts（bundle-host d.ts X1 2a 的完整目录遍历面）。
 * 深度传参即本函数与字符串层的接缝：每进一层子目录 depth + 1（顶目录 depth=0）。
 * @param {string} dir 起始目录（bundle-host 传 libDir，depth=0）
 * @param {number} depth 当前目录深度
 */
export function rewriteDtsPaths(dir, depth) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, f.name)
    if (f.isDirectory()) { rewriteDtsPaths(abs, depth + 1); continue }
    if (!f.name.endsWith('.d.ts')) continue
    const p = join(dir, f.name)
    writeFileSync(p, rewriteDtsText(readFileSync(p, 'utf8'), depth))
  }
}
