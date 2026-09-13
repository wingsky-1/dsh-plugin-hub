import type { ServerResponse } from "node:http";

/**
 * 连接表项状态（stalledAt 缺省 = 未 stalled）。
 * failStreak：连续写抛错次数（≥3 ≈ 3 心跳周期判死，对齐 dsh-notifier 原版）。
 */
export interface SseConnState {
  /** 连续写抛错次数。 */
  failStreak: number;
  /** 自上次成功写/心跳以来的"写被拒"起始时刻（ms epoch；缺省 = 未 stalled）。 */
  stalledAt?: number;
  /** 注册时刻（ms epoch；maxAge 轮换依据）。 */
  registeredAt: number;
  /** 最近一次成功写时刻（ms epoch；idle 判定依据）。 */
  lastWriteAt: number;
}

/** 回收/淘汰原因（health 观测 + 调试）。`dispose` = 卸载时统一关连接那一次。 */
export type SseEvictReason =
  "close" | "error" | "limit" | "stalled" | "maxage" | "destroyed" | "dispose";

/** evict 原因计数（health 观测：先量化残留构成再调参）。键集与 `SseEvictReason` 一一对应。 */
export interface SseEvictStats {
  close: number;
  error: number;
  limit: number;
  stalled: number;
  maxage: number;
  destroyed: number;
  dispose: number;
}

/** 连接健康观测：排障用明细，**故意不进 `/health`**——它随连接数增长（上限 16~1024），
 *  而 `/health` 是常量大小的聚合面且经 lan-proxy 对局域网可见。真要暴露请单开路由。 */
export interface SseConnHealth {
  /** 连接已存活时长（ms）。 */
  ageMs: number;
  /** 距最近成功写已过去时长（ms；-1 = 从未写过）。 */
  lastWriteAgoMs: number;
  /** 当前 stalled 持续时长（ms；-1 = 未 stalled）。 */
  stalledMs: number;
}

/** createSseHub 选项。 */
export interface SseHubOptions {
  /** 连接上限实时读取器（配置改动即时生效；超限淘汰 stalled 优先、其次最老）。 */
  getMaxConnections: () => number;
  /** 心跳间隔（默认 30s；测试注入短值）。 */
  heartbeatMs?: number;
  /** stalled 回收窗口：连续写被拒超过此时长即 evict（默认 90s）。 */
  stalledTimeoutMs?: number;
  /** maxAge 轮换上限（默认 120min；0 = 关闭轮换）。 */
  maxAgeMs?: number;
  /** maxAge 轮换的"空闲"门槛：距最近成功写超过此时长才算空闲（默认 15min）。 */
  idleTimeoutMs?: number;
}

/**
 * SSE 连接枢纽（共享核心，取代各包自建连接表）。
 * 连接表 + 心跳 + 上限淘汰 + stalled/maxAge 主动回收（#515）。
 * 广播负载生成留调用方：hub 只向全部连接写现成 text 帧并判死收口；
 * ?since 补拉（notifier 路由层行为）不进 hub。
 */
export interface SseHub {
  /** 注册一条 SSE 连接：入表 + 挂 close/error 监听 + 上限淘汰。 */
  register(res: ServerResponse): void;
  /** 向全部连接写一帧 text（调用方生成，通常经 sseData()）；判死收口在内部。 */
  broadcast(text: string): void;
  /** 当前连接数（语义 = 服务端未释放句柄数）。 */
  size(): number;
  /** evict 原因计数（health 观测）。 */
  evictStats(): SseEvictStats;
  /** 连接健康快照（按注册序；排障用明细，不进 `/health`，理由见 `SseConnHealth`）。 */
  connHealth(now?: number): SseConnHealth[];
  /** 停止心跳定时器。 */
  dispose(): void;
}

/** 创建 SSE 枢纽并启动心跳（unref：不阻止进程退出）。 */
export declare function createSseHub(options: SseHubOptions): SseHub;
