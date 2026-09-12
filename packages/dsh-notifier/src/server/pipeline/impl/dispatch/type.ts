/**
 * dsh-notifier pipeline 域 —— 投递块自己的形状。
 */
import type { PipelineDeps } from "../../deps.ts";

/**
 * 投递块的入参：从域注入面上切下来的两样能力。
 *
 * 不把整个 `PipelineDeps` 递给本块：那样它也能拿到总开关与帧出口，而它既不该决定发
 * 不发，也不该自己发帧。切片让「本块能用到什么」在签名上就是完整的。
 */
export type DispatchPort = Pick<PipelineDeps, "channels" | "stores">;
