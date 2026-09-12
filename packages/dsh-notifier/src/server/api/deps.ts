/**
 * dsh-notifier api 域 —— **依赖声明**。
 *
 * 本域声明「我需要外部什么」，不关心谁满足它——装配由组合根完成。域之间不互相注入：
 * 需要谁的能力，在这里引出来，实现块从本文件取。
 *
 * 浏览器出口要的东西比别的域杂，这张表也最长：三个域的能力、共享层的两个设施（SSE
 * 枢纽与回环围栏）、以及只有组合根够得着的两样——路由注册口与帧入口。
 */
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { NotifyKind, OutgoingFrame } from "../pipeline/interface.ts";
import type { LoggerPort } from "../shared/type.ts";

export { readConfig, readSettingsView, writeConfig } from "../config/interface.ts";
export { submit } from "../pipeline/interface.ts";
export { clearHistory, readHistory, readStatus } from "../stores/interface.ts";
export { isLoopbackRequest } from "../../../../../shared/loopback.js";
export { createSseHub } from "../../../../../shared/sse-hub.js";

export type { NotifyFrame } from "../channels/interface.ts";
export type { LoggerPort } from "../shared/type.ts";
export type { SseHub, SseHubOptions } from "../../../../../shared/sse-hub.js";
export type { NotifyKind, OutgoingFrame };

/** 宿主路由注册口：与宿主契约同源，不在两侧各写一遍。 */
export type RegisterRoute = (route: WebRoute) => () => void;

/**
 * 帧入口：订阅待展示的通知帧（组合根把宿主事件总线那一头接好）。
 *
 * 只有 `on` 没有 `emit`：api 域是帧的**消费者**，给它发帧的能力等于让它能伪造通知。
 * 生产帧是裁决管线的事。
 */
export interface FrameInlet {
  onFrame(handler: (payload: OutgoingFrame) => void): () => void;
}

/** 装配入参：本域**拿不到**的东西。域间依赖不在这里——它们由本文件直接引。 */
export interface ApiDeps {
  /** 宿主路由注册口：只有组合根够得着 `ctx.webServer`。 */
  register: RegisterRoute;
  /** 帧入口。 */
  frames: FrameInlet;
  /** 失败出口（端点内的异常一律在这里出声，不静默吞）。 */
  logger: LoggerPort;
}
