/**
 * 三个工具共用的绑定动作：来源读取、路径解析、归属校验、落登记。
 *
 * 校验顺序是刻意的：先「存在且是目录」（本地事实，最便宜），再「属于同一仓库」（要起 git）。
 * 反过来的话，一个手误的路径会先换来一次 git 调用和一句含糊的 git 报错。
 *
 * 绑定来源**只从 scope 域读**（`readOrigin`）：侧边栏的生效根与工具面的现状读数因此同源，
 * 工具才不会在 fork 出来的会话里回一句「本会话没有绑定」——那正是 #847 要修的缺陷。
 */
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { BindingRecord } from "../../../binding/interface.ts";
import type { WorktreeOrigin } from "../../../scope/interface.ts";
import type { AgentFace, ToolsDeps } from "../../deps.ts";
import type { SessionFace } from "../session/index.ts";
import type { ToolResultValue } from "../protocol/index.ts";

/** 当前的绑定状态（三个工具的返回信封都要它）。 */
export interface BindingState {
  readonly bound: boolean;
  readonly worktree: string;
  readonly branch: string;
}

/**
 * 还没解析出来源时用的中性读数。早退路径（缺会话、缺 cwd、不在仓库、缺必填参数）用它：
 * 为一句「没有 cwd」白付一趟 git 与持久面读不值得，那些失败的成因也和「绑在哪」无关。
 */
export const NO_ORIGIN: WorktreeOrigin = { kind: "none" };

/**
 * 读来源的结果：`problem` 非空时 `origin` 是中性读数，调用方应直接把 `problem` 当作失败原因报出去。
 */
export interface OriginRead {
  readonly origin: WorktreeOrigin;
  readonly problem: string | undefined;
}

/**
 * 读某个会话的绑定来源（自己的登记 / 继承来的登记 / 没有）。
 *
 * 解析异常在这里收口。scope 域未装配或已释放时它抛的是**插件自己的装配状态**（内部文案是
 * 「scope 域尚未装配」）：那句话与调用者正在做的事毫无关系，透给模型只会让它照着一句无法行动的
 * 话去猜。所以对外只说「读不到绑定状态、稍后重试」，原因留给 logger —— 现场痕迹不丢，
 * 模型也不会拿到内部装配文案。
 *
 * 不静默翻成「没有绑定」：那会把一次真实故障说成事实，而「看错地方」正是本插件最该避免的事。
 */
export async function readOrigin(deps: ToolsDeps, sessionId: string): Promise<OriginRead> {
  try {
    return { origin: await deps.scope.worktreeOrigin(sessionId), problem: undefined };
  } catch (cause) {
    deps.logger.warn(
      "dsh-worktree-sidebar: 读取绑定来源失败 —— " +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    return {
      origin: NO_ORIGIN,
      problem:
        "Could not read this session's binding state. Retry once the extension is fully loaded.",
    };
  }
}

/** 把来源翻成信封里的状态读数：继承态下 worktree / branch 取的是继承到的那条登记。 */
export function stateOf(origin: WorktreeOrigin): BindingState {
  if (origin.kind === "none") return { bound: false, worktree: "", branch: "" };
  return { bound: true, worktree: origin.record.worktreeRoot, branch: origin.record.branch };
}

/**
 * 组装结果信封。**继承来源说明只在这里加一次**：三个工具、每条成功与失败路径都经过它。
 * 各调用点自己拼就一定会漏——漏掉之后模型读到的是「本会话没有绑定」，它会去重建一条
 * 本已存在的登记（#847 的现场就是这样）。
 */
export function resultOf(origin: WorktreeOrigin, ok: boolean, detail: string): ToolResultValue {
  const state = stateOf(origin);
  const inherited =
    origin.kind === "inherited"
      ? "This root is inherited from session " +
        origin.ownerSessionId +
        "; this session has no binding of its own. "
      : "";
  return {
    ok,
    bound: state.bound,
    worktree: state.worktree,
    branch: state.branch,
    detail: inherited + detail,
  };
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
 *
 * `before` 由调用方先解析好再递进来：调用方在更早的分支上就要用它（那几处失败路径也要报现状），
 * 在这里重算一遍等于白付一趟 git 与持久面读。
 */
export async function bindWorktree(
  deps: ToolsDeps,
  session: SessionFace,
  repo: string,
  target: string,
  registeredAt: string,
  before: WorktreeOrigin,
): Promise<ToolResultValue> {
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
  // 成功路径的 after 就是刚写下的那条记录（own 态的定义如此），不必再解析一遍——
  // 那会白付一趟 git 与持久面读，而结果只可能等价。
  return resultOf(
    { kind: "own", record },
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
