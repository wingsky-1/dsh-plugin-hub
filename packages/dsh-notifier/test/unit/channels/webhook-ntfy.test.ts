/**
 * dsh-notifier channels 域 webhook 出口 — ntfy JSON 发布。
 *
 * 这里验证 ntfy topic 地址解析、数字 priority、根地址兼容和原始路径字节保留。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendWebhook } from "../../../src/server/channels/impl/webhook/index.ts";
import type { WebhookTarget } from "../../../src/server/channels/impl/webhook/type.ts";
import { reasonOf, retryableOf, stubFetch } from "../../helpers.ts";
import { messageOf, targetOf } from "./webhook-test-support.ts";

const ntfyTopicTemplate = (topic: string): string =>
  JSON.stringify({
    topic,
    title: "{{title}}",
    message: "{{message}}",
    tags: ["{{kind}}"],
    priority: "{{priority}}",
  });

const ntfyOf = (over: Partial<WebhookTarget> = {}): WebhookTarget =>
  targetOf({ url: "https://ntfy.sh/demo", preset: "ntfy", ...over });

function registerNtfyTopicRewrite(): void {
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
}

function registerNtfyRootTopic(): void {
  // 验收 2：根地址 + 模板真实 topic → 原样保留；默认/空 topic 无出站且原因明确。
  it("根地址 + 真实 topic：URL 原样保留、topic 保留", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://ntfy.sh/", template: ntfyTopicTemplate("myreal") }),
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
      ntfyOf({ url: "https://self.example/ntfy/", template: ntfyTopicTemplate("demo") }),
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
}

function registerNtfyTopicConflicts(): void {
  // 验收 4：topic URL 与显式 body.topic 冲突不得投错；query 与编码路径可观察。
  it("topic URL 与显式 topic 冲突：不出站，报配置错误", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://ntfy.sh/demo", template: ntfyTopicTemplate("other") }),
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
      ntfyOf({ url: "https://ntfy.sh/demo", template: ntfyTopicTemplate("demo") }),
      messageOf(),
    );
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(calls[0]!.url).toBe("https://ntfy.sh/");
    expect(JSON.parse(calls[0]!.body).topic).toBe("demo");
  });
}

function registerNtfyRewritePreserves(): void {
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
      ntfyOf({ url: "https://ntfy.sh/", template: ntfyTopicTemplate("has space") }),
      messageOf(),
    );
    expect(result.status).toBe("failed");
    expect(retryableOf(result)).toBe(false);
    expect(reasonOf(result).code).toBe("reasonWebhookTemplateInvalid");
    expect(reasonOf(result).detail).toContain("topic 非法");
    expect(calls).toHaveLength(0);
  });
}

function registerNtfyPathBytes(): void {
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
}

function registerNtfyRawPathRewrite(): void {
  // 主控复核风险 2：改写只截原始 pathname 的已明确末段——编码前缀、双斜杠、query
  // 原样保留；比较时才解码候选末段。
  it("原始路径字节保留：双斜杠不被压扁，截段后前缀逐字保留", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://self.example/base//demo", template: ntfyTopicTemplate("demo") }),
      messageOf(),
    );
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(calls[0]!.url).toBe("https://self.example/base//");
    expect(JSON.parse(calls[0]!.body).topic).toBe("demo");
  });

  it("原始路径字节保留：单斜杠前缀截段后落到前缀根 /base/", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://self.example/base/demo", template: ntfyTopicTemplate("demo") }),
      messageOf(),
    );
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(calls[0]!.url).toBe("https://self.example/base/");
    expect(JSON.parse(calls[0]!.body).topic).toBe("demo");
  });

  it("原始路径字节保留：编码前缀截段后原样保留", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://self.example/%6Etfy/demo", template: ntfyTopicTemplate("demo") }),
      messageOf(),
    );
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(calls[0]!.url).toBe("https://self.example/%6Etfy/");
    expect(JSON.parse(calls[0]!.body).topic).toBe("demo");
  });

  it("编码末段按解码比对：d%65mo 命中显式 demo 后改写为根地址", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const result = await sendWebhook(
      ntfyOf({ url: "https://ntfy.sh/d%65mo", template: ntfyTopicTemplate("demo") }),
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
      ntfyOf({ url: raw, template: ntfyTopicTemplate("demo") }),
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
}

function registerNtfyPresetBoundary(): void {
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
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ntfy JSON 发布（#1102）：根地址 + 数字 priority，旧 topic URL 自动兼容", () => {
  registerNtfyTopicRewrite();
  registerNtfyRootTopic();
  registerNtfyTopicConflicts();
  registerNtfyRewritePreserves();
  registerNtfyPathBytes();
  registerNtfyRawPathRewrite();
  registerNtfyPresetBoundary();
});
