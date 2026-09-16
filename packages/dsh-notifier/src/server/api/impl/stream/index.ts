/** api 域流块：SSE 连接、序号与断线补拉（共享层枢纽只管连接表、心跳与主动回收）。**序号**持久化在 `seq.json` 且重启后
 * 接着数——重置会让重连客户端把旧帧当新的，表现为「偶尔少一条通知」；**补拉**走 `?since=N`（EventSource 自动重连不带 query）。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createSseHub,
  type SseEvictStats,
  type SseHub,
} from "../../../../../../../shared/sse-hub.js";
import {
  readTextFileSync,
  writeTextAtomic,
  SEQ_FILE_NAME,
  notifierFile,
} from "../../../shared/interface.ts";
import type { OutgoingFrame } from "../../deps.ts";
import type { StreamDeps, StreamEvent } from "./type.ts";

/** 补拉缓冲上限（条）：断线重连能回放的窗口，超出后只能从最新开始接。 */
const REPLAY_LIMIT = 200;

/** 心跳间隔（毫秒）：与客户端 60s 看门狗对齐，留足两次失败的余地。 */
const HEARTBEAT_MS = 30000;

/** 开流锚点。注释帧客户端不解析，它的作用是**立即 flush 响应头**：Node 会缓冲响应头直到第一次写入，没有这一行，
 * 客户端要等到第一个心跳（30s 后）才从 CONNECTING 进入 OPEN。 */
const CONNECTED = ": connected\n\n";

/** 线协议里的通知事件（`ping` 之外的那一支）。 */
type NotifyEvent = Extract<StreamEvent, { type: "notify" }>;

/** 未装配时的占位。占位值不会被真正读到（`installed` 守卫），它的作用是让字段有确定的类型、不必每个使用点判空。 */
const UNINSTALLED: StreamDeps = {
  logger: { warn: () => {} },
};

/** 未装配的枢纽：连接表为空，`dispose` 幂等。返回形状必须与真实枢纽逐键一致，否则「未装配」与
 * 「已装配但一条都没淘汰」在 `/health` 上长得不一样。 */
const UNINSTALLED_HUB: SseHub = {
  register: () => {},
  broadcast: () => {},
  size: () => 0,
  evictStats: () => ({
    close: 0,
    error: 0,
    stalled: 0,
    maxage: 0,
    destroyed: 0,
    dispose: 0,
  }),
  connHealth: () => [],
  dispose: () => {},
};

/** 流枢纽：连接表在共享层，序号与补拉在本块。 */
class StreamHub {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /** 装配入参（失败出口）。 */
  private deps: StreamDeps = UNINSTALLED;
  /** 枢纽：心跳与回收由共享层跑。 */
  private hub: SseHub = UNINSTALLED_HUB;
  /** 单调序号：上次进程留下的值往后接着数。 */
  private seq = 0;
  /** 补拉缓冲：只留最近 `REPLAY_LIMIT` 条。 */
  private replay: StreamEvent[] = [];
  /** 序号落盘位置：DSH home 由环境决定、进程内不变，故随实例一次性定下。 */
  private readonly file = notifierFile(SEQ_FILE_NAME);

  /** 装配：读回上次的序号，建起连接表与心跳。 */
  install(deps: StreamDeps): void {
    if (this.installed) throw new Error("dsh-notifier: api 流只能装配一次");
    this.installed = true;
    this.deps = deps;
    this.seq = readSeq(this.file);
    this.hub = createSseHub({
      heartbeatMs: HEARTBEAT_MS,
    });
  }

  /** 卸载：停心跳、关连接、忘掉缓冲。序号留在盘上，下次接着数。 */
  release(): void {
    this.hub.dispose();
    this.hub = UNINSTALLED_HUB;
    this.replay = [];
    this.installed = false;
  }

  /** 当前连接数。语义是**服务端未释放的句柄数**，不是「在线设备数」：两者混起来会让刷新页面的残留句柄看起来像多了
   * 一台设备。 */
  size(): number {
    return this.hub.size();
  }

  /** 回收原因计数：`/health` 的 `sseEvicts` 观测面（常量大小的聚合）。per-conn 明细（`connHealth`）
   * 故意不上去——它随连接数增长，而 `/health` 经 lan-proxy 对局域网可见。 */
  evictStats(): SseEvictStats {
    return this.hub.evictStats();
  }

  /** GET /events：接上一条 SSE 连接，并回放 `?since` 之后的帧。 */
  handle(req: IncomingMessage, res: ServerResponse): void {
    if (!this.installed) {
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      // 反代缓冲会把 SSE 攒成一次性大响应，客户端看起来像「连上了但一直没消息」。
      "x-accel-buffering": "no",
    });
    res.write(CONNECTED);
    for (const event of this.since(sinceOf(req))) res.write(encode(event));
    this.hub.register(res);
  }

  /**
   * 广播一条通知帧：翻成线协议 → 编号 → 入缓冲 → 落序号 → 推给所有连接。翻译（`body`→`message`、
   * `pop`→`playOnly`）在这里而不在裁决管线：线协议是**浏览器出口**的约定，管线对外给的是内部帧，
   * 翻译上移会让内部词汇被线协议反向锁死。
   */
  publish(payload: OutgoingFrame): void {
    if (!this.installed) return;
    this.seq += 1;
    const { frame } = payload;
    const event: NotifyEvent = {
      type: "notify",
      seq: this.seq,
      kind: payload.kind,
      title: frame.title,
      message: frame.body,
      ts: Date.now(),
      sound: frame.sound,
      // 可见性判定归浏览器出口，帧自描述：客户端拿到就能执行，不必回查自己那份可能已过期的配置快照。
      whenVisible: frame.whenVisible,
    };
    // 缺席而不是 `false`：客户端判的是 `=== true`，而缺席让不认识这个字段的旧客户端收到的帧
    // 与从前逐字节一致。
    if (!frame.pop) event.playOnly = true;
    this.replay.push(event);
    if (this.replay.length > REPLAY_LIMIT) this.replay.splice(0, this.replay.length - REPLAY_LIMIT);
    // 序号是 fire-and-forget：写失败只让下次重启回退几条，不值得挡住广播。
    void writeTextAtomic(this.file, `${this.seq}\n`);
    this.hub.broadcast(encode(event));
  }

  /** 序号大于 `since` 的帧，按序。 */
  private since(value: number): StreamEvent[] {
    return this.replay.filter((event) => event.type === "notify" && event.seq > value);
  }
}

/** 一帧的 SSE 文本：`data:` 行加空行结束（客户端按 `onmessage` 收）。 */
function encode(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** 从请求 URL 取 `?since=`；缺失或非法一律当 0（= 回放整个缓冲）。 */
function sinceOf(req: IncomingMessage): number {
  const query = (req.url ?? "").split("?")[1];
  if (query === undefined) return 0;
  const raw = new URLSearchParams(query).get("since");
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** 读回上次进程留下的序号；文件缺失或内容不是正数都从 0 起算。 */
function readSeq(file: string): number {
  const read = readTextFileSync(file);
  if (!read.ok) return 0;
  const parsed = Number.parseInt(read.text.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** 本域唯一的流实例：类不外放，外面 `new` 不出第二份序号。 */
export const streamHub = new StreamHub();
