/**
 * dsh-notifier stores 域 —— **依赖声明**。
 *
 * 本域声明「我需要外部什么」，不关心谁满足它——装配由组合根完成。契约与实现块都
 * 经本文件引用，不直连他域。
 *
 * `readConfig` 以**能力**的形式在这里出现，而不是装配期算好的一个数字：保留天数看着
 * 只是一个数，实际是一条会变的设置——取一次快照，用户之后改的值就再也不生效，症状是
 * 「历史清理不按设置来」，几乎没人会联想到装配那一刻。
 */
import type { LoggerPort } from "../shared/type.ts";

export { readConfig } from "../config/interface.ts";

/** 装配入参：本域依赖的全部外部。 */
export interface StoreDeps {
  /** 写入失败出口（写入是 fire-and-forget，没有同步返回值可承载失败）。 */
  logger: LoggerPort;
}
