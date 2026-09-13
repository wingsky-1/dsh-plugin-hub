/**
 * dsh-notifier channels 域 deliver 块 —— 投递编排的 fail-soft 与展示上限。
 *
 * 判据为什么落在这里：出口承诺「失败是返回值，不是异常」，而 `deliver` 是唯一能证明这句承诺被
 * 守住的地方——一次拒绝若冒给 `Promise.all`，整批一起失败，调用方只能记一条「全都没发出去」。
 * 上限表同住一块：出口与编排共用同一份，改错一个数字同时影响所有出口的截断。
 * 出口一律用本地假目标：真出口要发网络 / 起子进程，而本块要守的是编排语义，不是出口行为。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { deliver } from "../../../src/server/channels/interface.ts";
import type {
  DeliveryTarget,
  NotifyFrame,
  NotifyMessage,
} from "../../../src/server/channels/interface.ts";
import {
  FAILURE_REASON_MAX,
  displayCaps,
  truncateCodePoints,
} from "../../../src/server/channels/impl/deliver/caps.ts";
import { pollUntil, stubFetch, wire } from "../../helpers.ts";

/** 待投递消息：`ts` 写死不取 `Date.now()`，免得断言跟着运行时刻漂。 */
function messageOf(over: Partial<NotifyMessage> = {}): NotifyMessage {
  return { title: "标题", body: "正文", kind: "done", ts: 1_700_000_000_000, ...over };
}

/** 待兑现的 promise：用来制造「上一个出口还挂着」的现场。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** 一个浏览器出口目标：`emitFrame` 由本用例给，用来观测编排何时触达出口。 */
function browserTarget(emitFrame: (frame: NotifyFrame) => void): DeliveryTarget {
  return { type: "browser", popup: true, sound: false, whenVisible: false, emitFrame };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deliver：并发投递，逐目标 fail-soft", () => {
  // 一个出口卡住（bark 的硬超时是 10s）不该把同批的系统通知一起压住。
  it("一个出口卡住不拖住同批其它出口（串行 await 会让 10s 超时的 bark 压住系统通知）", async () => {
    const gate = deferred<Response>();
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: unknown) => {
      const url = String(input);
      calls.push(url);
      const response = url.endsWith("/slow")
        ? gate.promise
        : Promise.resolve(new Response("{}", { status: 200 }));
      return response;
    });

    const pending = deliver(messageOf(), [
      { type: "bark", baseUrl: "http://127.0.0.1:40281/slow", deviceKey: "dk" },
      { type: "bark", baseUrl: "http://127.0.0.1:40281/fast", deviceKey: "dk" },
    ]);
    await pollUntil(() => calls.length === 2, "快出口应在慢出口返回之前就发出");
    gate.resolve(new Response("{}", { status: 200 }));
    expect((await pending).map((result) => result.status)).toEqual(["ok", "ok"]);
  });

  // 违约若冒给 Promise.all，真实到达的出口也一起背锅，调用方只能记一条「全都没发出去」。
  it("出口违约被收成本条失败，不牵连同批其它出口；结果与 targets 同序（错位等于把失败记到别人头上）", async () => {
    const emitted: NotifyFrame[] = [];
    const results = await deliver(messageOf(), [
      browserTarget(() => {
        throw new Error("帧出口已断开");
      }),
      browserTarget((frame) => {
        emitted.push(frame);
      }),
    ]);
    // 违约的出口没给出任何证据，故 stage 取 accepted；再投一次只是把同一个洞踩第二遍，故不可重试。
    expect(results[0]).toEqual({
      status: "failed",
      stage: "accepted",
      reason: "帧出口已断开",
      retryable: false,
    });
    expect(results[1]).toEqual({ status: "ok", stage: "accepted" });
    expect(emitted).toHaveLength(1);
  });

  // 未知出口类型若落成空元素，下游读 `result.status` 会当场 TypeError，整批结果连同一起来到
  // 这一步的出口一起丢；跨边界值不受编译期联合约束，故判的是这一侧的行为。
  it("未知投递目标类型：该目标收成一条失败明细，其余目标照常投递，结果里不出现空元素", async () => {
    const emitted: NotifyFrame[] = [];
    const results = await deliver(messageOf(), [
      wire<DeliveryTarget>({ type: "slack" }),
      browserTarget((frame) => {
        emitted.push(frame);
      }),
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      status: "failed",
      stage: "accepted",
      reason: "未知投递目标类型: slack",
      retryable: false,
    });
    expect(results[1]).toEqual({ status: "ok", stage: "accepted" });
    expect(emitted).toHaveLength(1);
  });

  // 派发表漏一个 case，那个出口的目标会被判成「未知类型」——用户看到的是「webhook 频道永远失败」。
  it("webhook 目标经派发表走到出口：真发出请求并回报出口的结论（漏 case 即该出口永远失败）", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const results = await deliver(messageOf(), [
      { type: "webhook", url: "http://127.0.0.1:40281/hook", preset: "raw" },
    ]);

    expect(results).toEqual([{ status: "ok", stage: "delivered" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
  });
});

describe("展示上限：码点口径与逐出口数值", () => {
  // 按 UTF-16 截会腰斩 emoji：屏幕上出现替换符，等于用户看到的内容被改坏。
  it("按码点截断：emoji 代理对不会被腰斩成替换符（按 UTF-16 切会留下孤立高位代理）", () => {
    expect(truncateCodePoints("🙂🙂", 1)).toBe("🙂");
    expect(truncateCodePoints("🙂".repeat(64), 64)).toBe("🙂".repeat(64));
  });

  // 上限是各外部系统容忍度的编码，改宽一处就会让某个出口收到它显示不了的长度。
  it("上限表是外部系统容忍度的编码：system 正文只有 256，webhook/bark 4096，页面 2048", () => {
    expect(displayCaps.system).toEqual({ titleMax: 64, bodyMax: 256 });
    expect(displayCaps.bark).toEqual({ titleMax: 64, bodyMax: 4096 });
    expect(displayCaps.webhook).toEqual({ titleMax: 64, bodyMax: 4096 });
    expect(displayCaps.browser).toEqual({ titleMax: 64, bodyMax: 2048 });
    // 失败原因上限的唯一独立锚点：出口那两处是「用常量截、用常量量」，只有钉住字面量才能
    // 发现常量本身被改宽（状态页只显示一行，改宽即撑坏）。
    expect(FAILURE_REASON_MAX).toBe(300);
  });
});
