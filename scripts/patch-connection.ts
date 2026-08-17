#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * patch-connection — 为 dsh-client-connection 的 isLoopback 判定打上显式信任开关
 * （lan-proxy 配套：内网设备经 lan-proxy 获得完整 settings 读写），幂等。
 *
 * 背景（开源仓自足，EPLAN 阶段 E S3）：该补丁原唯一实现在开发主仓 dshx.py，
 * 只维护开源仓后 npm 用户无法获得 → 内网 settings 读写静默失效。本脚本把实现
 * 迁入开源仓，lan-proxy README 显式声明安装步骤。
 *
 * 原理：客户端注入 __dshTrustedLan，宿主 dsh-client-connection 的 isLoopback
 * 判定需被打补丁（追加 `|| globalThis.__dshTrustedLan === true`）才有消费方。
 * 幂等：已含标记则跳过；目标文本缺失（dsh 升级变更）则报错不覆盖。
 *
 * 用法：
 *   node scripts/patch-connection.ts               # 自动探测宿主 bundle 路径
 *   node scripts/patch-connection.ts --bundle <abs> # 显式指定 dsh-client-connection/lib/client.js
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PATCH_OLD = 'isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),'
const PATCH_NEW = 'isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname) || globalThis.__dshTrustedLan === true,'
const PATCH_MARK = 'dsh-lan-proxy patch'

/** 解析 --bundle 参数（若提供）。 */
function bundleArg(argv) {
  const i = argv.indexOf('--bundle')
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined
}

/** 候选 bundle 路径（显式 / DSH_PACKAGES_ROOT / Volta 默认布局，与 dshx.py 探测对齐）。 */
function candidateBundles(explicit) {
  if (explicit) return [explicit]
  const inner = join('node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-connection', 'lib', 'client.js')
  const env = process.env.DSH_PACKAGES_ROOT
  if (env) return [join(env, '@deepseek-ai', 'dsh', inner)]
  // Volta：node 在 tools/image/node/<ver>/，packages 在其下
  const volta = join(dirname(process.execPath), '..', '..', '..', 'packages')
  return [
    join(volta, '@deepseek-ai', 'dsh', inner),
    join(volta, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', inner),
  ]
}

function main() {
  const bundlePath = candidateBundles(bundleArg(process.argv)).find(existsSync)
  if (!bundlePath) {
    console.error('[patch-connection] 未找到 dsh-client-connection bundle。')
    console.error('  用 --bundle <绝对路径> 指定 dsh-client-connection/lib/client.js，或设置 DSH_PACKAGES_ROOT。')
    process.exit(1)
  }

  const source = readFileSync(bundlePath, 'utf8')
  if (source.includes(PATCH_MARK)) {
    console.log(`[patch-connection] 已应用（幂等）：${bundlePath}`)
    return
  }
  if (!source.includes(PATCH_OLD)) {
    console.error(`[patch-connection] 在 ${bundlePath} 未找到目标文本——dsh 升级导致 bundle 变更？`)
    console.error(`  期望: ${PATCH_OLD}`)
    process.exit(1)
  }
  const newSource = source.replace(
    PATCH_OLD,
    `// ${PATCH_MARK}: 显式信任开关，内网设备经 lan-proxy 获得完整 settings 读写\n\t\t\t\t${PATCH_NEW}`,
  )
  writeFileSync(bundlePath, newSource, 'utf8')
  console.log(`[patch-connection] 已应用至 ${bundlePath}`)
}

main()