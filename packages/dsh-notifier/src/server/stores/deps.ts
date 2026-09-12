/**
 * dsh-notifier stores 域 —— **依赖声明**。
 *
 * 本域声明「我需要外部什么」，不关心谁满足它——装配由组合根完成。契约与实现块都
 * 经本文件引用，不直连他域。
 *
 * 依赖以**域**为单位，而且不接收算好的值：保留天数看着只是一个数字，实际是一条会变
 * 的设置——装配期取一次，用户之后改的值就再也不生效，症状是「历史清理不按设置来」，
 * 几乎没人会联想到装配那一刻。
 */
import type { LoggerPort } from "../shared/type.ts";

/** config 域对外契约的完整面。 */
export type ConfigPort = typeof import("../config/interface.ts");

/** 装配入参：本域依赖的全部外部。 */
export interface StoreDeps {
  /** 设置：保留天数等写入策略的来源，写历史时才读。 */
  config: ConfigPort;
  /** 写入失败出口（写入是 fire-and-forget，没有同步返回值可承载失败）。 */
  logger: LoggerPort;
}
