// dsh 插件家族共享层 — DSH home 解析（单一事实源）。
//
// 历史：`process.env.DSH_HOME ?? join(homedir(), ".dsh")` 在 4 包 9 处逐字复制
// （#517 全仓扫描），且与 mcp-manager manager.ts 的空串防御形态并存——
// `DSH_HOME=""` 在两种形态下分别解析为 cwd 相对路径（随进程 cwd 漂移）与
// 默认 home，行为分裂。统一由本模块承载：**空白（空串/纯空白）视同未设置**
// ——与官方 `@deepseek-ai/dsh-home-paths` `resolveDshHome` 权威语义对齐
// （"An empty or whitespace-only `$DSH_HOME` is treated as unset"），非空 env
// 原样采用（不 resolve、不展开 `~`——官方在 resolve 层做，插件落盘拼 base
// 不需要），保证默认形态路径逐字节不变。
//
// 消费方：dsh-notifier / dsh-lan-proxy / dsh-mcp-manager / dsh-provider-usage
// （provider-usage 的 path-resolve.ts pluginHome 为渐进退役 facade，内部改调
// 本模块，公开签名不变）。

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 用户 home 目录（`~` 的展开目标）：`HOME` 非空白原样采用；未设置或空白回落
 * `os.homedir()`。Windows 按 Node/libuv 语义以 `USERPROFILE` 优先（libuv 在
 * Windows 只读 `USERPROFILE`，`HOME` 仅作次级宽容）。
 *
 * 为什么不直接用 `os.homedir()`：它读的是**进程级** environ（libuv `getenv`），
 * 而 worker_threads 里的 `process.env` 只是每线程副本、对 native addon 不可见
 * （Node 官方 worker_threads 文档：changes "are not visible to native add-ons"）。
 * Stryker 的 vitest-runner 强制 `pool: 'threads'` 且 inline 选项无法被配置覆盖，
 * 于是测试里 `process.env.HOME = <临时目录>` 的隔离整片失效。显式 env 优先既恢复
 * 可测性，又与 libuv 自身的取值次序一致（POSIX：`$HOME` 优先，未定义才查 passwd），
 * **默认形态逐字节不变**。业界同形先例：npm `loadHome()`、gemini-cli `GEMINI_CLI_HOME`。
 *
 * @returns {string} 用户 home 目录路径。
 */
export function userHome() {
  const env = process.platform === "win32"
    ? (process.env.USERPROFILE ?? process.env.HOME)
    : process.env.HOME;
  return env !== undefined && env.trim().length > 0 ? env : homedir();
}

/**
 * DSH home 基目录：`DSH_HOME` 非空白原样采用；未设置**或空白**回落
 * `~/.dsh`（默认形态路径逐字节不变）。语义对齐官方
 * `@deepseek-ai/dsh-home-paths#resolveDshHome`（空白 env 视同未设置）。
 * 落盘/读取持久化文件一律以本函数为 base——仓库纪律「落盘路径必须感知
 * DSH_HOME」及其豁免口径由 docs/DEVELOPMENT.md §1 承载（PR #523）。
 *
 * @returns {string} DSH home 目录路径。
 */
export function dshHome() {
  const env = process.env.DSH_HOME;
  return env !== undefined && env.trim().length > 0 ? env : join(userHome(), ".dsh");
}
