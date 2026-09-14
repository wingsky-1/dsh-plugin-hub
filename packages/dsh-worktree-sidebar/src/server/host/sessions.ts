/**
 * 会话链适配层：只回答「这个会话的父会话是谁」。
 *
 * 官方把父链记在会话 header 上（`parentSession?: SessionId`，dsh-session/lib/types/types.d.ts:71），
 * 子 agent 建立时由 dsh-subagent 写入（dsh-subagent/lib/index.js:504-510 同时继承父的 cwd）。
 * 本域不读 cwd——那个事实已经在子会话自己的 header 里了——只读父 id。
 */
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionChainPort } from "../scope/deps.ts";

/** 官方 sessions 服务的窄面：只按 id 取一次会话记录。 */
export interface SessionsFace {
  get(id: SessionId): { readonly header: { readonly parentSession?: string } } | undefined;
}

export function bindSessions(sessions: SessionsFace): SessionChainPort {
  return {
    parentOf: (sessionId) => {
      const session = sessions.get(sessionId as SessionId);
      return session === undefined ? undefined : session.header.parentSession;
    },
  };
}
