/**
 * dsh-notifier channels 域 webhook 出口 —— 模板渲染与认证头。
 *
 * 判据为什么是这些：
 *  - 模板是用户自由文本，渲染是**注入面**：JSON-aware 两步法若退化成拼字符串，用户标题里的一个
 *    引号就能改掉整个请求体（发到用户自己配的端点上，等于把通知内容交给别人构造）；
 *  - 凭据只走请求头、且同名头只能有一份（两份 content-type 会被对端按未定义行为处理）；
 *  - 失败零重试是硬约束：webhook 不是幂等 POST，重投等于让对端把同一条通知处理两遍。
 * 无网络：fetch 整体换成桩，`afterEach` 还原。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clampTimeoutSec,
  renderWebhookBody,
  priorityFor,
  sendWebhook,
} from "../../../src/server/channels/impl/webhook/index.ts";
import type {
  WebhookPreset,
  WebhookTarget,
} from "../../../src/server/channels/impl/webhook/type.ts";
import type {
  NotifyMessage,
  NotifySeverity,
} from "../../../src/server/channels/impl/deliver/type.ts";
import { reasonOf, retryableOf, stubFetch, wire } from "../../helpers.ts";

/** 渲染变量；`ts` 写死，免得断言跟着运行时刻漂。 */
function varsOf(over: Partial<Parameters<typeof renderWebhookBody>[2]> = {}) {
  return { title: "标题", message: "正文", kind: "done", ts: 1_700_000_000_000, ...over };
}

function targetOf(over: Partial<WebhookTarget> = {}): WebhookTarget {
  return { type: "webhook", url: "http://127.0.0.1:40281/hook", preset: "raw", ...over };
}

function messageOf(over: Partial<NotifyMessage> = {}): NotifyMessage {
  return { title: "标题", body: "正文", kind: "done", ts: 1_700_000_000_000, ...over };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("模板渲染（纯函数，无网络）", () => {
  // 预设模板是对端 API 的契约：键名或结构漂移，用户的 ntfy/gotify 就再也收不到。
  // ntfy 的 priority 是数字（官方 JSON 协议 1..5；旧名称字面量由出口归一，见下）。
  it("空模板回落到预设默认模板，三个预设的顶层键各自固定", () => {
    const ntfy = JSON.parse(renderWebhookBody("", "ntfy", varsOf({ severity: "failure" })));
    expect(Object.keys(ntfy).sort()).toEqual(["message", "priority", "tags", "title", "topic"]);
    expect(ntfy.priority).toBe(5);

    const gotify = JSON.parse(renderWebhookBody("", "gotify", varsOf({ severity: "failure" })));
    expect(Object.keys(gotify).sort()).toEqual(["message", "priority", "title"]);
    expect(gotify.priority).toBe("9");

    const raw = JSON.parse(renderWebhookBody("", "raw", varsOf({ severity: "failure" })));
    expect(Object.keys(raw).sort()).toEqual(["body", "event", "severity", "title", "ts"]);
    expect(raw.event).toBe("done");
    expect(raw.body).toBe("正文");
    // raw 的 {{severity}} 是强度原文：回落成空串等于对端永远看不到这次通知的严重性。
    expect(raw.severity).toBe("failure");
  });

  // {{ts}} 若进了字符串占位符白名单，raw 模板的裸数字会变成字符串，对端解析直接报错。
  it("{{ts}} 只在文本层做裸值替换（数字直出，进 JSON 后才成立）并按毫秒取整", () => {
    const parsed = JSON.parse(
      renderWebhookBody('{"ts": {{ts}}}', "raw", varsOf({ ts: 1_700_000_000_000.6 })),
    );
    expect(parsed.ts).toBe(1_700_000_000_001);
    expect(typeof parsed.ts).toBe("number");
  });

  // 标题里的引号若能闭合 JSON 字符串，用户的通知内容就能改写整个请求体。
  it("文本占位符替换后重新序列化：引号与换行逃不出字符串（JSON 注入面）", () => {
    const title = 'a"b\\c\nd';
    const message = '}},"evil":true,"z":"';
    const parsed = JSON.parse(
      renderWebhookBody(
        '{"title":"{{title}}","message":"{{message}}"}',
        "raw",
        varsOf({ title, message }),
      ),
    );
    expect(parsed.title).toBe(title);
    expect(parsed.message).toBe(message);
    expect(parsed.evil).toBeUndefined();
  });

  // 二次扫描会让「正文里写占位符」变成一只自我复制的注入源。
  it("替换内容不被二次扫描：正文里写 {{title}} 会原样留下", () => {
    const parsed = JSON.parse(
      renderWebhookBody(
        '{"title":"{{title}}","message":"{{message}}"}',
        "raw",
        varsOf({ title: "A", message: "{{title}}" }),
      ),
    );
    expect(parsed.message).toBe("{{title}}");
    expect(parsed.title).toBe("A");
  });

  // 把不认识的占位符清空，会静默删掉用户自己写的字面量。
  it("占位符白名单：容许两侧空白，不认识的原样保留（不猜也不清空用户自己写的字面量）", () => {
    const parsed = JSON.parse(
      renderWebhookBody('{"k":"{{ kind }}","topic":"{{topic}}"}', "raw", varsOf({ kind: "error" })),
    );
    expect(parsed.k).toBe("error");
    expect(parsed.topic).toBe("{{topic}}");
  });

  // 降级成文本发送会让对端收到解析不了的 body，而历史里看起来是「已送达」。
  it("非法 JSON 模板抛错：宁可这次投递失败，也不降级成文本发送", () => {
    expect(() => renderWebhookBody("{", "raw", varsOf())).toThrow(/不是合法 JSON/u);
  });

  // 缺省回落若产出字面量 undefined，对端会收到一个非法优先级。
  // ntfy 一格是数字（字符串形态经渲染归一，见上）；gotify / raw 沿用既有契约。
  it("priority 值表与缺省回落：没有 severity 时不得产出字面量 undefined", () => {
    const table: ReadonlyArray<readonly [WebhookPreset, NotifySeverity | undefined, string]> = [
      ["ntfy", "failure", "5"],
      ["ntfy", "info", "3"],
      ["ntfy", undefined, "3"],
      ["gotify", "failure", "9"],
      ["gotify", undefined, "3"],
      ["raw", "failure", "failure"],
      ["raw", undefined, ""],
    ];
    for (const [preset, severity, expected] of table) {
      expect(priorityFor(preset, severity), `${preset}/${String(severity)}`).toBe(expected);
    }
    // `__proto__` 是唯一能区分布尔守卫「有没有做」的取值：它不在映射表里，但按原型链取得到
    // `Object.prototype`，没有 hasOwn 守卫时回落分支根本不执行（`critical` 两边都是 undefined，恒绿）。
    expect(priorityFor("ntfy", wire<NotifySeverity>("__proto__"))).toBe("3");
    expect(priorityFor("raw", wire<NotifySeverity>("__proto__"))).toBe("");
  });

  // ntfy priority 归一成数字：旧名称字面量兼容映射，非法值抛错进投递失败。
  it("ntfy priority 渲染归一：数字直出、旧名称兼容、非法抛错", () => {
    expect(
      JSON.parse(renderWebhookBody("", "ntfy", varsOf({ severity: "warning" }))).priority,
    ).toBe(4);
    expect(
      JSON.parse(renderWebhookBody("", "ntfy", varsOf({ severity: "success" }))).priority,
    ).toBe(2);
    expect(JSON.parse(renderWebhookBody("", "ntfy", varsOf()))).toEqual(
      expect.objectContaining({ priority: 3 }),
    );
    // 旧名称字面量（用户手写过旧映射的模板）兼容成数字
    expect(JSON.parse(renderWebhookBody('{"priority": "high"}', "ntfy", varsOf())).priority).toBe(
      4,
    );
    // 数字字面量 1..5 原样保留
    expect(JSON.parse(renderWebhookBody('{"priority": 5}', "ntfy", varsOf())).priority).toBe(5);
    // 越界数字与未知字符串抛错（调用方转成这次投递失败）
    expect(() => renderWebhookBody('{"priority": 9}', "ntfy", varsOf())).toThrow(/priority 非法/u);
    expect(() => renderWebhookBody('{"priority": "critical"}', "ntfy", varsOf())).toThrow(
      /priority 非法/u,
    );
    // gotify 沿用既有契约：字符串不断言成数字
    expect(JSON.parse(renderWebhookBody("", "gotify", varsOf()))).toEqual(
      expect.objectContaining({ priority: "3" }),
    );
  });
});

describe("投递：凭据只走请求头，失败即终态", () => {
  // 两份同名头是对端的未定义行为；凭据进 URL 或 body 则会留在日志与请求记录里。
  it("bearer / basic 各就其位，凭据不进 URL 与 body，同名自定义头不产生第二份 content-type", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    await sendWebhook(
      targetOf({
        headers: { "Content-Type": "text/plain", "x-custom": "1" },
        auth: { kind: "bearer", token: "tk-1" },
      }),
      messageOf(),
    );
    const headers = calls[0]!.headers;
    expect(headers["authorization"]).toBe("Bearer tk-1");
    expect(headers["x-custom"]).toBe("1");
    expect(headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(Object.keys(headers).filter((key) => key.toLowerCase() === "content-type")).toEqual([
      "content-type",
    ]);
    expect(calls[0]!.url).not.toContain("tk-1");
    expect(calls[0]!.body).not.toContain("tk-1");

    await sendWebhook(
      targetOf({ auth: { kind: "basic", user: "user", password: "pass" } }),
      messageOf(),
    );
    expect(calls[1]!.headers["authorization"]).toBe("Basic dXNlcjpwYXNz");
    expect(calls[1]!.body).not.toContain("pass");
  });

  // 跨边界喂入未知认证形状：类型围栏只在编译期，运行时仍可能到；凭据一旦拼进 URL 就会留在
  // 对端访问日志、代理与浏览器历史里（请求头不会）。
  it("未知认证形状：凭据不进 URL 与查询串，请求仍照发（已删掉的 query 成员不得复活）", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const secret = "query-secret-9f2a";
    const result = await sendWebhook(
      targetOf({
        auth: wire<NonNullable<WebhookTarget["auth"]>>({
          kind: "query",
          name: "token",
          value: secret,
        }),
      }),
      messageOf(),
    );

    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
    // 判的是实际发出的 URL，而不是「没抛错」：拼进查询串的凭据在 URL 上，等于写进对端日志。
    expect(calls[0]!.url).not.toContain(secret);
    expect(calls[0]!.url).not.toContain("token");
    expect(new URL(calls[0]!.url).search).toBe("");
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
    expect(calls[0]!.body).not.toContain(secret);
  });

  // 抛穿会把一次投递失败升级成批次失败，还可能让调用方重试整批。
  it("模板渲染失败落成这次投递的失败且不发请求（retryable=false）：坏 body 不如不发", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(targetOf({ template: "{" }), messageOf());
    expect(result.status).toBe("failed");
    expect(retryableOf(result)).toBe(false);
    const reason = reasonOf(result);
    expect(reason.code).toBe("reasonWebhookTemplateInvalid");
    // 宿主原文（JSON.parse 的报错）不作主文案，但必须留下来供定位
    expect(reason.detail).toContain("webhook 模板不是合法 JSON");
    expect(calls).toHaveLength(0);
  });

  // webhook 不幂等：重投等于让对端把同一条通知处理两遍。
  it("HTTP 非 2xx 与网络错误都标不可重试（webhook 不幂等，重投等于让对端处理两遍）", async () => {
    stubFetch(() => new Response("nope", { status: 401 }));
    const unauthorized = await sendWebhook(targetOf(), messageOf());
    expect(unauthorized).toMatchObject({ status: "failed", stage: "delivered", retryable: false });
    expect(reasonOf(unauthorized)).toEqual({
      code: "reasonWebhookHttp",
      params: { status: 401 },
      detail: "nope",
    });

    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const offline = await sendWebhook(targetOf(), messageOf());
    expect(retryableOf(offline)).toBe(false);
    expect(reasonOf(offline)).toEqual({
      code: "reasonWebhookRequestFailed",
      detail: "ECONNREFUSED",
    });
  });

  // AbortSignal.timeout 只接受有限非负数：NaN 与负数都当场抛 RangeError，异常冒到 fetch 的
  // catch 里就变成「每一次投递都失败」——clamp 正是拦在它前面。用例因此判的是「有 clamp 才发得出去」。
  it("timeoutSec 脏值被夹进 1..60 秒：负数与 NaN 都不再让 AbortSignal.timeout 抛 RangeError", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    expect((await sendWebhook(targetOf({ timeoutSec: -5 }), messageOf())).status).toBe("ok");
    expect(calls[0]!.signal?.aborted).toBe(false);

    expect((await sendWebhook(targetOf({ timeoutSec: Number.NaN }), messageOf())).status).toBe(
      "ok",
    );
    expect(calls[1]!.signal?.aborted).toBe(false);
  });

  // 上界与下界是**唯一**箍：配置层允许到 600，而 clamp 的产物只落在 AbortSignal 的 deadline 上，
  // 从外面读不出来（改宽上界、把下界改成 0 都不影响「请求发出去了」）。故这里直接判函数值。
  it.each<[string, number | undefined, number]>([
    ["负数 → 下界", -5, 1],
    ["0 → 下界", 0, 1],
    ["下界本身保留", 1, 1],
    ["上界本身保留", 60, 60],
    ["配置层允许的 600 也被收到上界", 600, 60],
    ["NaN → 缺省", Number.NaN, 10],
    ["undefined（未配置）→ 缺省", undefined, 10],
  ])("timeoutSec clamp（%s）：%s → %s 秒", (_label, value, expected) => {
    expect(clampTimeoutSec(value)).toBe(expected);
  });

  // 状态页只显示一行，未截断的长原因会把它撑坏并挤掉别的信息。
  it("失败原因按 300 码点封顶（状态页只显示一行，原因是摘要不是全文）", async () => {
    stubFetch(() => {
      throw new Error("长".repeat(400));
    });
    const result = await sendWebhook(targetOf(), messageOf());
    expect(reasonOf(result).code).toBe("reasonWebhookRequestFailed");
    expect(Array.from(reasonOf(result).detail ?? "")).toHaveLength(300);
  });
});

describe("出站 URL 硬闸（#1016 P0）：发出去之前先判地址", () => {
  // 判据是「桩 fetch 没被调用」：只断言返回 failed 时，一个把校验写在 fetch 之后、
  // 或者干脆把 URL 原样发出去的实现同样能绿。
  it("解析失败 / userinfo / 非 http(s) 的 url 一律不出站，原因自带「已拒绝投递」", async () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      // 写面只校验 url 是非空串（config/impl/input/index.ts 的 webhook 频道校验），
      // "ntfy.sh/x" 存得进配置，故这一支生产可达（把它 catch 成放行，全部测试仍会绿）
      ["解析失败", "ntfy.sh/x", "解析失败"],
      // 凭据拼进 URL 会留在对端访问日志与代理历史里（凭据只走请求头，见本文件上方用例）
      ["userinfo", "http://user:pass@ntfy.sh/x", "userinfo"],
      // userinfo 判据是「用户名或口令**任一**非空」，两种单边形态同样要拒（与 bark 出口同款判据）。
      // 只测 `user:pass@` 时，判据被写成 `&&` 的实现全文照绿——实测它把这两种真的放了出去。
      // 同仓原版 secure-fetch.test.ts:141 早有「userinfo 无口令同样拒绝」，这里是它的对齐。
      ["userinfo 无口令", "http://user@ntfy.sh/x", "userinfo"],
      ["userinfo 无用户", "http://:pass@ntfy.sh/x", "userinfo"],
      ["ftp", "ftp://ntfy.sh/x", "ftp:"],
    ];
    for (const [label, url, expected] of cases) {
      const calls = stubFetch(() => new Response("{}", { status: 200 }));
      const result = await sendWebhook(targetOf({ url }), messageOf());

      expect(calls, label + "：地址不合规时桩 fetch 不该被调用").toHaveLength(0);
      expect(result.status, label).toBe("failed");
      // 出口本就零重试（webhook 不幂等），这里只是把「地址不合规」也归到同一侧，不新开口子
      expect(retryableOf(result), label).toBe(false);
      const reason = reasonOf(result);
      expect(reason.code, label).toBe("reasonWebhookRequestFailed");
      // 原因必须自带「没发出去」：客户端主文案是「Webhook 请求失败（网络或超时）」
      expect(reason.detail, label).toContain("已拒绝投递");
      expect(reason.detail, label).toContain(expected);
    }
  });

  // 防收紧过头：只读 origin + path 的公网 ntfy 是本出口的主用例，判据里不得出现地址分类。
  it("合法 ntfy 仍放行并照常投递（不得按私网 / 回环 / 链路本地拦）", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    expect(await sendWebhook(targetOf({ url: "https://ntfy.sh/x" }), messageOf())).toEqual({
      status: "ok",
      stage: "delivered",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ntfy.sh/x");
  });

  // 回归护栏：准人是「多一道否决」不是「换了发送方式」。默认 url 是回环地址——本文件其余用例
  // 全部经它，若闸误拦回环，全文一起红，这条因此是把「放行路径一字未改」钉住的锚。
  it("放行时地址与请求体一字不变（准入不改变放行路径的行为）", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    expect(await sendWebhook(targetOf(), messageOf())).toEqual({
      status: "ok",
      stage: "delivered",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:40281/hook");
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ title: "标题", body: "正文" });
  });

  // 顺序决定（#1016）：地址错与模板错同时成立时报哪一个。此前的安全属性（准人在 fetch 之前）
  // 已被上面用例的 `calls` 为空钉住，剩下来的是「先判地址」这个顺序本身没有钉——把准入整块挪到
  // 渲染之后，全部用例照绿，而用户改完模板再撞一次地址。判据是 reason.code：
  // `{ url: "ntfy.sh/x", template: "{" }` 必须报地址解析失败（reasonWebhookRequestFailed），
  // 而不是模板非法（reasonWebhookTemplateInvalid）。
  it("地址与模板同时不合法时先报地址（准入先于模板渲染）", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(targetOf({ url: "ntfy.sh/x", template: "{" }), messageOf());
    expect(reasonOf(result).code).toBe("reasonWebhookRequestFailed");
    expect(reasonOf(result).detail).toContain("已拒绝投递");
    expect(calls).toHaveLength(0);
  });

  // 防收紧过头（#1016 方向变更的正面判据）：webhook 出站是 fetchImpl(target.url)，**原样使用、
  // 不做任何拼接**，带 query 的地址今日就能工作——`https://gateway/hook?tenant=x` 是合法且常用的
  // 配法。判据是桩 fetch 收到的地址**逐字不变**：一旦有人又把 query 加回拒绝清单，这条先红。
  it("带 query 的 url 放行且原样发出（不得把 query 收回拒绝清单）", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    expect(await sendWebhook(targetOf({ url: "https://ntfy.sh/x?tenant=a" }), messageOf())).toEqual(
      { status: "ok", stage: "delivered" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ntfy.sh/x?tenant=a");
  });
});

describe("ntfy JSON 发布（#1102）：根地址 + 数字 priority，旧 topic URL 自动兼容", () => {
  // issue 现象：JSON 发到 topic URL 会整包显示为正文；官方要求 JSON 发往服务根地址。
  const topicTemplate = (topic: string): string =>
    JSON.stringify({
      topic,
      title: "{{title}}",
      message: "{{message}}",
      tags: ["{{kind}}"],
      priority: "{{priority}}",
    });
  const ntfyOf = (over: Partial<WebhookTarget> = {}): WebhookTarget =>
    targetOf({ url: "https://ntfy.sh/demo", preset: "ntfy", ...over });

  // 验收 1：旧默认模板（空模板回落，topic 仍是 <topic> 占位）+ topic URL → 改写为根地址。
  it("旧 topic URL + 默认模板：改写为服务根地址，topic/title/message/tags 与数字 priority 齐全", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(ntfyOf({ template: "" }), messageOf({ severity: "failure" }));
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ntfy.sh/");
    const body = JSON.parse(calls[0]!.body);
    expect(body.topic).toBe("demo");
    expect(body.title).toBe("标题");
    expect(body.message).toBe("正文");
    expect(body.tags).toEqual(["done"]);
    expect(body.priority).toBe(5);
  });

  // 验收 2：根地址 + 模板真实 topic → 原样保留；默认/空 topic 无出站且原因明确。
  it("根地址 + 真实 topic：URL 原样保留、topic 保留", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://ntfy.sh/", template: topicTemplate("myreal") }),
      messageOf({ severity: "info" }),
    );
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(calls[0]!.url).toBe("https://ntfy.sh/");
    const body = JSON.parse(calls[0]!.body);
    expect(body.topic).toBe("myreal");
    expect(body.priority).toBe(3);
  });

  it("根地址 + 默认/空 topic：不出站，报缺 topic（retryable=false）", async () => {
    for (const template of ["", '{\n  "topic": "<topic>"\n}']) {
      const calls = stubFetch(() => new Response("{}", { status: 200 }));
      const result = await sendWebhook(ntfyOf({ url: "https://ntfy.sh/", template }), messageOf());
      expect(result.status, `模板 ${template.slice(0, 12)}`).toBe("failed");
      expect(retryableOf(result), `模板 ${template.slice(0, 12)}`).toBe(false);
      expect(reasonOf(result).code).toBe("reasonWebhookTemplateInvalid");
      expect(reasonOf(result).detail).toContain("缺少可用 topic");
      expect(calls, "缺 topic 时桩 fetch 不该被调用").toHaveLength(0);
    }
  });

  // 验收 3：自托管前缀根地址 + 显式 topic 原样保留；旧前缀 topic 模式（多段 + 占位）拒绝不盲猜。
  it("自托管前缀根地址 + 显式 topic：base path 原样保留不截断", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://self.example/ntfy/", template: topicTemplate("demo") }),
      messageOf(),
    );
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(calls[0]!.url).toBe("https://self.example/ntfy/");
    expect(JSON.parse(calls[0]!.body).topic).toBe("demo");
  });

  it("多段路径 + 占位 topic：拒绝不明确模式，不猜自托管前缀", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://self.example/ntfy/mytopic", template: "" }),
      messageOf(),
    );
    expect(result.status).toBe("failed");
    expect(retryableOf(result)).toBe(false);
    expect(reasonOf(result).code).toBe("reasonWebhookTemplateInvalid");
    expect(reasonOf(result).detail).toContain("无法明确提取 topic");
    expect(calls).toHaveLength(0);
  });

  // 验收 4：topic URL 与显式 body.topic 冲突不得投错；query 与编码路径可观察。
  it("topic URL 与显式 topic 冲突：不出站，报配置错误", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://ntfy.sh/demo", template: topicTemplate("other") }),
      messageOf(),
    );
    expect(result.status).toBe("failed");
    expect(retryableOf(result)).toBe(false);
    expect(reasonOf(result).code).toBe("reasonWebhookTemplateInvalid");
    expect(reasonOf(result).detail).toContain("不一致");
    expect(calls).toHaveLength(0);
  });

  it("显式 topic 与 URL 末段一致：改写为根地址发出（不发往 topic URL）", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://ntfy.sh/demo", template: topicTemplate("demo") }),
      messageOf(),
    );
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(calls[0]!.url).toBe("https://ntfy.sh/");
    expect(JSON.parse(calls[0]!.body).topic).toBe("demo");
  });

  it("改写保留 query：topic URL 的查询串跟到根地址上", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://ntfy.sh/demo?tenant=a", template: "" }),
      messageOf(),
    );
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(calls[0]!.url).toBe("https://ntfy.sh/?tenant=a");
    expect(JSON.parse(calls[0]!.body).topic).toBe("demo");
  });

  // 验收 5：转义/认证/零重试/nonexistent 预设不回归。
  it("改写不破坏转义与认证：恶意文本逃不出字符串，凭据仍只走请求头", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ template: "", auth: { kind: "bearer", token: "tk-9f" } }),
      messageOf({ title: 'a"b', body: '}},"evil":true,"z":"' }),
    );
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    const body = JSON.parse(calls[0]!.body);
    expect(body.title).toBe('a"b');
    expect(body.evil).toBeUndefined();
    expect(calls[0]!.headers["authorization"]).toBe("Bearer tk-9f");
    expect(calls[0]!.url).not.toContain("tk-9f");
    expect(calls[0]!.body).not.toContain("tk-9f");
  });

  it("非法 topic（字符集外）出站前拒绝，不发错地址", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://ntfy.sh/", template: topicTemplate("has space") }),
      messageOf(),
    );
    expect(result.status).toBe("failed");
    expect(retryableOf(result)).toBe(false);
    expect(reasonOf(result).code).toBe("reasonWebhookTemplateInvalid");
    expect(reasonOf(result).detail).toContain("topic 非法");
    expect(calls).toHaveLength(0);
  });

  // 主控复核风险 1：名称查表无 hasOwn 时 `"__proto__"` 会拿到 Object.prototype（truthy
  // 非数字）并发出——priority 必须是数字，该反证钉住精确拒绝且无出站。
  it("priority 原型污染键精确拒绝：__proto__/constructor 不得出站", async () => {
    for (const evil of ['{"priority": "__proto__"}', '{"priority": "constructor"}']) {
      const calls = stubFetch(() => new Response("{}", { status: 200 }));
      const result = await sendWebhook(
        ntfyOf({ url: "https://ntfy.sh/", template: evil }),
        messageOf(),
      );
      expect(result.status, evil).toBe("failed");
      expect(retryableOf(result), evil).toBe(false);
      expect(reasonOf(result).code, evil).toBe("reasonWebhookTemplateInvalid");
      expect(reasonOf(result).detail, evil).toContain("priority 非法");
      expect(calls, "非法 priority 时桩 fetch 不该被调用").toHaveLength(0);
    }
  });

  // 主控复核风险 2：改写只截原始 pathname 的已明确末段——编码前缀、双斜杠、query
  // 原样保留；比较时才解码候选末段。
  it("原始路径字节保留：双斜杠不被压扁，截段后前缀逐字保留", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://self.example/base//demo", template: topicTemplate("demo") }),
      messageOf(),
    );
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(calls[0]!.url).toBe("https://self.example/base//");
    expect(JSON.parse(calls[0]!.body).topic).toBe("demo");
  });

  it("原始路径字节保留：单斜杠前缀截段后落到前缀根 /base/", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://self.example/base/demo", template: topicTemplate("demo") }),
      messageOf(),
    );
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(calls[0]!.url).toBe("https://self.example/base/");
    expect(JSON.parse(calls[0]!.body).topic).toBe("demo");
  });

  it("原始路径字节保留：编码前缀截段后原样保留", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://self.example/%6Etfy/demo", template: topicTemplate("demo") }),
      messageOf(),
    );
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(calls[0]!.url).toBe("https://self.example/%6Etfy/");
    expect(JSON.parse(calls[0]!.body).topic).toBe("demo");
  });

  it("编码末段按解码比对：d%65mo 命中显式 demo 后改写为根地址", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://ntfy.sh/d%65mo", template: topicTemplate("demo") }),
      messageOf(),
    );
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(calls[0]!.url).toBe("https://ntfy.sh/");
    expect(JSON.parse(calls[0]!.body).topic).toBe("demo");
  });

  it("编码前缀根地址原样保留：%6Etfy/ + 显式 topic 不截断不错位", async () => {
    const raw = "https://self.example/%6Etfy/?x=1";
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: raw, template: topicTemplate("demo") }),
      messageOf(),
    );
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(calls[0]!.url).toBe(raw);
    expect(JSON.parse(calls[0]!.body).topic).toBe("demo");
  });

  // 主控复核风险 3：尾斜杠 + 缺 topic 是不明确根模式（前缀根与 topic 地址无法区分），
  // 不猜、报不明确且无出站；与「显式 topic + 前缀根原样保留」配对。
  it("尾斜杠 + 缺 topic：不把前缀根末段当 topic，结果是拒绝而非改写", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://self.example/ntfy/", template: "" }),
      messageOf(),
    );
    expect(result.status).toBe("failed");
    expect(retryableOf(result)).toBe(false);
    expect(reasonOf(result).code).toBe("reasonWebhookTemplateInvalid");
    expect(reasonOf(result).detail).toContain("以 / 结尾");
    expect(calls).toHaveLength(0);
  });

  it("gotify / raw 不进 ntfy 分支：topic 形 URL 原样发出", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    expect(
      await sendWebhook(
        targetOf({ url: "https://gotify.example/message?token=x", preset: "gotify" }),
        messageOf(),
      ),
    ).toEqual({ status: "ok", stage: "delivered" });
    expect(calls[0]!.url).toBe("https://gotify.example/message?token=x");
  });
});
