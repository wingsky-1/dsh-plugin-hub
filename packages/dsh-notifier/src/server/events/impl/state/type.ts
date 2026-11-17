/** dsh-notifier events 域 —— agent 状态机自己的形状。 */
import type { AgentRegistryPort } from "../../deps.ts";
import type { LoggerPort } from "../../../shared/interface.ts";
import type { TurnEndEvidence } from "../session/type.ts";

/** 一个 agent 的运行足迹（running → idle 之间）。 */
export interface AgentRun {
  runningSeen: boolean;
  startedAt: number;
  /** 进入 running 时的证据快照；turn 不比它新的 `turn/end` 属于上一轮。 */
  runningBaseline?: TurnEndEvidence;
  /** 已结过账的 turn：不比它新的证据不算新完成。 */
  lastEndedTurn?: number;
}

/** 状态机装配入参。 */
export interface StateDeps {
  /** 日志出口：完成判定跳过的诊断要它（「为什么没发 done」的唯一线索）。 */
  logger: LoggerPort;
  /** 子代理归属判定要它（见 `../session/`）。 */
  agents: AgentRegistryPort;
}

/** 一次 idle 的完成判定结果。 */
export type DoneOutcome =
  | { ok: true; kind: "done" | "subagent-done"; taskTitle?: string; durationMs: number }
  | { ok: false };

/** turn 停止边界的判定结果：同一 turn 只放行一次。 */
export type TurnStoppingOutcome = { ok: true; turn?: number; taskTitle?: string } | { ok: false };

/** 一次 idle 的 turn 证据裁决：完成判定的全部输入与诊断字段。 */
export interface TurnEvidence {
  best?: TurnEndEvidence;
  /** 会话日志里的快照证据。 */
  snapshot?: TurnEndEvidence;
  /** `session/event` 推送来的证据。 */
  pushed?: TurnEndEvidence;
  /** 证据来源标签：`push` / `快照兜底` / `快照冻结` / `无`。 */
  source: string;
  /** 已结账的 turn。 */
  rememberedTurn?: number;
  /** 证据是否构成一次新的结束。 */
  hasNewEnd: boolean;
}
