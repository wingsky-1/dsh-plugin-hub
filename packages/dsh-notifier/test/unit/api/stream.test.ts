/**
 * dsh-notifier api 域 stream 块 —— SSE 线协议与序号。
 *
 * 判据面：线协议是**与已发布客户端**的约定（字段名刻意与内部帧不同名：客户端读 `message` / `playOnly`，
 * 内部帧叫 `body` / `pop`），序号则决定断线补拉能否正确工作——重置序号会让重连客户端把旧帧当新的，
 * 表现为「偶尔少一条通知」。两件事都没有任何编译期保护。
 *
 * 装配纪律：走 `installApi` 这一条真实路径（序号在装配期从盘上读回）。隔离 home 必须建于模块导入
 * **之前**——序号文件路径在模块加载期就由 `notifierFile()` 定下（`streamHub` 是模块级单例），
 * 导入之后再改 `DSH_HOME` 就写到真实 `~/.dsh` 去了。
 *
 * 用例间隔离：本文件共享一个临时 home 与一个模块级单例，序号会跨用例延续。故每个用例前把刻度文件
 * 删掉，且**每次发布都等它落盘**（写入是 fire-and-forget，不等就可能串到下一个用例的装配里）。
 */
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiDeps, OutgoingFrame } from "../../../src/server/api/deps.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import {
  SEQ_FILE_NAME,
  notifierFile,
  readTextFileSync,
} from "../../../src/server/shared/interface.ts";
import { jsonReq, makeLogger, pollUntil, settleMicrotasks, tempDshHome } from "../../helpers.ts";

const home = tempDshHome();
const { installApi, releaseApi } = await import("../../../src/server/api/interface.ts");
// 端口新增的 dry-run 纯函数走真实实现（动态导入与上同纪：config 单例的落盘路径在构造时定下）。
const { resolveDraftChannels, normalizeConfig } =
  await import("../../../src/server/config/interface.ts");
const { finalizeRequest, barkTarget, browserTarget, systemTarget, webhookTarget } =
  await import("../../../src/server/pipeline/interface.ts");
const { dryRunTarget } = await import("../../../src/server/channels/interface.ts");
// 动态导入而不是顶层静态 import：流实例的落盘路径在构造时定下，静态导入会先于上面的临时 home 求值。
const { streamHub } = await import("../../../src/server/api/impl/stream/index.ts");

/** 视图四件事实：api 域只把它原样透传给设置端点，形状够用即可。 */
const VIEW = { user: {}, revision: 1, writable: true, effective: {} };

beforeEach(() => {
  rmSync(notifierFile(SEQ_FILE_NAME), { force: true });
});

afterEach(() => {
  releaseApi();
});

afterAll(() => {
  home.dispose();
});

/** 假请求：`url` 带 `?since=` 是补拉的关键。 */
function makeReq(url: string): IncomingMessage {
  return jsonReq({ method: "GET", url });
}

/** 假 SSE 响应：连接表要 `on`/`destroyed`/`destroy`，断言要 `text`。`writeOk=false` 用来造背压
 * （write 返回 false 是 stalled 回收唯一认的输入），别的用例都用默认的正常写。 */
function makeRes(writeOk = true) {
  const rec = { status: 0, headers: {} as Record<string, string>, text: "", destroyed: false };
  const listeners = new Map<string, Array<() => void>>();
  const res = {
    get destroyed() {
      return rec.destroyed;
    },
    get writableEnded() {
      return false;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      rec.status = status;
      rec.headers = { ...(headers ?? {}) };
      return res;
    },
    write(chunk: string) {
      rec.text += chunk;
      return writeOk;
    },
    end(chunk?: string) {
      if (chunk !== undefined) rec.text += chunk;
      return res;
    },
    on(event: string, handler: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return res;
    },
    destroy() {
      rec.destroyed = true;
      for (const handler of listeners.get("close") ?? []) handler();
    },
  };
  return { res: res as unknown as ServerResponse, rec };
}

/** 盘上的序号刻度；读不出来给 0。 */
function readSeqFromDisk(): number {
  const read = readTextFileSync(notifierFile(SEQ_FILE_NAME));
  return read.ok ? Number.parseInt(read.text.trim(), 10) || 0 : 0;
}

/** 装配一次 api 域，交出帧发布面（帧入口就是宿主接线的那一条）。 */
function assemble() {
  const routes: WebRoute[] = [];
  const frames: Array<(payload: OutgoingFrame) => void> = [];
  const deps: ApiDeps = {
    register: (route) => {
      routes.push(route);
      return () => {};
    },
    frames: {
      onFrame: (handler) => {
        frames.push(handler);
        return () => {};
      },
    },
    logger: makeLogger(),
    config: {
      readConfig: () => ({ ...DEFAULT_CONFIG }),
      readSettingsView: () => VIEW,
      writeConfig: async () => ({ ok: true, view: VIEW }),
      resolveDraftChannels,
      normalizeConfig,
    },
    stores: {
      readHistory: async () => [],
      clearHistory: async () => 0,
      readStatus: async () => ({}),
    },
    pipeline: {
      submit: () => {},
      finalizeRequest,
      barkTarget,
      browserTarget,
      systemTarget,
      webhookTarget,
    },
    kinds: { listKinds: () => [], confirmKind: async () => ({ ok: true, view: VIEW }) },
    // 流块不碰能力面，但端口是必填的：这里给一份最小实现，本文件不该因为别人的面长大而改
    channels: {
      probeCapabilities: () => Promise.reject(new Error("流块不该碰能力面")),
      hostPlatform: () => "linux",
      undeterminedCapabilities: () => {
        throw new Error("流块不碰能力面");
      },
      dryRunTarget,
    },
  };
  installApi(deps);
  const publish = (payload: OutgoingFrame): void => {
    for (const handler of frames) handler(payload);
  };
  return {
    routes,
    publish,
  };
}

/** 发布一帧并等序号落盘：写入是 fire-and-forget，不等就会串到下一个用例的装配里。 */
async function publishAndSettle(publish: (payload: OutgoingFrame) => void, payload: OutgoingFrame) {
  const before = readSeqFromDisk();
  publish(payload);
  await pollUntil(() => readSeqFromDisk() === before + 1, "序号未落盘");
}

/** 一帧通知的内部形状；`pop: false` 是「只响不弹」。 */
function frame(
  over: Partial<OutgoingFrame["frame"]> = {},
  kind: OutgoingFrame["kind"] = "done",
): OutgoingFrame {
  return {
    kind,
    frame: {
      pop: true,
      sound: { mode: "system" },
      whenVisible: false,
      title: "标题",
      body: "正文",
      ...over,
    },
  };
}

/** 假响应与其可观测记录（判据只钉在这份记录与连接表 size 上）。 */
type FakeRes = ReturnType<typeof makeRes>;

/** 接上一条 SSE 连接（`handle` 同步写完响应头与回放帧）；`make` 让回收类用例换成背压响应。 */
function connect(
  routes: WebRoute[],
  url = "/api/dsh-notifier/events",
  make: () => FakeRes = makeRes,
) {
  const route = routes.find((item) => item.path === "/api/dsh-notifier/events");
  if (route === undefined) throw new Error("events 路由未注册");
  const captured = make();
  route.handler(makeReq(url), captured.res);
  return captured;
}

/** 从响应文本里取出全部 `data:` 帧（注释锚点与空行不算）。 */
function framesOf(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>);
}

describe("线协议：内部帧 → 客户端读的字段名", () => {
  it("弹窗帧带 message 与序号，且不带 playOnly（客户端判 `=== true`，缺席即照常弹）", async () => {
    const { routes, publish } = assemble();
    await publishAndSettle(publish, frame({ title: "标题", body: "正文" }));

    const [event] = framesOf(connect(routes).rec.text);
    expect(event!.type).toBe("notify");
    expect(event!.seq).toBe(1);
    expect(event!.kind).toBe("done");
    expect(event!.title).toBe("标题");
    expect(event!.message).toBe("正文");
    expect(event!.sound).toEqual({ mode: "system" });
    expect("playOnly" in event!).toBe(false);
    expect("body" in event!).toBe(false);
  });

  it("pop=false 的帧带 playOnly: true（只响不弹是客户端唯一的分支依据）", async () => {
    const { routes, publish } = assemble();
    await publishAndSettle(publish, frame({ pop: false }));

    const [event] = framesOf(connect(routes).rec.text);
    expect(event!.playOnly).toBe(true);
  });

  it("开流先写注释锚点并要求反代不缓冲（否则客户端要么等到 30s 心跳才进入 OPEN，要么消息被攒成一坨）", () => {
    const { routes } = assemble();
    const { rec } = connect(routes);
    expect(rec.status).toBe(200);
    expect(rec.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(rec.headers["x-accel-buffering"]).toBe("no");
    expect(rec.text.startsWith(": connected\n\n")).toBe(true);
  });
});

describe("序号：落盘并跨装配接着数", () => {
  it("没有刻度文件时第一帧从 1 起算，并把刻度写到盘上", async () => {
    const { routes, publish } = assemble();
    await publishAndSettle(publish, frame());

    expect(framesOf(connect(routes).rec.text).map((event) => event.seq)).toEqual([1]);
    expect(readSeqFromDisk()).toBe(1);
  });

  it("重新装配后接着数（重置会让重连客户端把旧帧当新的，表现为偶尔少一条通知）", async () => {
    const first = assemble();
    await publishAndSettle(first.publish, frame());

    releaseApi();
    const second = assemble();
    await publishAndSettle(second.publish, frame());

    expect(framesOf(connect(second.routes).rec.text).map((event) => event.seq)).toEqual([2]);
  });

  // 刻度文件是磁盘上的东西：断电截断、被别的工具写过都会留下脏值。负刻度若原样采纳，新帧的序号
  // 会接在负值后面（重连客户端 `since` 全是正数，于是每一帧都被当成旧的丢掉）；非数字与空白则
  // 必须回落 0。表里只有 `-5` 那一档能杀掉「去掉 parsed > 0 守卫」的改写；`abc` 一档代表
  // 「非数字」（`"   "` 与它走同一条 `Number.isFinite` 分支，合成一档不丢信息），空文件是另一条读路径。
  it.each([["-5"], ["abc"], [""]])(
    "刻度文件是脏值（%j）时从 0 起算：第一帧仍是 1，负值不被采纳",
    async (text) => {
      const file = notifierFile(SEQ_FILE_NAME);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);

      const { routes, publish } = assemble();
      publish(frame());
      await pollUntil(() => readSeqFromDisk() === 1, "脏刻度被当成 0 之后第一帧写回 1");

      expect(framesOf(connect(routes).rec.text).map((event) => event.seq)).toEqual([1]);
    },
  );
});

describe("断线补拉：?since=N", () => {
  it("只回放序号大于 since 的帧（补拉的窗口语义就是这一个比较）", async () => {
    const { routes, publish } = assemble();
    await publishAndSettle(publish, frame());
    await publishAndSettle(publish, frame());
    await publishAndSettle(publish, frame());

    const replayed = framesOf(connect(routes, "/api/dsh-notifier/events?since=1").rec.text);
    expect(replayed.map((event) => event.seq)).toEqual([2, 3]);
  });

  it("since 缺失或非法一律当 0：宁可多回放，不能因为一个脏参数把补拉窗口关掉", async () => {
    const { routes, publish } = assemble();
    await publishAndSettle(publish, frame());
    await publishAndSettle(publish, frame());

    for (const url of [
      "/api/dsh-notifier/events",
      "/api/dsh-notifier/events?since=abc",
      "/api/dsh-notifier/events?since=-3",
    ]) {
      expect(
        framesOf(connect(routes, url).rec.text).map((event) => event.seq),
        url,
      ).toEqual([1, 2]);
    }
  });
});

describe("广播：已连接的客户端立刻收到新帧", () => {
  it("连接建立后发布的帧直接写进该连接（否则用户要等重连才看到，通知就不叫通知了）", async () => {
    const { routes, publish } = assemble();
    const { rec } = connect(routes);
    expect(framesOf(rec.text)).toEqual([]);

    await publishAndSettle(publish, frame({ title: "后来的" }));
    expect(framesOf(rec.text).map((event) => event.title)).toEqual(["后来的"]);
  });
});

describe("回放缓冲：上限 200 条", () => {
  // 缓冲无上限会随进程寿命线性涨；淘汰错对象（挤掉最新的那条）会让断线重连恰好丢掉最新一条通知，
  // 多淘汰一条则窗口比声明的窄。窗口长度与「挤掉哪一头」都只有把边界算清才看得出来。
  it("到上限不淘汰、超出即淘汰最旧的：200 条时首帧还在，第 201 条把首帧挤出窗口", async () => {
    const { routes, publish } = assemble();
    for (let index = 1; index <= 200; index += 1) {
      await publishAndSettle(publish, frame({ title: `第 ${index} 条` }));
    }

    const atLimit = framesOf(connect(routes).rec.text);
    expect(atLimit).toHaveLength(200);
    expect(atLimit[0]!.seq).toBe(1);
    expect(atLimit[0]!.title).toBe("第 1 条");
    expect(atLimit.at(-1)!.seq).toBe(200);

    await publishAndSettle(publish, frame({ title: "第 201 条" }));

    const overLimit = framesOf(connect(routes).rec.text);
    expect(overLimit).toHaveLength(200);
    expect(overLimit[0]!.seq).toBe(2);
    expect(overLimit[0]!.title).toBe("第 2 条");
    expect(overLimit.map((event) => event.seq)).toEqual(
      Array.from({ length: 200 }, (_item, index) => index + 2),
    );
  });
});

describe("装配守卫：未装配与重复装配", () => {
  // 第二次装配会换掉连接表与序号来源，而序号是从盘上读回来的——半途换掉就是「同一个进程两套刻度」。
  it("重复装配当场抛错（单例语义：第二次装配会换掉连接表与刻度来源）", () => {
    assemble();
    expect(() =>
      streamHub.install({
        logger: makeLogger(),
      }),
    ).toThrow(/api 流只能装配一次/u);
  });

  // 未装配时静默工作、或让 publish 推进刻度，都会在下一次装配时冒出一批谁也没发过的旧帧。
  it("未装配时 handle 回 503 空响应，publish 被丢弃且不写刻度文件", async () => {
    const { routes } = assemble();
    releaseApi();

    const refused = connect(routes);
    expect(refused.rec.status).toBe(503);
    expect(refused.rec.text).toBe("");

    // 刻度文件是被 publish 创建的。这里**不能**用真实 sleep 当否定判据——它只证明「还没写」，
    // 慢 runner 上假绿（实测：把落盘改成 120ms 后才发生的迟写，25ms 的等待照样全绿）。
    // 假时钟必须在 publish **之前**装上：晚装的话，publish 时排下的真实定时器不在假时钟管辖内，
    // 推进假时钟推不动它，「迟写」这类坏法照样漏过（这正是这条判据第一版没抓住的形态）。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      streamHub.publish(frame());
      // 假时钟让「排进定时器的写入」确定性触发；它触发的 fs 落在真实事件循环里，故再排空几轮队列
      // 等它落地（有界的队列排水，不是等一个时长）。
      await vi.advanceTimersByTimeAsync(1_000);
      for (let turn = 0; turn < 10; turn += 1) await settleMicrotasks();
    } finally {
      vi.useRealTimers();
    }
    expect(readSeqFromDisk()).toBe(0);
  });
});

describe("主动回收：连接上限机制移除后，连接表的有界性只剩这两路", () => {
  // 上限机制退役后，连接表没有「触顶淘汰」这条确定性收口了。真正会把表撑爆的是半开连接：
  // 设备息屏 / NAT 静默掐断不发 FIN，close/error 都不触发，写心跳也不抛错（数据进内核缓冲），
  // 于是一个不再消费的客户端会永远挂在表里。清掉它只剩共享层心跳里的两路主动回收。
  // 其中 destroyed 那一路由 dsh-mcp-manager 的 unit-routes-sse.test.ts 覆盖，stalled / maxAge
  // 两路**全仓再无第二条判据**——任一路静默失效（判定恒 false、窗口算式写反、心跳写被当成
  // 业务活动刷新 lastWriteAt），连接表就随半开连接无界增长，而没有任何用例会红。
  // 所以这两条不是「顺手补覆盖」，它们是移除上限之后仅存的有界性证据，不可省。
  // 断言只钉可观测事实（连接被 destroy、连接表 size 变化）；evictStats 是 /health 的观测面，
  // 拿它当判据等于用「实现自报的账」证明「实现干了事」。
  //
  // 假钟必须在 assemble() 之前装上：心跳的 setInterval 是装配期由枢纽建立的，晚装的话那颗
  // 真实定时器不归假钟管，推进假钟一次 tick 都推不动（本文件「装配守卫」用例踩过同一坑）。
  it("stalled 回收：写持续被拒（背压）超过窗口即判死，连接被 destroy 且连接表归零", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const { routes } = assemble();
      // 只会被拒的连接：每次心跳写都返回 false，stalled 窗口从第一次心跳起算。
      const { rec } = connect(routes, "/api/dsh-notifier/events", () => makeRes(false));
      expect(streamHub.size()).toBe(1);

      // 流块心跳 30s、共享层 stalled 窗口 90s（都是各自的默认值，notifier 未注入覆盖）：
      // 推进 150s 足以把「背压起始 + 超窗」两个条件都送到，且越过判死那一 tick。
      await vi.advanceTimersByTimeAsync(150_000);

      expect(rec.destroyed).toBe(true);
      expect(streamHub.size()).toBe(0);
    } finally {
      // 假钟还管着 clearInterval 时先卸载停心跳，再恢复真实时钟。
      releaseApi();
      vi.useRealTimers();
    }
  });

  it("maxAge 回收：存活超上限且业务空闲的连接被 destroy（心跳写不算业务活动）", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const { routes } = assemble();
      // 正常连接的写恒成功，但心跳写按共享层语义不算业务活动：lastWriteAt 停在注册时刻。
      const { rec } = connect(routes);
      expect(streamHub.size()).toBe(1);

      // 共享层 maxAge 120min、空闲门槛 15min（默认值）：推进 125min 越过 maxAge 那一 tick。
      // 「空闲」这一半同时是「假活动陷阱」的判据：一旦心跳写开始刷 lastWriteAt，每 30s 都新鲜，
      // 这条连接再也够不到 15min 空闲门槛，本用例会红。
      await vi.advanceTimersByTimeAsync(125 * 60_000);

      expect(rec.destroyed).toBe(true);
      expect(streamHub.size()).toBe(0);
    } finally {
      releaseApi();
      vi.useRealTimers();
    }
  });
});
