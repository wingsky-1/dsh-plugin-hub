/**
 * 三个工具共用的绑定动作：路径解析、归属校验、落登记、读现状。
 *
 * 校验顺序是刻意的：先「存在且是目录」（本地事实，最便宜），再「属于同一仓库」（要起 git）。
 * 反过来的话，一个手误的路径会先换来一次 git 调用和一句含糊的 git 报错。
 */
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { BindingRecord } from "../../../binding/interface.ts";
import type { AgentFace, ToolsDeps } from "../../deps.ts";
import type { SessionFace } from "../session/index.ts";
import type { ToolResultValue } from "../protocol/index.ts";

/** 当前的绑定状态（三个工具的返回信封都要它）。 */
export interface BindingState {
  readonly bound: boolean;
  readonly worktree: string;
  readonly branch: string;
}

/** 读某个会话的当前绑定状态。 */
export function stateOf(deps: ToolsDeps, sessionId: string): BindingState {
  const record = deps.binding.get(sessionId);
  if (record === undefined) return { bound: false, worktree: "", branch: "" };
  return { bound: true, worktree: record.worktreeRoot, branch: record.branch };
}

/** 组装结果信封。把状态与说明拼在一起，避免每个调用点各写一遍。 */
export function resultOf(state: BindingState, ok: boolean, detail: string): ToolResultValue {
  return { ok, bound: state.bound, worktree: state.worktree, branch: state.branch, detail };
}

/**
 * 把调用方给的路径解析成绝对路径。相对路径按**会话 cwd** 解析（那是调用者心里的基准），不是进程 cwd。
 *
 * 参数是 `string` 而不是 `string | undefined`：两个调用方都在更早的分支上把「没有 cwd」判失败并返回了，
 * 这里再留一条 undefined 分支就是一段**不可达代码**（覆盖率替一段永远到不了的代码记账没有意义）。
 */
export function resolveTarget(cwd: string, raw: string): string {
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/** 是目录才继续。不是就给一句能照着做的失败。 */
export function directoryProblem(target: string): string | undefined {
  const info = statSync(target, { throwIfNoEntry: false });
  if (info === undefined) return "No such directory: " + target;
  if (!info.isDirectory()) return "Not a directory: " + target;
  return undefined;
}

/** 会话所属仓库的可用 worktree 清单，用于失败时的可操作提示。 */
export async function availableWorktrees(deps: ToolsDeps, repo: string): Promise<string> {
  const entries = await deps.git.listWorktrees(repo);
  if (entries.length === 0) return "";
  return "\nAvailable worktrees:\n" + entries.map((entry) => "- " + entry.path).join("\n");
}

/**
 * 落一条绑定。归属校验在这里做唯一一次——三个工具都经过它，
 * 所以「只允许绑定同一仓库的 worktree」这条不变量不会因为某条路径漏写而破。
 */
export async function bindWorktree(
  deps: ToolsDeps,
  session: SessionFace,
  repo: string,
  target: string,
  registeredAt: string,
): Promise<ToolResultValue> {
  const before = stateOf(deps, session.id);
  // 身份凭据缺席时拒绝落盘：没有它，这条登记在下一个进程里可能被一个同 id 的新会话继承，
  // 而那是「静默看错地方」——留一条不可核对的登记比不登记更危险。
  if (session.createdAt === undefined) {
    return resultOf(
      before,
      false,
      "This session exposes no creation timestamp, so the binding could not be told apart from a " +
        "different session that reuses the same id after a restart. Refusing to bind.",
    );
  }
  const belongs = await deps.git.belongsTo(target, repo);
  if (belongs.kind !== "same") {
    // 写路径 fail-closed：读不出归属时拒绝，而不是照着「没验成」去写一条可能指向别的仓库的登记。
    // `notRepo` 在这里只用来把**文案**说准（git 明确回了否定），不参与摘除判定：权限不可读的目录
    // 在读数上与「不是工作树」同形，所以这句「不是本会话仓库的 worktree」读作「git 拒绝把它当工作树」，
    // 而不是「我们已经验过了」。剩下那一支（spawn 失败 / 超时）才说「没验成、稍后重试」。
    const why =
      belongs.kind === "different" || (belongs.kind === "unknown" && belongs.notRepo)
        ? "That directory is not a worktree of this session's repository (" +
          repo +
          "), so binding it would point the file tree outside this repository."
        : "Could not verify that the directory belongs to this session's repository (" +
          repo +
          "): " +
          (belongs.kind === "unknown" ? belongs.reason : "") +
          ". Retry once the directory is readable.";
    return resultOf(before, false, why + (await availableWorktrees(deps, repo)));
  }
  const branch = (await deps.git.headBranch(target)) ?? "";
  const record: BindingRecord = {
    repoRoot: repo,
    worktreeRoot: target,
    branch,
    createdAt: registeredAt,
    sessionCreatedAt: session.createdAt,
  };
  const written = await deps.binding.put(session.id, record);
  if (!written.ok) {
    return resultOf(before, false, "Could not persist the binding: " + written.reason);
  }
  const after = stateOf(deps, session.id);
  return resultOf(
    after,
    true,
    "Bound this session to the worktree." +
      " Open or refresh the right-sidebar Files tab to see it; the session cwd is unchanged," +
      " and @ references / present targets still resolve against the cwd.",
  );
}

/** 会话是否在一个 git 仓库里。不在就没有工具可言。 */
export async function repoOf(deps: ToolsDeps, agent: AgentFace): Promise<string | undefined> {
  if (agent.cwd === undefined) return undefined;
  const common = await deps.git.commonDir(agent.cwd);
  return common === undefined ? undefined : agent.cwd;
}
