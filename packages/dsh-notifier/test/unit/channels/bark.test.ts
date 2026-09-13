/**
 * dsh-notifier channels 域 bark 出口 —— 请求构造与失败分类。
 *
 * 判据为什么是这些：
 *  - `device_key` 是凭据，只许进 JSON body（反代访问日志默认记 URL 与 header）；
 *  - level 决定 iOS 上的紧急度：把 error 通知判成被动提示，用户在最需要的时候看不到它；
 *  - `retryable` 是**出口对失败的分类**（次数与退避归管线）：把 4xx 判成可重试会把用户的错误
 *    配置重投三次，把网络失败判成不可重试则静默丢通知。
 * 无网络：fetch 整体换成桩，`afterEach` 还原。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendBark } from "../../../src/server/channels/impl/bark/index.ts";
import type { BarkPushBody, BarkTarget } from "../../../src/server/channels/impl/bark/type.ts";
import type {
  NotifyMessage,
  NotifySeverity,
} from "../../../src/server/channels/impl/deliver/type.ts";
import { pollUntil, reasonOf, retryableOf, stubFetch, wire } from "../../helpers.ts";
import type { FetchCall } from "../../helpers.ts";

/** 2xx JSON 响应。 */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

/** 桩里记下的请求体（bark 要发的就是 `BarkPushBody`）。 */
function bodyOf(call: FetchCall): BarkPushBody {
  return JSON.parse(call.body) as BarkPushBody;
}

function targetOf(over: Partial<BarkTarget> = {}): BarkTarget {
  return {
    type: "bark",
    baseUrl: "http://127.0.0.1:40281/bark",
    deviceKey: "dk-secret-1",
    ...over,
  };
}

function messageOf(over: Partial<NotifyMessage> = {}): NotifyMessage {
  return { title: "标题", body: "正文", kind: "done", ts: 1_700_000_000_000, ...over };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("请求构造", () => {
  // 凭据进 URL 会留在反代访问日志里，那是密钥泄露最常见的一条路。
  it("device_key 只进 JSON body，URL 恰为 baseUrl + /push（凭据不进访问日志）", async () => {
    const calls = stubFetch(() => jsonResponse({ code: 200 }));
    expect(await sendBark(targetOf(), messageOf())).toEqual({ status: "ok", stage: "delivered" });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("http://127.0.0.1:40281/bark/push");
    expect(call.headers["content-type"]).toBe("application/json; charset=utf-8");
    const body = bodyOf(call);
    expect(body.device_key).toBe("dk-secret-1");
    expect(body.title).toBe("标题");
    expect(body.body).toBe("正文");
  });

  // 错误通知被映射成被动提示等于在最需要的时候安静下来；非法值当合法用会发出对端不识别的 level。
  it("level 优先级：显式 level 覆盖 severity 映射；非法 severity 视同未提供", async () => {
    const calls = stubFetch(() => jsonResponse({ code: 200 }));

    await sendBark(targetOf({ level: "critical" }), messageOf({ severity: "info" }));
    expect(bodyOf(calls[0]!).level).toBe("critical");

    // 失败通知必须穿透专注模式：映射到 passive 会让它在最需要的时候安静下来。
    await sendBark(targetOf(), messageOf({ severity: "failure" }));
    expect(bodyOf(calls[1]!).level).toBe("timeSensitive");

    await sendBark(targetOf(), messageOf({ severity: "info" }));
    expect(bodyOf(calls[2]!).level).toBe("passive");

    // `__proto__` 是唯一能区分布尔守卫「有没有做」的取值：它不在映射表里，但按原型链取得到
    // `Object.prototype`，没有 hasOwn 守卫时 level 会被写成 `{}`（`critical` 两边都是 undefined，恒绿）。
    await sendBark(targetOf(), messageOf({ severity: wire<NotifySeverity>("__proto__") }));
    expect("level" in bodyOf(calls[3]!)).toBe(false);
  });

  // 把没配置的字段发成空值会覆盖用户在 App 里的设置，而 badge 0 是有语义的「清角标」。
  it("可选字段有值才带：badge=0 是「清角标」而不是没配置", async () => {
    const calls = stubFetch(() => jsonResponse({ code: 200 }));

    await sendBark(
      targetOf({ group: "组", sound: "bell", icon: "i", url: "https://example.com", badge: 0 }),
      messageOf(),
    );
    const full = bodyOf(calls[0]!);
    expect(full.group).toBe("组");
    expect(full.sound).toBe("bell");
    expect(full.icon).toBe("i");
    expect(full.url).toBe("https://example.com");
    expect(full.badge).toBe(0);

    await sendBark(targetOf(), messageOf());
    expect(Object.keys(bodyOf(calls[1]!)).sort()).toEqual(["body", "device_key", "title"]);
  });

  // 「只有 undefined 才省略」：空串是**有值**，要照发。这条区分了「没配置」与「配置成空」，
  // 而它此前只由实现本身承担（把判据改成 `sound !== ""` 时全套用例不红）。
  it("空串按「有值」写进 body：省略只针对 undefined", async () => {
    const calls = stubFetch(() => jsonResponse({ code: 200 }));
    await sendBark(targetOf({ sound: "", group: "", url: "", icon: "" }), messageOf());
    const body = bodyOf(calls[0]!);
    expect(body.sound).toBe("");
    expect(body.group).toBe("");
    expect(body.url).toBe("");
    expect(body.icon).toBe("");
  });

  // 正文上限只在出口（定稿层只截标题），出口不截就会把超长正文整条发出去。
  it("出口自己也要截断：标题 64 / 正文 4096 码点（定稿层只截标题，正文上限只在出口）", async () => {
    const calls = stubFetch(() => jsonResponse({ code: 200 }));
    await sendBark(targetOf(), messageOf({ title: "题".repeat(100), body: "文".repeat(5000) }));

    const body = bodyOf(calls[0]!);
    expect(Array.from(body.title)).toHaveLength(64);
    expect(Array.from(body.body)).toHaveLength(4096);
  });

  // 未知键是 README 承诺的前向兼容面（配置层已按 string/number 过滤）；已知键必须赢，
  // 否则配置里写一个 title 就能顶掉通知标题——那是透传面不该有的能力。
  it("实例的未知键原样进推送体，且已知键优先：透传不参与改写通知本身", async () => {
    const calls = stubFetch(() => jsonResponse({ code: 200 }));
    await sendBark(
      targetOf({ extras: { volume: 5, call: "1", title: "顶掉标题", body: "顶掉正文" } }),
      messageOf({ title: "原标题", body: "原正文" }),
    );
    // 透传键不在 `BarkPushBody` 的声明里（它描述的是**已知**键的形状），故按开放视图看整份 body。
    const body = wire<Record<string, unknown>>(bodyOf(calls[0]!));
    expect(body.volume).toBe(5);
    expect(body.call).toBe("1");
    expect(body.title).toBe("原标题");
    expect(body.body).toBe("原正文");
  });

  // 调用方给的超时若不生效，一次挂死的推送会一直占着管线到出口的 10s 硬超时。
  it("timeoutMs 是真实的中止时限：到点即中止（不写就用出口自己的 10s 硬超时）", async () => {
    let aborted = false;
    stubFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(call.signal?.reason);
          });
        }),
    );

    const pending = sendBark(targetOf({ timeoutMs: 5 }), messageOf());
    await pollUntil(() => aborted, "5ms 超时应当中止请求", 2000);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(retryableOf(result)).toBe(true);
  });

  // 0 不是「立刻超时」而是「没配置」：把它当合法时限传下去，`AbortSignal.timeout(0)` 会在请求发出的
  // 同一刻中止——该频道从此每次都失败，而设置页上看不出任何异常。
  it("timeoutMs=0 视同未配置，回落出口自己的 10s 硬超时（0 不是「立刻超时」）", async () => {
    const calls = stubFetch(() => jsonResponse({ code: 200 }));
    // 钉「回落的是哪个数」，而不是「过了一小会儿还没中止」：`AbortSignal.timeout` 的 deadline 从外面
    // 读不出来，而真实 sleep 只能证明「还没触发」（实测：把硬超时常量错落成 100ms，25ms 的等待照样全绿；
    // 假时钟也管不到 `AbortSignal.timeout` 的原生计时器）。这里记账请求值，任何错落的时限都会现形。
    const requested: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms: number): AbortSignal => {
      requested.push(ms);
      return realTimeout(ms);
    };
    try {
      expect(await sendBark(targetOf({ timeoutMs: 0 }), messageOf())).toEqual({
        status: "ok",
        stage: "delivered",
      });
    } finally {
      AbortSignal.timeout = realTimeout;
    }
    expect(requested).toEqual([10_000]);
    expect(calls[0]!.signal?.aborted).toBe(false);
  });
});

describe("失败分类：只回答可不可重试，不自己重投", () => {
  // 反代用 200 包一张错误页时，只看 HTTP 状态会把「没送到」记成成功。
  it("成功判定双查 2xx 与响应体 code：反代用 200 包一张错误页时不算送到", async () => {
    const businessCode = stubFetch(() =>
      jsonResponse({ code: 400, message: "invalid device key" }),
    );
    const rejected = await sendBark(targetOf(), messageOf());
    expect(rejected).toMatchObject({ status: "failed", stage: "delivered", retryable: true });
    expect(reasonOf(rejected)).toBe("bark code 400: invalid device key");
    // 出口只投一次：重投决定权在管线（它看 retryable），出口自己不许偷偷重试。
    expect(businessCode).toHaveLength(1);

    const notJson = stubFetch(() => new Response("not json at all", { status: 200 }));
    expect(await sendBark(targetOf(), messageOf())).toEqual({ status: "ok", stage: "delivered" });
    expect(notJson).toHaveLength(1);
  });

  // 反代/中间件常回 2xx 包一个空对象：把「没有 code 键」判成失败，等于把一次成功投递记成故障
  // （而重试会把同一条通知再发两遍）。口径是「有 code 且 ≠200 才算失败」，不是「code 必须等于 200」。
  it("2xx 且响应体没有 code 键时按成功处理（只有 code 存在且非 200 才是失败）", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    expect(await sendBark(targetOf(), messageOf())).toEqual({ status: "ok", stage: "delivered" });
    expect(calls).toHaveLength(1);
  });

  // 4xx 判可重试会把用户的错误配置重投三次，5xx 判不可重试则是静默丢通知。
  it("HTTP 状态分类：4xx 是确定失败，5xx 进可重试面；读不到响应体时原因只留状态码", async () => {
    const client = stubFetch(() => new Response("bad token", { status: 400 }));
    const rejected = await sendBark(targetOf(), messageOf());
    expect(retryableOf(rejected)).toBe(false);
    expect(reasonOf(rejected)).toBe("bark HTTP 400: bad token");
    expect(client).toHaveLength(1);

    const server = stubFetch(() => new Response("boom", { status: 503 }));
    const serverError = await sendBark(targetOf(), messageOf());
    expect(retryableOf(serverError)).toBe(true);
    expect(reasonOf(serverError)).toBe("bark HTTP 503: boom");
    expect(server).toHaveLength(1);

    // 边界取 500 本身：判据写成 `> 500` 会把恰好 500 的服务端故障当成终态，静默丢掉一次可恢复的失败。
    const exactly500 = stubFetch(() => new Response("boom", { status: 500 }));
    const serverFault = await sendBark(targetOf(), messageOf());
    expect(retryableOf(serverFault)).toBe(true);
    expect(reasonOf(serverFault)).toBe("bark HTTP 500: boom");
    expect(exactly500).toHaveLength(1);

    stubFetch(
      () =>
        ({
          ok: false,
          status: 503,
          text: () => Promise.reject(new Error("响应体读取中断")),
        }) as unknown as Response,
    );
    expect(reasonOf(await sendBark(targetOf(), messageOf()))).toBe("bark HTTP 503");
  });

  // 网络失败被判成终态就是静默丢通知；原因不封顶会把状态页撑爆。
  it("网络失败与响应体读取中断同属可重试面，原因按 300 码点封顶", async () => {
    stubFetch(() => {
      throw new Error("长".repeat(400));
    });
    const offline = await sendBark(targetOf(), messageOf());
    expect(offline.status).toBe("failed");
    expect(retryableOf(offline)).toBe(true);
    expect(reasonOf(offline)).toBe("bark 请求失败: " + "长".repeat(289));
    expect(reasonOf(offline)).toHaveLength(300);

    stubFetch(
      () =>
        ({
          ok: true,
          status: 200,
          json: () => Promise.reject(new TypeError("terminated")),
        }) as unknown as Response,
    );
    const interrupted = await sendBark(targetOf(), messageOf());
    expect(interrupted.status).toBe("failed");
    expect(retryableOf(interrupted)).toBe(true);
    expect(reasonOf(interrupted)).toBe("bark 响应体读取失败: terminated");
  });
});
