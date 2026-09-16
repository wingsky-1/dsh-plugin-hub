/**
 * 一个会话**自己**的登记现在还有效吗——失效就摘掉。
 *
 * 摘掉而不是仅仅忽略：客户端以 revision 判定缓存有效性，只忽略不摘的话 revision 不变、
 * 客户端继续把文件根指向 worktree，而宿主已经按 cwd 解析——用户看到的是持续的 outside-workspace
 * 报错，且没有任何东西会自愈。
 *
 * 但「失效」的要求是硬证据。三条判据里只有**确实拿到**了否定答案的那种才允许摘：
 * 目录不存在（`stat` 说 ENOENT）、会话 id 已被另一个会话复用（`createdAt` 不同）、
 * 两侧都读出了公共 git 目录且不同。读不出来的一律保住登记——一次权限抖动或持久面抖动
 * 不该变成一次永久的摘除。
 */
import { statSync } from "node:fs";
import type { ScopeDeps, SessionIdentity } from "../../deps.ts";

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
  const identity = await identityOf(deps, sessionId);
  if (identity !== undefined && identity.createdAt !== record.sessionCreatedAt) {
    await drop(
      deps,
      sessionId,
      "会话 id 已被另一个会话复用（登记属于 createdAt=" +
        record.sessionCreatedAt +
        "，当前会话是 " +
        identity.createdAt +
        "）：" +
        record.worktreeRoot,
    );
    return null;
  }
  const belongs = await deps.git.belongsTo(record.worktreeRoot, record.repoRoot);
  if (belongs.kind === "different") {
    await drop(deps, sessionId, "已不是该仓库的 worktree：" + record.worktreeRoot);
    return null;
  }
  if (belongs.kind === "unknown") {
    // 保留登记 + 出声：这一次问不出归属，正确的行为是沿用上次的成功态，而不是摘掉用户的登记。
    deps.logger.warn(
      "dsh-worktree-sidebar: 无法确认 worktree 归属，保留该会话的登记 — " + belongs.reason,
    );
  }
  return record.worktreeRoot;
}

/** 核对会话身份。读不出来（持久面缺席或抛错）时回 undefined，调用方因此保住登记。 */
async function identityOf(
  deps: ScopeDeps,
  sessionId: string,
): Promise<SessionIdentity | undefined> {
  const live = deps.sessions.liveIdentityOf(sessionId);
  if (live !== undefined) return live;
  try {
    return await deps.sessions.storedIdentityOf(sessionId);
  } catch (cause) {
    deps.logger.warn(
      "dsh-worktree-sidebar: 无法核对会话身份，保留该会话的登记 — " +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    return undefined;
  }
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
