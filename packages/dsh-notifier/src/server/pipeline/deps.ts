/**
 * dsh-notifier pipeline 域 —— **依赖声明**。
 *
 * 本域声明「我需要外部什么」，不关心谁满足它——装配由组合根完成。域之间不互相注入：
 * 需要谁的能力，在这里引出来，实现块从本文件取。于是装配方只需要给「本域拿不到的
 * 东西」——宿主能力与挂载点值。
 *
 * 依赖以**能力**为单位，而且不接收算好的值：设置是活的，装配期算出的数字会变成静态
 * 数据，而它看起来与实时读取一模一样。
 */
import type { NotifyFrame } from "../channels/interface.ts";
import { readConfig } from "../config/interface.ts";

export { deliver } from "../channels/interface.ts";
export { readConfig };
export { appendHistory, recordStatus } from "../stores/interface.ts";

/** 当前生效设置：config 读面的返回类型，不请 config 域再多导出一个名字。 */
export type EffectiveConfig = ReturnType<typeof readConfig>;

/**
 * 帧出口：通知帧交给宿主事件总线（组合根接线，api 域消费）。
 *
 * 它不属于任何域，所以不成「面」；写成具名接口而不是裸函数，是为了让依赖清单里出现
 * 的是「一个出口」，而不是一个看不出从哪来的回调。
 */
export interface FramePort {
  emit(frame: NotifyFrame): void;
}

/** 装配入参：本域**拿不到**的东西。域间依赖不在这里——它们由本文件直接引。 */
export interface PipelineDeps {
  /** 组合层总开关：挂载点给的值，不落盘、不进设置层，装配期定下后不再变。 */
  enabled: boolean;
  /** 帧出口：接的是宿主事件总线，只有组合根够得着。 */
  frames: FramePort;
}

export type { NotifyFrame };
export type { DeliveryTarget, NotifyMessage } from "../channels/interface.ts";
export type { ChannelDelivery, HistoryEntry } from "../stores/interface.ts";
