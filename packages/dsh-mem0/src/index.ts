/**
 * dsh-mem0 — 宿主端装配层入口。
 *
 * 核心能力：
 * 1. 启动并维持本地 stdio Python 记忆服务运行时（支持动态配置热重载）；
 * 2. 经 ctx.mcpManager.registerServer 注册 mem0 及其 4 个封装工具；
 * 3. 注册会话级单次提示词钩子（<=50 tokens）；
 * 4. 接入 DSH 官方 settings 存储体系（~/.dsh/settings.yaml）；
 * 5. 注册 /api/dsh-mem0/* loopback 保护路由；
 * 6. 生命周期严格随 Cordis 容器释放，零孤儿进程。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { McpManagerService } from "../../../shared/mcp-manager-service.d.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CONFIG,
  mergeConfigPatch,
  SETTINGS_NS,
  type Mem0Config,
} from "./config.ts";
import { StdioMemoryExecutor } from "./executor.ts";
import { registerMemoryPromptHook } from "./prompt.ts";
import { createMem0Routes } from "./routes.ts";
import { installMem0Settings, type OwnerScopeLike } from "./settings.ts";
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
export {
  Config,
  DEFAULT_CONFIG,
  SETTINGS_NS,
  maskApiKey,
  isMaskedKey,
  sanitizeConfigForClient,
  mergeConfigPatch,
} from "./config.ts";
export type { Mem0Config } from "./config.ts";

/**
 * 强依赖宿主服务：
 * - mcpManager: MCP 统一管理、状态与工具注册
 * - webServer: 注册 Web 路由
 */
export const inject = ["mcpManager", "webServer"];

const __dirname = dirname(fileURLToPath(import.meta.url));

export function apply(ctx: Context, initialConfig?: Partial<Mem0Config>): void {
  const scriptPath = resolve(__dirname, "../server/mem0_server.py");

  let currentConfig: Mem0Config = {
    ...DEFAULT_CONFIG,
    ...(initialConfig ?? {}),
  };

  const executor = new StdioMemoryExecutor({
    scriptPath,
    pythonBin: currentConfig.pythonBin,
  });

  let ownerScope: OwnerScopeLike | undefined;
  let uiConfigSource: (() => Mem0Config) | undefined;

  const buildEnvOverrides = (cfg: Mem0Config): Record<string, string> => ({
    MEM0_CONFIG_JSON: JSON.stringify(cfg),
    LLM_API_KEY: cfg.llmApiKey || "",
    LLM_BASE_URL: cfg.llmBaseUrl || "",
    LLM_MODEL: cfg.llmModel || "",
    LLM_PROVIDER: cfg.llmProvider || "openai",
    EMBEDDER_API_KEY: cfg.embedderApiKey || "",
    EMBEDDER_BASE_URL: cfg.embedderBaseUrl || "",
    EMBEDDER_MODEL: cfg.embedderModel || "",
    EMBEDDER_PROVIDER: cfg.embedderProvider || "openai",
    MEM0_CUSTOM_INSTRUCTIONS: cfg.customInstructions || "",
  });

  // 注册官方 settings 命名空间
  installMem0Settings(ctx, currentConfig, {
    setSource: (source) => {
      uiConfigSource = source;
      try {
        const persisted = source();
        if (persisted && typeof persisted === "object") {
          currentConfig = mergeConfigPatch(currentConfig, persisted as unknown as Record<string, unknown>);
        }
      } catch {
        // ignore
      }
    },
    onChange: () => {
      if (uiConfigSource) {
        try {
          const next = uiConfigSource();
          if (next && typeof next === "object") {
            currentConfig = mergeConfigPatch(currentConfig, next as unknown as Record<string, unknown>);
            executor.setPythonBin(currentConfig.pythonBin);
            executor.restart(buildEnvOverrides(currentConfig)).catch((err) => {
              ctx.logger?.warn?.(`[dsh-mem0] settings onChange 重启失败: ${String(err)}`);
            });
          }
        } catch {
          // ignore
        }
      }
    },
    onScope: (scope) => {
      ownerScope = scope;
    },
  });

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
      command: currentConfig.pythonBin,
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
      getConfig: () => currentConfig,
      updateConfig: async (patch: Record<string, unknown>) => {
        const next = mergeConfigPatch(currentConfig, patch);
        currentConfig = next;
        if (ownerScope && typeof ownerScope.update === "function") {
          await ownerScope.update(next).catch((e: unknown) => {
            ctx.logger?.warn?.(`[dsh-mem0] settings.update 落盘失败: ${String(e)}`);
          });
        }
        executor.setPythonBin(next.pythonBin);
        await executor.restart(buildEnvOverrides(next));
        return next;
      },
    });
    webServer.register(routes);
  }

  // 4. 注册提示词纪律钩子
  const unregisterPrompt = registerMemoryPromptHook(ctx);

  // 5. 异步尝试拉起 stdio 运行时
  executor.start(buildEnvOverrides(currentConfig)).catch((err: unknown) => {
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
