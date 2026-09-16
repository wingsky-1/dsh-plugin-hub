/**
 * dsh-notifier 客户端 —— SSE 通知流会话。
 *
 * 连接、看门狗、断线重连与 seq 去重原先直接 new EventSource 并用真实的 setTimeout/Date.now，
 * 于是「重连是否带上 since」「重复帧有没有被丢」「半开连接能不能被发现」全都测不到——而这三条
 * 正是断线窗口里丢通知的三个成因。时间与连接都从端口进来之后，它们可以用假时钟与假
 * EventSource 精确驱动。
 *
 * 三条语义是刻意的，别在重写时简化：
 * 1. 重连必须带 since：EventSource 自动重连不携带 query，不带就等于把断线期间的事件丢掉；
 * 2. 只有**解析成功**的帧才刷新 lastActivity——畸形帧不该让半开检测失效；
 * 3. 重连有最小间隔：onerror 与看门狗会互相触发，不设间隔就是重连风暴。
 */

/** 看门狗窗口：这么久没有任何帧（notify 或心跳 ping）就主动重建。 */
export const WATCHDOG_MS = 60000;

/** 看门狗检查的起始延迟：比窗口长 5 秒，避免恰好在边界上误判。 */
const WATCHDOG_ARM_MS = WATCHDOG_MS + 5000;

/** 重连最小间隔（毫秒）。 */
const RECONNECT_MIN_GAP_MS = 5000;

/** 通知流连接的最小可判别面。 */
export interface EventSourceLike {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface SessionPorts {
  /** 通知流地址（不含 since 查询参数）。 */
  url: string;
  createSource(url: string): EventSourceLike;
  now(): number;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(handle: number): void;
  /** 非致命问题的留痕出口（解析失败、关闭失败、EventSource 不可用）。 */
  warn(message: string, cause: unknown): void;
}

export interface NotifySession {
  close(): void;
  reconnect(): void;
}

export function startNotifySession(
  ports: SessionPorts,
  onFrame: (frame: Record<string, unknown>) => void,
): NotifySession {
  let source: EventSourceLike | null = null;
  let lastActivity = 0;
  // lastSeq 既是去重水位又是 since 的起点：两者必须同源，否则要么重复提醒、要么漏帧
  let lastSeq = 0;
  let watchdog: number | null = null;
  let lastReconnectAt = 0;

  function armWatchdog(): void {
    if (watchdog !== null) ports.clearTimer(watchdog);
    watchdog = ports.setTimer(() => {
      if (ports.now() - lastActivity > WATCHDOG_MS) forceReconnect();
      else armWatchdog();
    }, WATCHDOG_ARM_MS);
  }

  function forceReconnect(): void {
    const now = ports.now();
    if (now - lastReconnectAt < RECONNECT_MIN_GAP_MS) return;
    lastReconnectAt = now;
    closeSource();
    connect();
  }

  function closeSource(): void {
    if (source === null) return;
    try {
      source.close();
    } catch (error) {
      ports.warn("关闭旧 SSE 连接失败", error);
    }
    source = null;
  }

  function connect(): void {
    closeSource();
    try {
      const url = ports.url + (lastSeq > 0 ? "?since=" + lastSeq : "");
      const next = ports.createSource(url);
      source = next;
      lastActivity = ports.now();
      next.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as Record<string, unknown>;
          lastActivity = ports.now();
          if (data.type === "ping") return;
          if (data.type === "notify") {
            if (typeof data.seq === "number") {
              if (lastSeq > 0 && data.seq <= lastSeq) return;
              lastSeq = data.seq;
            }
            onFrame(data);
          }
        } catch (error) {
          ports.warn("帧解析失败", error);
        }
      };
      next.onerror = () => {
        // 主动重建（带 since 补拉）：EventSource 自动重连不携带 query，无法回放
        forceReconnect();
      };
      armWatchdog();
    } catch (error) {
      ports.warn("EventSource 不可用", error);
    }
  }

  connect();
  return {
    close(): void {
      if (watchdog !== null) ports.clearTimer(watchdog);
      closeSource();
    },
    reconnect: forceReconnect,
  };
}
