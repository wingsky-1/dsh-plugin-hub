/**
 * dsh-notifier events 域 —— 会话日志读取与子代理归属判定（只读宿主对象，不改写）。
 * payload 跨宿主边界不受信，读取一律防御性收窄。
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
// 会话标题事件由该插件并入 `SessionEventMap`：不引它，`session/title` 就不在日志类型里。
import type {} from "@deepseek-ai/dsh-session-title";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { TurnEndReason } from "@deepseek-ai/dsh-session/types";
import type { SessionTitle, TurnEndRead } from "./type.ts";
// 截断走包内唯一的 code-point 截断而不是 `String.prototype.slice`：同包 8 个展示出口
// （bark / webhook / browser / system / pipeline finalize / shared reason）都用它，
// 唯独这里用 code-unit 切片会把 emoji 会话标题切成半个代理对（渲染成替换字符）。
import { truncateCodePoints } from "../../../shared/interface.ts";

/** 会话标题的展示上限；模板拼接与任务名共用这一个数字。 */
const TITLE_LIMIT = 40;

/** 会话标题：日志里最后一个 `session/title`，trim 后按 code-point 截断 40 字符。 */
export function sessionTitleOf(agent: Agent): SessionTitle {
  try {
    // eslint-disable-next-line sonarjs/deprecation -- 0.1.7-rc.1 起 snapshotEvents 标 @deprecated（rc.2 沿用）（本仓规则名见 tools/lint/eslint.config.js，上游同位置 oxlint-disable）：同步快照读法在迁移前保留，测试 5 处不动（P2）。
    const events = agent.session.snapshotEvents();
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type !== "session/title") continue;
      const title = event.data.title.trim();
      if (title.length === 0) return { found: false };
      return { found: true, title: truncateCodePoints(title, TITLE_LIMIT) };
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
    // eslint-disable-next-line sonarjs/deprecation -- 0.1.7-rc.1 起 snapshotEvents 标 @deprecated（rc.2 沿用）（本仓规则名见 tools/lint/eslint.config.js，上游同位置 oxlint-disable）：同步快照读法在迁移前保留，测试 5 处不动（P2）。
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
 * 是否子代理：只看会话 header 的持久化谱系信号，不探活体注册表。
 *
 * rc.5 把 delegationDepth 持久化进 header（顶层缺省，子代理子会话为父深度 + 1），origin 也仍是
 * 子代理子会话的粗分类。两者都是持久事实，父 agent 消亡后依然成立。此前依赖的运行时归属探针不再
 * 作为判据：`agents.isOwnedBy` 在 rc.3 起已从宿主服务面消失（rc.5 亦无）；`ctx.subagents` 的树关系
 * 虽仍在，但要求父 agent 保持活跃运行时归属，父一消亡就判不出来，正是本判据要消除的静默失败形态。
 *
 * 拿不准一律按主任务收口：多报一条 done 可以接受，把用户自己的 fork 当子代理静默掉不行。rc.5 的普通
 * fork 不写 parentSession，历史 fork 残留的 parentSession 单独一条不构成谱系证据。
 */
export function isSubagentOf(agent: Agent): boolean {
  const header = agent.session.header;
  if (header.origin === "subagent") return true;
  return typeof header.delegationDepth === "number" && header.delegationDepth > 0;
}

/** `reason.kind` 的运行时取值；拿不到字符串就按空值处理。 */
function readTurnKind(reason: TurnEndReason): string {
  const kind: string = reason.kind;
  return typeof kind === "string" ? kind : "";
}
