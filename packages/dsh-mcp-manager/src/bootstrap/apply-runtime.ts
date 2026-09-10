/**
 * dsh-mcp-manager — apply 装配拆分：运行期装配阶段（#592 阶段二 Batch A）。
 *
 * 原 apply() 单函数圈复杂度 78（内联 fs.watch 防重入、中间层热切换闭包、
 * catalog 注入、路由注册与 SSE 广播等十余个装配阶段）；本模块把可独立理解
 * 的装配阶段抽为具名工厂，apply() 退化为顺序装配骨架（comp <= 15）。
 *
 * 行为约束（与拆分前逐字节等价）：
 * - fs.watch 防重入（busy/rerun 队列补跑）与 watcher error 自愈语义不变；
 * - setMiddlewareMode 热切换的 dispose→init→register→reconcile 顺序不变；
 * - 全部 disposer 收口回 apply 的顶层 effect。
 */

import { dirname } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import type { CatalogCache, CatalogDecision, CatalogMessage, SupervisorLite, CatalogAgent } from "../catalog/interface.ts";
import { resolveCatalogInjection } from "../catalog/interface.ts";
import { normalizeMiddlewareMode } from "../workspace/interface.ts";
import type { McpManager } from "../connection/interface.ts";
import { registerMiddlewareTools, registerDirectMcpGuard } from "../inject/interface.ts";
import type { MiddlewareMode } from "../types/interface.ts";
import { makeRoutes, makeEventsRoute, makeHealthRoute } from "../api/interface.ts";
import { sseData } from "../../../../shared/host-utils.js";

/** apply 运行期装配产物的 disposer 集合（顶层 effect 统一收口）。 */
export interface ApplyDisposers {
  disposeRoutes: () => void;
  disposeSection: () => void;
  disposeInjection: () => void;
  disposeMiddleware: () => void;
  watchCleanup: () => void;
}

export function createEmptyDisposers(): ApplyDisposers {
  const noop = () => {};
  return { disposeRoutes: noop, disposeSection: noop, disposeInjection: noop, disposeMiddleware: noop, watchCleanup: noop };
}

/**
 * 中间层模式热切换（设置页「中间层模式」下拉；initMiddleware 幂等已有，
 * off↔project/all 需重新注册/卸载中间层工具——dispose 后重建）。
 * 注册在模式分支之外：启动即 off 时也能从设置页切到 project/all。
 */
export function makeMiddlewareHotSwitch(
  manager: McpManager,
  middlewarePolicy: Record<string, unknown> | undefined,
  resolveRoot: (agent: unknown) => Promise<string | undefined>,
  dispose: { current: () => void },
): (mode: MiddlewareMode) => Promise<void> {
  return async (mode: MiddlewareMode): Promise<void> => {
    if (normalizeMiddlewareMode(mode) === manager.middlewareMode) return;
    const next = normalizeMiddlewareMode(mode);
    manager.middlewareMode = next;
    dispose.current();
    if (next !== "off") {
      const mw = await manager.initMiddleware(next, middlewarePolicy ?? {});
      dispose.current = registerMiddlewareTools(manager.ctx, mw, resolveRoot, next, {
        disabledTools: manager.disabledTools,
        stats: manager.stats,
      });
    } else {
      // D8：off 模式无中间层实例，独立注册 mcp__ 直呼守卫（数据源直查禁用表）。
      const guardDispose = registerDirectMcpGuard(manager.ctx, manager.disabledTools, resolveRoot);
      if (guardDispose !== undefined) dispose.current = guardDispose;
    }
    // off ↔ project/all：重注册/卸载中间层工具后 reconcile——all 模式下全局
    // supervisor 由 reconcile 停掉、新全局条目经 start 内部接管触达 @global
    // 单元（#382 F3）；off 语义停掉全部中间层接管条目。防同一 server 双进程。
    manager.reconcileServers();
    manager.logger.info(`dsh-mcp-manager: middleware mode=${next} (hot-switched)`);
    // B20（C-EVT）：热切换后补 summary 帧——summary 帧源集合含热切换；现状
    // 缺失致热切换后客户端无帧可回拉 GET /servers（与客户端 C10 同根）。
    manager.emitStatus();
  };
}

/**
 * L1 能力目录注入（history-based 去重，仿 dsh-tool-skill catalog）：
 * 决策逻辑在 resolveCatalogInjection（纯函数，可单测）。
 */
export function registerCatalogInjection(
  ctx: Context,
  manager: McpManager,
  catalogMaxEntries: number,
): () => void {
  // 官方强类型 payload：PreStepDecision waterfall（{kind:'reject'}|{kind:'enter';messages}）。
  // 目录决策逻辑在纯函数 resolveCatalogInjection（自建 CatalogDecision 宽面，
  // 可单测），此处仅做边界收窄/放宽。
  return ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    signal.throwIfAborted();
    // 目录数据源按会话 cwd 计算（工作区缓存），不跟随 host 的"当前工作区"
    // 实时状态——切换工作区不改变本会话目录集合，MCP 没变化就不重复注入。
    const supervisors = await manager.catalogServersFor(agent?.session?.header?.cwd);
    // #569：合成注入端目录缓存视图（B 起步 + 中间层 per-root 目录覆盖 +
    // 磁盘 last-good 兜底）。manager.catalogCache 是 supervisor（直呼）路径的
    // 摘要缓存；middleware 模式下其采集的工具目录注入端此前读不到——视图把
    // 两套数据源收口为一个 CatalogCache 形态，公共函数签名不变。
    const catalogView = await manager.catalogViewFor(agent?.session?.header?.cwd, supervisors);
    // 边界放宽：纯函数吃自建宽面 CatalogDecision，返回值即本轮 PreStepDecision
    return resolveCatalogInjection(
      decision as unknown as CatalogDecision,
      messages as CatalogMessage[],
      supervisors as Map<string, SupervisorLite>,
      catalogMaxEntries,
      catalogView,
      agent as unknown as CatalogAgent | undefined,
      // 热切换后目录文案按当前模式渲染（#362 设置页中间层模式下拉）。
      manager.middlewareMode,
    ) as unknown as PreStepDecision;
  });
}

/**
 * 注册 /api/dsh-mcp/* 路由 + SSE 状态广播接线。
 * 状态变化 → 广播 SSE 帧（hub 在 makeEventsRoute 中惰性创建，#515）。
 */
export function setupRoutesAndBroadcast(ctx: Context, manager: McpManager): () => void {
  const routes = makeRoutes(manager);
  const eventsRoute = makeEventsRoute(manager);
  const healthRoute = makeHealthRoute(manager);
  const disposers = [...routes, eventsRoute, healthRoute].map((route) => ctx.webServer.register(route));
  const unsubscribeStatus = manager.onStatus(() => {
    manager.sseHub?.broadcast(sseData({ type: "summary" }));
  });
  return () => {
    unsubscribeStatus();
    for (const dispose of disposers) dispose();
    // #515：hub.dispose() 统一停心跳 + destroy 全部连接（幂等，不依赖
    // close 事件异步时序）；取代旧 sseHeartbeatCleanups 逐连接清理。
    manager.sseHub?.dispose();
    manager.sseHub = undefined;
  };
}

/**
 * 变更点驱动（#111）：fs.watch 监听全局与当前项目 mcp.json 配置目录，
 * 外部编辑/落盘 → 防重入 reconcile（运行中排队补跑）。取代 mtime 轮询。
 */
export async function setupConfigWatchersAsync(manager: McpManager): Promise<() => void> {
  try {
    const fs = await import("node:fs");
    const watchers: Array<{ close(): void }> = [];
    const watched = new Set<string>();
    const watchConfig = (dir: string) => {
      if (watched.has(dir)) return;
      watched.add(dir);
      let busy = false;
      let rerun = false;
      const run = () => {
        if (busy) {
          rerun = true;
          return;
        }
        busy = true;
        void (async () => {
          try {
            await manager.refreshFromDisk();
          } finally {
            busy = false;
            if (rerun) {
              rerun = false;
              run();
            }
          }
        })();
      };
      try {
        const watcher = fs.watch(dir, { persistent: false }, () => run());
        // 目录被删/重命名等场景 FSWatcher 会 emit error；无监听器会抛
        // uncaught exception 崩溃宿主进程（P1 修复）。
        watcher.on("error", () => {
          // 目录消失/权限变化：移除 watcher（配置写路径仍会 reconcile）。
          const index = watchers.indexOf(watcher);
          if (index >= 0) watchers.splice(index, 1);
          try {
            watcher.close();
          } catch {
            // 已关闭
          }
        });
        watchers.push(watcher);
      } catch {
        // watch 不可用（某些平台/只读目录）：降级无 watcher（写路径仍会 reconcile）。
      }
    };
    watchConfig(dirname(manager.store.path));
    if (manager.projectStore !== undefined) watchConfig(dirname(manager.projectStore.path));
    // 会话切换时项目 store 变化 → 重新挂 watcher。
    const unwatchProject = manager.onStatus(() => {
      if (manager.projectStore !== undefined) watchConfig(dirname(manager.projectStore.path));
    });
    return () => {
      unwatchProject();
      for (const watcher of watchers.splice(0)) {
        try {
          watcher.close();
        } catch {
          // 已关闭
        }
      }
    };
  } catch {
    // fs.watch 不可用：保持既有行为（写路径仍会 reconcile）。
    return () => {};
  }
}


