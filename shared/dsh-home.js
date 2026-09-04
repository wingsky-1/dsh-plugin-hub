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
 * DSH home 基目录：`DSH_HOME` 非空白原样采用；未设置**或空白**回落
 * `~/.dsh`（默认形态路径逐字节不变）。语义对齐官方
 * `@deepseek-ai/dsh-home-paths#resolveDshHome`（空白 env 视同未设置）。
 * 落盘/读取持久化文件一律以本函数为 base
 * （docs/DEVELOPMENT.md §1「落盘路径必须感知 DSH_HOME」）。
 *
 * @returns {string} DSH home 目录路径。
 */
export function dshHome() {
  const env = process.env.DSH_HOME;
  return env !== undefined && env.trim().length > 0 ? env : join(homedir(), ".dsh");
}
