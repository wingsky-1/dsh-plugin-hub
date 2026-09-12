/**
 * dsh-notifier events 域 —— 宿主事件 → 通知请求。
 *
 * 本块只回答「刚刚发生了什么」：哪种宿主事件对应哪一种通知、该说什么话。**它不做
 * 「该不该发」的判断**——事件开关、免打扰时段、频道选择都属于裁决层，而它们会在
 * 本域看不见的地方被改。让这里每次都去问一遍「现在开着吗」，等于把一条运行期策略
 * 摊进翻译逻辑，而翻译只该认事件。
 *
 * **未实现的翻译返回「不是通知」而不是抛错**：宿主事件是活的，装配完成那一刻就
 * 可能到达，抛出去等于让插件在正常运行中崩掉。骨架期的「还没做」在行为上就等于
 * 「不打扰」——想看出翻译没做，读这个文件比读日志可靠。
 *
 * 依赖方向：只引用本目录，不引用 `interface.ts`。
 */
import type { AgentStatus } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import type { Translation } from "./type.ts";

/**
 * 审批请求 → 通知请求。
 *
 * 未实现：应产出 `ask` 请求（工具名 + 等待理由）。
 */
export function translateApproval(request: ApprovalRequest): Translation {
  void request;
  return { ok: false };
}

/**
 * 用户提问 → 通知请求。
 *
 * 未实现：应产出 `question` 请求（问题摘要）。
 */
export function translateUserQuestion(request: AskUserQuestionRequest): Translation {
  void request;
  return { ok: false };
}

/**
 * 会话内事件 → 通知请求。
 *
 * 未实现：`turn/end` 分流完成与错误（`done` / `error` / `turn-end`），
 * `tool/result` 承接工具失败。多数 kind 本就不对应任何通知。
 */
export function translateSessionEvent(sessionId: string, event: SessionEvent): Translation {
  void sessionId;
  void event;
  return { ok: false };
}

/**
 * agent 生命周期迁移 → 通知请求。
 *
 * 未实现：`idle` 是子代理完成的判据。
 */
export function translateAgentStatus(agentId: string, status: AgentStatus): Translation {
  void agentId;
  void status;
  return { ok: false };
}

/**
 * agent 被销毁 → 通知请求。
 *
 * 未实现：子代理消亡的收尾通知。与 `agent/status` 的 `idle` 互补——正常路径先
 * `idle` 再销毁，异常路径可能只有销毁。
 */
export function translateAgentDisposed(agentId: string): Translation {
  void agentId;
  return { ok: false };
}

/**
 * turn 到达停止边界 → 通知请求。
 *
 * 未实现：与 `turn/end` 会话事件互补——一个说「要停了」，一个说「已经停了」。
 */
export function translateTurnStopping(agentId: string, turn: number): Translation {
  void agentId;
  void turn;
  return { ok: false };
}

/**
 * agent 出错 → 通知请求。
 *
 * 未实现：`error` 的直接来源。
 */
export function translateAgentError(agentId: string, turn: number, errorText: string): Translation {
  void agentId;
  void turn;
  void errorText;
  return { ok: false };
}
