/** `ws_worktree_create`：先 `git worktree add` 建出来，再登记给当前会话。 */
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ToolsDeps } from "../../deps.ts";
import { bindWorktree, resolveTarget, resultOf, stateOf } from "../bind/index.ts";
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
      "Path and branch are yours to choose; the plugin imposes no layout convention. If git worktree add " +
      "succeeds but binding fails, the directory is left in place and the result says so.",
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
            "git check-ref-format --branch before git is called. Omit to check out the repository HEAD " +
            "detached (git worktree add --detach), which creates no branch and works for paths whose " +
            "last segment is not a valid branch name.",
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
          { bound: false, worktree: "", branch: "" },
          false,
          "This tool needs an agent session, and the call carries none. Run it as an agent tool call.",
        );
      }
      const state = stateOf(deps, session.id);
      if (session.cwd === undefined) {
        return resultOf(
          state,
          false,
          "This session has no working directory, so it cannot be checked against a git repository.",
        );
      }
      const repo = session.cwd;
      if ((await deps.git.commonDir(repo)) === undefined) {
        return resultOf(state, false, "This session is not inside a git repository.");
      }
      const raw = argString(args, "path");
      if (raw === undefined) {
        return resultOf(state, false, "Missing required parameter: path.");
      }
      const target = resolveTarget(repo, raw);
      const branch = argString(args, "branch");
      if (branch !== undefined && !(await deps.git.checkRefFormat(branch))) {
        return resultOf(
          state,
          false,
          "Not a valid git branch name: " +
            branch +
            " (git check-ref-format --branch rejected it).",
        );
      }

      const created = await deps.git.addWorktree(repo, target, branch);
      if (!created.ok) {
        return resultOf(state, false, "git worktree add failed: " + created.reason);
      }

      const bound = await bindWorktree(deps, session, repo, target, deps.now());
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
