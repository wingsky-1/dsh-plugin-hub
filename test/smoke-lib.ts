// @ts-nocheck
'use strict'

/**
 * smoke-lib — 共享 smoke 工具（各包 test/smoke.ts 复用，业务断言保留在各自文件）。
 *
 * 提供：
 *   - check(name, fn) / report(title)：断言注册 + 汇总 + 退出码（预留，供后续换用；
 *     存量 6 包 smoke 仍用各自本地实现，业务断言未迁移）；
 *   - fakeReq / makeRes：路由 handler 测试用 req/res stub（预留，后续接入）；
 *   - assertClientProductContract：客户端产物「执行契约」断言——复用 scripts/client-contract-lib.ts
 *     （与 contract-check 同一实现，消除 6 份 smoke 内嵌重复的业务语义）【已接入】；
 *   - assertClientSourceContract：客户端产物「源形态」契约断言（兼容 legacy 手写 IIFE 与
 *     wrapper 生成两种产物形态）【已接入】；
 *   - clientRouteLiterals：提取客户端产物中的字符串字面量（预留；pattern 必须为编译期
 *     可信字面量，勿拼接外部输入）。
 *
 * 历史教训：id 等契约断言曾在每个带客户端包的 smoke.ts 中各自内联（6 份近似重复，
 * 格式一致但实现各异），未来 client 变化会漏改——统一至此一处。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertClientContract } from '../scripts/client-contract-lib.ts'

let count = 0
let failedCount = 0

/** 断言注册：捕获失败并记录（不中断流程），立即输出 ok/FAIL。 */
export function check(name, fn) {
  count++
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (e) {
    failedCount++
    console.log(`  FAIL ${name}: ${String(e.message).split('\n')[0]}`)
  }
}

/** 汇总 + 设置进程退出码；返回失败数。 */
export function report(title = 'smoke') {
  const failed = failedCount
  console.log(failed === 0 ? `${title}: all checks passed` : `${title}: ${failed} failed / ${count} total`)
  process.exitCode = failed === 0 ? 0 : 1
  return failed
}

/** fake IncomingMessage（默认回环地址 + GET；可覆盖）。 */
export function fakeReq(overrides = {}) {
  return {
    method: 'GET',
    url: '/',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  }
}

/** fake ServerResponse：收集 statusCode/headers/chunks，end 置 done 标志。 */
export function makeRes() {
  const rec = { statusCode: 200, statusMessage: null, headers: {}, chunks: [], done: false }
  const res = {
    statusCode: 200,
    setHeader(k, v) { rec.headers[k] = v },
    getHeader(k) { return rec.headers[k] },
    writeHead(code, msg, headers) {
      rec.statusCode = code
      if (typeof msg === 'string') rec.statusMessage = msg
      if (headers) Object.assign(rec.headers, headers)
      return res
    },
    write(chunk) {
      if (chunk) rec.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      return true
    },
    end(chunk) {
      rec.done = true
      if (chunk) rec.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      return res
    },
  }
  return { res, rec }
}

/** 客户端产物执行契约断言（复用 client-contract-lib，与 contract-check 同源）。
 *  @param pkgDir 插件包目录（fs 路径），内部读取 package.json 与 lib/client.js。 */
export function assertClientProductContract(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const code = readFileSync(join(pkgDir, 'lib', 'client.js'), 'utf8')
  const { ok, checks } = assertClientContract(pkg.name, code)
  assert.ok(
    ok,
    `客户端契约断言失败: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(', ') || '未知'}`,
  )
}

/** 客户端产物源形态契约断言（兼容 legacy 手写 IIFE 与 wrapper 生成两种产物）。
 *  @param pkgDir 插件包目录（fs 路径）。 */
export function assertClientSourceContract(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const clientCode = readFileSync(join(pkgDir, 'lib', 'client.js'), 'utf8')
  assert.strictEqual(
    clientCode.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*"([^"]+)"/)?.[1],
    pkg.name,
    '客户端注册 id 必须等于包名（浏览器 arrive 契约）',
  )
  assert.ok(clientCode.includes('"use strict"'), 'use strict')
  // 契约外壳：legacy/wrapper 是 IIFE 包裹；externals(cjs factory) 是顶层 load。
  // 两者都经 window.__ModuleLoader__.load 注册（已有 load id 断言兜底）——
  // 此处断言外壳存在即可，兼容三种产物形态。
  assert.ok(/\(\(\)\s*=>|\(function\s*\(\)\s*\{/.test(clientCode) || /window\.__ModuleLoader__\.load\s*\(/.test(clientCode), '契约外壳（IIFE 或顶层 load）')
  // exports 装配：legacy/wrapper 产物是 `exports.apply =` 直接赋值；externals(factory)
  // 产物经 esbuild cjs __export 装配——功能契约由 assertClientProductContract（执行断言）
  // 硬保证，此处仅需确认 apply/inject 导出名存在于产物。
  assert.ok(/exports\.apply\s*=|export \{|apply:/.test(clientCode) && /\bapply\b/.test(clientCode), 'exports.apply 装配')
  assert.ok(/exports\.inject\s*=|export \{|inject:/.test(clientCode) && /\binject\b/.test(clientCode), 'exports.inject 装配')
  assert.ok(clientCode.includes('Symbol.toStringTag'), 'Symbol.toStringTag')
  assert.ok(/factory:\s*function\s*\(/.test(clientCode), 'factory 函数形态（含 esbuild 重命名）')
  // 结尾兼容三种产物：legacy/wrapper 是 `})();`，externals(factory) 是 `})`（顶层 load 闭合）
  const trimmedEnd = clientCode.trimEnd()
  assert.ok(trimmedEnd.endsWith('})') || trimmedEnd.endsWith('})();'), 'load 注册在文件末尾')
  const codeOnly = clientCode.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  assert.equal((codeOnly.match(/__ModuleLoader__\.load/g) || []).length, 1, 'load 恰好一次')
}

/** 提取客户端产物中的字符串字面量（宿主 ROUTES/CHANNEL 一致性断言的辅助）。 */
export function clientRouteLiterals(clientCode, pattern) {
  const found = new Set()
  for (const m of clientCode.matchAll(new RegExp(pattern, 'g'))) {
    found.add(m[1])
  }
  return [...found]
}