#!/usr/bin/env node
/**
 * cov:src — **源码口径**覆盖率度量入口（issue #690 S1）。
 *
 * 现状（#722 阶段三起）——本命令已冗余，退役归阶段 5：
 *   它当初的存在理由是「`pnpm cov` 只能从 lib 产物采集，src 行是失真值」。阶段三把
 *   `pnpm cov` 换成 vitest 的 istanbul provider 并只跑 unit + integration（两者直连
 *   `src/`）后，**`pnpm cov` 本身就是 src 口径**，本命令的动机不复存在。差异只剩采集
 *   范围：本命令走 c8 默认口径（凡被加载的文件都进分母，含 `scripts/**`），而
 *   `pnpm cov` 由 include 限定为 `packages/*/src` + `shared`——后者才是 CI 判分口径。
 *   两者共用 `coverage/coverage-final.json` 同一落盘路径，**先跑本命令会覆盖 CI 口径
 *   的产物**，不要连着跑。
 *
 * 保留原因：仍可跑通（实测 exit 0），作为独立采集器的对照面存在；退役必须与
 * mutation-lib-to-src-{hook,loader}.mjs 同批（本命令是它们仅剩的引用方），归阶段 5。
 *
 * 历史动机（保留以备回溯）：`pnpm cov` 曾是 CI mutation-verdict 的覆盖率输入，其
 * self-written 派生（scripts/gate/self-cov.mjs，阶段三已退役）绑定 lib 产物形态
 * （esbuild 边界注释 / 垫片过滤分段）；本脚本经 lib→src hook 让测试从 src 加载，
 * 把产物口径下的失真值（`All files 61.61%`、`events/event-handlers.ts` 27.24%、
 * `server/routes.ts` 46.72%）还原为真实口径（93.02% / 96.91% / 92.28%）。
 *
 * 为什么不写成 `NODE_OPTIONS="..." c8 ...` 放进 package.json：仓库无环境变量前缀
 * 脚本先例，且该语法在 Windows cmd 下不成立；Node wrapper 用 file URL 传路径，
 * 天然跨平台（也规避盘符与空格问题）。
 *
 * 约束：hook 只在本命令注入——`pnpm test` 与 `pnpm cov` 不受影响。
 * 前提：需要先有 lib 产物（契约测试仍读 lib）。
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
