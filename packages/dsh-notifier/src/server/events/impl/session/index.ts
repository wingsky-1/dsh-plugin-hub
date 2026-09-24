/**
 * dsh-notifier events 域 —— 会话日志读取与子代理归属判定（只读宿主对象，不改写）。
 * payload 跨宿主边界不受信，读取一律防御性收窄。
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
// 会话标题事件由该插件并入 `SessionEventMap`：不引它，`session/title` 就不在日志类型里。
import type {} from "@deepseek-ai/dsh-session-title";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { TurnEndReason } from "@deepseek-ai/dsh-session/types";
import type { AgentRegistryPort } from "../../deps.ts";
import type { SessionTitle, TurnEndRead } from "./type.ts";

/** 会话标题的展示上限；模板拼接与任务名共用这一个数字。 */
const TITLE_LIMIT = 40;

/** 会话标题：日志里最后一个 `session/title`，trim 后截断 40 字符。 */
export function sessionTitleOf(agent: Agent): SessionTitle {
  try {
    // eslint-disable-next-line sonarjs/deprecation -- 0.1.7-rc.1 起 snapshotEvents 标 @deprecated（本仓规则名见 tools/lint/eslint.config.js，上游同位置 oxlint-disable）：同步快照读法在迁移前保留，测试 5 处不动（P2）。
    const events = agent.session.snapshotEvents();
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type !== "session/title") continue;
      const title = event.data.title.trim();
      if (title.length === 0) return { found: false };
      return { found: true, title: title.slice(0, TITLE_LIMIT) };
    }
  } catch {
    // 日志读不出来不影响通知主流程
  }
  return { found: false };
}

/**
 * 从一条会话事件里读 turn 证据；`turn` 非有限数必须跳过——返回 NaN 会被完成判定当成合法
 * 证据推进，此后真实完成因 `x > NaN` 恒为假被永久吞掉。
 */
export function turnEndEvidenceOf(event: SessionEvent): TurnEndRead {
  if (event.type !== "turn/end") return { found: false };
  const reason = event.data.reason;
  if (typeof reason !== "object" || reason === null) return { found: false };
  const turn = event.data.turn;
  if (!Number.isFinite(turn)) return { found: false };
  return { found: true, evidence: { turn, kind: readTurnKind(reason) } };
}

/** 日志里最新一条 `turn/end`；倒序扫，因为 `turn/end` 之后可能尾随别的追加。 */
export function lastTurnEndOf(agent: Agent): TurnEndRead {
  try {
    // eslint-disable-next-line sonarjs/deprecation -- 0.1.7-rc.1 起 snapshotEvents 标 @deprecated（本仓规则名见 tools/lint/eslint.config.js，上游同位置 oxlint-disable）：同步快照读法在迁移前保留，测试 5 处不动（P2）。
    const events = agent.session.snapshotEvents();
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const read = turnEndEvidenceOf(events[i]);
      if (read.found) return read;
    }
  } catch {
    // 日志读不出来不影响通知主流程
  }
  return { found: false };
}

/**
 * 是否子代理：`origin` 命中即真；否则要运行时归属确凿成立（父 agent 在活体注册表里，
 * 且确由它创建）。任一环不成立都走主任务分支——宁可多报一条 done，不静默用户自己的任务。
 */
export function isSubagentOf(agent: Agent, agents: AgentRegistryPort): boolean {
  if (agent.session.header.origin === "subagent") return true;
  const parentId = agent.session.header.parentSession;
  if (parentId === undefined) return false;
  const parent = agents.lookup(parentId);
  if (!parent.found) return false;
  return agents.isOwnedBy(agent.id, parent.agent);
}

/** `reason.kind` 的运行时取值；拿不到字符串就按空值处理。 */
function readTurnKind(reason: TurnEndReason): string {
  const kind: string = reason.kind;
  return typeof kind === "string" ? kind : "";
}
