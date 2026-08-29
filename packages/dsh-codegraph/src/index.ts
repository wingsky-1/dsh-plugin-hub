/**
 * dsh-codegraph — codegraph MCP + worktree 开发纪律（宿主端）。
 *
 * 目标（issue #329 阶段2）：把 codegraph（@colbymchenry/codegraph，本地代码
 * 图谱 MCP）与配套 worktree 开发纪律打包成 dsh 插件一键交付：
 * - **探测 + 引导安装**：codegraph CLI 未装 → 注入引导（输出安装命令，不自动
 *   执行；autoInstall=true 时自动装，幂等容错：装前再探测、失败仅 warn）；
 * - **运行时注册**：经 mcp-manager 核心服务（ctx.mcpManager，阶段1 新增）
 *   registerServer 注册 codegraph MCP 服务器（stdio: codegraph serve --mcp，
 *   内存态不落盘）；mcp-manager 未启用时回退自带 stdio 客户端（复用
 *   shared/ 的 transport/protocol）或纯提示；
 * - **纪律工具**（工具层硬纪律，核心价值）：codegraph_explore 封装——查询前
 *   强制 sync + 校验/补全 projectPath（自动补全 + 拒绝兜底），杜绝「worktree
 *   索引静默过期」与「漏传 projectPath 查错对象」；
 * - **agent 钩子**：agent/created + 会话 cwd 判定，git 仓（主 checkout /
 *   worktree）才注入纪律（~200 tokens/次）；非 git 仓（日常维护/讨论空间）
 *   不注入——多工作空间天然区分；
 * - **requireGit**：非 git 仓不启用（默认），可配置覆盖。
 *
 * 安全模型（详见 README「安全模型」一节）：不自动执行第三方安装命令（默认）、
 * stdio 子进程继承宿主权限、索引为本地 SQLite 无加密、工具在真实服务器上执行。
 *
 * 依赖：dsh-mcp-manager（提供 ctx.mcpManager service；未启用时降级）。
 */
import type { Context } from "@deepseek-ai/cordis";
// 类型面：mcpManager service 类型（来自 dsh-mcp-manager 的 service.ts 声明合并）。
import type { McpManagerService } from "@wingsky-1/dsh-mcp-manager";
import { installGuidance, isCodegraphInstalled, runInstall } from "./install.ts";
import { findGitRoot, guardedExplore } from "./guard.ts";
import { registerDisciplineHook } from "./discipline.ts";

/** Stable cordis plugin name. */
export const name = "codegraph";

/** 需要的宿主服务：agents（agent/created 事件）；mcpManager 经 ctx.get 探测（非 inject）。 */
export const inject = ["agents"];

// 内部模块 re-export（公共测试面 + 其他插件可复用纯函数）。
export { isCodegraphInstalled, installGuidance, runInstall } from "./install.ts";
export { findGitRoot, isGitRepo, syncCodegraph, exploreCodegraph, guardedExplore } from "./guard.ts";
export { shouldInject, DISCIPLINE_TEXT, registerDisciplineHook } from "./discipline.ts";

/** 插件配置。 */
export interface CodegraphConfig {
  /** 总开关。 */
  enabled?: boolean;
  /** 未装 codegraph CLI 时自动安装（默认 false：仅引导，不自动执行第三方命令）。 */
  autoInstall?: boolean;
  /** 自定义安装命令（默认 npm install -g @colbymchenry/codegraph）。 */
  installCommand?: string;
  /** 查询前强制 sync（默认 true）。 */
  syncBeforeQuery?: boolean;
  /** 不传 projectPath 时拒绝调用（默认 true：自动补全 + 拒绝兜底）。 */
  requireProjectPath?: boolean;
  /** 非 git 仓不启用（默认 true）。 */
  requireGit?: boolean;
  /** 注入纪律到 agent（默认 true）。 */
  injectDiscipline?: boolean;
}

const DEFAULT_INSTALL_COMMAND = "npm install -g @colbymchenry/codegraph";

/** 注册纪律工具（ctx.tools）。返回 disposer。 */
function registerGuardTool(
  ctx: Context,
  cfg: Required<Pick<CodegraphConfig, "syncBeforeQuery" | "requireProjectPath">>,
): () => void {
  // ctx.tools 为官方 dsh-tools 服务；此处仅在其存在时注册（防御降级）。
  const tools = (ctx as unknown as { tools?: { register(d: unknown): () => void } }).tools;
  if (tools === undefined || typeof tools.register !== "function") return () => {};
  return tools.register({
    name: "codegraph_explore",
    description:
      "查询 codegraph 代码图谱（本地索引，返回相关符号源码 + 调用路径）。" +
      "自动先 sync 目标 worktree 索引再查（新鲜度硬保证）；projectPath 缺省补全为当前" +
      "会话 worktree；无索引/无法确定 projectPath 时拒绝并提示。结构类代码问题优先用它。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "代码问题/符号名（如：X 被谁调用）" },
        projectPath: { type: "string", description: "目标 worktree 路径（缺省补全为当前会话 worktree）" },
      },
      required: ["query"],
    },
    output: { type: "text" },
    execute: async (args: { query: string; projectPath?: string }, exec: { agent?: { session?: { header?: { cwd?: string } } } }) => {
      const cwd = exec?.agent?.session?.header?.cwd;
      return { content: [{ type: "text", text: await guardedExplore(args, cwd) }] };
    },
  });
}

/**
 * 挂载入口：探测/安装 → 注册 MCP 服务器 → 纪律工具 → agent 钩子。
 */
export async function apply(ctx: Context, config: CodegraphConfig = {}): Promise<void> {
  const enabled = config.enabled !== false;
  const autoInstall = config.autoInstall === true;
  const installCommand = config.installCommand ?? DEFAULT_INSTALL_COMMAND;
  const syncBeforeQuery = config.syncBeforeQuery !== false;
  const requireProjectPath = config.requireProjectPath !== false;
  const requireGit = config.requireGit !== false;
  const injectDiscipline = config.injectDiscipline !== false;

  if (!enabled) return;

  // 0. requireGit：当前会话 cwd 非 git 仓 → 不启用（静默跳过）。
  const sessionCwd = (ctx as unknown as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd;
  if (requireGit && findGitRoot(sessionCwd) === undefined) return;

  // 1. 探测 codegraph CLI；未装 → autoInstall 或引导。
  if (!isCodegraphInstalled()) {
    if (autoInstall) {
      // 装前再探测一次（用户可能已手动装，避免重复安装）。
      if (!isCodegraphInstalled()) {
        const ok = await runInstall(installCommand);
        if (!ok) {
          ctx.logger.warn(`dsh-codegraph: 自动安装失败（${installCommand}），请手动安装`);
        }
      }
    }
    // 仍未装 → 注入引导（不阻断其他功能，但 MCP 服务器无法注册）。
    if (!isCodegraphInstalled()) {
      ctx.logger.info(`dsh-codegraph: ${installGuidance(installCommand)}`);
    }
  }

  // 2. 注册 MCP 服务器（经 mcp-manager 核心服务；未启用时纯提示降级）。
  const mcpManager = (ctx as unknown as { get(name: string): McpManagerService | undefined }).get("mcpManager");
  if (mcpManager !== undefined && isCodegraphInstalled()) {
    try {
      await mcpManager.registerServer({
        name: "codegraph",
        transport: "stdio",
        command: "codegraph",
        args: ["serve", "--mcp"],
        toolCallTimeoutMs: 60000,
        reconnect: {},
      });
    } catch (error) {
      ctx.logger.warn(`dsh-codegraph: 注册 codegraph MCP 服务器失败：${String(error)}`);
    }
  } else if (isCodegraphInstalled()) {
    ctx.logger.info("dsh-codegraph: dsh-mcp-manager 未启用，跳过 MCP 服务器注册（纪律工具仍可用）");
  }

  // 3. 纪律工具（工具层硬纪律：强制 sync + projectPath）。
  const disposeTool = registerGuardTool(ctx, { syncBeforeQuery, requireProjectPath });

  // 4. agent 纪律钩子（git 仓会话才注入）。
  const disposeHook = injectDiscipline ? registerDisciplineHook(ctx) : () => {};

  // 卸载清理（effect disposer）。
  ctx.effect(() => {
    return () => {
      disposeTool();
      disposeHook();
      // 卸载时注销 MCP 服务器（不影响 store 持久化条目）。
      if (mcpManager !== undefined) {
        void mcpManager.unregisterServer("codegraph").catch(() => {});
      }
    };
  });
}
