/** api 域依赖声明：只声明「我需要外部什么」，声明面**只有类型**（共享层设施由实现块直接引）。浏览器出口要的能力
 * 比别的域杂，但组成一样：域能力面（按提供方分组）+ 只有组合根够得着的两样（路由注册口、帧入口）。 */
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type * as configApi from "../config/interface.ts";
import type * as pipelineApi from "../pipeline/interface.ts";
import type * as sdkApi from "../sdk/interface.ts";
import type * as storesApi from "../stores/interface.ts";
import type { LoggerPort } from "../shared/interface.ts";

/** config 域给下游的能力面：设置页要读视图写设置，流枢纽要读连接上限。 */
export type ConfigPort = Pick<typeof configApi, "readConfig" | "readSettingsView" | "writeConfig">;

/** stores 域给下游的能力面：通知记录与频道投递状态。 */
export type StorePort = Pick<typeof storesApi, "readHistory" | "clearHistory" | "readStatus">;

/** pipeline 域给下游的能力面：测试通知走**同一条**裁决管线。 */
export type PipelinePort = Pick<typeof pipelineApi, "submit">;

/** sdk 域给浏览器的能力面：动态种类的清单与用户确认。只要管理面、不要服务面——那是给兄弟插件的，设置页既不
 * 替别人登记种类，也不代人发送通知。 */
export type KindPort = Pick<typeof sdkApi, "confirmKind" | "listKinds">;

export type { NotifyFrame } from "../channels/interface.ts";
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
}
