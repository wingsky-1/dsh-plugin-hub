/**
 * 宿主能力面的类型定义处（I1 白名单点名的第二处）。
 *
 * 域拿不到 cordis `Context`，只能声明「我要什么能力」；能力的**形状**因此只在这里定义一次——
 * 宿主升级换形时改这一处，域 `deps.ts` 与组合根递进去的对象两侧同时跟随。`Context` 在本包只出现
 * 两处：这里（把它收窄成能力面）与包入口（组合根）。
 *
 * 收哪几条按附录 E.2 的宿主能力实测落定，不收的也有理由：
 * - `settings` 是**晚到服务**（`ctx.inject(["settings"], …)` 的回调里才取得到），`bindHost` 那一刻
 *   拿不到，它的能力面只能由接线点自己声明；
 * - `sessions` 在 E.2 的实测表里零命中，不预置一条没人用过、形状也没验过的门面。
 */
import type { Context, Events } from "@deepseek-ai/cordis";
// 宿主服务面靠声明合并挂到 `Context` 上：少了这几行，下面的 `Context["tools"]` 等取不到成员。
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-tools";

/** 宿主日志出口的收窄面：本包只在诊断处出声，且不因为出声改变动作。 */
export interface LoggerPort {
  warn(message: string): void;
}

/** 宿主路由注册口（`ctx.webServer`）：只取注册一样，摘除器由宿主自己返回。 */
export type RegisterPort = Pick<Context["webServer"], "register">;

/** 宿主工具注册表（`ctx.tools`）：只取注册一样。 */
export type ToolsPort = Pick<Context["tools"], "register">;

/** 宿主提示词组装口（`ctx.systemPrompt`）：只取分节一样。 */
export type PromptPort = Pick<Context["systemPrompt"], "section">;

/** 宿主出口（`ctx.provide`）：服务的**名字**归提供方所有，这里只负责把服务挂上上下文。 */
export interface ExposePort {
  provide(name: string, service: unknown): () => void;
}

/**
 * 宿主事件面：只放本插件真的订阅的那一条。
 *
 * `agent/pre-step` 是 **waterfall**：处理完必须把判定交还给续行，漏掉就等于替所有人短路了这一步
 * ——所以端口把续行原样递给订阅方，让它在看得见事件的地方决定怎么续（本插件要在这一步注入能力目录）。
 */
export interface EventsPort {
  onPreStep(
    handler: (
      payload: Parameters<Events["agent/pre-step"]>[0],
      next: Parameters<Events["agent/pre-step"]>[1],
    ) => ReturnType<Events["agent/pre-step"]>,
  ): () => void;
}

/**
 * 组合根允许触碰的宿主上下文面：把 `Context` 收窄成六个成员的 `Pick`，`bindHost` 的入参到此为止，
 * 域拿不到更宽的上下文。
 */
export type HostContextPort = Pick<
  Context,
  "logger" | "webServer" | "tools" | "on" | "systemPrompt" | "provide"
>;

/** 组合根收窄后递给各域的宿主能力面：域再从中 `Pick` 自己那一份。 */
export interface HostFaces {
  readonly logger: LoggerPort;
  readonly register: RegisterPort;
  readonly tools: ToolsPort;
  readonly prompt: PromptPort;
  readonly expose: ExposePort;
  readonly events: EventsPort;
}
