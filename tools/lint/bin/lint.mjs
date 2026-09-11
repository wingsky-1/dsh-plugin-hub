#!/usr/bin/env node
/**
 * 仓库 lint 入口（#722 阶段五）。
 *
 * 为什么包一层而不直接跑 eslint：ESLint 的 basePath 由 cwd 决定，而 `eslint` 可执行文件位于
 * tools/lint/node_modules —— 直接在子包目录里跑会让配置文件中的 `files` 模式、以及 lint-staged
 * 传入的仓库根相对路径双双错位。这里把 cwd 恒定在仓库根，使两条路径口径统一。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

const LINT_PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = join(LINT_PKG, '..', '..')

/**
 * 默认 lint 面：手写源码与其配置，不含构建产物（忽略规则见 eslint.config.js）。
 *
 * 为什么写成文件级 glob 而非目录：ESLint 的 lintFiles 对裸目录模式（形如「包目录 + src」）
 * 报 file-not-found，必须展开到文件；且扩展名要逐个列出，花括号写法匹配不到 .d.mts 一类多段后缀。
 */
const SOURCE_EXT = '{ts,tsx,mts,cts,js,mjs,cjs}'
const DEFAULT_PATTERNS = [
  `packages/*/src/**/*.${SOURCE_EXT}`,
  `packages/*/test/**/*.${SOURCE_EXT}`,
  `shared/**/*.${SOURCE_EXT}`,
  `scripts/**/*.${SOURCE_EXT}`,
  'tools/lint/eslint.config.js',
  `tools/lint/bin/*.${SOURCE_EXT}`,
  `vitest.config.${SOURCE_EXT}`,
]

const argv = process.argv.slice(2)
const fix = argv.includes('--fix')
const patterns = argv.filter((a) => !a.startsWith('-'))

const eslint = new ESLint({
  cwd: REPO_ROOT,
  overrideConfigFile: join(LINT_PKG, 'eslint.config.js'),
  fix,
})

const results = await eslint.lintFiles(patterns.length > 0 ? patterns : DEFAULT_PATTERNS)
if (fix) await ESLint.outputFixes(results)

const formatter = await eslint.loadFormatter('stylish')
const output = formatter.format(results)
if (output.trim() !== '') console.log(output)

const errorCount = results.reduce((n, r) => n + r.errorCount, 0)
const fileCount = results.length
console.log(`lint: 检查 ${fileCount} 个文件，error ${errorCount}（阈值来源 scripts/data/gauntlet.config.json 的 complexity 段）`)
process.exit(errorCount > 0 ? 1 : 0)
