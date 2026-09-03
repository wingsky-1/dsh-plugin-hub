/**
 * agent 纪律钩子——按会话 cwd 条件注入 worktree 开发纪律（#359 三轮，B2）。
 *
 * 注入方式：**agent/pre-step user 消息注入**（与 dsh-tool-skill / dsh-time-context
 * 官方插件同款载体，出现在 GUI「上下文注入」面板）。
 *
 * 幂等（官方模式）：查**会话历史** `agent.session.snapshotEvents()` 是否已注入过本插件的
 * 纪律消息（source.kind=plugin && source.plugin=codegraph）——与 dsh-time-context
 * 的 `latestInjectionTime(agent)` 同款（pre-step 的 messages 不含历史注入，
 * 不能靠查 messages 判重）。compaction/resume 后历史被压缩 → 重新注入（幂等自愈）。
 *
 * 内容正交（B2：#360 曾与 mcp 能力目录排先后，实测脆弱且耦合——目录讲
 * "有哪些 MCP 服务器"，纪律讲 "codegraph_explore 工具怎么用"，本就不该有
 * 先后依赖）。纪律只保留工具层差异化信息（裸工具名、自动 sync、无索引引导）。
 *
 * 判定：payload.agent.session.header.cwd（dsh-session 类型，mcp-manager 中间层
 * 已实证可得）→ 沿 cwd 找 .git 标记（findGitRoot）：
 * - 是 git 仓（主 checkout / worktree）→ 注入纪律（~200 tokens/次，非每 step）；
 * - 非 git 仓（日常维护/讨论空间）→ 不注入（静默跳过，agent 正常讨论无噪声）。
 * 多工作空间天然区分：每个会话独立判定，互不影响。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-agent";
import { randomUUID } from "node:crypto";
import { findGitRoot } from "./guard.ts";

/** 注入给 agent 的 worktree 开发纪律文案（≤250 tokens，紧凑决策表）。
 * 只保留目录注入覆盖不到的**差异化纪律**（#359 去重 / B2 正交化）：
 * - 场景→首选工具→兜底的决策表（#417 A 项：删实现细节，模型按场景选工具）；
 * - 自动 sync 语义（worktree 索引新鲜度）；
 * - 无索引时返回引导（init 由 agent/用户决策）。
 * "codegraph 可用/注册形态"等能力声明由 mcp-manager 能力目录
 * （<available_mcp_servers>）承担，不在此重复；与目录**无先后依赖**（内容正交）。 */
export const DISCIPLINE_TEXT = [
  "【codegraph 开发纪律】git 仓内结构类查询优先用 codegraph（工具自动 sync",
  "当前 worktree 索引并补全 projectPath）：",
  "- 谁调用 X / 改 X 影响谁 → `codegraph_impact`（或 `codegraph_explore` 综合查）；",
  "- 单符号源码 + 调用/被调 trail、读文件 → `codegraph_node`；",
  "- 「谁调用 X」→ `codegraph_callers`；「X 调用了谁」→ `codegraph_callees`；",
  "- 记不清精确符号名 → `codegraph_search`；找文件路径/项目结构 → `codegraph_files`；",
  "- 查索引状态 → `codegraph_status`；",
  "- 全文搜词才用 grep；正在编辑的文件一律 Read 原文，不依赖图谱；",
  "- 没有 .codegraph 索引的目录会返回引导（codegraph init <path>），索引与否是用户决定。",
].join("\n");

/** 按会话 cwd 判定是否注入纪律（纯函数，便于单测）。 */
export function shouldInject(cwd: string | undefined): boolean {
  return findGitRoot(cwd) !== undefined;
}

/** 构造纪律注入消息（完整 UserMessage 契约：id + content block + source）。
 * source.kind=plugin → 出现在 GUI「上下文注入」面板（与 dsh-tool-skill 同载体）。 */
function disciplineMessage(): UserMessage {
  return {
    id: randomUUID() as UserMessage["id"],
    role: "user",
    content: [{ type: "text", text: DISCIPLINE_TEXT }],
    source: { kind: "plugin", plugin: "codegraph", form: "instructions" },
  };
}

/** 会话历史里是否已注入过纪律消息（官方模式：查 agent.session.snapshotEvents()，
 * 仿 dsh-time-context 的 latestInjectionTime）。compaction 后历史不可见 → false
 * → 重新注入（幂等自愈）。 */
function alreadyInjected(agent: { session?: { snapshotEvents?: () => ReadonlyArray<unknown> } }): boolean {
  const events = agent.session?.snapshotEvents?.();
  if (!Array.isArray(events)) return false;
  return events.some((event) => {
    const e = event as { type?: string; data?: { source?: { kind?: string; plugin?: string } } };
    return e.type === "user/message"
      && e.data?.source?.kind === "plugin"
      && e.data.source.plugin === "codegraph";
  });
}

/** 注册纪律注入（根 ctx pre-step 监听器，按 agent cwd 条件注入）。返回 disposer。 */
export function registerDisciplineHook(ctx: Context): () => void {
  const disposer = ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    signal.throwIfAborted();
    // 尊重 reject 决策（如其他监听器拒绝进入本轮 step），不覆盖为 enter。
    if (decision.kind === "reject") return decision;
    // 按会话 cwd 判定：非 git 仓 → 零注入（静默跳过）。
    const cwd = (agent.session as unknown as { header?: { cwd?: string } })?.header?.cwd;
    if (!shouldInject(cwd)) return decision;
    // 幂等：会话历史已注入过 → 原样放行。
    if (alreadyInjected(agent as unknown as { session?: { snapshotEvents?: () => ReadonlyArray<unknown> } })) return decision;
    // 不可变注入：追加纪律消息（内容与 mcp 能力目录正交，无先后依赖）。
    const nextMessages = Array.isArray(decision.messages)
      ? [...decision.messages, disciplineMessage()]
      : decision.messages;
    return { kind: "enter", messages: nextMessages };
  });
  return disposer;
}
