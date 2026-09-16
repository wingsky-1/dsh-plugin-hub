/**
 * 把「绑定」翻译成「生效的文件根」。解析器与浏览器路由**共用**这一个函数，
 * 两端因此不可能各说各话（降级预案 G7 的根治办法：不是让两边都算对，而是让只有一边在算）。
 *
 * 文件根的两个来源分别是 `impl/own`（本会话自己的登记）与 `impl/inherit`（沿父链继承），
 * 本文件只负责把它们合成一个答案、并保证解析器**永不抛出**。
 *
 * `bindingOrigin` 是这条链条对外的**唯一事实源**：它不只回答「根在哪」，还回答「根是谁的」。
 * 工具面要区分「本会话自己的登记」与「继承来的登记」，唯一正确的做法就是读它——让工具面
 * 另算一遍继承，得到的就是本插件最该避免的「两个事实源各说一句话」。
 */
import type { BindingRecord } from "../../../binding/interface.ts";
import type { FileScope, ScopeDeps } from "../../deps.ts";
import { inheritedOrigin } from "../inherit/index.ts";
import { ownRecord } from "../own/index.ts";

/**
 * 绑定来源。用判别联合而不是「根 + 若干冗余字段」：`root` 恒等于 `record.worktreeRoot`，
 * 存两份就多一个能漂移的地方；`kind` 也把「没有登记」时其余字段该取什么值这个问题整个消掉。
 */
export type WorktreeOrigin =
  | { readonly kind: "none" }
  | { readonly kind: "own"; readonly record: BindingRecord }
  | { readonly kind: "inherited"; readonly record: BindingRecord; readonly ownerSessionId: string };

/** 来源对应的 worktree 根；`none`（该会话按官方语义走）回 null。 */
export function rootOf(origin: WorktreeOrigin): string | null {
  return origin.kind === "none" ? null : origin.record.worktreeRoot;
}

/** 本会话的绑定来源：自己的登记优先，其次沿父链继承，都没有就是 none。 */
export async function bindingOrigin(deps: ScopeDeps, sessionId: string): Promise<WorktreeOrigin> {
  const own = await ownRecord(deps, sessionId);
  if (own !== undefined) return { kind: "own", record: own };
  const inherited = await inheritedOrigin(deps, sessionId);
  if (inherited !== undefined) {
    return {
      kind: "inherited",
      record: inherited.record,
      ownerSessionId: inherited.ownerSessionId,
    };
  }
  return { kind: "none" };
}

/** 当前生效的 worktree 根；null 表示该会话按官方语义（cwd）走。 */
export async function effectiveWorktree(
  deps: ScopeDeps,
  sessionId: string,
): Promise<string | null> {
  return rootOf(await bindingOrigin(deps, sessionId));
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
