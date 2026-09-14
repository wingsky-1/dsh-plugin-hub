/**
 * 工具的输入读取与结果信封。
 *
 * 三个工具共用同一个结果形状，是为了让「当前指向哪个 worktree」这件事永远出现在返回文本里：
 * 失败路径也要说清现状，否则模型在错误之后只知道「失败了」，不知道自己现在到底绑在哪。
 *
 * 输出 schema 只用 enforced subset 支持的键（单一 `type`、无 type 数组），
 * 「没有值」一律用空串表达而不是 null——该子集不接受可空类型。
 */
import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";

/** 三个工具的统一返回值。 */
export interface ToolResultValue {
  /** 本次请求的操作是否成功。 */
  readonly ok: boolean;
  /** 调用之后该会话是否仍有绑定。 */
  readonly bound: boolean;
  /** 绑定指向的 worktree 绝对路径；`bound` 为 false 时是空串。 */
  readonly worktree: string;
  /** 绑定的分支名；无绑定或 detached 时是空串。 */
  readonly branch: string;
  /** 面向模型的结果说明：成功是事实陈述，失败是原因加可操作的下一步。 */
  readonly detail: string;
}

/** 结果信封的 schema（`output.schema`）。 */
export const RESULT_SCHEMA: JsonSchemaNode = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "Whether the requested operation succeeded." },
    bound: {
      type: "boolean",
      description: "Whether a worktree is bound to this session after the call.",
    },
    worktree: {
      type: "string",
      description: "Absolute path of the bound worktree; empty when bound is false.",
    },
    branch: {
      type: "string",
      description: "Bound branch name; empty when bound is false or the worktree is detached.",
    },
    detail: {
      type: "string",
      description:
        "What happened: for failures, the reason and the next thing to try; for successes, the effect.",
    },
  },
  required: ["ok", "bound", "worktree", "branch", "detail"],
  additionalProperties: false,
};

/**
 * 结果渲染。**状态行永远在前**：模型据此知道调用后的真实状态，不必再调一次工具确认。
 */
export function renderResult(value: ToolResultValue): Array<{ type: "text"; text: string }> {
  const state = value.bound
    ? "bound worktree: " + value.worktree + (value.branch === "" ? "" : " [" + value.branch + "]")
    : "no worktree bound to this session";
  return [{ type: "text", text: state + "\n" + value.detail }];
}

/** 读一个非空字符串参数。空白串视同缺席（模型偶尔会给空串表示「没填」）。 */
export function argString(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** 读一个布尔参数。只有显式 `true` 为真——缺席、非布尔、字符串 "true" 都不算。 */
export function argBool(args: unknown, key: string): boolean {
  if (typeof args !== "object" || args === null) return false;
  return (args as Record<string, unknown>)[key] === true;
}
