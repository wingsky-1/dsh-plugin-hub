/**
 * dsh-notifier pipeline 域 —— 路由块自己的形状。
 */
import type { DeliveryTarget, FramePort } from "../../deps.ts";

/**
 * 带身份的目标。
 *
 * 投递层的 `DeliveryTarget` 刻意不带出口身份——「我是谁」是配置层与裁决层的概念，
 * 投递层不需要。但记频道状态需要身份，而 `DeliverResult` 同样不带（它按 `targets`
 * 下标同序归位）。身份因此必须在这里补上：下标只说得出「第几个」，说不出「哪个
 * 频道」，而设置页要展示的是后者。
 */
export interface RoutedTarget {
  /** 频道身份：配置里的实例 id，也是设置页定位那一行的键。 */
  channelId: string;
  target: DeliveryTarget;
}

/** 路由入参：构造目标时本块拿不到的东西。 */
export interface RouteDeps {
  /** 帧出口：浏览器目标自带发帧能力，由编排层从装配入参里取出来。 */
  frames: FramePort;
}
