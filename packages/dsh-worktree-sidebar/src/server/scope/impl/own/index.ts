/**
 * 一个会话**自己**的登记现在还有效吗——失效就摘掉。
 *
 * 摘掉而不是仅仅忽略：客户端以 revision 判定缓存有效性，只忽略不摘的话 revision 不变、
 * 客户端继续把文件根指向 worktree，而宿主已经按 cwd 解析——用户看到的是持续的 outside-workspace
 * 报错，且没有任何东西会自愈。
 */
import { statSync } from "node:fs";
import type { ScopeDeps } from "../../deps.ts";

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

/** 只看本会话自己的登记：没有、或已失效（目录没了 / 已不是该仓库的 worktree）都回 null。 */
export async function ownWorktree(deps: ScopeDeps, sessionId: string): Promise<string | null> {
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
