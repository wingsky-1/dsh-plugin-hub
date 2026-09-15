/** `ws_worktree_register`：把一个**已存在**的 worktree 登记给当前会话。 */
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ToolsDeps } from "../../deps.ts";
import {
  availableWorktrees,
  bindWorktree,
  directoryProblem,
  resolveTarget,
  resultOf,
  stateOf,
} from "../bind/index.ts";
import { argString, RESULT_SCHEMA, renderResult } from "../protocol/index.ts";
import type { ToolResultValue } from "../protocol/index.ts";
import { sessionOf } from "../session/index.ts";

export function buildRegisterTool(deps: ToolsDeps): ToolDefinition {
  return {
    name: "ws_worktree_register",
    description:
      "Bind an existing git worktree to THIS session, so the right-sidebar Files tab is rooted at that " +
      "worktree once you open or refresh it. The session cwd does not change. " +
      "Use ws_worktree_create instead when the worktree does " +
      "not exist yet. Only the Files tab follows the binding: @ file references, present targets and the " +
      "skill catalog still resolve against the session cwd, and under the workspace-write file policy the " +
      "agent cannot write into the worktree.",
    parameters: {
      type: "object",
      properties: {
        worktree: {
          type: "string",
          description:
            "The worktree to bind: an absolute path, or a path relative to the session working directory.",
        },
      },
      required: ["worktree"],
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
      if ((await deps.git.commonDir(session.cwd)) === undefined) {
        return resultOf(state, false, "This session is not inside a git repository.");
      }
      const raw = argString(args, "worktree");
      if (raw === undefined) {
        return resultOf(state, false, "Missing required parameter: worktree.");
      }
      const target = resolveTarget(session.cwd, raw);
      const problem = directoryProblem(target);
      if (problem !== undefined) {
        return resultOf(state, false, problem + (await availableWorktrees(deps, session.cwd)));
      }
      return bindWorktree(deps, session, session.cwd, target, deps.now());
    },
  };
}
