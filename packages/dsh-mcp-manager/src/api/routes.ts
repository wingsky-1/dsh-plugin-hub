/**
 * dsh-mcp-manager — HTTP 路由装配层（依赖 import 模块与仓库共享层）。
 *
 * /api/dsh-mcp/* 路由（loopback-only）供 web GUI 分级展示、快速接入、
 * 导入 mcpServers JSON；events 为 SSE 状态推送通道。
 * 例外：/api/dsh-mcp/config 是只读 UI 配置接口，允许非 loopback 访问，
 * 便于远程页面读取 position/offset 等非敏感展示配置。
 * 由 lib/index.js 组合根 re-export（ROUTES / makeRoutes）。
 *
 * #592 阶段二 Batch A 消峰：各端点 handler 已拆离至 routes-controllers.ts
 * 的独立控制器工厂（原 makeRoutes 单函数圈复杂度 84 → 装配后 <= 15）；
 * 本文件只保留 ROUTES 常量、装配函数与 SSE/health 工厂（SSE/health 原本
 * 即独立工厂形态，复杂度低，随装配层同文件保留）。
 */

// 辅助函数统一来自仓库共享层（loopback 围栏 / writeJson / readJsonBody / sseData）。
import { writeJson, sseData, guardLoopbackMethod } from "../../../../shared/host-utils.js";
import { createSseHub } from "../../../../shared/sse-hub.js";
import type { SseHub } from "../../../../shared/sse-hub.js";
import type { ServerConfig, ClientUiConfig, RoutesManager } from "../types/interface.ts";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { ServerResponse } from "node:http";
import type { McpStore } from "../config/store/interface.ts";
import {
  buildConfigRoute,
  buildServersRoute,
  buildSessionRoute,
  buildResumeRoute,
  buildConnectRoute,
  buildDisconnectRoute,
  buildReconnectRoute,
  buildImportJsonRoute,
  buildToolDisableRoute,
  type RouteHelpers,
} from "./routes-controllers.ts";
import { queryParam } from "./routes-helpers.ts";



// ------------------------------------------------------------ HTTP 路由

/** 路由路径清单（与客户端一致）。 */
export const ROUTES = {
  servers: "/api/dsh-mcp/servers",
  config: "/api/dsh-mcp/config",
  session: "/api/dsh-mcp/session",
  resume: "/api/dsh-mcp/resume",
  connect: "/api/dsh-mcp/servers/connect",
  disconnect: "/api/dsh-mcp/servers/disconnect",
  reconnect: "/api/dsh-mcp/servers/reconnect",
  importJson: "/api/dsh-mcp/import/json",
  events: "/api/dsh-mcp/events",
  health: "/api/dsh-mcp/health",
  toolDisable: "/api/dsh-mcp/tool-disable",
};

export { queryParam };

/** 组装 /api/dsh-mcp/* 路由。cwd 参数仅用于兼容旧调用（不再被路由使用）。 */
export function makeRoutes(manager: RoutesManager, cwd = process.cwd()): WebRoute[] {
  const handleError = (res: Parameters<WebRoute["handler"]>[1], error: unknown) => {
    writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  };
  /** 解析 scope 查询参数（缺省 global）。 */
  const scopeParam = (url: URL) => queryParam(url, "scope") ?? "";
  /** 若带 cwd 参数则先切换会话（跟随会话的项目级 MCP）。 */
  const maybeSession = async (url: URL): Promise<void> => {
    const cwdParam = queryParam(url, "cwd");
    if (cwdParam !== undefined && cwdParam !== "") await manager.setSession(cwdParam);
  };
  const helpers: RouteHelpers = { handleError, scopeParam, maybeSession };

  return [
    buildConfigRoute(manager, helpers),
    buildServersRoute(manager, helpers),
    buildSessionRoute(manager, helpers),
    buildResumeRoute(manager, helpers),
    buildConnectRoute(manager, helpers),
    buildDisconnectRoute(manager, helpers),
    buildReconnectRoute(manager, helpers),
    buildImportJsonRoute(manager, helpers),
    buildToolDisableRoute(manager, helpers),
  ];
}

// --------------------------------------------------------- 状态推送（SSE）

// sseData 已收敛 shared/host-utils.js（#472）：本文件经顶部共享层 import 使用，
// 导出面由组合根 src/index.ts re-export 保持 lib/index.js 不变。

/** 配置变更 SSE 帧：客户端收到后重新 GET /api/dsh-mcp/config 就地更新浮窗位置。 */
export function uiConfigChangedFrame(): string {
  return sseData({ type: "ui-config-changed" });
}

/**
 * SSE 心跳间隔：30s data ping（对齐 dsh-notifier HEARTBEAT_MS 形态，#268）。
 * 必须用 data 而非注释帧——注释帧既不触发客户端 onmessage 也不触发 onerror，
 * 半开连接（移动端切后台系统冻结 JS 并静默掐断 TCP）时客户端零事件无法自愈；
 * data 帧喂客户端 60s watchdog 使其能检测失活并关旧建新。
 * #515 起心跳由共享 hub（shared/sse-hub.js）统一管理，本常量保留兼容导出。
 */
export const SSE_HEARTBEAT_MS = 30_000;
/** 心跳 ping 帧（内容固定，模块级缓存避免逐次序列化；#515 起 hub 内置同帧）。 */
export const SSE_PING_FRAME = sseData({ type: "ping" });

/**
 * 向全部 SSE 连接写出一帧（#515 起收口到共享 hub；本函数保留兼容导出，
 * 接受 hub 或旧 Set 形态）。判死/背压由 hub writeFrame 统一处理。
 */
export function broadcastFrame(connections: SseHub | Set<ServerResponse> | undefined, frame: string): void {
  if (!connections) return;
  if (typeof (connections as SseHub).broadcast === "function") {
    (connections as SseHub).broadcast(frame);
    return;
  }
  for (const res of connections as Set<ServerResponse>) {
    try {
      res.write(frame);
    } catch {
      // 连接已断，等待 close 事件清理
    }
  }
}

/**
 * 状态变化推送通道（SSE）：浏览器端 EventSource 订阅，宿主状态变化时
 * 广播 `{ type: "summary" }` 帧（内容不随帧传输，浏览器收到后自行拉取）。
 *
 * #515 起连接管理收口到共享 hub（shared/sse-hub.js）：manager.sseHub 惰性创建
 * （上限淘汰 + 心跳 + stalled/maxAge 主动回收），本路由只负责入表与首帧——
 * 取代旧裸 Set + per-connection 心跳（#268/#515，消除与 dsh-notifier 不对称）。
 *
 * 半开连接防护（#268，对齐 dsh-notifier）：hub 每 30s 向全部连接写 data ping
 * 心跳——移动端切后台系统冻结 JS 并静默掐断 TCP，两端均收不到 FIN/RST，
 * 无心跳则客户端 watchdog 无失活信号可依。
 */
export function makeEventsRoute(manager: RoutesManager, options?: { heartbeatMs?: number; maxConnections?: number }): WebRoute {
  return {
    kind: "exact",
    path: ROUTES.events,
    handler: (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      // 惰性创建共享 hub（上限淘汰 + 心跳 + stalled/maxAge 回收）。
      // maxConnections 默认 16（与 dsh-notifier 对齐，#515 评审）；health 路由
      // 若在 events 之前注册会先建 hub，故 hub 创建不含业务副作用。
      const hub = (manager.sseHub ??= createSseHub({
        getMaxConnections: () => options?.maxConnections ?? 16,
        heartbeatMs: options?.heartbeatMs,
        warn: (_message) => {
          // 无 logger 注入面，静默（连接回收是自愈路径，无需告警）
        },
      }));
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      res.write(sseData({ type: "summary" }));
      hub.register(res);
    },
  };
}

/** 健康检查：插件是否加载、服务器/连接/工具状态（诊断"插件没生效"的标准入口）。 */
export function makeHealthRoute(manager: RoutesManager): WebRoute {
  return {
    kind: "exact",
    path: ROUTES.health,
    handler: (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      let servers = 0;
      let connected = 0;
      let tools = 0;
      for (const supervisor of manager.supervisors.values()) {
        servers += 1;
        if (supervisor.status === "connected") connected += 1;
        tools += supervisor.tools.length;
      }
      // 中间层连接池计数（#228：项目级连接不在 supervisors，需单独投影诊断）。
      let middlewareUnits = 0;
      let middlewareConnections = 0;
      let middlewareConnected = 0;
      for (const unit of manager.middleware?.units.values() ?? []) {
        middlewareUnits += 1;
        for (const entry of unit.connections.values()) {
          middlewareConnections += 1;
          if (entry.status === "connected") middlewareConnected += 1;
        }
      }
      writeJson(res, 200, {
        ok: true,
        plugin: "dsh-mcp-manager",
        servers,
        connected,
        tools,
        catalogCacheEntries: manager.catalogCache.size,
        middleware: {
          mode: manager.middlewareMode ?? "off",
          units: middlewareUnits,
          connections: middlewareConnections,
          connected: middlewareConnected,
        },
      });
    },
  };
}
