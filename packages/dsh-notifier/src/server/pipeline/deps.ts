/**
 * dsh-notifier pipeline 域 —— **依赖声明**。
 *
 * 本域声明「我需要外部什么」，不关心谁满足它——装配由组合根完成。契约与实现块都
 * 经本文件引用，不直连他域。
 *
 * 依赖一律以**域**为单位，而不是把对方的方法拆成一个个函数传进来：写 `config` 而
 * 不是 `readConfig`。散装函数在装配点读不出「依赖哪个域」，而且每多用到一个方法就要
 * 动一次组合根；域级的面一次说清边界，新增用法不必再改装配。
 *
 * 也不接收**算好的值**。设置是活的：用户在设置页提交后，装配期算出的数字就成了静态
 * 数据，而它看起来与实时读取一模一样——这类退化没有任何症状，直到有人改了设置却发现
 * 不生效。
 */
import type { NotifyFrame } from "../channels/interface.ts";

/** config 域对外契约的完整面。 */
export type ConfigPort = typeof import("../config/interface.ts");

/** channels 域对外契约的完整面。 */
export type ChannelsPort = typeof import("../channels/interface.ts");

/** stores 域对外契约的完整面。 */
export type StoresPort = typeof import("../stores/interface.ts");

/** 当前生效设置：config 读面的返回类型，不请 config 域再多导出一个名字。 */
export type EffectiveConfig = ReturnType<ConfigPort["readConfig"]>;

/**
 * 帧出口：通知帧交给宿主事件总线（组合根接线，api 域消费）。
 *
 * 它不属于任何域，所以不成「面」；写成具名接口而不是裸函数，是为了让依赖清单里出现
 * 的是「一个出口」，而不是一个看不出从哪来的回调。
 */
export interface FramePort {
  emit(frame: NotifyFrame): void;
}

/** 装配入参：本域依赖的全部外部。 */
export interface PipelineDeps {
  /** 组合层总开关：挂载点给的值，不落盘、不进设置层，装配期定下后不再变。 */
  enabled: boolean;
  /** 设置：裁决与路由的唯一设置来源。 */
  config: ConfigPort;
  /** 投递：消息与目标由本域构造，投递域只回答送到没有。 */
  channels: ChannelsPort;
  /** 持久化：历史与频道状态的写入出口。 */
  stores: StoresPort;
  /** 帧出口。 */
  frames: FramePort;
}

export type { NotifyFrame };
export type { DeliveryTarget, NotifyMessage } from "../channels/interface.ts";
export type { ChannelDelivery, HistoryEntry } from "../stores/interface.ts";
