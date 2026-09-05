/**
 * dsh-mem0 — 宿主端装配层入口。
 *
 * 核心能力：
 * 1. 启动并维持本地 stdio Python 记忆服务运行时；
 * 2. 经 ctx.mcpManager.registerServer 注册 mem0 及其 4 个封装工具；
 * 3. 注册会话级单次提示词钩子（<=50 tokens）；
 * 4. 注册 /api/dsh-mem0/* loopback 保护路由；
 * 5. 生命周期严格随 Cordis 容器释放，零孤儿进程。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { McpManagerService } from "../../../shared/mcp-manager-service.d.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioMemoryExecutor } from "./executor.ts";
import { registerMemoryPromptHook } from "./prompt.ts";
import { createMem0Routes } from "./routes.ts";
import { buildAllMemoryTools } from "./tool-definitions.ts";

export const name = "mem0";

// 内部模块 re-export（供公共测试面 + 其他插件消费）
export {
  GLOBAL_NAMESPACE,
  normalizeGitRemote,
  resolveGitCanonicalNamespace,
  resetNamespaceCache,
} from "./namespace.ts";
export {
  UNAVAILABLE_MSG,
  buildAllMemoryTools,
  buildMemorySearchTool,
  buildMemoryAddTool,
  buildMemoryListTool,
  buildMemoryDeleteTool,
} from "./tool-definitions.ts";
export {
  MEMORY_DISCIPLINE_TEXT,
  isMemoryDisciplineInjected,
  registerMemoryPromptHook,
} from "./prompt.ts";
export { createMem0Routes } from "./routes.ts";
export { StdioMemoryExecutor } from "./executor.ts";

/**
 * 强依赖宿主服务：
 * - mcpManager: MCP 统一管理、状态与工具注册
 * - webServer: 注册 Web 路由
 */
export const inject = ["mcpManager", "webServer"];

const __dirname = dirname(fileURLToPath(import.meta.url));

export function apply(ctx: Context): void {
  const scriptPath = resolve(__dirname, "../server/mem0_server.py");
  const executor = new StdioMemoryExecutor({ scriptPath });

  // 记录当前活跃的 cwd（用于非会话态路由查询兜底）
  let latestCwd: string | undefined = process.cwd();

  ctx.on("agent/pre-step", async ({ agent }, next) => {
    const cwd = (agent?.session as unknown as { header?: { cwd?: string } })?.header?.cwd;
    if (typeof cwd === "string" && cwd) {
      latestCwd = cwd;
    }
    return next();
  });

  // 1. 构建封装工具定义
  const tools = buildAllMemoryTools(executor);

  // 2. 经 mcpManager 注册 MCP 服务器（带有封装工具）
  const mcpManager = ctx.get("mcpManager") as McpManagerService | undefined;
  if (mcpManager && typeof mcpManager.registerServer === "function") {
    mcpManager.registerServer({
      name: "mem0",
      transport: "stdio",
      command: "python3",
      args: [scriptPath],
      toolDefinitions: tools,
      description: "Persistent long-term memory system for DSH agents.",
    }).catch((err: unknown) => {
      ctx.logger?.warn?.(`[dsh-mem0] mcpManager 注册失败: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // 3. 注册 HTTP 路由（/api/dsh-mem0/*）
  const webServer = ctx.get("webServer") as { register: (routes: WebRoute | WebRoute[]) => void } | undefined;
  if (webServer && typeof webServer.register === "function") {
    const routes = createMem0Routes({
      executor,
      getCurrentCwd: () => latestCwd,
    });
    webServer.register(routes);
  }

  // 4. 注册提示词纪律钩子
  const unregisterPrompt = registerMemoryPromptHook(ctx);

  // 5. 异步尝试拉起 stdio 运行时
  executor.start().catch((err: unknown) => {
    ctx.logger?.warn?.(`[dsh-mem0] stdio 运行时拉起异常: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 6. 生命周期注销：kill 子进程
  ctx.effect(() => {
    return () => {
      unregisterPrompt();
      executor.stop();
    };
  }, "dsh-mem0: dispose");
}
