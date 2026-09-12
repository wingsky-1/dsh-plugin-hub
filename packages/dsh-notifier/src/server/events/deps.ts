/**
 * dsh-notifier events 域 —— **依赖声明**。
 *
 * 本域声明「我需要外部什么」，不关心谁满足它——装配由组合根完成。契约与实现块都
 * 经本文件引用，不直连他域。
 *
 * 依赖一律以**域**为单位，而不是把对方的方法拆成一个个函数传进来：写 `pipeline`
 * 而不是 `onSubmit`。散装函数在装配点读不出「依赖哪个域」。
 */
import type { AgentStatus } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";

/** 裁决管线对外契约的完整面。通知请求的种类词汇也由它定义。 */
export type PipelinePort = typeof import("../pipeline/interface.ts");

export type { NotifyRequest } from "../pipeline/interface.ts";

/**
 * 宿主事件面：订阅 + 退订，仅此而已。
 *
 * 组合根把 cordis 的事件表适配成它：只有「订阅」这一件事，没有上下文、没有 emit、
 * 没有服务解析。域拿到的是**事件源**，不是宿主。
 *
 * 参数用官方类型层的原始负载（`SessionEvent` / `ApprovalRequest`），不做二次包装：
 * 包装会产生一个与本域判断无关的中间形状，而解释事件本来就是本域的工作——让组合根
 * 先解释一半，等于把「哪件事重要」这个判断劈成两处。
 */
export interface HostEventPort {
  /**
   * 审批请求到达。
   *
   * 本域只旁观：宿主该事件是 **waterfall**，由组合根在转发之后调用 `next()` 把判定
   * 交还给真正的应答者——不做这一步就会把别人的审批请求吞掉。
   */
  onApprovalRequest(handler: (request: ApprovalRequest) => void): () => void;
  /**
   * 用户提问到达。
   *
   * 与审批同构：宿主该事件也是 **waterfall**，同样由组合根在转发之后调用 `next()`
   * 交还判定——本域只想「知道有人在问」，不参与作答。
   */
  onUserQuestion(handler: (request: AskUserQuestionRequest) => void): () => void;
  /** 会话内事件到达（append-only 日志的每一次追加）。 */
  onSessionEvent(handler: (sessionId: string, event: SessionEvent) => void): () => void;
  /** agent 生命周期迁移。 */
  onAgentStatus(handler: (agentId: string, status: AgentStatus) => void): () => void;
  /** agent 被销毁（子代理消亡的判据之一）。 */
  onAgentDisposed(handler: (agentId: string) => void): () => void;
  /** agent 的某个 turn 到达停止边界。 */
  onAgentTurnStopping(handler: (agentId: string, turn: number) => void): () => void;
  /**
   * agent 的一次 step / turn 出错。
   *
   * 错误原文在宿主侧是宽类型（失败可能是任何东西抛出的），由组合根收窄成一条文本
   * 再交进来——本域不需要判断「这是什么异常」，只需要知道「说什么」。
   */
  onAgentError(handler: (agentId: string, turn: number, errorText: string) => void): () => void;
}

/** 装配入参：本域依赖的全部外部。 */
export interface EventsDeps {
  /** 宿主事件面。 */
  readonly events: HostEventPort;
  /**
   * 下游：通知请求的消费者。
   *
   * 做成入参而不是对本域下游的硬引用：请求去哪、要不要发都不是本域的决定——把出口
   * 做成参数，「谁消费通知」这件事就只有一个地方需要改。
   */
  readonly pipeline: PipelinePort;
}
