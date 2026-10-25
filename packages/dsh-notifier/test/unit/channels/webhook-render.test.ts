/**
 * dsh-notifier channels 域 webhook 出口 — 模板渲染。
 *
 * 模板是用户自由文本，渲染是注入面。这里只验证 JSON-aware 两步法、预设默认模板和 priority 契约。
 */
import { describe, expect, it } from "vitest";

import { priorityFor, renderWebhookBody } from "../../../src/server/channels/impl/webhook/index.ts";
import type { WebhookPreset } from "../../../src/server/channels/impl/webhook/type.ts";
import type { NotifySeverity } from "../../../src/server/channels/impl/deliver/type.ts";
import { wire } from "../../helpers.ts";

/** 渲染变量；`ts` 写死，免得断言跟着运行时刻漂。 */
function varsOf(over: Partial<Parameters<typeof renderWebhookBody>[2]> = {}) {
  return { title: "标题", message: "正文", kind: "done", ts: 1_700_000_000_000, ...over };
}

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
