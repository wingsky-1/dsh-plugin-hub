#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * contract-check — 客户端 8 项契约语义校验（与上游 check-client-contract 等价，
 * 适配 scope 包名：client id 与包名短名一致，如 @wingsky/dsh-memory → dsh-memory）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugins = readdirSync(join(ROOT, 'packages'))
  .filter(d => d.startsWith('dsh-') && existsSync(join(ROOT, 'packages', d, 'lib', 'client.js')))

let failed = 0
for (const p of plugins) {
  const c = readFileSync(join(ROOT, 'packages', p, 'lib', 'client.js'), 'utf8')
  const idMatch = c.match(/id: "([^"]+)"/)
  const codeOnly = c.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  const checks = {
    'id与包名短名一致': idMatch ? idMatch[1] === p : false,
    'load恰好一次': (codeOnly.match(/__ModuleLoader__\.load/g) ?? []).length === 1,
    'apply导出': /exports\.apply = apply/.test(c),
    'inject导出': /exports\.inject = inject/.test(c),
    'Symbol.toStringTag': c.includes('Symbol.toStringTag'),
    'factory函数形态': /factory:\s*function\s*\(/.test(c),
    'IIFE包裹': /\(function\s*\(\)\s*\{|\(\(\)\s*=>\s*\{/.test(c),
    'load在文件末尾': c.trimEnd().endsWith('})();'),
  }
  const ok = Object.values(checks).every(Boolean)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${p} | ${Object.entries(checks).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`)
}
if (plugins.length === 0) console.log('（当前无带客户端插件的包）')
console.log(failed === 0 ? '\n客户端契约：全部通过' : `\n客户端契约：${failed} 个失败`)
process.exit(failed === 0 ? 0 : 1)
