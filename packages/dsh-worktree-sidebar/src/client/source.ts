/**
 * 伪造的 `sessions` hook 源：把某个会话的 `cwd` 改写成 worktree 路径，其余字段原样透传。
 *
 * 三条硬约束，每一条失效的形态都很难查：
 * 1. **引用稳定**：同一次真实快照 + 同一条 worktree 路径必须回同一个对象。每次新建对象会让渲染层
 *    认为状态一直在变，表现是右栏持续重渲染（刷得看不出来，只是卡）。
 * 2. **只改一个字段**：ById 里其余会话、以及该会话的其余字段都必须是原引用，否则预览、命令面板等
 *    消费方会看到被我们改过的世界。
 * 3. **未绑定即原样**：没有绑定就直接回真实快照，不制造副本——那时我们的存在应当完全不可见。
 */
import type { ObservablePort, SessionsSnapshotLike } from "./shared/ports.ts";

/** 一个会话的改写源。 */
interface SessionsSource extends ObservablePort<SessionsSnapshotLike> {
  /** 通知订阅者状态可能变了（由绑定刷新驱动）。 */
  notify(): void;
}

/**
 * @param real - 真实会话源（官方注入的那一个）。
 * @param currentPath - 同步读当前生效的 worktree 路径；null 表示按真实 cwd 走。
 */
export function createSessionsSource(
  real: ObservablePort<SessionsSnapshotLike>,
  sessionId: string,
  currentPath: () => string | null,
): SessionsSource {
  const listeners = new Set<() => void>();
  let cached: SessionsSnapshotLike | undefined;
  let cachedFrom: SessionsSnapshotLike | undefined;
  let cachedPath: string | null = null;

  return {
    getSnapshot(): SessionsSnapshotLike {
      const snapshot = real.getSnapshot();
      const path = currentPath();
      if (path === null) return snapshot;
      // 引用稳定的判据是「真实快照同一 + 路径同一」，不是「上次算过」——
      // 少了任一项都会让一次真实的会话变更被缓存吞掉。
      if (cached !== undefined && cachedFrom === snapshot && cachedPath === path) return cached;
      cachedFrom = snapshot;
      cachedPath = path;
      cached = rewrite(snapshot, sessionId, path);
      return cached;
    },
    subscribe(listener: () => void): () => void {
      // 真实源与本地通知都要听：会话变了要重算，绑定变了也要重算。
      const unsubscribeReal = real.subscribe(listener);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribeReal();
      };
    },
    notify(): void {
      // 迭代副本：订阅者在回调里退订不该打断本轮其余订阅者。
      for (const listener of [...listeners]) listener();
    },
  };
}

/** 生成改写后的快照。`byId` 缺失或没有该会话时原样返回——我们不该凭空造出会话条目。 */
function rewrite(
  snapshot: SessionsSnapshotLike,
  sessionId: string,
  path: string,
): SessionsSnapshotLike {
  const byId = snapshot.byId;
  if (byId === undefined) return snapshot;
  const entry = byId[sessionId];
  if (typeof entry !== "object" || entry === null) return snapshot;
  return {
    ...snapshot,
    byId: { ...byId, [sessionId]: { ...(entry as Record<string, unknown>), cwd: path } },
  };
}
