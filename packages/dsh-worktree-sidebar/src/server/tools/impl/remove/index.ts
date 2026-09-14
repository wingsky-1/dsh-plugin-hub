/**
 * `ws_worktree_remove`：摘掉登记；只有显式 `removeDirectory` 才连带 `git worktree remove`。
 *
 * 默认不删目录是刻意的：删除可能丢掉未提交改动，而「我只是想换个根」与「我要销毁这个工作区」
 * 是两件事，不该由同一个默认值承担。
 */
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ToolsDeps } from "../../deps.ts";
import { resultOf, stateOf } from "../bind/index.ts";
import { argBool, RESULT_SCHEMA, renderResult } from "../protocol/index.ts";
import type { ToolResultValue } from "../protocol/index.ts";
import { sessionOf } from "../session/index.ts";

export function buildRemoveTool(deps: ToolsDeps): ToolDefinition {
  return {
    name: "ws_worktree_remove",
    description:
      "Unbind the worktree from THIS session; the right-sidebar Files tab returns to the session cwd " +
      "on its next open or refresh. " +
      "By default the worktree directory is left in place - pass removeDirectory: true to also run " +
      "git worktree remove, and force: true as well when it has uncommitted changes you accept losing. " +
      "The plugin never deletes directories itself.",
    parameters: {
      type: "object",
      properties: {
        removeDirectory: {
          type: "boolean",
          description:
            "Also remove the worktree directory with git worktree remove. Defaults to false: only the binding is dropped.",
        },
        force: {
          type: "boolean",
          description:
            "Adds --force to git worktree remove, discarding uncommitted changes. Only valid together with removeDirectory: true.",
        },
      },
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
      if (!state.bound) {
        return resultOf(
          state,
          false,
          "No worktree is bound to this session, so there is nothing to unbind.",
        );
      }
      const removeDirectory = argBool(args, "removeDirectory");
      const force = argBool(args, "force");
      if (force && !removeDirectory) {
        return resultOf(
          state,
          false,
          "force only applies together with removeDirectory: true; the binding is unchanged.",
        );
      }

      if (!removeDirectory) {
        const dropped = await deps.binding.drop(session.id);
        if (!dropped.ok) {
          return resultOf(state, false, "Could not persist the unbind: " + dropped.reason);
        }
        return resultOf(
          stateOf(deps, session.id),
          true,
          "Unbound the worktree from this session. The directory was left in place; open or refresh " +
            "the Files tab to return to the session cwd.",
        );
      }

      const record = deps.binding.get(session.id);
      if (record === undefined) {
        return resultOf(
          stateOf(deps, session.id),
          false,
          "The binding disappeared before it could be removed.",
        );
      }
      const removed = await deps.git.removeWorktree(record.repoRoot, record.worktreeRoot, force);
      if (!removed.ok) {
        return resultOf(
          state,
          false,
          "git worktree remove failed: " + removed.reason + " The binding is unchanged.",
        );
      }
      const dropped = await deps.binding.drop(session.id);
      if (!dropped.ok) {
        // 目录已经没了、登记还在：解析器会把「目录不存在」按未绑定处理，故这是一条自愈路径，
        // 但对调用者必须说清楚，否则下次来看会以为还绑着。
        return resultOf(
          state,
          false,
          "Removed the worktree directory, but the binding could not be dropped: " +
            dropped.reason +
            " It is now stale and will be treated as unbound; call this tool again to retry the unbind.",
        );
      }
      return resultOf(
        stateOf(deps, session.id),
        true,
        "Unbound this session and removed the worktree directory with git worktree remove.",
      );
    },
  };
}
