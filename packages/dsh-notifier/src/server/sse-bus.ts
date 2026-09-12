/**
 * dsh-notifier — 服务器侧逻辑：SSE 枢纽业务包装。
 *
 * 连接管理（register/size/dispose/心跳/stalled+maxAge 回收）委托共享 hub
 * （shared/sse-hub.js）；本包装在共享 hub 之上叠加 notifier 业务广播：
 * broadcast(payload) 附加递增 seq、入 600 条滚动缓冲（断线回放独立于 /history
 * 截断），framesSince(since) 供 events 路由 ?since 补拉。
 */
import type { ServerResponse } from "node:http";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { errorMessage, sseData } from "../../../../shared/host-utils.js";
import { createSseHub as createSharedHub } from "../../../../shared/sse-hub.js";
import type { SseConnHealth, SseEvictStats } from "../../../../shared/sse-hub.js";

export type { SseConnHealth, SseEvictStats };
export type { SseHubOptions } from "../../../../shared/sse-hub.js";

/**
 * seq 计数器持久化存储（本域内聚读写实现；装配层只提供路径与日志出口）。
 *
 * 语义硬约束（#733 M1-F2 自组合根**逐行等价**迁入，不得变更）：
 * - 缺文件 = 首启静默回退 0（ENOENT 不告警）；
 * - **合法 JSON 但值非法**（负数/小数/非数字）→ warn「seq 计数文件损坏」+ 回退 0；
 * - **非法 JSON（解析失败）与其他读取失败** → 走 catch 分支 → warn
 *   「seq 计数文件读取失败」（除 ENOENT 外）+ 回退 0。这是迁出前的既有控制流
 *   （损坏文案只在 JSON.parse 成功、值校验失败时命中），文案与分支归属逐字保留；
 * - 写面为**同步** tmp+rename 原子写——createSseHub 的 dispose 同步补写依赖
 *   此同步性（正常停止零丢失；kill -9 崩溃窗口 ≤ 500ms 防抖窗口）。
 */
export interface SeqStore {
  /** 读取续计数值（非法/缺失/损坏一律回退 0）。 */
  load(): number;
  /** 原子写入计数值（失败只 warn，不抛）。 */
  save(seq: number): void;
}

/**
 * 创建 seq 计数器存储。
 * @param options.file 计数器文件路径（装配层解析：与 status 文件同目录）。
 * @param options.warn 告警出口（装配层注入 ctx.logger.warn）。
 */
export function createSeqStore(options: { file: string; warn: (message: string) => void }): SeqStore {
  const { file, warn } = options;
  return {
    load(): number {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
        if (typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 && Number.isInteger(parsed)) return parsed;
        warn(`dsh-notifier: seq 计数文件损坏，回退 0：${file}`);
        return 0;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT") warn(`dsh-notifier: seq 计数文件读取失败，回退 0：${errorMessage(error)}`);
        return 0;
      }
    },
    save(seq: number): void {
      try {
        const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
        writeFileSync(tmp, String(seq), "utf8");
        renameSync(tmp, file);
      } catch (error) {
        warn(`dsh-notifier: seq 计数写入失败: ${errorMessage(error)}`);
      }
    },
  };
}

/** notifier 视角的 SSE 枢纽：共享连接管理面 + 业务广播 + 断线补拉。
 *  注意不 extends 共享 SseHub：共享的 broadcast(text) 是「写现成帧」原语，
 *  本接口的 broadcast(payload) 是「对象负载 → 附加 seq → 广播」业务语义，
 *  两者签名不同，用组合而非继承（register/size/dispose 委托共享 hub）。 */
export interface SseHub {
  /** 注册一条 SSE 连接：入表 + 挂 close/error 监听 + 上限淘汰（委托共享 hub）。 */
  register(res: ServerResponse): void;
  /** 广播一帧业务通知：附加递增 seq、入滚动缓冲、推给所有连接。 */
  broadcast(payload: Record<string, unknown>): void;
  /** 断线补拉：滚动缓冲中 seq 更大的帧（独立于 /history 截断）。 */
  framesSince(since: number): Array<Record<string, unknown> & { seq: number }>;
  /** 当前连接数（语义 = 服务端未释放句柄数）。 */
  size(): number;
  /** evict 原因计数（health 观测）。 */
  evictStats(): SseEvictStats;
  /** 连接健康快照（health per-conn 观测）。 */
  connHealth(now?: number): SseConnHealth[];
  /** 停止心跳定时器。 */
  dispose(): void;
}

/**
 * 创建 SSE 枢纽（notifier 业务包装）。
 *
 * @param options.getMaxConnections 连接上限实时读取器（配置改动即时生效）。
 * @param options.heartbeatMs 心跳间隔（默认 30s；测试注入短值）。
 * @param options.stalledTimeoutMs stalled 回收窗口（默认 90s；测试注入短值）。
 * @param options.maxAgeMs maxAge 轮换上限（默认 120min；0 = 关闭轮换）。
 * @param options.idleTimeoutMs maxAge 轮换空闲门槛（默认 15min）。
 * @param options.loadSeq seq 续计数注入面（缺省 = 内存模式，
 *   重启归零——旧行为；装配层传入持久化读取）。
 * @param options.saveSeq seq 落盘注入面（broadcast 后防抖调用，
 *   dispose 同步落盘；缺省 = 不持久化）。
 * @param options.seqFlushMs seq 落盘防抖窗口（默认 500ms；测试注入短窗防固定 sleep）。
 */
export function createSseHub(options: {
  getMaxConnections: () => number;
  heartbeatMs?: number;
  stalledTimeoutMs?: number;
  maxAgeMs?: number;
  idleTimeoutMs?: number;
  loadSeq?: () => number;
  saveSeq?: (seq: number) => void;
  seqFlushMs?: number;
}): SseHub {
  const { getMaxConnections } = options;
  // 共享 hub：连接表 + 心跳 + 上限淘汰 + stalled/maxAge 主动回收（单一实现）。
  const hub = createSharedHub({
    getMaxConnections,
    heartbeatMs: options.heartbeatMs,
    stalledTimeoutMs: options.stalledTimeoutMs,
    maxAgeMs: options.maxAgeMs,
    idleTimeoutMs: options.idleTimeoutMs,
  });

  /** SSE 已派发帧的滚动缓冲（断线回补用；上限 RECENT_LIMIT，独立于 /history 的
   *  200 条截断，避免补拉时尾部事件被截掉）。 */
  const RECENT_LIMIT = 600;
  // 启动时从注入面续计数（seq 单调性不变量：≥0 整数，非法回退 0）。
  const loadedSeq = options.loadSeq === undefined ? 0 : options.loadSeq();
  let notifySeq = Number.isFinite(loadedSeq) && Number.isInteger(loadedSeq) && loadedSeq >= 0 ? loadedSeq : 0;
  const recentFrames: Array<Record<string, unknown> & { seq: number }> = [];

  /** seq 落盘防抖窗口（默认 500ms）：窗口内多次广播合并为一次写；崩溃（kill -9）
   *  最多丢失最近一个防抖窗口内广播的帧。 */
  const SEQ_FLUSH_MS = options.seqFlushMs ?? 500;
  /** 是否有尚未落盘的 seq 变更（dispose 时据此同步补写，正常停止零丢失）。 */
  let seqDirty = false;
  let seqTimer: NodeJS.Timeout | null = null;

  function scheduleSeqFlush(): void {
    if (options.saveSeq === undefined) return; // 内存模式：不落盘
    seqDirty = true;
    if (seqTimer !== null) return; // 已有待写定时器
    seqTimer = setTimeout(() => {
      seqTimer = null;
      seqDirty = false;
      options.saveSeq?.(notifySeq);
    }, SEQ_FLUSH_MS);
    seqTimer.unref?.();
  }

  return {
    register: hub.register,
    size: hub.size,
    evictStats: hub.evictStats,
    connHealth: hub.connHealth,
    /** 业务广播：附加 seq → 入滚动缓冲 → 经共享 hub 写全部连接（判死收口在 hub）。 */
    broadcast(payload: Record<string, unknown>) {
      const frame: Record<string, unknown> & { seq: number } = Object.assign({}, payload, { seq: ++notifySeq });
      recentFrames.push(frame);
      if (recentFrames.length > RECENT_LIMIT) recentFrames.shift();
      scheduleSeqFlush();
      hub.broadcast(sseData(frame));
    },
    /** 断线补拉：滚动缓冲中 seq 更大的帧（?since 语义不变）。 */
    framesSince(since: number) {
      return recentFrames.filter((frame) => frame.seq > since);
    },
    /** 停止心跳定时器 + 同步补写防抖窗口内未落盘的 seq（正常停止零丢失；
     *  崩溃窗口即 ≤防抖窗口）。 */
    dispose: () => {
      hub.dispose();
      if (seqTimer !== null) {
        clearTimeout(seqTimer);
        seqTimer = null;
      }
      if (seqDirty && options.saveSeq !== undefined) {
        options.saveSeq(notifySeq);
        seqDirty = false;
      }
    },
  };
}
