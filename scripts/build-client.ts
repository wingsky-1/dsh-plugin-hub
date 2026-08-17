// @ts-nocheck
'use strict'

/**
 * build-client — 共享客户端构建预设（唯一注入点 + 唯一契约外壳）。
 *
 * 架构：源码写「干净模块」（导出 apply/inject，不含任何 loader 痕迹），
 * 契约外壳（IIFE + __ModuleLoader__.load 注册 + exports 装配）由本文件
 * 经 esbuild stdin 输入生成——IIFE/load/Symbol.toStringTag 模板只存在于
 * 本文件一处，任何包都不再手写。
 *
 * 双模式（渐进兼容）：
 *   - wrapper 模式（推荐/新形态）：源码无 __ModuleLoader__.load ⇒ 生成外壳构建；
 *   - legacy 模式（存量兼容）：源码自带 __ModuleLoader__.load（手写 IIFE）⇒ 原样构建。
 *
 * 注入与校验（与 dsh 浏览器端契约一致，非自拟）：
 *   - boot manifest 的 row.id = entry.name = 完整 npm 包名；
 *   - arrive(row) 拉取 /plugins/<包名>/client.js 后校验 factories.has(包名)；
 *   - 因此 load id 构建期注入 __DSH_PLUGIN_ID__（默认 = package.json name），
 *     extraDefine 可扩展（如 __DSH_ROUTES__）；
 *   - 内建契约校验（硬依赖）：产物 load id 必须是「字符串字面量」且 === 包名——
 *     define 被局部遮蔽/占位符拼错时唯一兜底，构建即失败，不等发布后炸。
 *
 * 用法（库形态，被 bundle-host.ts 编排调用；也可被其他构建入口复用）：
 *   const { buildClient, copyClientResources } = await import('./build-client.ts')
 */
import { build } from 'esbuild'
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 契约外壳模板（唯一一处）：干净模块 → 浏览器端 IIFE 产物（纯 JS，构建期生成不经 tsc）。 */
function renderWrapper(entryRel) {
  return `// 契约外壳（scripts/build-client.ts 生成），浏览器端全局由 dsh web 运行时提供。
import * as impl from ${JSON.stringify('./' + entryRel)}
window.__ModuleLoader__.load({
  id: __DSH_PLUGIN_ID__,
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    exports.apply = impl.apply
    exports.inject = impl.inject
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    return module.exports
  },
})
`
}

/**
 * 构建客户端产物（lib/client.js）。
 * @param {object} opts
 * @param {string} opts.src          客户端源码入口（src/client.ts 或 src/client/index.ts）
 * @param {string} opts.outfile      产物路径（lib/client.js）
 * @param {string} opts.packageName  load id 契约值 = 完整 npm 包名（含 scope）
 * @param {Record<string, unknown>} [opts.extraDefine] 附加注入：键为注入标识符，
 *   值为「原始 JS 值」（对象/数组/字符串/数字/布尔），build-client 内部统一
 *   JSON.stringify 为可注入的字面量文本（勿传已序列化字符串——会双重转义）
 * @returns {Promise<{ code: string, mode: 'wrapper' | 'legacy' }>}
 */
export async function buildClient({ src, outfile, packageName, extraDefine = {} }) {
  const sourceText = readFileSync(src, 'utf8')
  // 形态检测：剥离注释后检测 __ModuleLoader__.load——干净模块注释若提到 loader
  // 会被误判 legacy（导致 wrapper 没用上，构建行为错误）。
  const codeOnly = sourceText.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  const mode = /__ModuleLoader__\.load/.test(codeOnly) ? 'legacy' : 'wrapper'
  const define = {
    __DSH_PLUGIN_ID__: JSON.stringify(packageName),
    ...Object.fromEntries(Object.entries(extraDefine).map(([k, v]) => [k, JSON.stringify(v)])),
  }
  const base = {
    bundle: true,
    format: 'iife',
    target: 'es2020',
    charset: 'utf8',
    // 产物头部 use strict（legacy CLI 时代由 --banner:js="use strict"; 提供，统一到预设）
    banner: { js: '"use strict";' },
    define,
    write: false,
    logLevel: 'warning',
  }
  const result = mode === 'wrapper'
    ? await build({
        ...base,
        // stdin 输入：resolveDir 显式指向源码所在目录，wrapper 内相对 import 可解析
        stdin: { contents: renderWrapper(basename(src)), resolveDir: dirname(src), sourcefile: 'client-wrapper.ts' },
      })
    : await build({ ...base, entryPoints: [src] })
  const code = result.outputFiles[0].text
  // 内建契约校验（硬依赖）：产物 load id 必须是字符串字面量且 === 包名；
  // exports.apply/inject 装配必须存在——define 被局部遮蔽/占位符拼错/外壳装配
  // 出错时唯一兜底，构建即失败，不等发布后炸。
  const m = code.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*"([^"]+)"/)
  if (!m || m[1] !== packageName) {
    throw new Error(`客户端契约校验失败：load id 必须等于包名 ${packageName}（实际: ${m ? m[1] : '缺失'}）——检查源码占位符 __DSH_PLUGIN_ID__ 是否被遮蔽/拼错，或 wrapper 装配错误`)
  }
  if (!/exports\.apply\s*=/.test(code) || !/exports\.inject\s*=/.test(code)) {
    throw new Error(`客户端契约校验失败：产物缺少 exports.apply/exports.inject 装配——检查 wrapper 模板或源码导出`)
  }
  writeFileSync(outfile, code)
  return { code, mode }
}

/**
 * 复制 src/ 下非代码资源（toast.ps1 等）→ lib/（运行时从 lib 同目录定位）。
 * @param {string} pkgDir 插件包目录
 * @param {string} libDir 产物目录（lib/）
 * @returns {string[]} 复制的文件名列表
 */
export function copyClientResources(pkgDir, libDir) {
  const srcDir = join(pkgDir, 'src')
  if (!existsSync(srcDir)) return []
  const copied = []
  for (const f of readdirSync(srcDir)) {
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(f) && !f.startsWith('.') && existsSync(join(srcDir, f))) {
      cpSync(join(srcDir, f), join(libDir, f))
      copied.push(f)
    }
  }
  return copied
}