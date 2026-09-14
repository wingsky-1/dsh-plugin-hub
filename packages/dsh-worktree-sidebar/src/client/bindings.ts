/**
 * 绑定读取：每个会话一份状态，宿主回什么就是什么。
 *
 * 客户端**不做**「这个根还有效吗」的判断——宿主已经把「生效值」算好了（失效绑定会被它摘掉）。
 * 两边各判一次就是 G7 说的那种分叉：客户端认为还绑着、宿主已经按 cwd 解析，
 * 用户看到的是持续的 outside-workspace 报错。所以这里只负责搬运与保持上次成功态。
 */
import type { ObservablePort, ReadBinding } from "./shared/ports.ts";

/** 一个会话的绑定状态。同块使用，故不从本模块转出（对照 source.ts 的 SessionsSource）。 */
interface BindingState extends ObservablePort<string | null> {
  /** 拉一次宿主；失败保持上次成功态（G6）。 */
  refresh(): Promise<void>;
}

/** 造一个会话的绑定状态。 */
export function createBindingState(read: ReadBinding, sessionId: string): BindingState {
  let path: string | null = null;
  let revision = -1;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => path,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refresh(): Promise<void> {
      let next;
      try {
        next = await read(sessionId);
      } catch {
        // 拉取抛错与拉取失败同处置：保持上次成功态。首次就没成功过时 path 仍是 null——
        // 那是「按真实 cwd 走」，不是「错误地改了根」。
        return;
      }
      if (next === undefined) return;
      if (next.revision === revision && next.worktreePath === path) return;
      revision = next.revision;
      path = next.worktreePath;
      for (const listener of [...listeners]) listener();
    },
  };
}
