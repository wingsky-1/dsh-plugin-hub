/**
 * dsh-notifier events 域 —— 宿主事件 → 通知请求；不看开关（那是裁决层的事）。
 * 认不出的宿主事件返回「不是通知」而不是抛错——事件链是活的，抛错等于让插件崩在运行中。
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import type {
  AgentDisposedPayload,
  AgentErrorPayload,
  AgentStatusPayload,
  AgentTurnStoppingPayload,
} from "../../deps.ts";
import { sessionTitleOf, turnEndEvidenceOf } from "../session/index.ts";
import type { SessionTitle } from "../session/type.ts";
import { agentStates } from "../state/index.ts";
import { NOTIFY_KINDS } from "./catalog.ts";
import type { TranslatedKind } from "./catalog.ts";
import type { NotifyDetail, Translation } from "./type.ts";

/** 不是通知：多数宿主事件的归宿。 */
const NOT_A_NOTIFICATION: Translation = { ok: false };

/** 把详情渲染成一条请求；标题与正文只来自本目录的文案表（本域不填 severity）。 */
function render(kind: TranslatedKind, detail: NotifyDetail): Translation {
  const text = NOTIFY_KINDS[kind];
  return { ok: true, request: { kind, title: text.title, body: text.body(detail) } };
}

/** 任务名；`agent` 可缺（提问载荷上是可选的），缺了就是没有任务名。 */
function titleOf(agent?: Agent): SessionTitle {
  return agent === undefined ? { found: false } : sessionTitleOf(agent);
}

/** 审批请求 → `ask`（工具名 + 理由 + 任务名）。 */
export function translateApproval(request: ApprovalRequest): Translation {
  const title = titleOf(request.agent);
  return render("ask", {
    tool: request.toolName,
    taskTitle: title.found ? title.title : undefined,
    reason: request.reason,
  });
}

/** 用户提问 → `question`（首问摘要 + 任务名）。 */
export function translateUserQuestion(request: AskUserQuestionRequest): Translation {
  const first = request.questions[0];
  const title = titleOf(request.agent);
  return render("question", {
    taskTitle: title.found ? title.title : undefined,
    question: first !== undefined && first.question.length > 0 ? first.question : undefined,
  });
}

/** 会话内事件 → 通知请求：只认 `turn/end`，只记账不产出。 */
export function translateSessionEvent(sessionId: string, event: SessionEvent): Translation {
  const read = turnEndEvidenceOf(event);
  if (read.found) agentStates.rememberTurnEnd(sessionId, read.evidence);
  return NOT_A_NOTIFICATION;
}

/** agent 生命周期迁移 → 完成通知；`idle` 是判据，`running` 只记账。 */
export function translateAgentStatus(payload: AgentStatusPayload): Translation {
  const outcome = agentStates.observeStatus(payload);
  if (!outcome.ok) return NOT_A_NOTIFICATION;
  return render(outcome.kind, { taskTitle: outcome.taskTitle, durationMs: outcome.durationMs });
}

/** agent 被销毁 → 清账（不产出：完成与否已由 `idle` 判过）。 */
export function translateAgentDisposed(payload: AgentDisposedPayload): Translation {
  agentStates.forget(payload.agent.id);
  return NOT_A_NOTIFICATION;
}

/** turn 到停止边界 → `turn-end`（同一 turn 只发一次）。 */
export function translateTurnStopping(payload: AgentTurnStoppingPayload): Translation {
  const outcome = agentStates.observeTurnStopping(payload);
  if (!outcome.ok) return NOT_A_NOTIFICATION;
  return render("turn-end", { turn: outcome.turn, taskTitle: outcome.taskTitle });
}

/** agent 出错 → `error`（错误文本 + turn + step + 任务名）。 */
export function translateAgentError(payload: AgentErrorPayload): Translation {
  const title = titleOf(payload.agent);
  return render("error", {
    message: payload.error,
    taskTitle: title.found ? title.title : undefined,
    turn: payload.turn,
    step: payload.step,
  });
}
