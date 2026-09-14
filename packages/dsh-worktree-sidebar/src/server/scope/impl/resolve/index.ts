/**
 * 把「绑定」翻译成「生效的文件根」。解析器与浏览器路由**共用**这一个函数，
 * 两端因此不可能各说各话（降级预案 G7 的根治办法：不是让两边都算对，而是让只有一边在算）。
 *
 * 文件根的两个来源分别是 `impl/own`（本会话自己的登记）与 `impl/inherit`（子 agent 沿父链继承），
 * 本文件只负责把它们合成一个答案、并保证解析器**永不抛出**。
 */
import type { FileScope, ScopeDeps } from "../../deps.ts";
import { inheritedWorktree } from "../inherit/index.ts";
import { ownWorktree } from "../own/index.ts";

/** 当前生效的 worktree 根；null 表示该会话按官方语义（cwd）走。 */
export async function effectiveWorktree(
  deps: ScopeDeps,
  sessionId: string,
): Promise<string | null> {
  const own = await ownWorktree(deps, sessionId);
  if (own !== null) return own;
  return inheritedWorktree(deps, sessionId);
}

/**
 * 解析器的入口：命中绑定就给 worktree，否则委托。
 *
 * **永不抛出**是这里的核心承诺：官方 gateway 把 resolver 的异常翻成 `gateway/lookup-failed`，
 * 那是整条文件读取链路的硬失败，不是回退。所以 catch 必须在这里，而不是指望上游。
 */
export async function resolveScope(
  deps: ScopeDeps,
  delegate: (sessionId: string) => Promise<FileScope | undefined>,
  sessionId: string,
): Promise<FileScope | undefined> {
  try {
    const root = await effectiveWorktree(deps, sessionId);
    if (root !== null) return { sessionId, workspaceRoot: root };
  } catch (cause) {
    deps.logger.warn(
      "dsh-worktree-sidebar: 解析文件根失败，回退官方语义 — " +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
  try {
    return await delegate(sessionId);
  } catch (cause) {
    // 委托是官方的 resolve，它抛错说明上游环境有问题；
    // 回 undefined 让 gateway 走它的 lookup-not-found，而不是让异常从这里逃出去。
    deps.logger.warn(
      "dsh-worktree-sidebar: 官方默认解析失败 — " +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    return undefined;
  }
}
