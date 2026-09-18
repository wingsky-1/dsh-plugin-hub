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

import { writeJson, sseData, guardLoopbackMethod } from "../../../../../shared/host-utils.js";
import { createSseHub } from "../../../../../shared/sse-hub.js";
import type { SseHub } from "../../../../../shared/sse-hub.js";
import { ROUTES, SSE_FRAMES, SERVER_STATES } from "../../shared/interface.ts";
import type { SseFramePayload } from "../../shared/interface.ts";
import type { RoutesManager } from "../connection/interface.ts";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { ServerResponse } from "node:http";
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
import { apiPorts } from "./impl/service/index.ts";

// ------------------------------------------------------------ HTTP 路由

// 路由路径清单的物理定义在 shared/routes.ts（两端同一份）；此处只转出，
// api/interface.ts 与包入口的导出面不变。
export { ROUTES };

export { queryParam };

/** 组装 /api/dsh-mcp/* 路由。cwd 参数仅用于兼容旧调用（不再被路由使用）。 */
export function makeRoutes(manager: RoutesManager, _cwd = process.cwd()): WebRoute[] {
  const handleError = (res: Parameters<WebRoute["handler"]>[1], error: unknown) => {
    writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  };
  /**
   * 解析 scope 查询参数（缺省 global）。
   *
   * #767 S1-5b：缺省/非法值一律经 workspace 域归一化再下传。归一化前空串会让「缺 scope」的
   * 直呼落进另一条引擎分支，注册名与 userDisabled 清理都与显式 `scope=global` 分叉
   * （S1-4d-3 实测建档）。五条吃 scope 的路由（connect/disconnect/reconnect/remove/update）
   * 由这一处同时受益；disconnect 内的 normalizeScope 因此成为幂等冗余。
   */
  const scopeParam = (url: URL) =>
    apiPorts.get().workspace.normalizeScope(queryParam(url, "scope") ?? "");
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
  return sseData({ type: SSE_FRAMES.uiConfigChanged } satisfies SseFramePayload);
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
export const SSE_PING_FRAME = sseData({ type: SSE_FRAMES.ping } satisfies SseFramePayload);

/**
 * 向全部 SSE 连接写出一帧（#515 起收口到共享 hub；本函数保留兼容导出，
 * 接受 hub 或旧 Set 形态）。判死/背压由 hub writeFrame 统一处理。
 */
export function broadcastFrame(
  connections: SseHub | Set<ServerResponse> | undefined,
  frame: string,
): void {
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
 * （连接表 + 心跳 + stalled/maxAge 主动回收），本路由只负责入表与首帧——
 * 取代旧裸 Set + per-connection 心跳（#268/#515，消除与 dsh-notifier 不对称）。
 *
 * 半开连接防护（#268，对齐 dsh-notifier）：hub 每 30s 向全部连接写 data ping
 * 心跳——移动端切后台系统冻结 JS 并静默掐断 TCP，两端均收不到 FIN/RST，
 * 无心跳则客户端 watchdog 无失活信号可依。
 */
export function makeEventsRoute(
  manager: RoutesManager,
  options?: { heartbeatMs?: number },
): WebRoute {
  return {
    kind: "exact",
    path: ROUTES.events,
    handler: (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      // 惰性创建共享 hub（连接表 + 心跳 + stalled/maxAge 回收）；health 路由若在
      // events 之前注册会先建 hub，故 hub 创建不含业务副作用。
      const hub = (manager.sseHub ??= createSseHub({
        heartbeatMs: options?.heartbeatMs,
      }));
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      res.write(sseData({ type: SSE_FRAMES.summary } satisfies SseFramePayload));
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
      // 三计数按连接池**单元表**聚合（#767 笔 1a 单池）：直连账本已退役，池是唯一连接
      // 路径。顶层键集逐字不变（外部形状守恒）。
      // 状态判据走读时刷新的投影（statusOf）：中间层 entry.status 只在装载窗口结算时写入，
      // 官方的后台重连/预算耗尽没有第二处写入点，直读它会让「已掉线」长期计成 connected。
      let servers = 0;
      let connected = 0;
      let tools = 0;
      let middlewareUnits = 0;
      let middlewareConnections = 0;
      let middlewareConnected = 0;
      const middleware = manager.middleware;
      for (const unit of middleware?.units.values() ?? []) {
        middlewareUnits += 1;
        for (const serverName of unit.connections.keys()) {
          servers += 1;
          middlewareConnections += 1;
          if (middleware?.statusOf(unit.root, serverName) === SERVER_STATES.connected) {
            connected += 1;
            middlewareConnected += 1;
          }
          tools += middleware?.toolCountOf(unit.root, serverName) ?? 0;
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
          units: middlewareUnits,
          connections: middlewareConnections,
          connected: middlewareConnected,
        },
      });
    },
  };
}
