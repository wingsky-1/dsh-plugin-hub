/**
 * dsh-notifier pipeline 域 —— 路由块自己的形状。
 * 出站频道配置与投递参数都经设置模型、目标联合可达，不引它们的实现文件。
 */
import type { DeliveryTarget, EffectiveConfig, FramePort } from "../../deps.ts";
import type { LoggerPort } from "../../../shared/interface.ts";

/** 配置里的频道（出站实例 + 内置频道）。 */
export type ChannelConfig = EffectiveConfig["channels"][number];
export type BarkConfig = Extract<ChannelConfig, { type: "bark" }>;
export type WebhookConfig = Extract<ChannelConfig, { type: "webhook" }>;
export type BrowserConfig = Extract<ChannelConfig, { type: "browser" }>;
export type SystemConfig = Extract<ChannelConfig, { type: "system" }>;

/** 出站频道的投递参数。 */
export type BarkTarget = Extract<DeliveryTarget, { type: "bark" }>;
export type WebhookTarget = Extract<DeliveryTarget, { type: "webhook" }>;

/** bark 目标上按「有配置才带」处理的文本字段（`badge` 是数字，不走这里）。 */
export type BarkTextKey = "level" | "group" | "sound" | "icon" | "url";

/** 带身份的目标：下标只说得出「第几个」，记频道状态要的是「哪个频道」。 */
export interface RoutedTarget {
  /** 频道身份：`bark:<id>` / `webhook:<id>` / 内置 `browser`、`system`。 */
  channelId: string;
  target: DeliveryTarget;
}

/** 路由结果：本次要投递的目标，以及指向已删除频道的路由项（编排层据此 warn）。 */
export interface RouteOutcome {
  targets: RoutedTarget[];
  stale: string[];
}

/** 路由入参：构造目标时本块拿不到的东西。 */
export interface RouteDeps {
  /** 帧出口：浏览器目标的 `emitFrame` 由它构造。 */
  frames: FramePort;
  /** 失败出口：出站频道读取按 fail-soft 处理，只记日志。 */
  logger: LoggerPort;
}
