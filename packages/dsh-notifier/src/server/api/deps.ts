/**
 * dsh-notifier api 域 —— **依赖声明**。
 *
 * 本域声明「我需要外部什么」，不关心谁满足它——装配由组合根递进来。声明面**只有
 * 类型**：运行时能力不进这里（`ARCHITECTURE-METHOD.md` §2「跨域运行时能力一律经
 * `deps.ts` 注入」）。
 *
 * 浏览器出口要的能力比别的域杂，但组成一样：三个域的能力面（按提供方分组）、以及
 * 只有组合根够得着的两样——路由注册口与帧入口。
 *
 * 共享层的三个设施（回环围栏、请求体读取、SSE 枢纽）**不在这里**：它们是跨包共享层
 * 的源码依赖，由用到的实现块直接引——同一个东西在注入面上过一道，只会让「本域依赖
 * 了哪个域」这张清单里混进不属于任何域的条目。
 */
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type * as configApi from "../config/interface.ts";
import type * as pipelineApi from "../pipeline/interface.ts";
import type * as sdkApi from "../sdk/interface.ts";
import type * as storesApi from "../stores/interface.ts";
import type { LoggerPort } from "../shared/type.ts";

/** config 域给下游的能力面：设置页要读视图写设置，流枢纽要读连接上限。 */
export type ConfigPort = Pick<typeof configApi, "readConfig" | "readSettingsView" | "writeConfig">;

/** stores 域给下游的能力面：通知记录与频道投递状态。 */
export type StorePort = Pick<typeof storesApi, "readHistory" | "clearHistory" | "readStatus">;

/** pipeline 域给下游的能力面：测试通知走**同一条**裁决管线。 */
export type PipelinePort = Pick<typeof pipelineApi, "submit">;

/**
 * sdk 域给浏览器的能力面：动态种类的清单与用户确认。
 *
 * 只要管理面，不要服务面（登记与发送）：那是给兄弟插件的。设置页既不替别人登记种类，
 * 也不代人发送通知。
 */
export type KindPort = Pick<typeof sdkApi, "confirmKind" | "listKinds">;

export type { NotifyFrame } from "../channels/interface.ts";
export type { LoggerPort } from "../shared/type.ts";
export type { RawSettingValue } from "../config/interface.ts";
export type { NotifyRequest } from "../pipeline/interface.ts";
export type { SseHub } from "../../../../../shared/sse-hub.js";

/** 帧的种类与载荷：定义在裁决管线那边，本域只透传，不在两侧各写一遍。 */
export type NotifyKind = pipelineApi.NotifyKind;
export type OutgoingFrame = pipelineApi.OutgoingFrame;

/** 宿主路由注册口：与宿主契约同源，不在两侧各写一遍。 */
export type RegisterRoute = (route: WebRoute) => () => void;

/**
 * 帧入口：订阅待展示的通知帧（组合根把帧总线的消费那一头接好）。
 *
 * 只有 `on` 没有 `emit`：api 域是帧的**消费者**，给它发帧的能力等于让它能伪造通知。
 * 生产帧是裁决管线的事。
 */
interface FrameInlet {
  onFrame(handler: (payload: OutgoingFrame) => void): () => void;
}

/** 装配入参：本域**拿不到**的东西（宿主能力）与它依赖的域。 */
export interface ApiDeps {
  /** 宿主路由注册口：只有组合根够得着 `ctx.webServer`。 */
  register: RegisterRoute;
  /** 帧入口。 */
  frames: FrameInlet;
  /** 失败出口（端点内的异常一律在这里出声，不静默吞）。 */
  logger: LoggerPort;
  /** 设置读面与写面。 */
  config: ConfigPort;
  /** 历史与频道状态的读面。 */
  stores: StorePort;
  /** 下游裁决管线：页面上的测试按钮经它提交。 */
  pipeline: PipelinePort;
  /** 动态种类的管理面：设置页看清单、替用户确认。 */
  kinds: KindPort;
}
