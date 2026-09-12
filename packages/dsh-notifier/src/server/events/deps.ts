/** events 域依赖声明：本域只声明「我需要外部什么」，装配由组合根递进来；声明面**只有类型**。 */
import type { Events } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import type * as pipelineApi from "../pipeline/interface.ts";
import type { LoggerPort } from "../shared/interface.ts";

export type { NotifyRequest } from "../pipeline/interface.ts";

/** pipeline 域给下游的能力面。只有 `submit`：请求的去处只有一处，而「谁收到了」不属于适配层——裁决结果一旦
 * 回流到这里，本域就得开始关心开关。 */
export type PipelinePort = Pick<typeof pipelineApi, "submit">;

/** 宿主 agent 事件的载荷类型。从官方事件签名**派生**而不是照抄结构：上游改形状时本域签名自动跟随，不会静默漂移成
 * 第二份事实源。 */
export type AgentStatusPayload = Parameters<Events["agent/status"]>[0];
export type AgentDisposedPayload = Parameters<Events["agent/disposed"]>[0];
export type AgentTurnStoppingPayload = Parameters<Events["agent/turn-stopping"]>[0];

/** `agent/error` 的载荷，但 `error` 已是一条文本：官方那边失败可能是任何东西抛出的（`unknown`），收窄放在组合根
 * 那一次跨界处，域内不出现宽类型、也不必每个使用点各收窄一次。 */
export type AgentErrorPayload = Omit<Parameters<Events["agent/error"]>[0], "error"> & {
  error: string;
};

/** 活体 agent 的查询结果。写成判别联合而不是 `Agent | undefined`：「查不到」在这里是一个**有名字的事实**——它正是
 * 子代理判定里「父 agent 已消亡」那一支；用可选返回值表达，调用点就得靠判空去猜是哪一种情况。 */
export type AgentLookup = { found: true; agent: Agent } | { found: false };

/** 运行时归属查询面：某个会话是不是由某个活体 agent 的作用域创建的。fork 型委派与用户 fork 主线在持久化 header 上
 * 完全同形（都只有 parentSession、都没有 origin），header 单信号分不开——唯一可靠依据是运行时归属。 */
export interface AgentRegistryPort {
  /** 查活体 agent；不在册即已消亡或从未存在。 */
  lookup(id: SessionId): AgentLookup;
  /** `id` 是否由 `owner` 的作用域创建。 */
  isOwnedBy(id: SessionId, owner: Agent): boolean;
}

/** 宿主事件面：订阅 + 退订，仅此而已——域拿到的是**事件源**，不是宿主。参数用官方类型层的原始负载，不做二次包装
 * （包装会产生一个与本域判断无关的中间形状，而解释事件本来就是本域的工作）；agent 事件尤其不能只给 id：任务名、
 * 子代理归属、turn 证据都要从 **Agent 对象**上读。 */
export interface HostEventPort {
  /** 审批请求到达。本域只旁观：宿主该事件是 **waterfall**，由组合根在转发之后调用 `next()` 把判定交还给真正的
   * 应答者——不做这一步就会把别人的审批请求吞掉。 */
  onApprovalRequest(handler: (request: ApprovalRequest) => void): () => void;
  /** 用户提问到达。与审批同构（同为 **waterfall**），同样由组合根转发之后调 `next()` 交还判定——本域只想
   * 「知道有人在问」，不参与作答。 */
  onUserQuestion(handler: (request: AskUserQuestionRequest) => void): () => void;
  /** 会话内事件到达（append-only 日志的每一次追加）。 */
  onSessionEvent(handler: (sessionId: string, event: SessionEvent) => void): () => void;
  onAgentStatus(handler: (payload: AgentStatusPayload) => void): () => void;
  /** agent 被销毁（子代理消亡的判据之一）。 */
  onAgentDisposed(handler: (payload: AgentDisposedPayload) => void): () => void;
  onAgentTurnStopping(handler: (payload: AgentTurnStoppingPayload) => void): () => void;
  /** agent 的一次 step / turn 出错；载荷里的 `error` 已由组合根收窄成文本（见 `AgentErrorPayload`）。 */
  onAgentError(handler: (payload: AgentErrorPayload) => void): () => void;
}

/** 装配入参：本域**拿不到**的东西与它依赖的域。 */
export interface EventsDeps {
  /** 宿主事件面：只有组合根够得着 `ctx`。 */
  readonly events: HostEventPort;
  /** 宿主 agent 注册表：子代理归属判定的第二个信号。 */
  readonly agents: AgentRegistryPort;
  /** 诊断出口：完成判定跳过（abort / max-tokens 每轮都走）时要说得出为什么。 */
  readonly logger: LoggerPort;
  readonly pipeline: PipelinePort;
}
