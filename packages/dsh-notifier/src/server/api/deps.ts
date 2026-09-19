/** api 域依赖声明：只声明「我需要外部什么」，声明面**只有类型**（共享层设施由实现块直接引）。浏览器出口要的能力
 * 比别的域杂，但组成一样：域能力面（按提供方分组）+ 只有组合根够得着的两样（路由注册口、帧入口）。 */
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type * as configApi from "../config/interface.ts";
import type * as channelsApi from "../channels/interface.ts";
import type * as pipelineApi from "../pipeline/interface.ts";
import type * as sdkApi from "../sdk/interface.ts";
import type * as storesApi from "../stores/interface.ts";
import type { LoggerPort } from "../shared/interface.ts";

/** config 域给下游的能力面：设置页要读视图写设置，另含原始设置的只读面；
 * 草稿测试（dry-run）另要它的纯函数（resolveDraftChannels + normalizeConfig）——只读内存，
 * 不碰写面，调用方把还原原值显式传入，不在域内另读。 */
export type ConfigPort = Pick<
  typeof configApi,
  "readConfig" | "readSettingsView" | "writeConfig" | "resolveDraftChannels" | "normalizeConfig"
>;

/** stores 域给下游的能力面：通知记录与频道投递状态。 */
export type StorePort = Pick<typeof storesApi, "readHistory" | "clearHistory" | "readStatus">;

/** pipeline 域给下游的能力面：测试通知走**同一条**裁决管线；草稿测试（dry-run）另要它的
 * 目标直构件与定稿（与路由同一份映射，只是不走 judge / kindRoutes / 节奏门，见 dry-run 模块头）。 */
export type PipelinePort = Pick<
  typeof pipelineApi,
  "submit" | "finalizeRequest" | "barkTarget" | "browserTarget" | "systemTarget" | "webhookTarget"
>;

/** sdk 域给浏览器的能力面：动态种类的清单与用户确认。只要管理面、不要服务面——那是给兄弟插件的，设置页既不
 * 替别人登记种类，也不代人发送通知。 */
export type KindPort = Pick<typeof sdkApi, "confirmKind" | "listKinds">;

/** channels 域给浏览器的能力面：只读能力自检与平台事实，外加草稿测试的单目标出站。
 * **不含** `deliver`——api 域不该能伪造通知；`dryRunTarget` 是唯一的例外，且只接受已构造好的
 * 单个目标与固定的测试文案（目标由 pipeline 直构件产出，不接受任意通知请求），全程禁写面。 */
export type ChannelPort = Pick<
  typeof channelsApi,
  "probeCapabilities" | "hostPlatform" | "undeterminedCapabilities" | "dryRunTarget"
>;

export type { NotifyFrame } from "../channels/interface.ts";
export type { HostCapabilities } from "../channels/interface.ts";
export type { LoggerPort } from "../shared/interface.ts";
export type { RawSettingValue } from "../config/interface.ts";
export type { NotifyRequest } from "../pipeline/interface.ts";
export type { SseHub } from "../../../../../shared/sse-hub.js";

/** 帧的种类与载荷：定义在裁决管线那边，本域只透传，不在两侧各写一遍。 */
export type NotifyKind = pipelineApi.NotifyKind;
export type OutgoingFrame = pipelineApi.OutgoingFrame;

/** 宿主路由注册口：与宿主契约同源，不在两侧各写一遍。 */
export type RegisterRoute = (route: WebRoute) => () => void;

/** 帧入口：只有 `on` 没有 `emit`——api 域是帧的**消费者**，给它发帧的能力等于让它能伪造通知。 */
interface FrameInlet {
  onFrame(handler: (payload: OutgoingFrame) => void): () => void;
}

/** 装配入参：本域**拿不到**的东西（宿主能力）与它依赖的域。 */
export interface ApiDeps {
  /** 宿主路由注册口：只有组合根够得着 `ctx.webServer`。 */
  register: RegisterRoute;
  frames: FrameInlet;
  /** 失败出口（端点内的异常一律在这里出声，不静默吞）。 */
  logger: LoggerPort;
  config: ConfigPort;
  stores: StorePort;
  /** 下游裁决管线：页面上的测试按钮经它提交。 */
  pipeline: PipelinePort;
  /** 动态种类的管理面：设置页看清单、替用户确认。 */
  kinds: KindPort;
  /** channels 域的能力面：能力自检与平台事实。api 域**不投递**通知，投递由管线承担。 */
  channels: ChannelPort;
}
