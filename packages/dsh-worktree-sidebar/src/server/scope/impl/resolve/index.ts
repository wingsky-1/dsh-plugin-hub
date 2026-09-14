/**
 * 把「绑定」翻译成「生效的文件根」。解析器与浏览器路由**共用**这一个函数，
 * 两端因此不可能各说各话（降级预案 G7 的根治办法：不是让两边都算对，而是让只有一边在算）。
 */
import { statSync } from "node:fs";
import type { FileScope, ScopeDeps } from "../../deps.ts";

/** 存在性判定看到的形状。窄到只需要一个方法，测试才能用一个字面量替身驱动。 */
interface StatLike {
  isDirectory(): boolean;
}

/** 默认实现：直连 fs。`throwIfNoEntry` 只把 ENOENT 变成 undefined，其余错误照抛。 */
function realStat(path: string): StatLike | undefined {
  return statSync(path, { throwIfNoEntry: false });
}

/**
 * 目录是否真的在。只有 ENOENT/ENOTDIR 才算「不在」；其它错误（EACCES、EIO）按存在处理。
 *
 * `stat` 是可注入的：这段「读不了不等于不存在」的语义正是最容易写错、也最不该靠真实权限去构造
 * 测试环境的地方（换成 `return false` 会把一次权限抖动变成永久摘掉用户的绑定）。
 */
export function directoryExists(
  path: string,
  stat: (p: string) => StatLike | undefined = realStat,
): boolean {
  try {
    return stat(path)?.isDirectory() === true;
  } catch {
    // 读不了不等于不存在。把权限或 IO 抖动当成「目录没了」会**永久摘掉**用户的绑定，
    // 而重试的代价只是这一次列表失败。
    return true;
  }
}

/**
 * 当前生效的 worktree 根；null 表示该会话按官方语义（cwd）走。
 *
 * 失效绑定会被**摘掉**而不是仅仅忽略：客户端以 revision 判定缓存有效性，
 * 只忽略不摘的话 revision 不变、客户端继续把文件根指向 worktree，
 * 而宿主已经按 cwd 解析——用户看到的是持续的 outside-workspace 报错，
 * 且没有任何东西会自愈。
 */
export async function effectiveWorktree(
  deps: ScopeDeps,
  sessionId: string,
): Promise<string | null> {
  const record = deps.binding.get(sessionId);
  if (record === undefined) return null;

  const exists = deps.existsDirectory ?? directoryExists;
  if (!exists(record.worktreeRoot)) {
    await drop(deps, sessionId, "worktree 目录不存在：" + record.worktreeRoot);
    return null;
  }
  if (!(await deps.git.belongsTo(record.worktreeRoot, record.repoRoot))) {
    await drop(deps, sessionId, "已不是该仓库的 worktree：" + record.worktreeRoot);
    return null;
  }
  return record.worktreeRoot;
}

async function drop(deps: ScopeDeps, sessionId: string, reason: string): Promise<void> {
  deps.logger.warn("dsh-worktree-sidebar: " + reason + " —— 已摘掉该会话的登记");
  try {
    const dropped = await deps.binding.drop(sessionId);
    if (!dropped.ok) {
      deps.logger.warn("dsh-worktree-sidebar: 摘除失效绑定失败 — " + dropped.reason);
    }
  } catch (cause) {
    deps.logger.warn(
      "dsh-worktree-sidebar: 摘除失效绑定抛出 — " +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
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
    // 委托是官方的 resolve（或我们的等价实现），它抛错说明上游环境有问题；
    // 回 undefined 让 gateway 走它的 lookup-not-found，而不是让异常从这里逃出去。
    deps.logger.warn(
      "dsh-worktree-sidebar: 官方默认解析失败 — " +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    return undefined;
  }
}
