import type { Agent } from "@deepseek-ai/dsh-agent";
import { errorMessage } from "../../../shared/host-utils.js";
import type { NotifyConfig } from "./config.ts";
import { isSubagentOf, lastTurnEndOf, sanitizeErrorText, sessionTitleOf } from "./message.ts";
import type { NotifyDetail, SubagentOwnership } from "./message.ts";
import type { DoneBatcher } from "./aggregate.ts";

export interface EventHandlersDeps {
  getConfig: () => NotifyConfig;
  notify: (kind: string, detail?: NotifyDetail) => boolean;
  appendHistory: (entry: { ts: number; kind: string; title: string; message: string; suppressed?: string }) => void;
  doneBatcher: DoneBatcher;
  logger: { warn: (msg: string) => void };
  getAgents: () => SubagentOwnership | undefined;
  getUserQuestionsService: () => { ask?: unknown } | undefined;
}

export interface AgentState {
  runningSeen: boolean;
  startedAt: number;
  lastEndedTurn?: number;
  runningBaseline?: { turn: number; kind: string };
}

interface AskFunction {
  (request: unknown): Promise<unknown>;
  __dshNotifierWrapped?: boolean;
  __dshNotifierOriginal?: AskFunction;
}

interface ErrorMergeEntry {
  count: number;
  since: number;
  lastMessages: string[];
}

export interface EventHandlers {
  handleApprovalRequest: (req: any, next: () => Promise<any>) => Promise<any>;
  handleInternalService: (name: string) => void;
  handleSessionEvent: (session: any, event: any) => void;
  handleAgentStatus: (payload: { agent: any; status: string }) => void;
  handleAgentDisposed: (payload: { agent: any }) => void;
  handleAgentError: (payload: any) => void;
  handleAgentTurnStopping: (payload: any) => Promise<void>;
  hookUserQuestions: () => void;
  dispose: () => void;
}

interface TurnEvidenceResult {
  best?: { turn: number; kind: string };
  snapshot?: { turn: number; kind: string };
  pushed?: { turn: number; kind: string };
  evidenceSource: string;
  rememberedTurn?: number;
  hasNewEnd: boolean;
}

function formatEvidenceSource(pushed: unknown, snapshot: unknown, stale: boolean): string {
  if (pushed !== undefined) return "push";
  if (snapshot === undefined) return "无";
  return stale ? "快照冻结" : "快照兜底";
}

/**
 * 解析并裁决单次 idle 的 turn 证据（push 优先、快照兜底、stale 冻结）。
 * 导出供直测（PR0 红测先行 4：判定矩阵基线；重构 adjudicate 拆分时的行为判别网）。
 */
export function resolveTurnEvidence(
  agent: any,
  state: AgentState,
  eventStreamEnds: Map<string, { turn: number; kind: string }>,
): TurnEvidenceResult {
  const agentId = agent?.id ?? "?";
  const streamedRaw = eventStreamEnds.get(agentId);
  const pushed = streamedRaw !== undefined && Number.isFinite(streamedRaw.turn) ? streamedRaw : undefined;
  const snapshot = pushed === undefined ? lastTurnEndOf(agent) : undefined;
  const baselineTurn = state.runningBaseline?.turn;
  const stale =
    pushed === undefined &&
    snapshot !== undefined &&
    baselineTurn !== undefined &&
    snapshot.turn <= baselineTurn;
  const best = pushed ?? (stale ? undefined : snapshot);
  const evidenceSource = formatEvidenceSource(pushed, snapshot, stale);
  const rememberedTurn = state.lastEndedTurn;
  const hasNewEnd = best !== undefined && (rememberedTurn === undefined || best.turn > rememberedTurn);
  return { best, snapshot, pushed, evidenceSource, rememberedTurn, hasNewEnd };
}

function logIdleSkipped(
  agentId: string,
  evidence: TurnEvidenceResult,
  logger: { warn: (msg: string) => void },
): void {
  const { best, snapshot, pushed, evidenceSource, rememberedTurn } = evidence;
  logger.warn(
    `dsh-notifier: 完成判定跳过（不发 done）agent=${agentId} kind=${best?.kind ?? "none"} ` +
      `证据源=${evidenceSource} 快照turn=${snapshot !== undefined ? String(snapshot.turn) : "-"} ` +
      `推送turn=${pushed !== undefined ? String(pushed.turn) : "-"} ` +
      `记忆turn=${rememberedTurn ?? "-"}`,
  );
}

function dispatchUnmergedError(
  payload: any,
  sanitized: string,
  key: string,
  now: number,
  prev: ErrorMergeEntry | undefined,
  deps: EventHandlersDeps,
  errorMerge: Map<string, ErrorMergeEntry>,
): void {
  const mergedCount = prev !== undefined ? prev.count : 0;
  const mergedErrors = prev !== undefined ? prev.lastMessages : [];
  const notified = deps.notify("error", {
    message: sanitized,
    taskTitle: sessionTitleOf(payload?.agent),
    turn: typeof payload?.turn === "number" ? payload.turn : undefined,
    step: typeof payload?.step === "number" ? payload.step : undefined,
    mergedCount,
    mergedErrors,
  });
  if (notified) {
    errorMerge.set(key, { count: 0, since: now, lastMessages: [] });
  }
}

function tryMergeError(
  errorMerge: Map<string, ErrorMergeEntry>,
  key: string,
  sanitized: string,
  mergeMs: number,
  now: number,
  appendHistory: EventHandlersDeps["appendHistory"],
): boolean {
  const prev = mergeMs > 0 ? errorMerge.get(key) : undefined;
  if (prev !== undefined && now - prev.since < mergeMs) {
    prev.count += 1;
    prev.since = now;
    prev.lastMessages.push(sanitized.slice(0, 80));
    if (prev.lastMessages.length > 2) prev.lastMessages.shift();
    appendHistory({
      ts: now,
      kind: "error",
      title: "DSH：任务出错",
      message: `（合并）${sanitized.slice(0, 120)}`,
      suppressed: "merged",
    });
    return true;
  }
  return false;
}

/**
 * 集中管理审批、提问、会话事件、状态判定与错误去重的事件处理器集合。
 */
export class NotifierEventHandlers implements EventHandlers {
  private askRemindTimers = new Map<string, NodeJS.Timeout>();
  private agentStates = new Map<string, AgentState>();
  private eventStreamEnds = new Map<string, { turn: number; kind: string }>();
  private errorMerge = new Map<string, ErrorMergeEntry>();
  private turnNotified = new Set<string>();
  private deps: EventHandlersDeps;

  constructor(deps: EventHandlersDeps) {
    this.deps = deps;
  }

  handleApprovalRequest = async (req: any, next: () => Promise<any>): Promise<any> => {
    const current = this.deps.getConfig();
    if (!current.notifyAsk) return next();
    const askDetail = () => ({
      tool: req?.toolName as string | undefined,
      taskTitle: sessionTitleOf(req?.agent),
      reason: req?.reason ? sanitizeErrorText(req.reason, 120) : undefined,
    });
    try {
      this.deps.notify("ask", askDetail());
    } catch (error) {
      this.deps.logger.warn(`dsh-notifier: approval/request 通知失败: ${errorMessage(error)}`);
    }

    const askKey = req?.agent?.id ?? String(req?.toolName ?? "?");
    if (current.askRemindMin > 0) {
      const timer = setTimeout(() => {
        if (this.askRemindTimers.get(askKey) === timer) {
          this.askRemindTimers.delete(askKey);
          try {
            this.deps.notify("ask", { ...askDetail(), remindMinutes: current.askRemindMin });
          } catch (error) {
            this.deps.logger.warn(`dsh-notifier: 审批超时提醒失败: ${errorMessage(error)}`);
          }
        }
      }, current.askRemindMin * 60000);
      timer.unref();
      this.askRemindTimers.set(askKey, timer);
    }
    try {
      return await next();
    } finally {
      const t = this.askRemindTimers.get(askKey);
      if (t !== undefined) {
        clearTimeout(t);
        this.askRemindTimers.delete(askKey);
      }
    }
  };

  hookUserQuestions = (): void => {
    let svc: { ask?: unknown } | undefined;
    try {
      svc = this.deps.getUserQuestionsService();
    } catch {
      svc = undefined;
    }
    if (!svc || typeof svc.ask !== "function") return;
    let original: AskFunction = svc.ask as AskFunction;
    if (typeof original.__dshNotifierWrapped === "boolean" && typeof original.__dshNotifierOriginal === "function") {
      original = original.__dshNotifierOriginal;
    }
    const callOriginal: AskFunction = original.bind(svc);
    const wrapped = (async (request: unknown) => {
      try {
        if (this.deps.getConfig().notifyQuestion) {
          const first = Array.isArray(request && (request as { questions?: unknown[] }).questions)
            ? (request as { questions?: unknown[] }).questions![0]
            : undefined;
          this.deps.notify("question", {
            tool: "ask_user_question",
            taskTitle: sessionTitleOf((request as { agent?: Agent } | null | undefined)?.agent),
            question: first && (first as { question?: unknown }).question
              ? sanitizeErrorText((first as { question?: unknown }).question, 120)
              : undefined,
          });
        }
      } catch (error) {
        this.deps.logger.warn(`dsh-notifier: 提问通知失败: ${errorMessage(error)}`);
      }
      return callOriginal(request);
    }) as AskFunction;
    wrapped.__dshNotifierWrapped = true;
    wrapped.__dshNotifierOriginal = callOriginal;
    svc.ask = wrapped;
  };

  handleInternalService = (name: string): void => {
    if (name === "userQuestions") this.hookUserQuestions();
  };

  handleSessionEvent = (session: any, event: any): void => {
    try {
      if (event?.type !== "turn/end") return;
      const reason = event.data?.reason;
      if (reason === undefined || reason === null || typeof reason !== "object") return;
      const sessionId = session?.id !== undefined ? String(session.id) : undefined;
      if (sessionId === undefined) return;
      const turn = typeof event.data?.turn === "number" ? event.data.turn : NaN;
      if (!Number.isFinite(turn)) return;
      this.eventStreamEnds.set(sessionId, {
        turn,
        kind: String((reason as { kind?: unknown }).kind ?? ""),
      });
    } catch (error) {
      this.deps.logger.warn(`dsh-notifier: session/event 处理失败: ${errorMessage(error)}`);
    }
  };

  private handleAgentIdle(agent: any, state: AgentState): void {
    const agentId = agent?.id ?? "?";
    const durationMs = state.startedAt > 0 ? Date.now() - state.startedAt : 0;
    state.runningSeen = false;
    state.startedAt = 0;

    const evidence = resolveTurnEvidence(agent, state, this.eventStreamEnds);
    const { best, hasNewEnd } = evidence;

    if (!hasNewEnd || best === undefined || best.kind !== "completed") {
      logIdleSkipped(agentId, evidence, this.deps.logger);
      if (best !== undefined) state.lastEndedTurn = best.turn;
      return;
    }

    const current = this.deps.getConfig();
    const taskTitle = sessionTitleOf(agent);
    const agents = this.deps.getAgents();
    if (isSubagentOf(agent, agents)) {
      if (current.notifySubagentDone) this.deps.doneBatcher.enqueue("subagent-done", taskTitle, durationMs);
    } else if (current.notifyTaskDone) {
      this.deps.doneBatcher.enqueue("done", taskTitle, durationMs);
    }
    if (best !== undefined) state.lastEndedTurn = best.turn;
  }

  private handleAgentRunning(agent: any, state: AgentState): void {
    state.runningSeen = true;
    state.startedAt = Date.now();
    state.runningBaseline = lastTurnEndOf(agent);
  }

  handleAgentStatus = ({ agent, status }: { agent: any; status: string }): void => {
    try {
      const agentId = agent?.id ?? "?";
      let state = this.agentStates.get(agentId);
      if (state === undefined) {
        state = { runningSeen: false, startedAt: 0 };
        this.agentStates.set(agentId, state);
      }
      if (status === "idle" && state.runningSeen) {
        this.handleAgentIdle(agent, state);
      } else if (status === "running") {
        this.handleAgentRunning(agent, state);
      }
    } catch (error) {
      this.deps.logger.warn(`dsh-notifier: agent/status 处理失败: ${errorMessage(error)}`);
    }
  };

  handleAgentDisposed = ({ agent }: { agent: any }): void => {
    if (agent?.id !== undefined) {
      this.agentStates.delete(agent.id);
      this.eventStreamEnds.delete(agent.id);
      this.errorMerge.delete(agent.id);
      for (const key of [...this.turnNotified]) {
        if (key.startsWith(agent.id + ":")) this.turnNotified.delete(key);
      }
    }
  };

  handleAgentError = (payload: any): void => {
    try {
      const current = this.deps.getConfig();
      if (!current.notifyTaskError) return;
      const agentId = payload?.agent?.id;
      const key = agentId ?? "?";
      const now = Date.now();
      const rawMessage = payload?.error instanceof Error ? payload.error.message : errorMessage(payload?.error);
      const sanitized = sanitizeErrorText(rawMessage);
      const mergeMs = current.errorMergeWindowMs;

      if (tryMergeError(this.errorMerge, key, sanitized, mergeMs, now, this.deps.appendHistory)) {
        return;
      }

      const prev = mergeMs > 0 ? this.errorMerge.get(key) : undefined;
      dispatchUnmergedError(payload, sanitized, key, now, prev, this.deps, this.errorMerge);
    } catch (error) {
      this.deps.logger.warn(`dsh-notifier: agent/error 处理失败: ${errorMessage(error)}`);
    }
  };

  handleAgentTurnStopping = async (payload: any): Promise<void> => {
    try {
      if (this.deps.getConfig().notifyTurnEnd) {
        const turn = typeof payload?.turn === "number" ? payload.turn : NaN;
        const key = `${payload?.agent?.id ?? "?"}:${Number.isFinite(turn) ? turn : "?"}`;
        if (this.turnNotified.has(key)) return;
        this.turnNotified.add(key);
        this.deps.notify("turn-end", {
          turn: Number.isFinite(turn) ? turn : undefined,
          taskTitle: sessionTitleOf(payload?.agent),
        });
      }
    } catch (error) {
      this.deps.logger.warn(`dsh-notifier: turn-stopping 处理失败: ${errorMessage(error)}`);
    }
  };

  dispose = (): void => {
    for (const t of this.askRemindTimers.values()) clearTimeout(t);
    this.askRemindTimers.clear();
    this.turnNotified.clear();
  };
}

/**
 * 创建全套事件处理器与相关判定状态机。
 */
export function createEventHandlers(deps: EventHandlersDeps): EventHandlers {
  return new NotifierEventHandlers(deps);
}
