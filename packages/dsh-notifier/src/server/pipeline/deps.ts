/**
 * dsh-notifier pipeline 域 —— **依赖声明**。
 *
 * 本域声明「我需要外部什么」，不关心谁满足它——装配由组合根递进来。声明面**只有
 * 类型**：运行时能力不进这里（`ARCHITECTURE-METHOD.md` §2「跨域运行时能力一律经
 * `deps.ts` 注入」），实现块拿到的是装配入参里的能力对象。
 *
 * 能力按**提供方**分组，而不是一个能力一个字段：组合根递的是提供方的命名空间对象，
 * 于是本域将来多用一样能力时，装配那一侧一行都不用改。要哪几样仍然由本文件的 `Pick`
 * 说了算——分组收的是装配方的样板，不是本域的可见面。
 *
 * 而且不接收算好的值：设置是活的，装配期算出的数字会变成静态数据，而它看起来与实时
 * 读取一模一样。
 */
import type * as channelsApi from "../channels/interface.ts";
import type * as configApi from "../config/interface.ts";
import type * as storesApi from "../stores/interface.ts";
import type { NotifyKind } from "./impl/service/kinds.ts";

/** config 域给下游的能力面：本域只读设置，不改。 */
export type ConfigPort = Pick<typeof configApi, "readConfig">;

/** stores 域给下游的能力面：写历史（归档）与写频道终态（投递归位）。 */
export type StorePort = Pick<typeof storesApi, "appendHistory" | "recordStatus">;

/** channels 域给下游的能力面：把一条定稿消息投给若干出口。 */
export type ChannelsPort = Pick<typeof channelsApi, "deliver">;

/** 当前生效设置：从能力面派生，不请 config 域再多导出一个名字。 */
export type EffectiveConfig = ReturnType<ConfigPort["readConfig"]>;

/**
 * 帧出口的载荷：一次通知的种类，以及它该怎么弹。
 *
 * 种类与画面分开：`NotifyFrame` 是投递参数（怎么弹），kind 是这次通知**是什么**——
 * 客户端靠后者选图标与颜色。投递域不需要知道种类（消息无身份），所以它不在这份线
 * 协议里；但页面上要显示，于是随帧一起出去。
 */
export interface OutgoingFrame {
  kind: NotifyKind;
  frame: channelsApi.NotifyFrame;
}

/**
 * 帧出口：把一条待展示的通知交给宿主事件总线（组合根接线，api 域消费）。
 *
 * 它不属于任何域，所以不成「面」；写成具名接口而不是裸函数，是为了让依赖清单里出现
 * 的是「一个出口」，而不是一个看不出从哪来的回调。
 */
export interface FramePort {
  emit(payload: OutgoingFrame): void;
}

/** 装配入参：本域**拿不到**的东西（宿主能力、挂载点值）与它依赖的域。 */
export interface PipelineDeps {
  /** 组合层总开关：挂载点给的值，不落盘、不进设置层，装配期定下后不再变。 */
  enabled: boolean;
  /** 帧出口：接的是宿主事件总线，只有组合根够得着。 */
  frames: FramePort;
  /** 设置读面：每次裁决现取，不在装配期取快照。 */
  config: ConfigPort;
  /** 历史与频道状态的写面。 */
  stores: StorePort;
  /** 投递出口。 */
  channels: ChannelsPort;
}

export type { DeliveryTarget, NotifyMessage, NotifySeverity } from "../channels/interface.ts";
export type { ChannelDelivery, HistoryEntry } from "../stores/interface.ts";
