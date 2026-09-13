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
  it("空模板回落到预设默认模板，三个预设的顶层键各自固定", () => {
    const ntfy = JSON.parse(renderWebhookBody("", "ntfy", varsOf({ severity: "failure" })));
    expect(Object.keys(ntfy).sort()).toEqual(["message", "priority", "tags", "title", "topic"]);
    expect(ntfy.priority).toBe("urgent");

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
  it("priority 值表与缺省回落：没有 severity 时不得产出字面量 undefined", () => {
    const table: ReadonlyArray<readonly [WebhookPreset, NotifySeverity | undefined, string]> = [
      ["ntfy", "failure", "urgent"],
      ["ntfy", "info", "default"],
      ["ntfy", undefined, "default"],
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
    expect(priorityFor("ntfy", wire<NotifySeverity>("__proto__"))).toBe("default");
    expect(priorityFor("raw", wire<NotifySeverity>("__proto__"))).toBe("");
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
