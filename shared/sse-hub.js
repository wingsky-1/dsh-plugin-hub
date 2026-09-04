// dsh 插件家族共享层 — SSE 长连接枢纽（单一事实源，取代各包自建连接表）。
//
// 历史：dsh-notifier 与 dsh-mcp-manager 各自实现 SSE 连接管理且不对称——
// notifier 有上限/淘汰/心跳/判死，mcp-manager 只有裸 Set + per-connection 心跳，
// 无上限无淘汰；两包都缺「半开连接主动回收」（issue #515，源自 #330 已知取舍）。
// 本模块收敛为单一实现：连接表 + 心跳 + 上限淘汰 + stalled/maxAge 主动回收，
// 两包共用，消除不对称与逐包漂移。类型声明见同目录 sse-hub.d.ts。
//
// 设计边界（#515 评审收敛）：
// - 广播负载生成留各包：hub 只负责「向全部连接写一段现成 text 帧」并做判死收口；
//   帧内容（notifier notify 帧 + seq 滚动缓冲 / mcp summary/ui-config 帧）由调用方
//   生成，hub 不感知业务语义。
// - ?since 补拉不进 hub（notifier 路由层行为；mcp 提示型事件补拉无意义）。
// - 心跳用 data ping 而非注释帧（喂客户端 watchdog 检测半开，#268 架构不可倒退）。
//
// 半开/僵尸回收（issue #515）：
// - 半开连接（设备息屏/NAT 静默掐断）不发 FIN → close/error 不触发；写心跳也不
//   抛错（数据进内核缓冲）。单靠「注册时淘汰最老」只能保证表有界、不能清僵尸，
//   页面稳定时永不触发淘汰 → 表长期顶格。本模块补两路主动回收：
//   1. stalled 回收：write 返回 false 视为背压（不误杀健康慢客户端，对齐
//      dsh-notifier 既有锁定语义），但连续 false 超过窗口（stalledTimeoutMs，
//      默认 90s = 3 心跳周期）→ 判定对端永不消费 → evict；恢复写清零。
//      不读 writableLength（#515 评审否决：只反映 Node 用户缓冲，物理不可靠）。
//   2. maxAge 轮换：连接存活超过 maxAgeMs（默认 120min）且空闲超过
//      idleTimeoutMs（默认 15min）→ 主动正常关闭。客户端 EventSource 自动重连 +
//      notifier ?since 补拉 → 无感。条件含「空闲」避免轮换活跃长连接。
//   两者 + 既有 error/destroyed 兜底各管一段（内核缓冲背压型 / RTO 超时型 /
//   无 close 长命静默僵尸型），互补覆盖。
// - 淘汰优先级：stalled > 最老（有 stalled 先清 stalled，否则清最老）。
//
// 心跳为 hub 级单 interval（对齐 notifier，取代 mcp 的 per-connection interval）：
// 一个 tick 顺带做 写心跳 / stalled 判死 / maxAge 轮换 / 上限收缩，串行无竞争。

/** 心跳间隔（默认 30s）。 */
const DEFAULT_HEARTBEAT_MS = 30_000;
/** stalled 回收窗口（默认 90s = 3 心跳周期）。 */
const DEFAULT_STALLED_TIMEOUT_MS = 90_000;
/** maxAge 轮换上限（默认 120min；0 = 关闭轮换）。 */
const DEFAULT_MAX_AGE_MS = 120 * 60_000;
/** maxAge 轮换的「空闲」门槛（默认 15min）。 */
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
/** 写抛错判死阈值（对齐 dsh-notifier 原版：连续 ≥3 次抛错 ≈ 3 心跳周期判死）。 */
const MAX_WRITE_FAILS = 3;
/** 心跳 data ping 帧（喂客户端 60s watchdog 的半开失活信号；必须 data 而非注释帧）。 */
const PING_FRAME = 'data: {"type":"ping"}\n\n';

/**
 * 创建 SSE 枢纽并启动心跳（unref：不阻止进程退出）。
 * @param {object} options
 * @param {() => number} options.getMaxConnections 连接上限实时读取器（配置改动即时
 *   生效；超限淘汰 stalled 优先、其次最老）。
 * @param {number} [options.heartbeatMs] 心跳间隔（默认 30s；测试注入短值）。
 * @param {number} [options.stalledTimeoutMs] stalled 回收窗口（默认 90s；测试注入短值）。
 * @param {number} [options.maxAgeMs] maxAge 轮换上限（默认 120min；0 = 关闭轮换）。
 * @param {number} [options.idleTimeoutMs] maxAge 轮换的「空闲」门槛（默认 15min）。
 * @param {(message: string) => void} [options.warn] 日志出口（缺省静默）。
 * @returns {import("./sse-hub.d.ts").SseHub}
 */
export function createSseHub(options) {
  const { getMaxConnections } = options;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const stalledTimeoutMs = options.stalledTimeoutMs ?? DEFAULT_STALLED_TIMEOUT_MS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  /** 连接表：Map<响应, 状态>。Map 迭代序 = 插入序，超限淘汰时第一项即最老。 */
  const conns = new Map();
  /** evict 原因计数（health 观测）。 */
  const evictStats = { close: 0, error: 0, limit: 0, stalled: 0, maxage: 0, destroyed: 0 };
  /** 心跳定时器（unref：不阻止进程退出）。 */
  let heartbeatTimer;

  /** 移除一条连接（幂等）：先出表再 destroy，destroy 触发的 close 回调再次 evict 无害。 */
  function evict(res, reason) {
    if (conns.delete(res)) {
      evictStats[reason] += 1;
      try {
        res.destroy();
      } catch {
        // 忽略
      }
    }
  }

  /** 连接是否处于 stalled（写被拒超窗）。 */
  function isStalled(state, t) {
    return state.stalledAt !== undefined && t - state.stalledAt >= stalledTimeoutMs;
  }

  /**
   * 连接是否超过 maxAge 且「业务空闲」（maxAge 轮换条件）。
   *
   * **关键：lastWriteAt 只在业务广播（broadcast）写成功时刷新，心跳写不刷新**
   * （心跳是 hub 内部保活，不算用户活动——否则每 30s 心跳让 lastWriteAt 恒新鲜，
   * 半开僵尸也「看似活跃」，maxAge 永不触发，假活动陷阱）。maxAge 是「无 close
   * 长命静默僵尸」的确定性兜底：age 超限且 idleTimeoutMs 内无业务帧 → 主动关闭，
   * 客户端 EventSource 自动重连 + ?since 补拉，用户无感。
   */
  function isExpiredIdle(state, t) {
    if (maxAgeMs <= 0) return false;
    if (t - state.registeredAt < maxAgeMs) return false;
    return t - state.lastWriteAt > idleTimeoutMs;
  }

  /** 连接上限收缩：超限淘汰（stalled 优先，其次最老）。 */
  function enforceLimit() {
    const limit = Math.max(1, getMaxConnections());
    while (conns.size > limit) {
      // 优先淘汰 stalled 连接；无 stalled 则淘汰最老（插入序第一项）。
      let target;
      const t = Date.now();
      for (const [res, state] of conns) {
        if (isStalled(state, t)) {
          target = res;
          break;
        }
      }
      if (target === undefined) target = conns.keys().next().value;
      if (target === undefined) break;
      // 淘汰原因：已 stalled（超窗）记 stalled；否则（最老兜底）记 limit。
      const tgtState = conns.get(target);
      const reason = tgtState.stalledAt !== undefined && isStalled(tgtState, Date.now()) ? "stalled" : "limit";
      evict(target, reason);
    }
  }

  /**
   * 统一写帧（对齐 dsh-notifier 原版语义，#515 保留）：
   * - 抛错（对端已断强信号）→ failStreak++，≥3 判死 evict（防偶发单次误杀）。
   * - write 返回 false（背压）→ 置 stalledAt（首次）或保持，不立即清——背压不误杀，
   *   超窗才由心跳/淘汰 evict。
   * - destroyed / writableEnded → 立即 evict。
   * - 成功 → 清 stalled + 清 failStreak；若属业务写（activity=true，默认）额外刷
   *   lastWriteAt——心跳写 activity=false 不刷（心跳不算用户活动，避免 maxAge
   *   假活动陷阱）。
   * @param {boolean} [activity] 是否业务活动写（默认 true；心跳传 false）。
   * @returns {boolean} 是否成功写出。
   */
  function writeFrame(res, text, activity = true) {
    const state = conns.get(res);
    if (state === undefined) return false;
    if (res.destroyed || res.writableEnded) {
      evict(res, "destroyed");
      return false;
    }
    let written = false;
    try {
      written = res.write(text) !== false;
    } catch {
      state.failStreak += 1;
      if (state.failStreak >= MAX_WRITE_FAILS) evict(res, "error");
      return false;
    }
    if (written) {
      if (activity) state.lastWriteAt = Date.now();
      state.stalledAt = undefined;
      state.failStreak = 0;
      return true;
    }
    // write 返回 false（背压）：置 stalled（首次）或保持起始时刻（不重置窗口）。
    if (state.stalledAt === undefined) state.stalledAt = Date.now();
    return false;
  }

  /** 注册一条 SSE 连接：入表 + 挂 close/error 监听 + 上限淘汰。 */
  function register(res) {
    const t = Date.now();
    conns.set(res, { registeredAt: t, lastWriteAt: t, stalledAt: undefined, failStreak: 0 });
    res.on("close", () => evict(res, "close"));
    res.on("error", () => evict(res, "error"));
    // TCP keepalive：SSE 每 30s 心跳使连接从不空闲，keepalive 只兜底长空闲
    // （真实死连接探测靠 TCP 重传，分钟级）——保留但注明作用边界。
    try {
      res.socket?.setKeepAlive?.(true, 60_000);
    } catch {
      // 忽略
    }
    enforceLimit();
  }

  /** 向全部连接写一帧 text（调用方生成）；判死收口在 writeFrame。 */
  function broadcast(text) {
    for (const [res] of conns) {
      writeFrame(res, text);
    }
  }

  /** 当前连接数（语义 = 服务端未释放句柄数）。 */
  function size() {
    return conns.size;
  }

  /** evict 原因计数副本（health 观测）。 */
  function evictStatsCopy() {
    return { ...evictStats };
  }

  /** 连接健康快照（按注册序；health per-conn 观测）。 */
  function connHealth(nowMs) {
    const t = nowMs ?? Date.now();
    const out = [];
    for (const state of conns.values()) {
      out.push({
        ageMs: t - state.registeredAt,
        lastWriteAgoMs: t - state.lastWriteAt,
        stalledMs: state.stalledAt === undefined ? -1 : t - state.stalledAt,
      });
    }
    return out;
  }

  /** 停止心跳定时器。 */
  function dispose() {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  /**
   * 心跳 tick：stalled 判死 → maxAge 轮换 → 写 ping（复用 writeFrame 判死收口）→
   * 上限收缩。串行无竞争，全部回收路径收口在 evict。
   */
  function heartbeatTick() {
    const t = Date.now();
    for (const [res, state] of conns) {
      if (res.destroyed || res.writableEnded) {
        evict(res, "destroyed");
        continue;
      }
      if (isStalled(state, t)) {
        evict(res, "stalled");
        continue;
      }
      if (isExpiredIdle(state, t)) {
        evict(res, "maxage");
        continue;
      }
      // 写心跳 data ping（喂客户端 watchdog）：activity=false —— 成功清
      // stalled/failStreak 但不刷 lastWriteAt（心跳不算用户活动，防 maxAge
      // 假活动陷阱）；抛错累计 failStreak（writeFrame 内判死），背压置 stalled
      //（下轮判超窗）。
      writeFrame(res, PING_FRAME, false);
    }
    enforceLimit();
  }

  heartbeatTimer = setInterval(heartbeatTick, heartbeatMs);
  heartbeatTimer.unref?.();

  return {
    register,
    broadcast,
    size,
    evictStats: evictStatsCopy,
    connHealth,
    dispose,
  };
}
