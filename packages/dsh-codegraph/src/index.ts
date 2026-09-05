/**
 * dsh-codegraph — codegraph MCP + worktree 开发纪律（宿主端）。
 *
 * 目标（issue #329 阶段2 + #363 补充 3 架构收敛）：把 codegraph
 * （@colbymchenry/codegraph，本地代码图谱 MCP）与配套 worktree 开发纪律打包成
 * dsh 插件一键交付：
 * - **探测 + 引导安装**：codegraph CLI 未装 → 注入引导（输出安装命令，不自动
 *   执行；autoInstall=true 时自动装，幂等容错：装前再探测、失败仅 warn）；
 * - **运行时注册**：经 mcp-manager 核心服务（ctx.mcpManager）registerServer 注册
 *   codegraph MCP 服务器（stdio: codegraph serve --mcp，内存态不落盘）；
 * - **封装定义经 mcp-manager 注册（#363 补充 3）**：8 个封装工具
 *   （codegraph_explore / impact / node / callers / callees / search / files /
 *   status）经 registerServer 的 `toolDefinitions` 通道交给 manager 注册
 *   （#362 补充 4），**本插件不再 ctx.tools.register 任何裸名工具**。每个封装
 *   execute 先 `codegraph sync <path>`（TTL 30s 缓存）再内部转发底层真实
 *   codegraph CLI（guardedCodegraph 管线），底层实现完全内部化；
 * - **agent 钩子**：agent/pre-step + 会话 cwd 判定，git 仓（主 checkout /
 *   worktree）才注入纪律（~200 tokens/次，根 ctx 注册保证在 mcp 目录注入之后）；
 *   非 git 仓（日常维护/讨论空间）不注入——多工作空间天然区分（按会话 cwd 判定，
 *   由 discipline/guard 承担，不在 apply 阶段读取 ctx.session——apply 无会话概念）。
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
import type { McpManagerServerInput, McpManagerService } from "@wingsky-1/dsh-mcp-manager";
import { installGuidance, isCodegraphInstalled, runInstall } from "./install.ts";
import {
  CODEGRAPH_SYSTEM_PROMPT,
  DISCIPLINE_TEXT,
  codegraphPromptText,
  registerCodegraphPrompt,
  registerDisciplineHook,
  shouldInject,
} from "./discipline.ts";
import {
  buildCalleesToolDefinition,
  buildCallersToolDefinition,
  buildExploreToolDefinition,
  buildFilesToolDefinition,
  buildImpactToolDefinition,
  buildNodeToolDefinition,
  buildSearchToolDefinition,
  buildStatusToolDefinition,
} from "./tool-definition.ts";

/** Stable cordis plugin name. */
export const name = "codegraph";

/** 需要的宿主服务：mcpManager（MCP 注册/管理/使用；封装定义经其注册）、systemPrompt（系统提示词段落注入）。
 *  均经 inject 强依赖声明——缺失时 cordis 内核自动停用本插件。
 *  注：提示词注入为 ctx.systemPrompt.section（order: 170，在 mcp-manager 之后）；
 *  工具经 mcp-manager 注册（#363 补充 3），不再依赖 tools。 */
export const inject = ["mcpManager", "systemPrompt"];

// 内部模块 re-export（公共测试面 + 其他插件可复用纯函数）。
export { isCodegraphInstalled, installGuidance, runInstall } from "./install.ts";
export {
  findGitRoot,
  isGitRepo,
  syncCodegraph,
  syncCodegraphCached,
  runCodegraph,
  guardedCodegraph,
  guardedExplore,
  isNoResultOutput,
  findAmbiguousCandidates,
  resetSyncCache,
  SYNC_TTL_MS,
  exploreCodegraph,
} from "./guard.ts";
export {
  shouldInject,
  CODEGRAPH_SYSTEM_PROMPT,
  DISCIPLINE_TEXT,
  codegraphPromptText,
  registerCodegraphPrompt,
  registerDisciplineHook,
} from "./discipline.ts";
export {
  buildExploreToolDefinition,
  buildImpactToolDefinition,
  buildNodeToolDefinition,
  buildCallersToolDefinition,
  buildCalleesToolDefinition,
  buildSearchToolDefinition,
  buildFilesToolDefinition,
  buildStatusToolDefinition,
} from "./tool-definition.ts";
// 兼容旧名（#329/#356 公共导出面，避免破坏既有消费方）。
export { buildExploreToolDefinition as buildGuardToolDefinition } from "./tool-definition.ts";

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

/** 8 个 codegraph 封装工具定义（经 mcp-manager 的 registerServer.toolDefinitions
 *  通道注册，#363 补充 3）。execute 均先 sync 再内部转发底层 CLI。 */
export function buildCodegraphToolDefinitions(): ToolDefinition[] {
  return [
    buildExploreToolDefinition(),
    buildImpactToolDefinition(),
    buildNodeToolDefinition(),
    buildCallersToolDefinition(),
    buildCalleesToolDefinition(),
    buildSearchToolDefinition(),
    buildFilesToolDefinition(),
    buildStatusToolDefinition(),
  ];
}

/**
 * 挂载入口：探测/安装 → 经 mcp-manager 注册 MCP 服务器（携带封装定义）→ agent 钩子。
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

  // 2. 经 mcp-manager 注册 MCP 服务器（inject 强依赖保证可用）+ 封装定义
  //    （#363 补充 3：工具经 registerServer.toolDefinitions 交给 manager 注册，
  //    本插件不再 ctx.tools.register）。toolDefinitions? 可选字段来自官方
  //    McpManagerServerInput（#364 合入 main，shared/mcp-manager-service.d.ts
  //    单一事实源；#363 补充 3 的临时 RegisterServerInput 已删除）。
  //    用完整 service 面：注册后可经 getStatus/getTools 感知连接状态与工具列表。
  const mcpManager = (ctx as unknown as { mcpManager: McpManagerService }).mcpManager;
  const toolDefinitions = buildCodegraphToolDefinitions();
  if (isCodegraphInstalled()) {
    try {
      // #363 补充 3：封装定义经 mcp-manager 注册（manager 侧 #362 补充 4 消费）。
      const registerInput: McpManagerServerInput = {
        name: "codegraph",
        description:
          "Local code graph: ALWAYS prioritize for code search, symbol definitions, caller/callee relationships, and impact analysis. Call encapsulated bare tools directly (e.g. codegraph_search, codegraph_explore); DO NOT use mcp__ prefixes. Auto-syncs worktree index.",
        transport: "stdio",
        command: "codegraph",
        args: ["serve", "--mcp"],
        toolCallTimeoutMs: 60000,
        reconnect: {},
        toolDefinitions,
      };
      const { existing } = await mcpManager.registerServer(registerInput);
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

  // 3. agent 系统提示词钩子（order: 170，在 mcp-manager 之后，git 仓会话才注入）。
  const disposePrompt = injectDiscipline ? registerCodegraphPrompt(ctx) : () => {};

  // 卸载清理（effect disposer）。
  ctx.effect(() => {
    return () => {
      disposePrompt();
      // 卸载时注销 MCP 服务器（不影响 store 持久化条目；inject 保证 mcpManager 在场）。
      void mcpManager.unregisterServer("codegraph").catch(() => {});
    };
  });
}
