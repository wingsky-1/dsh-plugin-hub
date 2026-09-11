#!/usr/bin/env node
/**
 * cov:src — **源码口径**覆盖率度量入口（issue #690 S1）。
 *
 * 为什么单独一个命令而不替换 `pnpm cov`：`pnpm cov` 是 CI mutation-verdict 的
 * 覆盖率输入，其 self-written 派生（scripts/gate/self-cov.mjs）的口径绑定 **lib
 * 产物形态**（靠 esbuild 边界注释 / 垫片过滤分段）。本脚本经 lib→src hook 让测试
 * 从 src 加载，coverage 数据路径随之变为 `src/*.ts`，self-cov 解析不到产物形态 →
 * 逐包报 `self-written 函数覆盖 0%` → PR 全红（已实测）。
 * refactor-plan §6 也把「覆盖率经源码镜像」列为**移出**的仓库级项（破坏单包
 * PR 可独立回滚），故这里的定位是**开发者/评审用的真实口径度量**，不动 CI 判分。
 *
 * 为什么需要它：`pnpm cov` 从产物入口采集时，src 行只统计「被产物直连加载」的
 * 模块——实测 `All files 61.61%`、`events/event-handlers.ts` 27.24%、
 * `server/routes.ts` 46.72%，是失真值。复用 Stryker 测试宿主既有的 lib→src
 * resolve hook（scripts/test/mutation-lib-to-src-hook.mjs）把 `lib/*.js` 解析重定向
 * 到同包 `src/*.ts` 后，真实口径为 `All files 93.02%`、`event-handlers.ts` 96.91%、
 * `sdk/service.ts` 94.42%、`server/routes.ts` 92.28%。
 *
 * 为什么不写成 `NODE_OPTIONS="..." c8 ...` 放进 package.json：仓库无环境变量前缀
 * 脚本先例，且该语法在 Windows cmd 下不成立；Node wrapper 用 file URL 传路径，
 * 天然跨平台（也规避盘符与空格问题）。
 *
 * 约束：hook 只在本命令注入——`pnpm test` 与 `pnpm cov` 仍直跑产物，测试三层
 * 口径与 CI 判分口径都不受影响。
 * 前提：需要先有 lib 产物（与 `pnpm cov` 一致，CI 的 coverage job 先跑 pnpm build）。
 *
 * 用法：node scripts/gate/cov.mjs（或 pnpm cov:src）
 * 退出码：透传 c8 的退出码（采集失败必须显式失败，不得吞掉）。
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = join(ROOT, 'scripts', 'test', 'mutation-lib-to-src-hook.mjs')
const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(HOOK).href}`].filter(Boolean).join(' ')

// 直接以 node 执行 c8 的入口，而不是 `pnpm exec c8`：后者在 Windows 需要 shell 才能
// 解析 pnpm.cmd，而 shell 化又会让 `--filter !dsh-plugin-hub` 的 `!` 被 cmd 当延迟
// 扩展符解释。node + 解析出的绝对路径在两端都无歧义。
const require = createRequire(import.meta.url)
let c8Bin
try {
  c8Bin = require.resolve('c8/bin/c8.js')
} catch {
  c8Bin = join(ROOT, 'node_modules', 'c8', 'bin', 'c8.js')
}

const spawned = spawnSync(
  process.execPath,
  [
    c8Bin,
    '--reporter=json',
    '--reporter=json-summary',
    '--reporter=text',
    'pnpm',
    '-r',
    '--filter',
    '!dsh-plugin-hub',
    '--if-present',
    'test',
  ],
  { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: nodeOptions } },
)

if (spawned.error) {
  console.error(`cov: 启动 c8 失败：${spawned.error.message}`)
  process.exit(1)
}
process.exit(spawned.status ?? 1)
