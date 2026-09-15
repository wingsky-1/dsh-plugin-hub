/**
 * 会话链适配层：只回答「这个会话的父会话是谁」。
 *
 * 官方把父链记在会话 header 上（`parentSession?: SessionId`，dsh-session/lib/types/types.d.ts:71）。它有两个来源，
 * **两个都必要**：活会话走 `ctx.sessions.get`（同步），已结束会话只能走持久面 `sessionPersistence.stat`
 * （单会话定位，不读事件日志）——官方 `dsh-session/lib/index.js:1550-1557` 的 `get` 契约明写是
 * "Look up a live session"，会话被释放/detach 之后 header 就取不到了。而 UI 里能点选的子会话恰恰是
 * **已结束**的那些，少了持久面这一半，继承在用户可见的那个状态上就是空的。
 *
 * 持久面是可选服务（`dsh-base/cordis.patch.yml:110-111` 的 jsonl 后端提供）：缺席时如实回 undefined，
 * 继承退回 live-only，功能降级而不是把整条文件根解析拖垮。
 */
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { LiveParent, SessionChainPort, SessionIdentity } from "../scope/deps.ts";

/**
 * 官方会话 header 的窄面。`createdAt` 与 `parentSession` 同样重要：
 * id 是进程内计数器、重启后会重排，绑定要靠 `createdAt` 才认得出「这是不是同一个会话」。
 */
interface SessionHeaderFace {
  readonly parentSession?: string;
  readonly createdAt: number;
}

/** 官方 sessions 服务的窄面：只按 id 取一次**活**会话记录。 */
export interface SessionsFace {
  get(id: SessionId): { readonly header: SessionHeaderFace } | undefined;
}

/** 官方持久会话服务的窄面：只取一条已结束会话的 header。 */
export interface StoredSessionsFace {
  stat(id: SessionId): Promise<{ readonly header: SessionHeaderFace } | undefined>;
}

/**
 * 身份读数：`createdAt` 是有限数才算凭据，否则按「读不出来」回 undefined。
 *
 * 为什么要在这里拦一道：`scope` 域把「凭据与登记不同」当成**正面证据**并据此摘掉用户的绑定，
 * 于是畸形 header（非数值）会被读成「另一个会话」。官方存储不会产出这种 header
 * （`dsh-session` 构造与恢复都校验/填充），但本包对同类外部输入（`sessionOf`、`validateRecord`）
 * 一律在边界校验，这里保持同一条纪律。
 */
function identityFrom(createdAt: number): SessionIdentity | undefined {
  return Number.isFinite(createdAt) ? { createdAt } : undefined;
}

export function bindSessions(
  sessions: SessionsFace,
  /**
   * 持久面按**调用时刻**取：`ctx.get` 的语义是「取当刻值，未提供回 undefined」
   * （`cordis/lib/index.js:754-771`），在 apply 期取一次会让晚挂的后端永久退化成缺席。
   */
  storedSessions: () => StoredSessionsFace | undefined,
): SessionChainPort {
  return {
    liveParentOf: (sessionId): LiveParent => {
      const session = sessions.get(sessionId as SessionId);
      if (session === undefined) return { kind: "not-live" };
      const parent = session.header.parentSession;
      return parent === undefined ? { kind: "root" } : { kind: "parent", id: parent };
    },
    storedParentOf: async (sessionId) => {
      const stored = storedSessions();
      if (stored === undefined) return undefined;
      const snapshot = await stored.stat(sessionId as SessionId);
      return snapshot?.header.parentSession;
    },
    liveIdentityOf: (sessionId): SessionIdentity | undefined => {
      const live = sessions.get(sessionId as SessionId);
      return live === undefined ? undefined : identityFrom(live.header.createdAt);
    },
    storedIdentityOf: async (sessionId): Promise<SessionIdentity | undefined> => {
      const stored = storedSessions();
      if (stored === undefined) return undefined;
      const snapshot = await stored.stat(sessionId as SessionId);
      // 持久面也没有这条会话：此刻无从核对，交给调用方按「读不了不等于不存在」处置。
      return snapshot === undefined ? undefined : identityFrom(snapshot.header.createdAt);
    },
  };
}
