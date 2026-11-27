/**
 * dsh-notifier 客户端 —— SSE 通知流会话。
 *
 * 连接、看门狗、断线重连与 seq 去重原先直接 new EventSource 并用真实的 setTimeout/Date.now，
 * 于是「重连是否带上 since」「重复帧有没有被丢」「半开连接能不能被发现」全都测不到——而这三条
 * 正是断线窗口里丢通知的三个成因。时间与连接都从端口进来之后，它们可以用假时钟与假
 * EventSource 精确驱动。
 *
 * 四条语义是刻意的，别在重写时简化：
 * 1. 重连必须带 since：EventSource 自动重连不携带 query，不带就等于把断线期间的事件丢掉；
 *    首连没有已见水位（`lastSeq=0`）则**不带** since——服务端把缺省当新会话、不回放旧缓冲；
 * 2. 每次连接先收服务端 hello，按三态处理（#1143 v2）：
 *    - fresh（本地 lastSeq=0）：用 `hello.seq` 播种水位，随后到达的回放帧一律当旧帧丢弃；
 *    - resume（covered=true 且 lastSeq>0）：**不把水位抬到 hello.seq**，否则回放帧会被去重挡掉；
 *    - gap（covered=false 或服务端序号回退）：水位抬到 hello.seq、丢弃回放帧，并提示一次
 *      「可能错过」——不拉 /history 计数（有竞态、会低估，且不能当告警开关）；
 *    旧服务端没有 hello 时回落既有水位语义（逐帧 seq 去重），不伪造缺口。
 * 3. 只有**解析成功**的帧才刷新 lastActivity——畸形帧不该让半开检测失效；
 * 4. onerror 一律先 close 旧连接再**自调度**重连：EventSource 原生重连不携带 query，关晚了它就会
 *    裸奔重连并丢掉断线期间的帧；节流只把重连往后推，不让原生重连接管。
 */

/** 看门狗窗口：这么久没有任何帧（notify 或心跳 ping）就主动重建。 */
export const WATCHDOG_MS = 60000;

/** 看门狗检查的起始延迟：比窗口长 5 秒，避免恰好在边界上误判。 */
const WATCHDOG_ARM_MS = WATCHDOG_MS + 5000;

/** 重连最小间隔（毫秒）：节流只延迟自重连，不阻止它发生。 */
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

/** hello 的处置：新本水位（null = 保持不变）与是否要提示缺口。畸形 hello 当旧服务端（两者皆否）。 */
function readHello(
  lastSeq: number,
  data: Record<string, unknown>,
): { readonly watermark: number | null; readonly hint: boolean } {
  const seq = data.seq;
  if (typeof seq !== "number" || !Number.isFinite(seq) || seq < 0) {
    return { watermark: null, hint: false };
  }
  if (lastSeq === 0 || lastSeq === seq) {
    // fresh：用服务端高水位播种；追平：没有要补的帧，水位不动。
    return { watermark: seq, hint: false };
  }
  if (lastSeq < seq && data.covered === true) {
    // resume：不抬水位——回放帧的 seq 落在 (lastSeq, hello.seq]，抬了就会被去重丢掉。
    return { watermark: null, hint: false };
  }
  // gap（覆盖不了）或序号回退：跳到服务端当前高水位，旧帧丢弃，显式提示一次。
  return { watermark: seq, hint: true };
}

export function startNotifySession(
  ports: SessionPorts,
  onFrame: (frame: Record<string, unknown>) => void,
  /** 缺口提示：一次未覆盖的 hello 调一次（由接线方落成用户可见的提示）。 */
  onGap?: () => void,
): NotifySession {
  let source: EventSourceLike | null = null;
  let lastActivity = 0;
  // lastSeq 既是去重水位又是 since 的起点：两者必须同源，否则要么重复提醒、要么漏帧。
  // 0 是**无水位**（首连 / 刷新后的新会话）：不带 since，服务端不回放旧帧。
  let lastSeq = 0;
  let watchdog: number | null = null;
  /** 节流窗口内排下的自重连（同一时刻至多一个）。 */
  let reconnectTimer: number | null = null;
  /** 上一次自调度重连的时刻；0 = 还没有过，首次 onerror 立即重连。 */
  let lastReconnectAt = 0;
  let closed = false;

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) return;
    ports.clearTimer(reconnectTimer);
    reconnectTimer = null;
  }

  function armWatchdog(): void {
    if (watchdog !== null) ports.clearTimer(watchdog);
    watchdog = ports.setTimer(() => {
      watchdog = null;
      if (ports.now() - lastActivity > WATCHDOG_MS) forceReconnect();
      else armWatchdog();
    }, WATCHDOG_ARM_MS);
  }

  /** 自调度重连：节流窗口内排定时器到点再连，窗口外立即连；旧连接由调用方先 close。 */
  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== null) return;
    const wait = Math.max(0, lastReconnectAt + RECONNECT_MIN_GAP_MS - ports.now());
    if (wait === 0) {
      lastReconnectAt = ports.now();
      connect();
      return;
    }
    reconnectTimer = ports.setTimer(() => {
      reconnectTimer = null;
      if (closed) return;
      lastReconnectAt = ports.now();
      connect();
    }, wait);
  }

  function forceReconnect(): void {
    if (closed) return;
    closeSource();
    scheduleReconnect();
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

  /** hello 三态：fresh 播种、resume 保持水位、gap/序号回退抬水位并提示一次。 */
  function applyHello(data: Record<string, unknown>): void {
    const hello = readHello(lastSeq, data);
    if (hello.watermark !== null) lastSeq = hello.watermark;
    if (hello.hint) onGap?.();
  }

  function connect(): void {
    if (closed) return;
    clearReconnectTimer();
    closeSource();
    try {
      // lastSeq=0 即无水位：首连不带 since，服务端按新会话处理、不回放旧缓冲。
      const url = ports.url + (lastSeq > 0 ? "?since=" + lastSeq : "");
      const next = ports.createSource(url);
      source = next;
      lastActivity = ports.now();
      next.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as Record<string, unknown>;
          lastActivity = ports.now();
          if (data.type === "ping") return;
          if (data.type === "hello") {
            applyHello(data);
            return;
          }
          if (data.type === "notify") {
            if (typeof data.seq === "number") {
              // 无水位时没有可比较的已见帧，第一帧一律放行；有水位才丢重复与更旧的帧。
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
        // 只认仍是当前连接的那一条：close 之后旧闭包再被调用不该重复调度。
        if (source !== next) return;
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
      if (closed) return;
      closed = true;
      if (watchdog !== null) {
        ports.clearTimer(watchdog);
        watchdog = null;
      }
      clearReconnectTimer();
      closeSource();
    },
    reconnect: forceReconnect,
  };
}
