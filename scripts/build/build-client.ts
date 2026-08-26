// @ts-nocheck
'use strict'

/**
 * build-client — 共享客户端构建预设（唯一注入点 + 唯一契约外壳）。
 *
 * 架构：源码写「干净模块」（导出 apply/inject，不含任何 loader 痕迹），
 * 契约外壳（IIFE + __ModuleLoader__.load 注册 + exports 装配）由本文件
 * 经 esbuild 生成——IIFE/load/Symbol.toStringTag 模板只存在于本文件一处。
 *
 * 三条构建路径：
 *   - wrapper（零依赖干净模块）：esbuild iife + stdin 包装；
 *   - wrapper + externals（干净模块含 React 等宿主注入依赖）：干净模块以
 *     cjs 形态内联进 factory(require) 函数体——external 的 import 编译成
 *     `require("react")`，由 factory 注入的 require 解析（对齐 dsh-web-ui
 *     「ESM 源码 + external + loader 模块表 require 注入」机制）；
 *   - legacy（存量手写 IIFE）：原样构建。
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

/** 契约外壳模板：零依赖干净模块 → 浏览器端 IIFE 产物（纯 JS，构建期生成不经 tsc）。 */
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
 * 契约外壳模板（externals 路径）：干净模块（cjs，external 依赖经 factory require 注入）
 * 内联进 factory 函数体——factory 参数名 `require` 遮蔽外部，external 的
 * `require("react")` 即解析到注入值（对齐 dsh-web-ui 的 loader 模块表机制）。
 */
function renderFactoryContract(packageName, cleanCjs) {
  const indented = cleanCjs.split('\n').map((l) => (l.length ? '    ' + l : '')).join('\n')
  return `"use strict";
// 契约外壳（scripts/build-client.ts 生成）：external 依赖（React 等）经 factory 注入的 require 解析
window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageName)},
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
${indented}
    Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' })
    return module.exports
  }
})
`
}

/** 提取源码顶层 bare import specifier（非相对/绝对 → 宿主注入 external；scoped 包取前两段）。 */
function bareImports(ts) {
  const out = new Set()
  for (const m of ts.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
    const spec = m[1]
    if (spec.startsWith('.') || spec.startsWith('/')) continue
    out.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
  }
  return [...out]
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
 * @param {string[]} [opts.externals] 宿主注入依赖（如 ["react"]）：这些模块由
 *   loader 运行时 require 注入，不打进 bundle（干净模块 import 之）；
 *   空则走零依赖 wrapper 路径。
 * @param {boolean} [opts.inlineBareImports] 默认 false。为 true 时干净模块的
 *   bare import（第三方库，如 dompurify/diff2html）不按「宿主注入 external」处理，
 *   而是由 esbuild 内联进 client.js（产物仍自包含、零运行时依赖）。适用于客户端
 *   使用纯浏览器第三方库、无任何宿主注入 JS 模块的场景（宿主注入服务经
 *   dsh.client.inject 声明，与 JS import 无关）。
 *   ⚠️ 与默认语义互斥：默认「bare import = 宿主注入 external（React）」；
 *   inlineBareImports=true 则全部内联。二者按包二选一。
 * @returns {Promise<{ code: string, mode: 'wrapper' | 'legacy' }>}
 */
export async function buildClient({ src, outfile, packageName, extraDefine = {}, externals = [], inlineBareImports = false }) {
  const sourceText = readFileSync(src, 'utf8')
  // 形态检测：剥离注释后检测 __ModuleLoader__.load——干净模块注释若提到 loader
  // 会被误判 legacy（导致 wrapper 没用上，构建行为错误）。
  const codeOnly = sourceText.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  const mode = /__ModuleLoader__\.load/.test(codeOnly) ? 'legacy' : 'wrapper'
  // externals：显式传入优先；否则 wrapper 且未声明 inlineBareImports 时按「bare
  // import = 宿主注入 external」自动提取；inlineBareImports 或 legacy → 全部内联。
  const resolvedExternals =
    externals.length > 0
      ? externals
      : mode === 'wrapper' && !inlineBareImports
        ? bareImports(sourceText)
        : []
  const define = {
    __DSH_PLUGIN_ID__: JSON.stringify(packageName),
    ...Object.fromEntries(Object.entries(extraDefine).map(([k, v]) => [k, JSON.stringify(v)])),
  }
  const base = {
    bundle: true,
    target: 'es2020',
    charset: 'utf8',
    banner: { js: '"use strict";' },
    define,
    write: false,
    logLevel: 'warning',
    // .css → import 得到字符串字面量：客户端 CSS 放独立 .css 文件（有语法高亮/可静态检查），
    // 构建期 text-loader 原样内联进 client.js（产物仍自包含单文件、零运行时依赖、无独立请求）。
    loader: { '.css': 'text' },
  }

  let code
  if (mode === 'legacy') {
    const r = await build({ ...base, format: 'iife', entryPoints: [src] })
    code = r.outputFiles[0].text
  } else if (resolvedExternals.length > 0) {
    // externals 路径：干净模块 cjs（external 走 require）→ 内联进 factory
    const r = await build({ ...base, format: 'cjs', platform: 'browser', external: resolvedExternals, entryPoints: [src] })
    code = renderFactoryContract(packageName, r.outputFiles[0].text)
  } else {
    // 零依赖干净模块：iife + stdin wrapper
    const r = await build({
      ...base,
      format: 'iife',
      stdin: { contents: renderWrapper(basename(src)), resolveDir: dirname(src), sourcefile: 'client-wrapper.ts' },
    })
    code = r.outputFiles[0].text
  }

  // 内建契约校验（硬依赖）：产物 load id 必须是字符串字面量且 === 包名；
  // exports.apply/inject 装配必须存在——define 被局部遮蔽/占位符拼错/外壳装配
  // 出错时唯一兜底，构建即失败，不等发布后炸。
  const m = code.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*"([^"]+)"/)
  if (!m || m[1] !== packageName) {
    throw new Error(`客户端契约校验失败：load id 必须等于包名 ${packageName}（实际: ${m ? m[1] : '缺失'}）——检查源码占位符 __DSH_PLUGIN_ID__ 是否被遮蔽/拼错，或 wrapper 装配错误`)
  }
  const isFactory = mode === 'wrapper' && resolvedExternals.length > 0
  const exportsOk = isFactory
    ? /apply/.test(code) && /inject/.test(code)
    : /exports\.apply\s*=/.test(code) && /exports\.inject\s*=/.test(code)
  if (!exportsOk) {
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
  // withFileTypes：只处理文件，跳过目录（src/client/ 目录、shared 子目录等不是资源）
  for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
    const f = ent.name
    if (!ent.isFile()) continue
    // .css 走客户端 text-loader 构建期内联（见 loader 配置），不再作为独立资源复制
    if (!/\.(ts|tsx|js|mjs|cjs|css)$/.test(f) && !f.startsWith('.') && existsSync(join(srcDir, f))) {
      cpSync(join(srcDir, f), join(libDir, f))
      // .ps1 资源强制 UTF-8 BOM（issue #238）：Windows PowerShell 5.1 对无 BOM
      // 文件按 ANSI 码页解码，非 ASCII 注释即解析失败。构建期机器兜底，
      // 不依赖编辑器保存行为；已带 BOM 则原样跳过，重复构建不叠加双 BOM。
      if (f.endsWith('.ps1')) ensureUtf8Bom(join(libDir, f))
      copied.push(f)
    }
  }
  return copied
}

/** 确保 .ps1 产物带 UTF-8 BOM；已带则原样返回 false，缺失/不完整则补写并返回 true。 */
export function ensureUtf8Bom(filePath) {
  const buf = readFileSync(filePath)
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return false
  const text = buf.toString('utf8').replace(/^\uFEFF/, '')
  writeFileSync(filePath, '\uFEFF' + text, 'utf8')
  return true
}