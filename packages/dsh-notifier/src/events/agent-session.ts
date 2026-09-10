/**
 * dsh-notifier — 事件域：会话读取与子代理判定（事件层专属纯函数）。
 *
 * 事件层从 Agent 对象读取会话标题/turn 终态、判定子代理归属的最小结构子集：
 * 全部经官方类型层 import type（不引入运行时依赖），payload 跨宿主边界不受信，
 * 读取一律防御性收窄。sessionTitleOf 是全部 taskTitle 的唯一来源——脱敏
 * 统一到 sendKind 渲染后单点（此处仅截断），taskTitle 经模板拼接与历史
 * 落盘仍全覆盖（由统一时点承接）。
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { TurnEndReason } from "@deepseek-ai/dsh-session/types";

/** turn/end reason.kind 的官方联合（TurnEndReasonMap；插件可经 declare module 扩展，
 * 运行时出现未知 kind 由调用方保守静默——见 agent/status 完成判定白名单）。 */
type TurnEndKind = TurnEndReason extends { kind: infer K } ? K : never;

/**
 * 提取会话标题（用户可读的任务名，替代内部 session id）。
 * 数据源：agent.session.snapshotEvents() 中最后一个 session/title 事件（dsh-session-title
 * 官方插件维护，与 GUI 会话列表同源）。无标题（新会话/未生成）返回 undefined。
 * 仅截断 40 字符（展示语义：模板拼接/taskTitle 的标题行上限）；**不再脱敏**——
 * 统一时点后标题敏感片段由 sendKind 渲染后统一处理（本函数是全部 taskTitle
 * 的唯一来源，脱敏统一到下游单点，避免此处截断先于打码造成「长敏感串被腰斩成
 * 不满足规则阈值的残段漏网」的旧问题面；该覆盖由 sendKind 承接）。
 * @param agent Agent 对象（事件 payload.agent）。
 * @returns 截断 40 字符的标题（未脱敏；sanitizeContent=false 时原样透传）。
 */
export function sessionTitleOf(agent: Agent | undefined): string | undefined {
  try {
    // 运行时防御保留（payload 跨宿主边界，不受信）：显式收窄而非 Array.isArray
    // （后者会把 readonly SessionEvent[] 压成 any[]，令 typecheck 对 events 访问失明）。
    // 0.1.2-rc.1 起 session.events getter 移除，改走 snapshotEvents()（无参语义等价）。
    const events = agent?.session?.snapshotEvents?.() as ReadonlyArray<{ type: unknown; data?: { title?: unknown } }> | undefined;
    if (events === undefined) return undefined;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i] as { type: unknown; data?: { title?: unknown } } | undefined;
      if (ev?.type === "session/title" && typeof ev.data?.title === "string") {
        const title = ev.data.title.trim();
        return title.length > 0 ? title.slice(0, 40) : undefined;
      }
    }
  } catch {
    // 事件日志读取失败不影响通知主流程
  }
  return undefined;
}

/**
 * 取 agent 会话日志中最新一条 turn/end（倒序扫描；session.snapshotEvents() 是混合
 * 日志，turn/end 后可能尾随 session/title、inbox、user/message 等，不能
 * 取快照末尾——照 sessionTitleOf 同款倒序）。
 * 用于中断抑制：running→idle 时若本轮未闭合新的 turn/end（如 abort 早于
 * turn/start 落盘，dsh-agent-loop turn() 首行 throwIfAborted 在 try 外），
 * 读到的 turn/end 是上一次运行的，不可作为本轮结束依据。
 * @param agent Agent 对象（事件 payload.agent）。
 * @returns {turn, kind}（kind 为 turn/end reason.kind，如 completed /
 *   aborted / error / max-tokens）；无 turn/end 或读取失败返回 undefined。
 */
export function lastTurnEndOf(agent: Agent | undefined): { turn: number; kind: TurnEndKind } | undefined {
  try {
    // 运行时防御同 sessionTitleOf：显式收窄，不用 Array.isArray（any 化陷阱）；
    // 0.1.2-rc.1 起 session.events getter 移除，改走 snapshotEvents()（无参语义等价）。
    const events = agent?.session?.snapshotEvents?.() as ReadonlyArray<{ type: unknown; data?: { turn?: unknown; reason?: unknown } }> | undefined;
    if (events === undefined) return undefined;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i] as { type: unknown; data?: { turn?: unknown; reason?: unknown } } | undefined;
      if (ev?.type !== "turn/end") continue;
      const reason = ev.data?.reason;
      if (reason === undefined || reason === null || typeof reason !== "object") continue;
      // 非有限 turn 的证据不可用（payload 跨宿主边界，不受信）：跳过该条
      // 继续向前扫——若返回 {turn:NaN} 会被完成判定当作合法证据推进
      // lastEndedTurn=NaN，此后真实完成因 x > NaN 恒 false 被永久吞掉。
      if (typeof ev.data?.turn !== "number" || !Number.isFinite(ev.data.turn)) continue;
      const kind = String((reason as { kind?: unknown }).kind ?? "") as TurnEndKind;
      return { turn: ev.data.turn, kind };
    }
  } catch {
    // 事件日志读取失败不影响通知主流程
  }
  return undefined;
}

/**
 * 运行时归属查询面：对齐宿主 ctx.agents（AgentRegistry）判定所需
 * 的最小结构子集——get 查活体父 agent 存在性、isOwnedBy 断言「该子 agent 确由
 * 该父 agent 的作用域创建」。仅 import type 官方 Agent，不引入运行时依赖。
 */
export interface SubagentOwnership {
  get(id: string): Agent | undefined;
  isOwnedBy(id: string, owner: Agent): boolean;
}

/**
 * agent 是否为子代理：双信号判定（origin 命中即子代理；未命中才查运行时归属；
 * 两信号皆否一律走主任务分支——恰为两信号，无第三信号）。
 *
 * 三类会话 header 形态差异（DSH SessionHeader，均经官方类型层核验）：
 * - spawn 型子代理：origin === 'subagent'（SessionHeader 校验强制唯一合法值，
 *   packages/core/session/src/index.ts:125：origin 非 undefined 就必须是
 *   'subagent'），通常带 parentSession + delegationDepth=父+1。信号一即命中。
 * - fork 型委派子代理：parentSession + seedLength > 0、**无 origin**、
 *   delegationDepth = 0（Session.fork() session/src/index.ts:1091 与 apiproxy
 *   lineage 场景写 parentSession 但不带 origin）。信号一不命中，须查信号二。
 * - headless CLI 会话：header 仅 { cwd }（无 origin 无 parentSession），两信号
 *   皆否 → 主任务分支；其分类保持现状不在 notifier 变更面内。
 *
 * 为何需要信号二（运行时归属）：fork 型委派与用户 fork 主线在持久化 header 上
 * **不可区分**（两者都只落 parentSession + seedLength、无 origin）——单看 header
 * 要么漏报 fork 委派（现状 bug：委派 worker 完成被误报主任务 kind=done），要么
 * 把用户 fork 主线误静默（镜像回归）。唯一可靠区分点是**运行时归属**：
 * ctx.agents.get(parentSession) 非 undefined 且 isOwnedBy(该 agent id, 父 agent)
 * === true 时，该 fork 会话确由父 agent 作用域创建（委派 worker）；归属不成立
 * （父 id 不在 live registry / isOwnedBy false / agents 服务不可用）则视为用户
 * fork 主线，保守走主任务分支——宁可多报一条 done，不静默用户自己的任务。
 *
 * 已知保守边界（冷 resume）：实例重启后脱离父作用域续跑的 fork worker 不在
 * live registry，归属不成立 → 退报 done。与宿主 apiproxy 冷路径 fence 行为一致
 * （attached/inspect 检查点 agent 参数为 void 0 时仅 origin 生效），属已确认的
 * 接受边界（已源码级确认），不做持久化推断补齐。
 *
 * 运行时同型变体：父 agent 先亡/被清理（如委派方提前结束、
 * registry 逐出）时 `get(parent)` 同样返回 undefined，归属不成立 → 同样退报
 * done。与冷 resume 共享同一保守语义的方向性代价：宁可多报一条主任务 kind=done，
 * 不静默任何真实完成；两变体均不做持久化推断补齐。
 *
 * @param agent Agent 对象（事件 payload.agent）。
 * @param ownership 运行时归属查询面（ctx.agents）。缺省（undefined，如测试
 *   fake ctx 未装配 agents 服务）时跳过信号二：仅 origin 判定，行为与本修复
 *   前一致。
 */
export function isSubagentOf(agent: Agent | undefined, ownership?: SubagentOwnership): boolean {
  // 信号一：spawn 型（origin 由 header 校验强制唯一合法值，零误判面）
  if (agent?.session?.header?.origin === "subagent") return true;
  // 信号二：fork 型委派——仅 parentSession 不能作判据（用户 fork 主线同形态），
  // 必须运行时归属确凿成立才算子代理；任一环节不成立都保守走主任务分支。
  const parentId = agent?.session?.header?.parentSession;
  const selfId = agent?.id;
  if (parentId === undefined || ownership === undefined || selfId === undefined) return false;
  const parent = ownership.get(String(parentId));
  if (parent === undefined) return false;
  return ownership.isOwnedBy(String(selfId), parent) === true;
}