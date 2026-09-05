/**
 * agent 纪律钩子——按会话 cwd 条件注入 worktree 开发纪律（系统提示词）。
 *
 * 注入方式：**ctx.systemPrompt.section 系统提示词注入**（order: 170，紧跟在
 * dsh-mcp-manager order: 160 之后）。
 *
 * 判定：context.agent.session.header.cwd → 沿 cwd 找 .git 标记（findGitRoot）：
 * - 是 git 仓（主 checkout / worktree）→ 注入纪律（~140 tokens/次，全英文紧凑决策表）；
 * - 非 git 仓（日常维护/讨论空间）或无 session → 返回空字符串（零注入零 Token 浪费，
 *   严格杜绝 process.cwd 宿主逃逸）。
 */
import type { Context } from "@deepseek-ai/cordis";
import { findGitRoot } from "./guard.ts";

/** 注入给 agent 的 worktree 开发纪律文案（全英文，紧凑决策表，强调优先搜索）。 */
export const CODEGRAPH_SYSTEM_PROMPT = [
  "[Code Graph: codegraph_* tools]",
  "In git repositories, ALWAYS prioritize `codegraph_*` tools over grep or direct file reads for code search, symbol navigation, and architecture exploration. The tool layer auto-syncs the worktree index before queries.",
  "",
  "Quick Dispatch:",
  "- Search by keyword/concept: `codegraph_search` (PRIMARY entry point for discovering symbols)",
  "- Architecture & definitions: `codegraph_explore` (comprehensive multi-hop code context)",
  "- Call hierarchy: `codegraph_callers` (\"who calls X\") / `codegraph_callees` (\"what does X call\")",
  "- Pre-refactoring impact: `codegraph_impact` (analyze blast radius before modifying/deleting)",
  "- Source & symbol breakdown: `codegraph_node` (inspect single symbol or file symbol table)",
  "- Directory layout: `codegraph_files`",
  "- Check index status: `codegraph_status`",
  "",
  "Rules:",
  "- NEVER grep for code symbols or functions. Use grep ONLY for raw literal text (logs, strings, configs).",
  "- Directly invoke bare `codegraph_*` tools; DO NOT use `mcp__` prefixes.",
  "- For files actively being edited, read raw files directly. If unindexed, run `codegraph init <path>`.",
].join("\n");

/** @deprecated Kept for backwards compatibility with earlier contracts. */
export const DISCIPLINE_TEXT = CODEGRAPH_SYSTEM_PROMPT;

/** 按会话 cwd 判定是否注入纪律（纯函数，便于单测）。 */
export function shouldInject(cwd: string | undefined): boolean {
  return findGitRoot(cwd) !== undefined;
}

/**
 * 动态计算系统提示词文本（纯函数，供 systemPrompt.section(text) 回调）。
 * 安全防御：提取不到有效的 session cwd 时一律返回空字符串（杜绝 process.cwd 宿主污染）。
 */
export function codegraphPromptText(context?: unknown): string {
  const ctx = context as { agent?: { session?: { header?: { cwd?: string } } } } | undefined;
  const cwd = ctx?.agent?.session?.header?.cwd;
  if (!cwd || !shouldInject(cwd)) return "";
  return CODEGRAPH_SYSTEM_PROMPT;
}

/** 注册系统提示词段落（order 170，在 mcp-manager order 160 之后）。返回 disposer。 */
export function registerCodegraphPrompt(ctx: Context): () => void {
  const systemPrompt = (ctx as unknown as { systemPrompt?: { section: (opts: Record<string, unknown>) => () => void } }).systemPrompt;
  if (!systemPrompt || typeof systemPrompt.section !== "function") return () => {};
  return systemPrompt.section({
    name: "plugin:dsh-codegraph",
    order: 170,
    text: codegraphPromptText,
  });
}

/** @deprecated Kept for backwards compatibility. */
export const registerDisciplineHook = registerCodegraphPrompt;
