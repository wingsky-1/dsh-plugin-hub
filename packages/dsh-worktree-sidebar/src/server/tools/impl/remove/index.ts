/**
 * `ws_worktree_remove`：摘掉登记；只有显式 `removeDirectory` 才连带 `git worktree remove`。
 *
 * 默认不删目录是刻意的：删除可能丢掉未提交改动，而「我只是想换个根」与「我要销毁这个工作区」
 * 是两件事，不该由同一个默认值承担。
 *
 * **继承态不摘任何东西**：本会话没有自己的登记时，右栏的根属于父会话——摘它是改别人的状态，
 * 删目录更是销毁别人的工作区。这一态只如实说明并给出路。
 */
/**
 * 摘登记 + 删目录（removeDirectory: true）：落盘顺序是 removeWorktree → drop → 重解析。
 *
 * 顺序不能换：先 drop 再 remove 的话，remove 失败就留下一条「指向已不存在目录」的登记，
 * 而解析器会把「目录不存在」按未绑定处理——那等于静默把一次失败的删除说成成功。
 */
async function unbindAndRemove(
  deps: ToolsDeps,
  sessionId: string,
  origin: WorktreeOrigin & { readonly kind: "own" },
  force: boolean,
): Promise<ToolResultValue> {
  const removed = await deps.git.removeWorktree(
    origin.record.repoRoot,
    origin.record.worktreeRoot,
    force,
  );
  if (!removed.ok) {
    return resultOf(
      origin,
      false,
      "git worktree remove failed: " + removed.reason + " The binding is unchanged.",
    );
  }
  const dropped = await deps.binding.drop(sessionId);
  if (!dropped.ok) {
    // 目录已经没了、登记还在：解析器会把「目录不存在」按未绑定处理，故这是一条自愈路径，
    // 但对调用者必须说清楚，否则下次来看会以为还绑着。
    return resultOf(
      origin,
      false,
      "Removed the worktree directory, but the binding could not be dropped: " +
        dropped.reason +
        " It is now stale and will be treated as unbound; call this tool again to retry the unbind.",
    );
  }
  const after = await readOrigin(deps, sessionId);
  if (after.problem !== undefined) {
    // 目录与登记都已经落地，动作成功；现状读不回来时如实说明。
    return resultOf(
      after.origin,
      true,
      "Unbound this session and removed the worktree directory with git worktree remove. " +
        "The Files tab root could not be read back: " +
        after.problem,
    );
  }
  return resultOf(
    after.origin,
    true,
    after.origin.kind === "inherited"
      ? "Unbound this session and removed the worktree directory with git worktree remove. The " +
          "Files tab now follows the root inherited from session " +
          after.origin.ownerSessionId +
          "."
      : "Unbound this session and removed the worktree directory with git worktree remove.",
  );
}

/**
 * 只摘登记（removeDirectory 缺席）：目录留在原地。
 *
 * 与「连目录一起删」分成两个函数：两条路径的**落盘顺序**不同（这条是 drop→重解析；
 * 那条是 removeWorktree→drop→重解析），且各自的部分成功文案不同。挤在一个 execute 里时，
 * 「目录还在但登记没了」这个状态要读完两段才知道它属于哪条路径。
 */
async function unbindOnly(
  deps: ToolsDeps,
  sessionId: string,
  origin: WorktreeOrigin,
): Promise<ToolResultValue> {
  const dropped = await deps.binding.drop(sessionId);
  if (!dropped.ok) {
    return resultOf(origin, false, "Could not persist the unbind: " + dropped.reason);
  }
  // 摘掉自己的登记之后**必须重新解析**：右栏可能回落到继承来的根，那是调用者必须知道的事实。
  const after = await readOrigin(deps, sessionId);
  if (after.problem !== undefined) {
    // 摘除已经落盘，动作成功；只是现状读不回来——如实说不确定，而不是猜一个状态。
    return resultOf(
      after.origin,
      true,
      "Unbound this session's own binding. The Files tab root could not be read back: " +
        after.problem,
    );
  }
  return resultOf(
    after.origin,
    true,
    after.origin.kind === "inherited"
      ? "Unbound this session's own binding. The Files tab now follows the root inherited from " +
          "session " +
          after.origin.ownerSessionId +
          "."
      : "Unbound the worktree from this session. The directory was left in place; open or refresh " +
          "the Files tab to return to the session cwd.",
  );
}

import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ToolsDeps } from "../../deps.ts";
import { NO_ORIGIN, readOrigin, resultOf } from "../bind/index.ts";
import type { WorktreeOrigin } from "../bind/index.ts";
import { argBool, RESULT_SCHEMA, renderResult } from "../protocol/index.ts";
import type { ToolResultValue } from "../protocol/index.ts";
import { sessionOf } from "../session/index.ts";

/**
 * 继承态的解绑出路。三条互为补充：第 1 条是正路；2、3 两条在**父会话已经结束**（fork 的常见
 * 形态）时仍然走得通。第 3 条把本会话登记到自己的 cwd，视觉上等于取消继承——写的是一条**普通
 * 登记**（own 优先覆盖继承），不是任何形式的否定登记。
 */
function inheritedHelp(ownerSessionId: string, cwd: string | undefined): string {
  const main =
    "Nothing to unbind here: the Files tab root belongs to session " +
    ownerSessionId +
    ", not to this session. To stop following it: (1) unbind it in that session with ws_worktree_remove, " +
    "or (2) bind this session to another worktree with ws_worktree_create / ws_worktree_register.";
  if (cwd === undefined) return main;
  return (
    main +
    " A third option, when that session is gone: bind this session to its own working directory with " +
    'ws_worktree_register({ worktree: "' +
    cwd +
    '" }), which makes this session stop inheriting.'
  );
}

export function buildRemoveTool(deps: ToolsDeps): ToolDefinition {
  return {
    name: "ws_worktree_remove",
    description:
      "Unbind the worktree from THIS session; the right-sidebar Files tab returns to the session cwd " +
      "on its next open or refresh. " +
      "This only touches this session's own binding: when the Files tab follows a root inherited from a " +
      "parent session instead, the tool refuses (it never unbinds or removes another session's worktree) " +
      "and reports which session owns that root plus the ways to stop following it. " +
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
          NO_ORIGIN,
          false,
          "This tool needs an agent session, and the call carries none. Run it as an agent tool call.",
        );
      }
      const read = await readOrigin(deps, session.id);
      // 读不到绑定状态时也在**参数解析之前**报失败：那会儿连「本会话有没有自己的登记」都不知道，
      // 继续往下只会给出一个基于中性读数的错答案。
      if (read.problem !== undefined) return resultOf(read.origin, false, read.problem);
      // 继承态与未绑定态同样在参数解析之前判掉：否则 {removeDirectory:true} 会走到下面
      // 拿不到自己的记录，回一句含糊的失败，模型会以为「重试一次就好」。
      const origin = read.origin;
      if (origin.kind === "inherited") {
        return resultOf(origin, false, inheritedHelp(origin.ownerSessionId, session.cwd));
      }
      if (origin.kind === "none") {
        return resultOf(
          origin,
          false,
          "No worktree is bound to this session, so there is nothing to unbind.",
        );
      }
      const removeDirectory = argBool(args, "removeDirectory");
      const force = argBool(args, "force");
      if (force && !removeDirectory) {
        return resultOf(
          origin,
          false,
          "force only applies together with removeDirectory: true; the binding is unchanged.",
        );
      }

      if (!removeDirectory) return unbindOnly(deps, session.id, origin);
      return unbindAndRemove(deps, session.id, origin, force);
    },
  };
}
