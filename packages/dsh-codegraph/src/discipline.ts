/**
 * agent 纪律钩子——按会话 cwd 条件注入 worktree 开发纪律（#359 迁移）。
 *
 * 载体：agent/created（dsh-agent 无「子 agent 启动」专用事件，评审④核实；
 * 仓库先例 dsh-subagent-model-inherit 用 agent/created + inject:["agents"]）。
 * 注入方式：**systemPrompt.section（官方有序提示段）**，不再用 agent/pre-step
 * 拼 user 消息——system prompt 段每次请求都在（不随消息轮次丢失）、注册天然
 * 唯一（无重复注入）、order 精确控制位置、随 agent scope 自动清理。
 *
 * 顺序（#359）：mcp-manager 能力目录段 order=160（plugin:dsh-mcp-manager），
 * 本纪律段 order=161 恒在其后——先看到"有哪些 MCP 服务器"，再看"codegraph
 * 怎么用"。agent scope 注册沿 scope 链向下继承，子 agent 自动继承纪律。
 *
 * 判定：agent.session.header.cwd（dsh-session 类型，mcp-manager 中间层已实证
 * 可得）→ 沿 cwd 找 .git 标记（findGitRoot）：
 * - 是 git 仓（主 checkout / worktree）→ 注册纪律段（~200 tokens/次，非每 step）；
 * - 非 git 仓（日常维护/讨论空间）→ 不注册（静默跳过，agent 正常讨论无噪声）。
 * 多工作空间天然区分：每个会话独立判定，互不影响。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import { findGitRoot } from "./guard.ts";

/** 纪律段 order：mcp-manager 目录段（160）之后，工具带（100-199）内靠后。 */
export const DISCIPLINE_SECTION_ORDER = 161;

/** 纪律段唯一名（systemPrompt.section name 唯一，重复注册抛错）。 */
export const DISCIPLINE_SECTION_NAME = "plugin:dsh-codegraph";

/** 注入给 agent 的 worktree 开发纪律文案（~200 tokens，保持精简）。
 * 只保留目录注入覆盖不到的**差异化纪律**（#359 去重）：
 * - codegraph 工具全部经 mcp-manager 统一管理（project 模式 mcp__ 前缀 /
 *   all 模式 ws_mcp_call 裸名），本插件不直接注册工具，提供封装（先 sync +
 *   worktree 纪律）；
 * - 自动 sync 语义（worktree 索引新鲜度）；
 * - 无索引时返回引导（init 由 agent/用户决策）；
 * - 工具级禁用经 mcp-manager 对封装工具生效（#362 机制）。
 * "codegraph 可用"等能力声明由 mcp-manager 能力目录（<available_mcp_servers>）
 * 承担，不在此重复。 */
export const DISCIPLINE_TEXT = [
  "【codegraph 开发纪律】结构类查询（X 被谁调用/依赖关系/符号位置）优先用",
  "`codegraph_explore`——它会自动补全 projectPath 为当前会话 worktree 并先 sync",
  "再查，返回的源码视为已读，不必再 grep 复核；",
  "- 专属工具：改代码前看影响面用 `codegraph_impact`；单符号源码/调用 trail 用",
  "  `codegraph_node`；「谁调用 X」用 `codegraph_callers`、「X 调用了谁」用",
  "  `codegraph_callees`；不知道精确符号名用 `codegraph_search`；找文件路径/项目",
  "  结构用 `codegraph_files`；确认索引状态用 `codegraph_status`（同样自动 sync +",
  "  projectPath 补全）；",
  "- worktree 内新建/改动文件需 sync 后才进索引——查询结果以工具自动 sync 为准；",
  "- 正在编辑的文件一律 Read 原文，不依赖图谱；",
  "- 没有 .codegraph 索引的目录会返回引导（codegraph init <path>），索引与否是用户决定；",
  "- codegraph 工具全部经 mcp-manager 统一管理（project 模式 mcp__ 前缀、all 模式",
  "  ws_mcp_call 裸名）；本插件不直接注册工具，仅提供封装（先 sync + worktree 纪律），",
  "  工具级禁用经 mcp-manager 对封装工具生效。",
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
    // 非 git 仓 → 不注册（零注入；agent scope 沿链继承也不会带出纪律）。
    if (!shouldInject(cwd)) return;
    // git 仓 → 在 agent 自己的 scope 注册纪律段（order 161，恒在 MCP 目录段
    // 160 之后；随 agent scope 自动清理，子 agent 沿 scope 链继承）。
    (agent.ctx as unknown as { systemPrompt?: { section(opts: Record<string, unknown>): () => void } }).systemPrompt?.section({
      name: DISCIPLINE_SECTION_NAME,
      order: DISCIPLINE_SECTION_ORDER,
      text: DISCIPLINE_TEXT,
    });
  });
  return disposer;
}
