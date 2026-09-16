/**
 * dsh-notifier src/shared —— webhook 预设共享面的直连判据。
 *
 * 三份默认模板在收口前是**两份逐字相同的副本**（宿主出口的 `DEFAULT_TEMPLATES` 与客户端
 * `WEBHOOK_PRESETS` 的 `template`）。这里把三份字面量逐字钉住，并断言两端源文件里不再有第二份
 * 副本——漂移的症状是「设置页上看到的模板与实际发出去的 body 不是同一份」，用户既改不回默认值，
 * 也解释不了对端收到的字段。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  WEBHOOK_AUTHS,
  WEBHOOK_DEFAULT_TEMPLATES,
  WEBHOOK_DELIVERY_PRESETS,
  WEBHOOK_PRESETS,
  WEBHOOK_PRIORITY,
  deliveryPresetOf,
  webhookTemplateOf,
} from "../../../src/shared/interface.ts";

const pkgDir = fileURLToPath(new URL("../../../", import.meta.url));

/** 收口前两端各写一份的三份模板（逐字抄录，本文件的期望值）。 */
const NTFY_TEMPLATE =
  '{\n  "topic": "<topic>",\n  "title": "{{title}}",\n  "message": "{{message}}",\n  "tags": ["{{kind}}"],\n  "priority": "{{priority}}"\n}';
const GOTIFY_TEMPLATE =
  '{\n  "title": "{{title}}",\n  "message": "{{message}}",\n  "priority": "{{priority}}"\n}';
const RAW_TEMPLATE =
  '{\n  "event": "{{kind}}",\n  "title": "{{title}}",\n  "body": "{{message}}",\n  "severity": "{{severity}}",\n  "ts": {{ts}}\n}';

const read = (rel: string) => readFileSync(join(pkgDir, rel), "utf8");

describe("默认模板", () => {
  it("三份模板逐字钉住", () => {
    expect(WEBHOOK_DEFAULT_TEMPLATES).toEqual({
      ntfy: NTFY_TEMPLATE,
      gotify: GOTIFY_TEMPLATE,
      raw: RAW_TEMPLATE,
    });
  });

  // 配置层的 custom 与投递层的 raw 是同一个东西：客户端「恢复默认模板」按配置层取值，
  // 出口按投递层取值，改名错一格就会给出另一份模板。
  it("客户端预设取值走共享面（custom 拿 raw 那一份）", () => {
    expect(webhookTemplateOf("ntfy")).toBe(NTFY_TEMPLATE);
    expect(webhookTemplateOf("gotify")).toBe(GOTIFY_TEMPLATE);
    expect(webhookTemplateOf("custom")).toBe(RAW_TEMPLATE);
  });

  // `{{ts}}` 必须在渲染第一步之前保持裸值形态（模板得先替换它才可能 JSON.parse 得动），
  // 而另两份模板必须本身就是合法 JSON——否则「空模板回落默认」这条路径第一次投递就失败。
  it("ntfy / gotify 本身是合法 JSON，raw 的 {{ts}} 是裸值形态", () => {
    expect(() => JSON.parse(NTFY_TEMPLATE)).not.toThrow();
    expect(() => JSON.parse(GOTIFY_TEMPLATE)).not.toThrow();
    expect(RAW_TEMPLATE).toContain('"ts": {{ts}}');
  });
});

describe("预设词汇与两层改名", () => {
  it("配置层与投递层的词表逐项钉住", () => {
    expect([...WEBHOOK_PRESETS]).toEqual(["ntfy", "gotify", "custom"]);
    expect([...WEBHOOK_DELIVERY_PRESETS]).toEqual(["ntfy", "gotify", "raw"]);
    // 配置层每个预设都要落在投递层词表里（少一个出口就收到一个不认识的 preset）
    expect(
      WEBHOOK_PRESETS.map(deliveryPresetOf).every((p) => WEBHOOK_DELIVERY_PRESETS.includes(p)),
    ).toBe(true);
  });

  it("改名只发生在 custom → raw，其余同名", () => {
    expect(deliveryPresetOf("ntfy")).toBe("ntfy");
    expect(deliveryPresetOf("gotify")).toBe("gotify");
    expect(deliveryPresetOf("custom")).toBe("raw");
  });
});

describe("{{priority}} 映射表", () => {
  it("12 格逐项钉住（raw = severity 原文）", () => {
    expect(WEBHOOK_PRIORITY).toEqual({
      ntfy: { failure: "urgent", warning: "high", success: "low", info: "default" },
      gotify: { failure: "9", warning: "7", success: "3", info: "3" },
      raw: { failure: "failure", warning: "warning", success: "success", info: "info" },
    });
  });

  // 少一格 = 那个 severity 在出口侧静默回落到 info（用户的失败通知变成默认优先级）。
  it("三张表覆盖同一个 severity 全集", () => {
    const expected = ["failure", "info", "success", "warning"];
    for (const preset of WEBHOOK_DELIVERY_PRESETS) {
      expect(Object.keys(WEBHOOK_PRIORITY[preset]).sort(), preset).toEqual(expected);
    }
  });
});

describe("认证方式白名单", () => {
  it("取值与顺序逐项钉住（顺序即下拉顺序）", () => {
    expect([...WEBHOOK_AUTHS]).toEqual(["none", "bearer", "basic", "header"]);
  });
});

describe("单点化：两端源文件里不再有第二份副本", () => {
  it("宿主出口只消费共享面（模板与 PRIORITY 不再本地声明）", () => {
    const src = read("src/server/channels/impl/webhook/index.ts");
    for (const template of [NTFY_TEMPLATE, GOTIFY_TEMPLATE, RAW_TEMPLATE]) {
      expect(src).not.toContain(template);
    }
    expect(src).not.toMatch(/const DEFAULT_TEMPLATES/u);
    expect(src).not.toMatch(/const PRIORITY/u);
    expect(src).toMatch(/WEBHOOK_DEFAULT_TEMPLATES/u);
    expect(src).toMatch(/WEBHOOK_PRIORITY/u);
  });

  it("客户端预设表只消费共享面（认证默认值按设计仍留客户端）", () => {
    // 预设表随 webhookCard 搬到 settings/channels/webhook-card.tsx：读取对象改指卡文件，字面量与
    // 判据强度不变。index.tsx 一并扫，防「搬走时顺手复制第二份」。
    const src = read("src/client/settings/channels/webhook-card.tsx");
    const entry = read("src/client/index.tsx");
    for (const template of [NTFY_TEMPLATE, GOTIFY_TEMPLATE, RAW_TEMPLATE]) {
      expect(src).not.toContain(template);
      expect(entry).not.toContain(template);
    }
    expect(src).toMatch(/ntfy:\s*\{[^}]*template:\s*webhookTemplateOf\("ntfy"\)/u);
    expect(src).toMatch(
      /custom:\s*\{[^}]*auth:\s*"header"[^}]*template:\s*webhookTemplateOf\("custom"\)/u,
    );
  });

  it("宿主配置闸门与客户端都不再自写白名单字面量", () => {
    const input = read("src/server/config/impl/input/index.ts");
    expect(input).not.toMatch(/const WEBHOOK_PRESETS/u);
    expect(input).not.toMatch(/const WEBHOOK_AUTHS/u);
    expect(input).toMatch(/from "\.\.\/\.\.\/\.\.\/\.\.\/shared\/interface\.ts"/u);
    // 白名单消费点随 webhookCard 搬到 settings/channels/webhook-card.tsx：只改读取对象。
    const client = read("src/client/settings/channels/webhook-card.tsx");
    expect(client).not.toMatch(/\[\s*"none",\s*"bearer",\s*"basic",\s*"header"\s*\]/u);
    expect(client).toMatch(/WEBHOOK_AUTHS/u);
  });

  it("宿主路由块用共享的 preset 改名函数，不再本地维护映射表", () => {
    const src = read("src/server/pipeline/impl/route/index.ts");
    expect(src).not.toMatch(/PRESET_MAP/u);
    expect(src).toMatch(/deliveryPresetOf\(preset\)/u);
  });
});
