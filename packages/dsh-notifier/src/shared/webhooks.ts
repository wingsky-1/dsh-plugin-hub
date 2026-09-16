/**
 * dsh-notifier —— webhook 预设的共享面：默认模板、`{{priority}}` 映射、认证方式白名单，
 * 以及「配置层预设 → 投递层预设」的改名（纯数据 + 两个纯映射函数，只做同目录类型 import）。
 *
 * 为什么两端共用一份：客户端「选预设 → 填充模板」与宿主端「按预设渲染 body」此前各写一份
 * **逐字相同**的模板（收口时已机器比对：三对字面量逐字节相等）。漂移的症状是「设置页上看到的
 * 模板与实际发出去的 body 不是同一份」——用户既改不回默认值，也解释不了对端收到的字段。
 *
 * 两层词汇必须分开：配置层 / 设置页叫 `custom`，投递层叫 `raw`（同一个东西），改名只此一处
 * （`deliveryPresetOf`）。认证**方式**白名单是两端共有的；「预设 → 认证方式」的默认值
 * （ntfy / gotify → bearer、custom → header）只在客户端有对应物——宿主端没有「套用预设」这个
 * 动作，故那半张表留在客户端。
 */
import type { NotifySeverity } from "./kinds.ts";

/** 配置层 / 设置页的预设白名单（顺序即下拉顺序）。 */
export const WEBHOOK_PRESETS = ["ntfy", "gotify", "custom"] as const;

/** 配置层的预设。 */
export type WebhookPreset = (typeof WEBHOOK_PRESETS)[number];

/** 投递层的预设白名单（配置层的 `custom` 在投递层叫 `raw`）。 */
export const WEBHOOK_DELIVERY_PRESETS = ["ntfy", "gotify", "raw"] as const;

/** 投递层的预设。 */
export type WebhookDeliveryPreset = (typeof WEBHOOK_DELIVERY_PRESETS)[number];

/**
 * 预设默认模板（逐字保留自收口前的两份副本）。模板是 JSON 文本：`{{ts}}` 之外的空模板由宿主端
 * 渲染器回落，客户端的「恢复默认模板」直接取这里的字面量。
 */
export const WEBHOOK_DEFAULT_TEMPLATES: Readonly<Record<WebhookDeliveryPreset, string>> = {
  ntfy: '{\n  "topic": "<topic>",\n  "title": "{{title}}",\n  "message": "{{message}}",\n  "tags": ["{{kind}}"],\n  "priority": "{{priority}}"\n}',
  gotify:
    '{\n  "title": "{{title}}",\n  "message": "{{message}}",\n  "priority": "{{priority}}"\n}',
  raw: '{\n  "event": "{{kind}}",\n  "title": "{{title}}",\n  "body": "{{message}}",\n  "severity": "{{severity}}",\n  "ts": {{ts}}\n}',
};

/** `{{priority}}` 映射表（`raw` = severity 原文）；查不到即 severity 非法，视同未提供。 */
export const WEBHOOK_PRIORITY: Readonly<
  Record<WebhookDeliveryPreset, Readonly<Record<NotifySeverity, string>>>
> = {
  ntfy: { failure: "urgent", warning: "high", success: "low", info: "default" },
  gotify: { failure: "9", warning: "7", success: "3", info: "3" },
  raw: { failure: "failure", warning: "warning", success: "success", info: "info" },
};

/** 认证方式白名单（顺序即下拉顺序）。凭据一律走请求头，故没有「URL 内联凭据」这一档。 */
export const WEBHOOK_AUTHS = ["none", "bearer", "basic", "header"] as const;

/** 认证方式。 */
export type WebhookAuth = (typeof WEBHOOK_AUTHS)[number];

/** 配置层预设 → 投递层预设。两层词汇的唯一改名点。 */
export function deliveryPresetOf(preset: WebhookPreset): WebhookDeliveryPreset {
  return preset === "custom" ? "raw" : preset;
}

/** 配置层预设的默认模板（改名与查表都只此一处）。 */
export function webhookTemplateOf(preset: WebhookPreset): string {
  return WEBHOOK_DEFAULT_TEMPLATES[deliveryPresetOf(preset)];
}
