/**
 * 仓库 ESLint 扁平配置（#722 阶段五）。
 *
 * 本文件与整个 lint 工具链一起放在 tools/lint 隔离包内：typescript-eslint 需要 TypeScript 的
 * compiler API，而仓根 typescript 是 tsgo 7.x（无 API，且根 tsc 由它提供、不可替换）。
 * 隔离带来两个约束，配置与入口都必须遵守：
 *   1. 本文件只能 import 本包声明的依赖（pnpm 严格布局下父目录解析不到子包依赖）；
 *   2. files 模式相对 basePath 解析，而 basePath 由入口的 cwd 决定——入口固定以仓库根为 cwd，
 *      故此处模式一律写成仓库根相对形式。
 *
 * 阈值不在本文件硬编码：唯一事实源是 scripts/data/gauntlet.config.json 的 complexity 段
 * （起步值为全域实测最大值，收紧路线见 issue #732）。
 */
import { readFileSync } from 'node:fs'
import tseslint from 'typescript-eslint'
import sonarjs from 'eslint-plugin-sonarjs'

const gauntlet = JSON.parse(
  readFileSync(new URL('../../scripts/data/gauntlet.config.json', import.meta.url), 'utf8'),
)
const { cyclomatic, cognitive } = gauntlet.complexity
if (typeof cyclomatic !== 'number' || typeof cognitive !== 'number') {
  throw new Error('gauntlet.config.json 缺少 complexity.cyclomatic / complexity.cognitive —— 阈值事实源不可读，fail-closed')
}

// 手写源码面：逐扩展名显式列出，花括号写法匹配不到 .d.mts 一类的多段后缀。
const TS_SOURCES = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts']
const JS_SOURCES = ['**/*.js', '**/*.mjs', '**/*.cjs']

// 构建产物、依赖与本地草稿不参与 lint；声明文件没有实现体，复杂度门禁对其无意义。
const IGNORES = [
  '**/node_modules/**',
  '**/lib/**',
  'coverage/**',
  '.maintenance-drafts/**',
  '**/*.d.ts',
  '**/*.d.mts',
  '**/*.d.cts',
]

const complexityRules = {
  complexity: ['error', cyclomatic],
  'sonarjs/cognitive-complexity': ['error', cognitive],
}

export default [
  { ignores: IGNORES },
  {
    files: TS_SOURCES,
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { sonarjs },
    rules: complexityRules,
  },
  {
    files: JS_SOURCES,
    plugins: { sonarjs },
    rules: complexityRules,
  },
]
