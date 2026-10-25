/** dsh-notifier config input 测试专属 fixture。 */

import type {
  BarkChannelConfig,
  BrowserChannelConfig,
  ChannelConfig,
  RawSettingValue,
  SettingInvalid,
  SettingsPatch,
  StoredSettings,
  SystemChannelConfig,
  WebhookChannelConfig,
} from "../../../src/server/config/impl/model/type.ts";

import { validateSettings } from "../../../src/server/config/impl/input/index.ts";

/** 绕过类型构造运行时真实存在、类型层却排除掉的脏值。 */
export function raw(value: unknown): RawSettingValue {
  return value as RawSettingValue;
}

/** 同上，用于净化面：那里的入参类型是 `StoredSettings`，标量与空值同样落不进去。 */
export function stored(value: unknown): StoredSettings {
  return value as StoredSettings;
}

/** 取校验失败载荷；放行即当场失败（否则断言会落在一个不存在的事实上）。 */
export function invalidOf(patch: SettingsPatch): SettingInvalid {
  const verdict = validateSettings(patch);
  if (verdict.ok) throw new Error(`期望判非法，实际放行：${JSON.stringify(patch)}`);
  return verdict.error;
}

/** 取归一化后的第一个出站频道并收窄到 bark（内置两条恒在最前，故按类型找而不是按下标）。 */
export function barkOf(channels: readonly ChannelConfig[]): BarkChannelConfig {
  const channel = channels.find((item) => item.type === "bark");
  if (channel?.type !== "bark") throw new Error("期望归一化出一个 bark 频道");
  return channel;
}

/** 取归一化后的第一个出站频道并收窄到 webhook。 */
export function webhookOf(channels: readonly ChannelConfig[]): WebhookChannelConfig {
  const channel = channels.find((item) => item.type === "webhook");
  if (channel?.type !== "webhook") throw new Error("期望归一化出一个 webhook 频道");
  return channel;
}

/** 取归一化后的浏览器内置条目。 */
export function browserOf(channels: readonly ChannelConfig[]): BrowserChannelConfig {
  const channel = channels.find((item) => item.type === "browser");
  if (channel?.type !== "browser") throw new Error("期望归一化出一个浏览器内置条目");
  return channel;
}

/** 取归一化后的系统内置条目。 */
export function systemOf(channels: readonly ChannelConfig[]): SystemChannelConfig {
  const channel = channels.find((item) => item.type === "system");
  if (channel?.type !== "system") throw new Error("期望归一化出一个系统内置条目");
  return channel;
}

/** 内置两条的合法提交形态：写面要求显式提交的 `channels` 仍然带着它们。 */
export const BUILTINS = [
  { type: "browser", id: "browser", enabled: true, popup: true, sound: false, whenVisible: false },
  { type: "system", id: "system", enabled: false, popup: false, sound: false },
] as const;

/** 出站频道提交体补上两条内置条目：内置不能删除，缺了它们提交会先被那条规则拦下。 */
export function withBuiltins(list: readonly Record<string, unknown>[]): RawSettingValue[] {
  return [...BUILTINS, ...list] as unknown as RawSettingValue[];
}

/** 一条内置条目，只带被测字段：缺的字段由归一化沿「存量别名 → 默认表」补齐。 */
export function builtinWithSound(
  type: "browser" | "system",
  sound: RawSettingValue,
): Record<string, RawSettingValue> {
  return { type, id: type, sound };
}

/** 合法 bark 频道：单项守卫用例以它为基底，只改被测字段。 */
export const BARK = {
  type: "bark",
  id: "bark:phone",
  baseUrl: "https://api.day.app",
  deviceKey: "key-1",
};

/** 合法 webhook 频道。 */
export const WEBHOOK = {
  type: "webhook",
  id: "webhook:hook",
  url: "https://example.test/hook",
};
