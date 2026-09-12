/** sdk 域依赖声明：只声明「我需要外部什么」，声明面**只有类型**；能力按提供方分组（本域将来多用一样时装配那侧不用改）。 */
import type * as configApi from "../config/interface.ts";
import type * as pipelineApi from "../pipeline/interface.ts";
import type { NotifierService } from "./impl/service/type.ts";

/** config 域给下游的能力面：读确认名单，写确认动作。 */
export type ConfigPort = Pick<typeof configApi, "readConfig" | "writeConfig">;

/** pipeline 域给下游的能力面。除提交口外还要一个**判据**（`isBuiltinKind`）：外部与内置的分界是裁决的坐标系，
 * 本域在边界上就要用它；自己写一份内置名单等于把同一张表抄成两份。 */
export type PipelinePort = Pick<typeof pipelineApi, "isBuiltinKind" | "submit">;

/** 宿主出口：把本域的服务面挂上宿主上下文。端口收的是**服务对象本身**而不是「服务名 + 值」——服务名是本域
 * ABI 的一部分，让组合根各写一遍，改名漏改时消费方 `ctx.get` 会拿到空，一个只在别的插件里才看得见的失败。 */
export interface ExposePort {
  /** 把服务面挂上上下文（宿主那边就是 `ctx.provide`）。@returns 摘除器。 */
  provide(service: NotifierService): () => void;
}

/** 装配入参：本域**拿不到**的东西（宿主上下文）与它依赖的域。 */
export interface SdkDeps {
  /** 宿主出口：只有组合根够得着 `ctx.provide`。 */
  readonly expose: ExposePort;
  /** 设置读面与写面：确认名单住在设置里，清单要按它算。 */
  readonly config: ConfigPort;
  /** 下游裁决管线：外部请求与宿主事件走**同一条**，不另开旁路。 */
  readonly pipeline: PipelinePort;
}

export type {
  BuiltinKind,
  ExternalKind,
  NotifyKind,
  NotifySeverity,
} from "../pipeline/interface.ts";
