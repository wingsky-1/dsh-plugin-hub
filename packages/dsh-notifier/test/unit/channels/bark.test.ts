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
    // 业务码与宿主原文分开断言：文案归客户端字典，服务端只负责这两段数据不串味。
    expect(reasonOf(rejected)).toEqual({
      code: "reasonBarkRejected",
      params: { code: "400" },
      detail: "invalid device key",
    });
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
    expect(reasonOf(rejected)).toEqual({
      code: "reasonBarkHttp",
      params: { status: 400 },
      detail: "bad token",
    });
    expect(client).toHaveLength(1);

    const server = stubFetch(() => new Response("boom", { status: 503 }));
    const serverError = await sendBark(targetOf(), messageOf());
    expect(retryableOf(serverError)).toBe(true);
    expect(reasonOf(serverError)).toEqual({
      code: "reasonBarkHttp",
      params: { status: 503 },
      detail: "boom",
    });
    expect(server).toHaveLength(1);

    // 边界取 500 本身：判据写成 `> 500` 会把恰好 500 的服务端故障当成终态，静默丢掉一次可恢复的失败。
    const exactly500 = stubFetch(() => new Response("boom", { status: 500 }));
    const serverFault = await sendBark(targetOf(), messageOf());
    expect(retryableOf(serverFault)).toBe(true);
    expect(reasonOf(serverFault)).toEqual({
      code: "reasonBarkHttp",
      params: { status: 500 },
      detail: "boom",
    });
    expect(exactly500).toHaveLength(1);

    stubFetch(
      () =>
        ({
          ok: false,
          status: 503,
          text: () => Promise.reject(new Error("响应体读取中断")),
        }) as unknown as Response,
    );
    // 读不到响应体时 detail 缺席（不是空串）：状态码本身已是完整原因
    expect(reasonOf(await sendBark(targetOf(), messageOf()))).toEqual({
      code: "reasonBarkHttp",
      params: { status: 503 },
    });
  });

  // 网络失败被判成终态就是静默丢通知；原因不封顶会把状态页撑爆。
  it("网络失败与响应体读取中断同属可重试面，原因按 300 码点封顶", async () => {
    stubFetch(() => {
      throw new Error("长".repeat(400));
    });
    const offline = await sendBark(targetOf(), messageOf());
    expect(offline.status).toBe("failed");
    expect(retryableOf(offline)).toBe(true);
    expect(reasonOf(offline)).toEqual({
      code: "reasonBarkRequestFailed",
      detail: "长".repeat(300),
    });
    expect(reasonOf(offline).detail).toHaveLength(300);

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
    expect(reasonOf(interrupted)).toEqual({
      code: "reasonBarkBodyUnreadable",
      detail: "terminated",
    });
  });
});

describe("出站 URL 硬闸（#1016 P0）：发出去之前先判地址", () => {
  // 判据逐条是「桩 fetch 没被调用」：只断言返回 failed 时，一个把校验写在 fetch 之后、
  // 或者干脆把 URL 原样发出去的实现同样能绿。
  it("解析失败 / userinfo / 非 http(s) 的 baseUrl 一律不出站，原因自带「已拒绝投递」", async () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      // 解析失败这一支同时是**行为变更点**：写面只校验 baseUrl 是非空串
      // （config/impl/input/index.ts 的 bark 频道校验），"api.day.app" 存得进配置。
      // 改前它在 fetch 里抛 TypeError、被 catch 成网络错误（retryable=true，重投三次同一个
      // 错地址）；改后由硬闸拒投（retryable=false，detail 说明是地址解析不了）。
      ["解析失败", "api.day.app", "解析失败"],
      // 凭据拼进 URL 会留在对端访问日志里（与本包「device key 不落 URL」同一条红线）
      ["userinfo", "http://user:pass@127.0.0.1:40281/bark", "userinfo"],
      // userinfo 判据是「用户名或口令**任一**非空」，两种单边形态同样要拒：写面只校验 baseUrl 是
      // 非空串，`user@` / `:pass@` 都存得进配置，且都会把凭据留在对端访问日志里。
      // 只测 `user:pass@` 一种形态时，判据被写成 `&&`（两边都非空才拒）的实现全文照绿——实测它把
      // 这两种真的放了出去。同仓原版 secure-fetch.test.ts:141 早有「userinfo 无口令同样拒绝」，
      // 这次补齐即是对齐那份样板。
      ["userinfo 无口令", "http://user@127.0.0.1:40281/bark", "userinfo"],
      ["userinfo 无用户", "http://:pass@127.0.0.1:40281/bark", "userinfo"],
      ["ftp", "ftp://127.0.0.1:40281/bark", "ftp:"],
    ];
    for (const [label, baseUrl, expected] of cases) {
      const calls = stubFetch(() => jsonResponse({ code: 200 }));
      const result = await sendBark(targetOf({ baseUrl }), messageOf());

      expect(calls, label + "：地址不合规时桩 fetch 不该被调用").toHaveLength(0);
      expect(result.status, label).toBe("failed");
      // URL 是配置事实：判成可重试会把用户的错配置打三遍
      expect(retryableOf(result), label).toBe(false);
      const reason = reasonOf(result);
      expect(reason.code, label).toBe("reasonBarkRequestFailed");
      // 原因必须自带「没发出去」：客户端主文案是「Bark 请求失败（网络或超时）」
      expect(reason.detail, label).toContain("已拒绝投递");
      expect(reason.detail, label).toContain(expected);
    }
  });

  // 防收紧过头：内网自建 bark-server 是 README 明写支持的场景，拦私网等于关掉主要用法。
  // 判的是真的发出去并按 2xx 判成功，不是「没被拒」。
  it("合法私网 bark 仍放行并照常投递（不得按私网 / 回环 / 链路本地拦）", async () => {
    const calls = stubFetch(() => jsonResponse({ code: 200 }));
    expect(await sendBark(targetOf({ baseUrl: "http://192.168.1.10:8080" }), messageOf())).toEqual({
      status: "ok",
      stage: "delivered",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://192.168.1.10:8080/push");
  });

  // 回归护栏：准人是「多一道否决」不是「换了发送方式」。默认 baseUrl 是回环地址——本文件其余
  // 用例全部经它，若闸误拦回环，全文一起红，这条因此是把「放行路径一字未改」钉住的锚。
  it("放行时地址拼接与推送体一字不变（准入不改变放行路径的行为）", async () => {
    const calls = stubFetch(() => jsonResponse({ code: 200 }));
    expect(await sendBark(targetOf(), messageOf())).toEqual({ status: "ok", stage: "delivered" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:40281/bark/push");
    expect(calls[0]!.method).toBe("POST");
    expect(bodyOf(calls[0]!)).toMatchObject({ device_key: "dk-secret-1", title: "标题" });
  });
});

describe("/push 拼到 pathname 上（#1016 P0）：query 与尾斜杠都不再打歪地址", () => {
  // 判据是桩 fetch 收到的**完整 URL**：只断「已送达」的话，一个把 /push 拼到别处、或者干脆
  // 不拼的实现同样能绿。旧实现是 `baseUrl + "/push"` 字符串拼接，两档 base 各打歪一次。
  it("base 带 query：/push 落在 pathname 上，query 原样留在后面", async () => {
    const calls = stubFetch(() => jsonResponse({ code: 200 }));
    expect(
      await sendBark(targetOf({ baseUrl: "http://127.0.0.1:40281/bark?tenant=a" }), messageOf()),
    ).toEqual({ status: "ok", stage: "delivered" });
    expect(calls).toHaveLength(1);
    // 旧拼接得到 .../bark?tenant=a/push —— /push 掉进 query 串，实际打到被截断的 /bark
    expect(calls[0]!.url).toBe("http://127.0.0.1:40281/bark/push?tenant=a");
  });

  it("base 带尾斜杠：/push 紧跟末段之后（不得拼出 //push 双斜杠）", async () => {
    const calls = stubFetch(() => jsonResponse({ code: 200 }));
    expect(await sendBark(targetOf({ baseUrl: "https://api.day.app/bark/" }), messageOf())).toEqual(
      { status: "ok", stage: "delivered" },
    );
    expect(calls).toHaveLength(1);
    // 旧拼接得到 .../bark//push —— 多出一个空路径段，部分反代会把它当成独立段拒收
    expect(calls[0]!.url).toBe("https://api.day.app/bark/push");
  });

  // 连续尾斜杠是**另一种**形态：只测单个 `/` 时，把去尾斜杠的正则从 `/\/+$/` 收窄成
  // `/\/$/` 的实现同样全绿，而它拼出的 `https://host/a//push` 与本 issue 要修的 `//push` 是同一
  // 种空路径段（部分反代把它当独立段拒收，用户只看到「推不出去」）。判据是完整 URL 逐字比对。
  it("base 带连续尾斜杠：整段尾斜杠都去掉（不得拼出 /a//push 空路径段）", async () => {
    const calls = stubFetch(() => jsonResponse({ code: 200 }));
    expect(await sendBark(targetOf({ baseUrl: "https://host/a//" }), messageOf())).toEqual({
      status: "ok",
      stage: "delivered",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://host/a/push");
  });

  // 见证「修 query 拼接没把最常见形态改坏」：默认 baseUrl 带子路径且不带 query。
  // 上一条 describe 的锚也断同一事实，那条锚的是整个请求（method/header/body），此处是拼接本身。
  it("base 带子路径且无 query：/push 追加在路径末尾", async () => {
    const calls = stubFetch(() => jsonResponse({ code: 200 }));
    expect(await sendBark(targetOf({ baseUrl: "https://host/a/b" }), messageOf())).toEqual({
      status: "ok",
      stage: "delivered",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://host/a/b/push");
  });

  // hash 无需特判的理由钉在这里：fragment 不随请求发出、fetch 忽略它，故落点是 /x/push
  // 而不是被 fragment 截断的 /x —— 旧的字符串拼接在这个 base 上正好打歪成后者。
  it("base 带 hash：/push 同样落在 pathname 上（fragment 不参与请求）", async () => {
    const calls = stubFetch(() => jsonResponse({ code: 200 }));
    expect(await sendBark(targetOf({ baseUrl: "https://host/x?t=1#frag" }), messageOf())).toEqual({
      status: "ok",
      stage: "delivered",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://host/x/push?t=1#frag");
  });
});
