#!/usr/bin/env node
/**
 * 阶段四目录化产物入口配套（包内构建步骤，供 package.json build 在 tsc 之后、bundle-host 之前执行）。
 *
 * 为什么需要本文件：目录化把组合根 src/index.ts 移入 src/apply/（目标树 apply/ 层），
 * tsc（rootDir=src）随之把入口 emit 到 lib/apply/index.js；但包的发布面与全部外部
 * 消费者（package.json main/exports、test 从 ../lib/index.js 导入、contract/pack-check、
 * 阶段四产物等价性 diff 验收）都锚定 lib/index.js / lib/index.d.ts。故在包内生成
 * 两层薄转发保持产物入口面不变（lib/index.js -> lib/apply/index.js），语义与重构前等价；
 * esbuild 在 bundle-host 中沿转发递归内联，最终 lib/index.js 与重构前产物内容等价。
 *
 * 同时把 src/domain1/adapters/*.{mjs,d.mts} 拷贝到 lib/domain1/adapters/（与 tsc
 * 产物的相对引用结构一致）：.mjs/.d.mts 不被 tsc emit，而 lib/apply/index.js 的
 * `export * from "../domain1/adapters/xxx.mjs"` 与 index.d.ts 的类型解析都需要它们在位。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)))
const srcAdapters = join(pkgDir, 'src', 'domain1', 'adapters')
const libAdapters = join(pkgDir, 'lib', 'domain1', 'adapters')
const libDir = join(pkgDir, 'lib')

// 1. 适配器产物归位（与 tsc 输出结构对齐，替代共享 bundle-host 中 src/adapters 硬编码）
if (existsSync(srcAdapters)) {
  mkdirSync(libAdapters, { recursive: true })
  for (const f of readdirSync(srcAdapters)) {
    if (/\.(mjs|d\.mts)$/.test(f)) cpSync(join(srcAdapters, f), join(libAdapters, f))
  }
}

// 2. 产物入口薄转发（保持 lib/index.js / lib/index.d.ts 发布面）
writeFileSync(
  join(libDir, 'index.js'),
  '// 阶段四目录化产物入口转发（组合根 src/apply/index.ts -> lib/apply/index.js；bundle-host 递归内联后等价）\nexport * from "./apply/index.js";\n',
)
writeFileSync(
  join(libDir, 'index.d.ts'),
  '// 阶段四目录化类型入口转发（发布面 lib/index.d.ts 锚定不变）\nexport * from "./apply/index.js";\n',
)
console.log('[prepare-lib-entry] 适配器产物归位 lib/domain1/adapters/ 与入口转发 lib/index.js|d.ts 完成')
