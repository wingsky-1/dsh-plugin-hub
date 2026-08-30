/**
 * dsh-codegraph — codegraph MCP + worktree 开发纪律（宿主端）。
 *
 * 目标（issue #329 阶段2）：把 codegraph（@colbymchenry/codegraph，本地代码
 * 图谱 MCP）与配套 worktree 开发纪律打包成 dsh 插件一键交付：
 * - **探测 + 引导安装**：codegraph CLI 未装 → 注入引导（输出安装命令，不自动
 *   执行；autoInstall=true 时自动装，幂等容错：装前再探测、失败仅 warn）；
 * - **运行时注册**：经 mcp-manager 核心服务（ctx.mcpManager）registerServer 注册
 *   codegraph MCP 服务器（stdio: codegraph serve --mcp，内存态不落盘）；
 * - **纪律工具**（工具层硬纪律，核心价值）：codegraph_explore 封装——查询前
 *   强制 sync + 校验/补全 projectPath（自动补全 + 拒绝兜底），杜绝「worktree
 *   索引静默过期」与「漏传 projectPath 查错对象」；
 * - **agent 钩子**：agent/created + 会话 cwd 判定，git 仓（主 checkout /
 *   worktree）才注入纪律（~200 tokens/次）；非 git 仓（日常维护/讨论空间）
 *   不注入——多工作空间天然区分（按会话 cwd 判定，由 discipline/guard 承担，
 *   不在 apply 阶段读取 ctx.session——apply 无会话概念）。
 *
 * 安全模型（详见 README「安全模型」一节）：不自动执行第三方安装命令（默认）、
 * stdio 子进程继承宿主权限、索引为本地 SQLite 无加密、工具在真实服务器上执行。
 *
 * 依赖：dsh-mcp-manager（提供 ctx.mcpManager service）。经 inject 声明强依赖——
 * mcp-manager 未启用时 cordis 内核自动停用本插件，启用后自动激活（无需手动
 * ctx.get 探测；MCP 注册/管理/使用本来就是 mcp-manager 的能力，本插件基于它接入）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
// 类型面：mcpManager service 类型从 mcp-manager 包引（该包 re-export
// shared/mcp-manager-service.d.ts，类型单一事实源仍在 shared/，消费入口走包）。
import type { McpManagerService } from "@wingsky-1/dsh-mcp-manager";
import { installGuidance, isCodegraphInstalled, runInstall } from "./install.ts";
import { registerDisciplineHook } from "./discipline.ts";
import { buildGuardToolDefinition } from "./tool-definition.ts";

/** Stable cordis plugin name. */
export const name = "codegraph";

/** 需要的宿主服务：agents（agent/created 事件）、mcpManager（MCP 注册/管理/使用）、
 *  tools（纪律工具注册）。均经 inject 强依赖声明——缺失时 cordis 内核自动停用本插件。 */
export const inject = ["agents", "mcpManager", "tools"];

// 内部模块 re-export（公共测试面 + 其他插件可复用纯函数）。
export { isCodegraphInstalled, installGuidance, runInstall } from "./install.ts";
export { findGitRoot, isGitRepo, syncCodegraph, exploreCodegraph, guardedExplore } from "./guard.ts";
export { shouldInject, DISCIPLINE_TEXT, registerDisciplineHook } from "./discipline.ts";
export { buildGuardToolDefinition } from "./tool-definition.ts";

/** 插件配置。 */
export interface CodegraphConfig {
  /** 总开关。 */
  enabled?: boolean;
  /** 未装 codegraph CLI 时自动安装（默认 false：仅引导，不自动执行第三方命令）。 */
  autoInstall?: boolean;
  /** 自定义安装命令（默认 npm install -g @colbymchenry/codegraph）。 */
  installCommand?: string;
  /** 注入纪律到 agent（默认 true）。 */
  injectDiscipline?: boolean;
}

const DEFAULT_INSTALL_COMMAND = "npm install -g @colbymchenry/codegraph";

/**
 * 注册纪律工具（ctx.tools，inject 保证在场）。返回 disposer。
 *
 * 注册定义以官方 ToolDefinition 类型约束（不再用 unknown 断言）——
 * 参数 schema 字段名是 `parameters`（ToolSchema 契约），此前误用 MCP 风格的
 * `inputSchema` 导致 schema 投影抛 "parameters must be lossless JSON"（#356）。
 */
function registerGuardTool(ctx: Context): () => void {
  const tools = (ctx as unknown as { tools: { register(d: ToolDefinition): () => void } }).tools;
  return tools.register(buildGuardToolDefinition());
}

/**
 * 挂载入口：探测/安装 → 注册 MCP 服务器 → 纪律工具 → agent 钩子。
 */
export async function apply(ctx: Context, config: CodegraphConfig = {}): Promise<void> {
  const enabled = config.enabled !== false;
  const autoInstall = config.autoInstall === true;
  const installCommand = config.installCommand ?? DEFAULT_INSTALL_COMMAND;
  const injectDiscipline = config.injectDiscipline !== false;

  if (!enabled) return;

  // 注：不做 apply 阶段会话判定——apply（插件加载时）无「当前会话」概念，且
  // ctx.session 需 inject 才能访问（cordis Proxy）。「非 git 仓不注入纪律」由
  // discipline（agent 会话 cwd 判 git）与 guard（工具执行时按 exec 会话 cwd
  // 补全 projectPath，非 git 拒绝）在会话级无条件承担，无需配置开关。

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

  // 2. 注册 MCP 服务器（经 mcp-manager 核心服务，inject 强依赖保证可用）。
  //    用完整 service 面：注册后可经 getStatus/getTools 感知连接状态与工具列表。
  const mcpManager = (ctx as unknown as { mcpManager: McpManagerService }).mcpManager;
  if (isCodegraphInstalled()) {
    try {
      const { existing } = await mcpManager.registerServer({
        name: "codegraph",
        transport: "stdio",
        command: "codegraph",
        args: ["serve", "--mcp"],
        toolCallTimeoutMs: 60000,
        reconnect: {},
      });
      if (!existing) {
        // 注册即连接：查询状态确认连接进度（connecting/connected 皆正常，failed 需提示）。
        const status = mcpManager.getStatus("codegraph");
        if (status !== undefined && status.status === "failed") {
          ctx.logger.warn(`dsh-codegraph: codegraph MCP 服务器连接失败：${status.error ?? "未知原因"}`);
        }
      }
    } catch (error) {
      ctx.logger.warn(`dsh-codegraph: 注册 codegraph MCP 服务器失败：${String(error)}`);
    }
  }

  // 3. 纪律工具（工具层硬纪律：强制 sync + projectPath——纪律行为固化为默认，
  //    不提供关闭开关，保证「查询前 sync + projectPath 校验」不被配置绕过）。
  const disposeTool = registerGuardTool(ctx);

  // 4. agent 纪律钩子（git 仓会话才注入）。
  const disposeHook = injectDiscipline ? registerDisciplineHook(ctx) : () => {};

  // 卸载清理（effect disposer）。
  ctx.effect(() => {
    return () => {
      disposeTool();
      disposeHook();
      // 卸载时注销 MCP 服务器（不影响 store 持久化条目；inject 保证 mcpManager 在场）。
      void mcpManager.unregisterServer("codegraph").catch(() => {});
    };
  });
}
