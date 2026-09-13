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
import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApiDeps, OutgoingFrame } from "../../../src/server/api/deps.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import {
  SEQ_FILE_NAME,
  notifierFile,
  readTextFileSync,
} from "../../../src/server/shared/interface.ts";
import { makeLogger, pollUntil, tempDshHome } from "../../helpers.ts";

const home = tempDshHome();
const { installApi, releaseApi } = await import("../../../src/server/api/interface.ts");

/** 视图四件事实：流块只用 `readConfig`，其余两处给足形状即可。 */
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
  return {
    method: "GET",
    url,
    headers: { host: "127.0.0.1:3080" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

/** 假 SSE 响应：连接表要 `on`/`destroyed`/`destroy`，断言要 `text`。 */
function makeRes() {
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
      return true;
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
      readConfig: () => ({ ...DEFAULT_CONFIG, maxConnections: 8 }),
      readSettingsView: () => VIEW,
      writeConfig: async () => ({ ok: true, view: VIEW }),
    },
    stores: {
      readHistory: async () => [],
      clearHistory: async () => 0,
      readStatus: async () => ({}),
    },
    pipeline: { submit: () => {} },
    kinds: { listKinds: () => [], confirmKind: async () => ({ ok: true, view: VIEW }) },
  };
  installApi(deps);
  const publish = (payload: OutgoingFrame): void => {
    for (const handler of frames) handler(payload);
  };
  return { routes, publish };
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
    frame: { pop: true, sound: { mode: "system" }, title: "标题", body: "正文", ...over },
  };
}

/** 接上一条 SSE 连接（`handle` 同步写完响应头与回放帧）。 */
function connect(routes: WebRoute[], url = "/api/dsh-notifier/events") {
  const route = routes.find((item) => item.path === "/api/dsh-notifier/events");
  if (route === undefined) throw new Error("events 路由未注册");
  const captured = makeRes();
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
