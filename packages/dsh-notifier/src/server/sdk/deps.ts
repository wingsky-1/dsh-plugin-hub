/**
 * dsh-notifier sdk 域 —— **依赖声明**。
 *
 * 本域声明「我需要外部什么」，不关心谁满足它——装配由组合根递进来。声明面**只有
 * 类型**：运行时能力不进这里（`ARCHITECTURE-METHOD.md` §2「跨域运行时能力一律经
 * `deps.ts` 注入」），实现块拿到的是装配入参里的能力对象。
 *
 * 能力按**提供方**分组：组合根递的是提供方的命名空间对象，于是本域将来多用一样能力时，
 * 装配那一侧一行都不用改。要哪几样仍然由本文件的 `Pick` 说了算。
 *
 * 对外 ABI 的类型面（`NotifierService`）经 `./impl/service/type.ts` 取用而不是在这里
 * 重新声明：服务面的形状是本域对外的承诺，它只能有一个物理定义。
 */
import type * as configApi from "../config/interface.ts";
import type * as pipelineApi from "../pipeline/interface.ts";
import type { NotifierService } from "./impl/service/type.ts";

/** config 域给下游的能力面：读确认名单，写确认动作。 */
export type ConfigPort = Pick<typeof configApi, "readConfig" | "writeConfig">;

/**
 * pipeline 域给下游的能力面。
 *
 * 除提交口外还要一个**判据**（`isBuiltinKind`）：外部种类与内置种类的分界是裁决的
 * 坐标系，本域在边界上就要用它（决定一个 id 是「登记的动态种类」还是「想冒充内置」）。
 * 让本域自己写一份内置名单，等于把同一张表抄成两份。
 */
export type PipelinePort = Pick<typeof pipelineApi, "isBuiltinKind" | "submit">;

/**
 * 宿主出口：把本域的服务面挂上宿主上下文。
 *
 * 端口收的是**服务对象本身**，不是「服务名 + 值」：服务名是本域 ABI 的一部分（它同时
 * 写在包入口的声明合并里），属于域内知识。让组合根各写一遍，改名时就会有一处漏改，
 * 而症状是消费方 `ctx.get` 拿到空——一个只在别的插件里才看得见的现象。
 */
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
