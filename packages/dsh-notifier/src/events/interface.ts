/**
 * dsh-notifier — events/interface.ts：事件域唯一对外引用面。
 *
 * 目录外代码只能从这里引用：事件处理器集合（createEventHandlers + 判定直测
 * 入口 resolveTurnEvidence）、完成风暴聚合（createDoneBatcher）、会话读取与
 * 子代理判定纯函数（sessionTitleOf/lastTurnEndOf/isSubagentOf——index.ts 的
 * 导出面经本文件收口）（verify-dir-imports 静态强制）。
 */
export { createEventHandlers, resolveTurnEvidence } from "./event-handlers.ts";
export type { AgentState, EventHandlers, EventHandlersDeps } from "./event-handlers.ts";
export { createDoneBatcher } from "./aggregate.ts";
export type { DoneBatcher, DoneBatcherOptions } from "./aggregate.ts";
export { isSubagentOf, lastTurnEndOf, sessionTitleOf } from "./agent-session.ts";
export type { SubagentOwnership } from "./agent-session.ts";