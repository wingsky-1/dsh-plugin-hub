/**
 * 官方默认解析所需的三个事实。逐条对齐 dsh-api-workspace-files/lib/index.js:378-387：
 * 活会话优先、`sessionPersistence` 用可选链（缺该服务不是错误）、`sandboxPolicy.workspaceRoot` 兜底。
 *
 * 「没有 header」与「header 存在但没有 cwd」在这里分成 undefined 与 `{cwd: undefined}` 两态
 * （见 scope/deps.ts 的 `HeaderFace`）：官方对二者处置不同，压成同一个 undefined 会在一个
 * 本该有文件根的会话上凭空回 undefined。
 */
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { DefaultScopePort } from "../server/scope/deps.ts";

/** 官方 sandboxPolicy 的窄面：只取工作区根。 */
export interface SandboxPolicyFace {
  readonly workspaceRoot?: string;
}

/** 官方 sessionPersistence 的窄面：只按 id 取一次 header。 */
export interface PersistedSessionFace {
  readonly header: { readonly cwd?: string };
}

export interface SessionPersistenceFace {
  stat(id: SessionId): Promise<PersistedSessionFace | undefined>;
}

/**
 * 三个宿主事实面。两个官方服务按结构读（它们的 Context 声明不住在我们依赖的类型包里，
 * 官方靠 static inject 取用），读不到一律回 undefined——让上游走它自己的 lookup-not-found，
 * 而不是在这里抛。
 */
export interface DefaultsHostPort {
  sandboxPolicy(): SandboxPolicyFace | undefined;
  sessionPersistence(): SessionPersistenceFace | undefined;
  /** 活会话；该会话不存在时返回 undefined。 */
  liveSession(sessionId: string): PersistedSessionFace | undefined;
}

/** 把三个宿主事实面映射成 scope 域的缺省等价实现。 */
export function bindDefaults(host: DefaultsHostPort): DefaultScopePort {
  return {
    live: (sessionId) => {
      const session = host.liveSession(sessionId);
      return session === undefined ? undefined : { cwd: session.header.cwd };
    },
    stored: async (sessionId) => {
      const store = host.sessionPersistence();
      if (store === undefined) return undefined;
      const stored = await store.stat(sessionId as SessionId);
      return stored === undefined ? undefined : { cwd: stored.header.cwd };
    },
    sandboxRoot: () => host.sandboxPolicy()?.workspaceRoot,
  };
}
