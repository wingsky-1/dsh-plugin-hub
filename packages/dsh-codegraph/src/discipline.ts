/**
 * agent 纪律钩子——按会话 cwd 条件注入 worktree 开发纪律。
 *
 * 载体：agent/created（dsh-agent 无「子 agent 启动」专用事件，评审④核实；
 * 仓库先例 dsh-subagent-model-inherit 用 agent/created + inject:["agents"]）。
 * 判定：agent.session.header.cwd（dsh-session 类型，mcp-manager 中间层已实证
 * 可得）→ 沿 cwd 找 .git 标记（findGitRoot）：
 * - 是 git 仓（主 checkout / worktree）→ 注入纪律（~200 tokens/次，非每 step）；
 * - 非 git 仓（日常维护/讨论空间）→ 不注入（静默跳过，agent 正常讨论无噪声）。
 * 多工作空间天然区分：每个会话独立判定，互不影响。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import { findGitRoot } from "./guard.ts";

/** 注入给 agent 的 worktree 开发纪律文案（~200 tokens，保持精简）。 */
export const DISCIPLINE_TEXT = [
  "【codegraph 开发纪律】本会话工作目录是 git 仓库（主 checkout 或 worktree），",
  "codegraph 代码图谱可用：",
  "- 结构类查询（X 被谁调用/依赖关系/符号位置）优先用 codegraph_explore，",
  "  它会自动先 sync 再查，返回的源码视为已读，不必再 grep 复核；",
  "- worktree 内新建/改动文件需 sync 后才进索引——查询结果以工具自动 sync 为准；",
  "- 正在编辑的文件一律 Read 原文，不依赖图谱；",
  "- 没有 .codegraph 索引的目录会返回引导，索引与否是用户决定。",
].join("\n");

/** 按会话 cwd 判定是否注入纪律（纯函数，便于单测）。 */
export function shouldInject(cwd: string | undefined): boolean {
  return findGitRoot(cwd) !== undefined;
}

/** 注册 agent/created 钩子（按 cwd 条件注入纪律）。返回 disposer。 */
export function registerDisciplineHook(ctx: Context): () => void {
  const disposer = ctx.on("agent/created", ({ agent }) => {
    // 提取会话 cwd（agent.session.header.cwd；防御缺省）。
    const cwd = (agent.session as unknown as { header?: { cwd?: string } })?.header?.cwd;
    if (!shouldInject(cwd)) return;
    // 在子 agent 自己的 scope 注册 pre-step：首轮向 messages 追加纪律文本
    // （~200 tokens/次，非每 step），随 scope 自动清理。
    let injected = false;
    agent.ctx.on("agent/pre-step", async ({ messages }, next) => {
      const decision = await next();
      if (injected) return decision;
      injected = true;
      // 追加一条 user 消息承载纪律（与 mcp-manager 目录注入同构）。
      (messages as unknown as Array<{ role: string; content: string }>).push({
        role: "user",
        content: DISCIPLINE_TEXT,
      });
      return { kind: "enter", messages } as unknown as ReturnType<typeof next>;
    });
  });
  return disposer;
}
