/** pipeline 域依赖声明：只声明「我需要外部什么」，声明面**只有类型**；能力按**提供方**分组（本域将来多用一样时
 * 装配那侧不用改，要哪几样仍由 `Pick` 说了算），也不接算好的值——设置是活的，装配期算出的数字会变成静态数据。 */
import type * as channelsApi from "../channels/interface.ts";
import type * as configApi from "../config/interface.ts";
import type { LoggerPort } from "../shared/interface.ts";
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

/** 帧出口的载荷：一次通知的种类，以及它该怎么弹。种类与画面分开——`NotifyFrame` 是投递参数（怎么弹），kind 是
 * 这次通知**是什么**，客户端靠后者选图标与颜色；投递域不需要知道种类（消息无身份），但页面上要显示，故随帧一起出去。 */
export interface OutgoingFrame {
  kind: NotifyKind;
  frame: channelsApi.NotifyFrame;
}

/** 帧出口：把一条待展示的通知交给浏览器那一侧的入口（组合根接线，api 域消费）。实现由组合根本地接线（`FrameBus`），
 * **不经过宿主事件总线**——帧的生产与消费两端都在本包内，挂上全局总线等于把一条内网线拉到公共面上。 */
export interface FramePort {
  emit(payload: OutgoingFrame): void;
}

/** 装配入参：本域**拿不到**的东西（宿主能力、挂载点值）与它依赖的域。 */
export interface PipelineDeps {
  /** 组合层总开关：挂载点给的值，不落盘、不进设置层，装配期定下后不再变。 */
  enabled: boolean;
  /** 帧出口：只有组合根够得着 api 域的帧入口。 */
  frames: FramePort;
  /** 失败出口：投递层承诺 fail-soft，真抛出来时只有这里能出声。 */
  logger: LoggerPort;
  /** 设置读面：每次裁决现取，不在装配期取快照。 */
  config: ConfigPort;
  stores: StorePort;
  channels: ChannelsPort;
}

export type { DeliveryTarget, NotifyMessage, NotifySeverity } from "../channels/interface.ts";
export type { ChannelDelivery, HistoryEntry } from "../stores/interface.ts";
