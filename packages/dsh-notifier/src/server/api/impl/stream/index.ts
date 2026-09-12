/**
 * dsh-notifier api 域 —— 流块：SSE 连接、序号与断线补拉。
 *
 * 共享层的枢纽只管连接表、心跳与上限淘汰（#515 的 stalled / maxAge 回收都在那边）。
 * 三件本插件特有的事在这里：
 *
 * - **序号**：单调递增且持久化（`seq.json`），重启后接着数。重置序号会让重连的客户端
 *   把旧帧当新的、或把新帧当旧的丢掉，而两种都表现为「偶尔少一条通知」；
 * - **补拉缓冲**：客户端重连带 `?since=N`，服务端回放序号更大的帧。EventSource 的
 *   自动重连不带 query，所以这条路径只在客户端主动重建时走到；
 * - **帧编码**：`data:` 行的文本由本块生成——枢纽的契约明写负载生成留调用方。
 *
 * 状态收在实例字段里。类可以被实例化多次，但域只装配一个——「一份序号」这件事靠
 * 契约层不导出实例来保证，而不是靠把状态藏进闭包让别人够不着。
 *
 * 依赖方向：只引用本目录、`../../deps.ts` 与包内共享层，不引用 `interface.ts`。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readTextFileSync, writeTextAtomic } from "../../../shared/file-io.ts";
import { SEQ_FILE_NAME, notifierFile } from "../../../shared/paths.ts";
import type { OutgoingFrame, SseHub } from "../../deps.ts";
import { createSseHub, readConfig } from "../../deps.ts";
import type { StreamDeps, StreamEvent } from "./type.ts";

/** 补拉缓冲上限（条）：断线重连能回放的窗口，超出后只能从最新开始接。 */
const REPLAY_LIMIT = 200;

/** 心跳间隔（毫秒）：与客户端 60s 看门狗对齐，留足两次失败的余地。 */
const HEARTBEAT_MS = 30000;

/**
 * 未装配时的占位。
 *
 * 装配是必经路径（`installed` 守卫），占位值不会被真正读到；它的作用是让字段有确定
 * 的类型，从而不必让每个使用点都先判一次空。
 */
const UNINSTALLED: StreamDeps = { logger: { warn: () => {} } };

/** 未装配的枢纽：连接表为空，`dispose` 幂等。 */
const UNINSTALLED_HUB: SseHub = {
  register: () => {},
  broadcast: () => {},
  size: () => 0,
  evictStats: () => ({ close: 0, error: 0, limit: 0, stalled: 0, maxage: 0, destroyed: 0 }),
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
      // 连接上限实时读设置：用户在设置页调小之后，下一次淘汰就该按新值来。
      getMaxConnections: () => readConfig().maxConnections,
      heartbeatMs: HEARTBEAT_MS,
      warn: (message: string) => this.deps.logger.warn(message),
    });
  }

  /** 卸载：停心跳、关连接、忘掉缓冲。序号留在盘上，下次接着数。 */
  release(): void {
    this.hub.dispose();
    this.hub = UNINSTALLED_HUB;
    this.replay = [];
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
    for (const event of this.since(sinceOf(req))) res.write(encode(event));
    this.hub.register(res);
  }

  /** 广播一条通知帧：编号、入缓冲、落序号、推给所有连接。 */
  publish(payload: OutgoingFrame): void {
    if (!this.installed) return;
    this.seq += 1;
    const event: StreamEvent = { type: "notify", seq: this.seq, kind: payload.kind, frame: payload.frame };
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
