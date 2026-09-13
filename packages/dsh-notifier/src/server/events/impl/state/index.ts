/**
 * dsh-notifier events 域 —— agent 状态机：完成判定与 turn 去重（装配与卸载成对）。
 * 常驻状态：每个 agent 的运行足迹、最近一次 turn/end、已发过的 turn。
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AgentStatusPayload, AgentTurnStoppingPayload } from "../../deps.ts";
import { isSubagentOf, lastTurnEndOf, sessionTitleOf } from "../session/index.ts";
import type { TurnEndEvidence } from "../session/type.ts";
import type {
  AgentRun,
  DoneOutcome,
  StateDeps,
  TurnEvidence,
  TurnStoppingOutcome,
} from "./type.ts";

const NOT_INSTALLED = "dsh-notifier: events 域状态机尚未装配";

/** 未装配时的占位：真被读到说明装配守卫有洞，当场暴露而不是按空状态判定；日志没人听，静默。 */
const UNINSTALLED: StateDeps = {
  logger: { warn: () => {} },
  agents: {
    lookup: () => {
      throw new Error(NOT_INSTALLED);
    },
    isOwnedBy: () => {
      throw new Error(NOT_INSTALLED);
    },
  },
};

/** 完成判定与 turn 去重的状态机。 */
class AgentStateMachine {
  private installed = false;
  private deps: StateDeps = UNINSTALLED;
  private readonly runs = new Map<string, AgentRun>();
  /** 键是 agent id，也就是会话 id：`session/event` 只给得到会话 id。 */
  private readonly turnEnds = new Map<string, TurnEndEvidence>();
  private readonly notifiedTurns = new Set<string>();

  /** 装配：重复装配是编程错误。 */
  install(deps: StateDeps): void {
    if (this.installed) throw new Error("dsh-notifier: events 域状态机只能装配一次");
    this.installed = true;
    this.deps = deps;
  }

  /** 卸载：清掉全部状态与集合，并复位装配标记——同进程的下一次装配不能撞上「只能装配一次」。 */
  release(): void {
    this.runs.clear();
    this.turnEnds.clear();
    this.notifiedTurns.clear();
    this.deps = UNINSTALLED;
    this.installed = false;
  }

  /** 记下一次推送来的 `turn/end`（idle 判定优先用它）。 */
  rememberTurnEnd(agentId: string, evidence: TurnEndEvidence): void {
    this.turnEnds.set(agentId, evidence);
  }

  /** agent 生命周期迁移：running 起记，idle 判定完成。 */
  observeStatus(payload: AgentStatusPayload): DoneOutcome {
    const agent = payload.agent;
    const run = this.runOf(agent.id);
    if (payload.status === "idle" && run.runningSeen) return this.settleIdle(agent, run);
    if (payload.status === "running") this.markRunning(agent, run);
    return { ok: false };
  }

  /** turn 到停止边界：同一 agent 的同一 turn 只放行一次。 */
  observeTurnStopping(payload: AgentTurnStoppingPayload): TurnStoppingOutcome {
    const turn = payload.turn;
    const key = `${payload.agent.id}:${Number.isFinite(turn) ? turn : "?"}`;
    if (this.notifiedTurns.has(key)) return { ok: false };
    this.notifiedTurns.add(key);
    const title = sessionTitleOf(payload.agent);
    return {
      ok: true,
      turn: Number.isFinite(turn) ? turn : undefined,
      taskTitle: title.found ? title.title : undefined,
    };
  }

  /** agent 消亡：清掉它的运行足迹、turn 证据与去重记录（不产出请求）。 */
  forget(agentId: string): void {
    this.runs.delete(agentId);
    this.turnEnds.delete(agentId);
    for (const key of [...this.notifiedTurns]) {
      if (key.startsWith(`${agentId}:`)) this.notifiedTurns.delete(key);
    }
  }

  private runOf(agentId: string): AgentRun {
    const existing = this.runs.get(agentId);
    if (existing !== undefined) return existing;
    const run: AgentRun = { runningSeen: false, startedAt: 0 };
    this.runs.set(agentId, run);
    return run;
  }

  private markRunning(agent: Agent, run: AgentRun): void {
    run.runningSeen = true;
    run.startedAt = Date.now();
    const baseline = lastTurnEndOf(agent);
    run.runningBaseline = baseline.found ? baseline.evidence : undefined;
  }

  private settleIdle(agent: Agent, run: AgentRun): DoneOutcome {
    const durationMs = run.startedAt > 0 ? Date.now() - run.startedAt : 0;
    run.runningSeen = false;
    run.startedAt = 0;

    const evidence = this.resolveEvidence(agent, run);
    const best = evidence.best;
    // 没产出通知的这一轮同样记账：否则 abort 之后同一 turn 的旧证据会在下一次 idle 被当成新完成。
    if (best !== undefined) run.lastEndedTurn = best.turn;
    if (best === undefined || !evidence.hasNewEnd || best.kind !== "completed") {
      this.warnIdleSkipped(agent.id, evidence);
      return { ok: false };
    }
    const title = sessionTitleOf(agent);
    return {
      ok: true,
      kind: isSubagentOf(agent, this.deps.agents) ? "subagent-done" : "done",
      taskTitle: title.found ? title.title : undefined,
      durationMs,
    };
  }

  /** 推送证据优先、快照兜底；不比进入 running 时更新的快照是上一轮的（冻结）。 */
  private resolveEvidence(agent: Agent, run: AgentRun): TurnEvidence {
    const streamed = this.turnEnds.get(agent.id);
    const pushed = streamed !== undefined && Number.isFinite(streamed.turn) ? streamed : undefined;
    const read = pushed === undefined ? lastTurnEndOf(agent) : undefined;
    const snapshot = read !== undefined && read.found ? read.evidence : undefined;
    const baselineTurn = run.runningBaseline?.turn;
    const stale =
      pushed === undefined &&
      snapshot !== undefined &&
      baselineTurn !== undefined &&
      snapshot.turn <= baselineTurn;
    const best = pushed ?? (stale ? undefined : snapshot);
    const rememberedTurn = run.lastEndedTurn;
    return {
      best,
      snapshot,
      pushed,
      source: evidenceSourceOf(stale, pushed, snapshot),
      rememberedTurn,
      hasNewEnd: best !== undefined && (rememberedTurn === undefined || best.turn > rememberedTurn),
    };
  }

  /** 完成判定跳过时的诊断——「为什么没发 done」的唯一线索；文本与旧实现逐字一致。 */
  private warnIdleSkipped(agentId: string, evidence: TurnEvidence): void {
    const { best, snapshot, pushed, source, rememberedTurn } = evidence;
    this.deps.logger.warn(
      `dsh-notifier: 完成判定跳过（不发 done）agent=${agentId} kind=${best !== undefined ? best.kind : "none"} ` +
        `证据源=${source} 快照turn=${snapshot !== undefined ? String(snapshot.turn) : "-"} ` +
        `推送turn=${pushed !== undefined ? String(pushed.turn) : "-"} ` +
        `记忆turn=${rememberedTurn !== undefined ? String(rememberedTurn) : "-"}`,
    );
  }
}

/** 证据源标签：推送优先，其次快照（比基线旧的快照属于上一轮），都没有就是「无」。 */
function evidenceSourceOf(
  stale: boolean,
  pushed?: TurnEndEvidence,
  snapshot?: TurnEndEvidence,
): string {
  if (pushed !== undefined) return "push";
  if (snapshot === undefined) return "无";
  return stale ? "快照冻结" : "快照兜底";
}

/** 本域唯一的状态机实例：类不外放，外面 `new` 不出第二份。 */
export const agentStates = new AgentStateMachine();
