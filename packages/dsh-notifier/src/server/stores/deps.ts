/**
 * dsh-notifier stores 域 —— **依赖声明**。
 *
 * 本域声明「我需要外部什么」，不关心谁满足它——装配由组合根递进来。声明面**只有
 * 类型**：运行时能力不进这里（`ARCHITECTURE-METHOD.md` §2「跨域运行时能力一律经
 * `deps.ts` 注入」），实现块使的能力来自装配入参。
 *
 * 设置以**能力**的形式出现，而不是装配期算好的一个数字：保留天数看着只是一个数，
 * 实际是一条会变的设置——取一次快照，用户之后改的值就再也不生效，症状是「历史清理
 * 不按设置来」，几乎没人会联想到装配那一刻。
 */
import type * as configApi from "../config/interface.ts";
import type { LoggerPort } from "../shared/type.ts";

/**
 * config 域给下游的能力面。
 *
 * 用 `Pick` 而不是整个命名空间：本域只用到「读当前生效设置」。把写面一并递进来，等于
 * 让历史存储具备了改设置的能力，而它连设置长什么样都不该关心。
 */
export type ConfigPort = Pick<typeof configApi, "readConfig">;

/** 装配入参：本域依赖的全部外部。 */
export interface StoreDeps {
  /** 写入失败出口（写入是 fire-and-forget，没有同步返回值可承载失败）。 */
  logger: LoggerPort;
  /** 设置读面：保留天数每次读时现取，不在装配期取快照。 */
  config: ConfigPort;
}

