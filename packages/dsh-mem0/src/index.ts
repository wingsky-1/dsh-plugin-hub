/**
 * dsh-mem0 — 宿主端装配层入口。
 *
 * 核心能力：
 * 1. 启动并维持本地 stdio Python 记忆服务运行时（支持动态配置热重载）；
 * 2. 经 ctx.mcpManager.registerServer 注册 mem0 及其 4 个封装工具；
 * 3. 注册会话级单次提示词钩子（<=50 tokens）；
 * 4. 接入 DSH 官方 settings 存储体系（~/.dsh/settings.yaml）；
 * 5. 注册 /api/dsh-mem0/* loopback 保护路由；
 * 6. #581：会话首轮智能记忆预检索与 `<user_long_term_memories>` 围栏注入；
 * 7. 生命周期严格随 Cordis 容器释放，零孤儿进程。
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
import { registerSmartPreInjectionHook } from "./pre-injection-hook.ts";
import { registerMemoryPromptHook } from "./prompt.ts";
import { createMem0Routes } from "./routes.ts";
import { installMem0Settings, type OwnerScopeLike } from "./settings.ts";
import { buildAllMemoryTools } from "./tool-definitions.ts";
import { autoInstallDependencies, probePythonEnvironment } from "./venv-manager.ts";
import {
  resolveLlmRuntimeConfig,
  listLlmProviders,
  listLlmModels,
} from "./provider-resolver.ts";

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
export {
  parseSearchCandidates,
  filterCandidatesByThreshold,
  redactCandidates,
  buildPreInjectionText,
  PRE_INJECTION_HEADER,
  PRE_INJECTION_DISCIPLINE_TEXT,
} from "./pre-injection.ts";
export {
  registerSmartPreInjectionHook,
  isPreInjectionTriggered,
  PRE_INJECTION_TIMEOUT_MS,
} from "./pre-injection-hook.ts";
export type { PreInjectCandidate, PreInjectOptions } from "./pre-injection.ts";
export { createMem0Routes } from "./routes.ts";
export { parseMemoryListOutput, type MemoryListItem, type MemoryListParseResult } from "./routes.ts";
export { aggregateProviderUsage, type ProviderUsageStat } from "./usage-aggregator.ts";
export { StdioMemoryExecutor } from "./executor.ts";
export {
  Config,
  DEFAULT_CONFIG,
  SETTINGS_NS,
  EMBEDDER_MODELS_INFO,
  LLM_MODELS_INFO,
  maskApiKey,
  isMaskedKey,
  sanitizeConfigForClient,
  mergeConfigPatch,
} from "./config.ts";
export {
  DEFAULT_VENV_DIR,
  VENV_PYTHON,
  isVenvUsable,
  removeBrokenVenv,
  probePythonEnvironment,
  autoInstallDependencies,
} from "./venv-manager.ts";
export {
  resolveLlmRuntimeConfig,
  listLlmProviders,
  listLlmModels,
} from "./provider-resolver.ts";
export type { Mem0Config } from "./config.ts";

/**
 * 强依赖宿主服务：
 * - mcpManager: MCP 统一管理、状态与工具注册
 * - webServer: 注册 Web 路由
 * - llm: 提供商/模型目录与凭据 Seam（#612：缺声明时 cordis 对 ctx.llm 属性访问
 *   会确定性同步抛错 `cannot get property "llm" without inject`，可选链无法防护，
 *   直接导致 buildEnvOverrides 必然 reject、executor 永不启动——服务未就绪根因）
 */
export const inject = ["mcpManager", "webServer", "llm"];

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

  const buildEnvOverrides = async (cfg: Mem0Config): Promise<Record<string, string>> => {
    const llmRuntime = await resolveLlmRuntimeConfig(cfg, ctx);
    return {
      MEM0_CONFIG_JSON: JSON.stringify({
        ...cfg,
        llmApiKey: llmRuntime.llmApiKey,
        llmBaseUrl: llmRuntime.llmBaseUrl,
        llmModel: llmRuntime.llmModel,
        llmProvider: llmRuntime.llmProvider,
        embeddingDims: cfg.embeddingDims || 512,
      }),
      LLM_API_KEY: llmRuntime.llmApiKey || "",
      LLM_BASE_URL: llmRuntime.llmBaseUrl || "",
      LLM_MODEL: llmRuntime.llmModel || "",
      LLM_PROVIDER: llmRuntime.llmProvider || "openai",
      EMBEDDER_API_KEY: cfg.embedderApiKey || "",
      EMBEDDER_BASE_URL: cfg.embedderBaseUrl || "",
      EMBEDDER_MODEL: cfg.embedderModel || "",
      EMBEDDER_PROVIDER: cfg.embedderProvider || "fastembed",
      MEM0_CUSTOM_INSTRUCTIONS: cfg.customInstructions || "",
    };
  };

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
            buildEnvOverrides(currentConfig).then((env) => executor.restart(env)).catch((err) => {
              // #612：重启链失败同样落地到 executor，保持状态可观测
              executor.markEnvBuildFailed?.(err instanceof Error ? err.message : String(err));
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

  // #612：最近一次"能让服务 ready"的环境覆盖配置（用于保存失败自动回滚）
  let lastGoodEnv: Record<string, string> | undefined;
  // #612：/start 幂等互斥哨兵（与 auto retry、onChange restart 互斥，防并发拉起）
  let startInFlight = false;

  const startExecutorOnce = async (): Promise<void> => {
    if (startInFlight) return;
    startInFlight = true;
    try {
      const env = await buildEnvOverrides(currentConfig);
      await executor.start(env);
      if (executor.isReady()) {
        lastGoodEnv = env;
      } else {
        // 启动未成功：调度指数退避自动重试（stop/restart 会自动取消挂起重试）
        executor.scheduleAutoRetry?.();
      }
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      executor.markEnvBuildFailed?.(detail);
      ctx.logger?.warn?.(`[dsh-mem0] stdio 运行时拉起异常: ${detail}`);
      executor.scheduleAutoRetry?.();
    } finally {
      startInFlight = false;
    }
  };

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
  // #592 拆解：配置热切换（含 #612 失败回滚）与依赖自愈装配件提出 effect 子树，
  // 路由装配以具名引用消费（压平 routes effect 的圈复杂度；行为逐位一致）。
  const switchMem0Config = async (previousConfig: Mem0Config, next: Mem0Config): Promise<void> => {
    try {
      const env = await buildEnvOverrides(next);
      await executor.restart(env);
      if (executor.isReady()) {
        lastGoodEnv = env;
        return;
      }
      // #612：新配置起不来 → 用最近一次 good env 自动回滚重启，并回写旧配置
      const rollbackEnv = lastGoodEnv ?? await buildEnvOverrides(previousConfig);
      currentConfig = previousConfig;
      executor.setPythonBin(previousConfig.pythonBin);
      await executor.restart(rollbackEnv).catch(() => {});
      throw new Error(
        `Service failed to start with new config (status: ${executor.getStatus().reason}); rolled back to previous config`,
      );
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      executor.markEnvBuildFailed?.(detail);
      throw err;
    }
  };

  const updateMem0Config = async (patch: Record<string, unknown>): Promise<Mem0Config> => {
    const next = mergeConfigPatch(currentConfig, patch);
    const previousConfig = currentConfig;
    currentConfig = next;
    if (ownerScope && typeof ownerScope.update === "function") {
      await ownerScope.update(next).catch((e: unknown) => {
        ctx.logger?.warn?.(`[dsh-mem0] settings.update 落盘失败: ${String(e)}`);
      });
    }
    executor.setPythonBin(next.pythonBin);
    await switchMem0Config(previousConfig, next);
    return next;
  };

  const installMem0Dependencies = async () => {
    ctx.logger?.info?.("[dsh-mem0] 开始触发后台依赖自动安装/自愈...");
    const res = await autoInstallDependencies(currentConfig.pythonBin, (line) => {
      ctx.logger?.debug?.(`[dsh-mem0 install] ${line}`);
    });
    if (res.ok) {
      executor.setPythonBin(res.pythonBin);
      const env = await buildEnvOverrides(currentConfig);
      await executor.restart(env);
    }
    return res;
  };

  ctx.effect(() => {
    const webServer = ctx.get("webServer") as { register: (route: WebRoute) => () => void } | undefined;
    if (!webServer || typeof webServer.register !== "function") return () => {};
    const routes = createMem0Routes({
      executor,
      getCurrentCwd: () => latestCwd,
      getConfig: () => currentConfig,
      appCtx: ctx,
      updateConfig: updateMem0Config,
      installDependencies: installMem0Dependencies,
      // #612：前端「启动服务」按钮入口——幂等互斥的手动拉起，复用最近一次环境覆盖配置
      startExecutor: async () => {
        await startExecutorOnce();
      },
      // #612：环境探测（诊断抽屉懒触发）
      probeEnvironment: async () => {
        return probePythonEnvironment(currentConfig.pythonBin);
      },
      // #612：stderr 日志尾随（executor 内部已按值脱敏）
      getStderrTail: () => executor.getStderrTail(),
    });
    const routeDisposers = routes.map((route) => webServer.register(route));
    return () => {
      for (const dispose of routeDisposers) {
        try {
          dispose();
        } catch {
          // ignore
        }
      }
    };
  }, "dsh-mem0: routes");

  // 4. 注册提示词纪律钩子
  const unregisterPrompt = registerMemoryPromptHook(ctx);

  // 4b. #581：注册会话首轮智能预检索注入钩子
  //（per-session 恰一次检索尝试；未就绪/抛错/超时三类静默降级，绝不阻塞首轮回复）
  const unregisterPreInjection = registerSmartPreInjectionHook(ctx, executor, () => currentConfig);

  // 5. 异步尝试拉起 stdio 运行时
  // #612：启动失败必须落到 executor（env_build_failed + detail），前端才有诊断与重试入口；
  // 不再只 warn 后静默停留 idle。失败后按指数退避自动重试。
  void startExecutorOnce();

  // 6. 生命周期注销：kill 子进程 + unregisterServer
  ctx.effect(() => {
    return () => {
      if (typeof unregisterPrompt === "function") {
        unregisterPrompt();
      }
      if (typeof unregisterPreInjection === "function") {
        unregisterPreInjection();
      }
      executor.stop();
      if (mcpManager && typeof mcpManager.unregisterServer === "function") {
        void mcpManager.unregisterServer("mem0").catch(() => {});
      }
    };
  }, "dsh-mem0: dispose");
}
