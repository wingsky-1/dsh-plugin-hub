/** `ws_worktree_create`：先 `git worktree add` 建出来，再登记给当前会话。 */
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ToolsDeps } from "../../deps.ts";
import { bindWorktree, NO_ORIGIN, readOrigin, resolveTarget, resultOf } from "../bind/index.ts";
import { argString, RESULT_SCHEMA, renderResult } from "../protocol/index.ts";
import type { ToolResultValue } from "../protocol/index.ts";
import { sessionOf } from "../session/index.ts";

export function buildCreateTool(deps: ToolsDeps): ToolDefinition {
  return {
    name: "ws_worktree_create",
    description:
      "Create a git worktree from this session's repository with git worktree add, then bind it to " +
      "THIS session so the right-sidebar Files tab is rooted at it (open or refresh that tab to see " +
      "the new root). The session cwd does not change. " +
      "Prefer this over a bare git worktree add when the Files tab should show the new worktree: a bare " +
      "git command creates the directory but leaves the Files tab rooted at the session cwd (for a " +
      "worktree you created that way, call ws_worktree_register on it instead). " +
      "Path and branch are yours to choose; the plugin imposes no layout convention. " +
      "base defaults to the current HEAD of the repository the session working directory is in, so pass " +
      "it explicitly when you need a different start point. " +
      "If git worktree add succeeds but binding fails, the directory is left in place and the result says " +
      "so. Whether the Files tab then actually follows the binding is reported by GET " +
      "/api/dsh-worktree-sidebar/health as scopeTakeover.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Where to create the worktree: an absolute path, or a path relative to the session working directory.",
        },
        branch: {
          type: "string",
          description:
            "Optional branch to create for the worktree (git worktree add -b). Validated with " +
            "git check-ref-format --branch before git is called. Omit to check out the start point " +
            "detached (git worktree add --detach): that is base, or the repository HEAD when base is " +
            "omitted too. Creating no branch also works for paths whose last segment is not a valid " +
            "branch name.",
        },
        base: {
          type: "string",
          description:
            "Optional start point (commit-ish: branch, tag, or SHA, e.g. origin/main). Defaults to the " +
            "current HEAD of the repository the session working directory is in.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args: unknown, value: unknown) => renderResult(value as ToolResultValue),
    },
    execute: async (args: unknown, exec: unknown): Promise<ToolResultValue> => {
      const session = sessionOf(exec);
      if (session === undefined) {
        return resultOf(
          NO_ORIGIN,
          false,
          "This tool needs an agent session, and the call carries none. Run it as an agent tool call.",
        );
      }
      if (session.cwd === undefined) {
        return resultOf(
          NO_ORIGIN,
          false,
          "This session has no working directory, so it cannot be checked against a git repository.",
        );
      }
      const repo = session.cwd;
      if ((await deps.git.commonDir(repo)) === undefined) {
        return resultOf(NO_ORIGIN, false, "This session is not inside a git repository.");
      }
      const raw = argString(args, "path");
      if (raw === undefined) {
        return resultOf(NO_ORIGIN, false, "Missing required parameter: path.");
      }
      // 来源解析放在上面那些廉价校验之后：早退路径不白付一趟 git 与持久面读。
      const read = await readOrigin(deps, session.id);
      if (read.problem !== undefined) return resultOf(read.origin, false, read.problem);
      const origin = read.origin;
      const target = resolveTarget(repo, raw);
      const branch = argString(args, "branch");
      if (branch !== undefined && !(await deps.git.checkRefFormat(branch))) {
        return resultOf(
          origin,
          false,
          "Not a valid git branch name: " +
            branch +
            " (git check-ref-format --branch rejected it).",
        );
      }
      const base = argString(args, "base");
      // 形态 guard 必须在 git 调用之前：起点位置的 "-" 开头值会被 worktree add 内部的选项解析吞掉
      // （实测 -f / --force 会 rc=0 但忽略起点、从 HEAD 建），那正是「静默产出过期基线」本身。
      if (base !== undefined && base.startsWith("-")) {
        return resultOf(
          origin,
          false,
          "Not a valid start point: " + base + ' (a start point must not begin with "-").',
        );
      }
      let startPoint: string | undefined;
      if (base !== undefined) {
        // 归一化成 SHA 之后再进 argv：SHA 不以 "-" 开头，二次解析因此无处下手。
        startPoint = await deps.git.resolveCommit(repo, base);
        if (startPoint === undefined) {
          return resultOf(origin, false, "Not a valid start point: " + base + ".");
        }
      }

      const created = await deps.git.addWorktree(repo, target, branch, startPoint);
      if (!created.ok) {
        return resultOf(origin, false, "git worktree add failed: " + created.reason);
      }

      const bound = await bindWorktree(deps, session, repo, target, deps.now(), origin);
      if (!bound.ok) {
        // 建出来了但没绑上：这是一次**部分成功**，不能报成失败让调用者以为目录没建。
        return {
          ...bound,
          detail:
            "The worktree was created at " +
            target +
            ", but binding it to this session failed: " +
            bound.detail +
            " The directory is left in place: bind it with ws_worktree_register, or remove it with " +
            "git worktree remove -- " +
            target,
        };
      }
      return {
        ...bound,
        detail:
          "Created the worktree and bound this session to it. Open or refresh the right-sidebar Files " +
          "tab to see it; the session cwd is unchanged.",
      };
    },
  };
}
