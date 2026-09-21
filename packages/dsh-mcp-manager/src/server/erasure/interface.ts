/**
 * dsh-mcp-manager — erasure/interface.ts：模型可见面兜底擦除域门面（#922 伴随项 E）。
 *
 * 本域只做一件事：在 system-prompt/assemble waterfall 的下游装配结果里，把
 * tools:sdk 段中漏网的 mcp__ 开头工具声明按声明级擦掉，并记数告警。
 * 为什么需要装配侧兜底：visibility 的 deny 是调用时刻快照加事件驱动重同步，
 * 连接翻转期注册表与连接池账本错位时必有泄漏窗口（#922 D1）；擦除域不修窗口，
 * 只保证窗口期模型也看不见泄漏声明。根因修复归方案 B，本域是伴随告警。
 *
 * 目录外（组合根）只能从本文件引用本域符号（verify-dir-imports 静态强制）。
 * 本域没有 deps.ts，也没有端口持有者：全部输入由组合根按调用实参递入。
 * 宿主类型只取官方类型层（catalog 锁版，仅 import type）。
 */
import type { AssembleContext, PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import type { LoggerPort } from "../shared/interface.ts";

/**
 * 组装 waterfall 的订阅口（组合根从宿主 ctx.on 递进来，本域不直接依赖 cordis）。
 * 签名与宿主 system-prompt/assemble 事件逐字对应，避免任何类型断言。
 */
export interface ErasureAssemblePort {
  onAssemble(
    handler: (
      assembly: PromptAssembly,
      context: AssembleContext,
      next: () => Promise<PromptAssembly>,
    ) => Promise<PromptAssembly>,
  ): () => void;
}

/**
 * startSdkErasure 的全部实参。
 */
export interface StartSdkErasureArgs {
  readonly assemble: ErasureAssemblePort;
  readonly logger: LoggerPort;
}

export { eraseMcpSdkDeclarations, startSdkErasure } from "./impl/guard/index.ts";
export type { ErasureResult, ErasureStats } from "./impl/guard/index.ts";
