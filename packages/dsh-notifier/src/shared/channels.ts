/**
 * dsh-notifier —— 频道对外 id 的归一化（纯数据 + 纯判定，无 import）。
 *
 * 为什么两端共用一份：id 是客户端勾选（写进 `kindRoutes`）与宿主端路由（投递池里的 `channelId`）
 * 之间唯一的对齐键。两端各算一份时漂移的症状是「用户勾了频道却收不到」——客户端写进去的字符串
 * 在投递池里找不到，通知静默落回广播或整个丢掉，而两边的代码各自看起来都对。
 *
 * 规则：内置频道取裸 `type`（身份由 `type` 唯一确定，不存在实例 id），实例频道取 `type:id`。
 * 两个集合天然不相交：内置的裸 id 永远不含冒号。
 */

/** 内置频道（值即 id）。 */
export const BUILTIN_CHANNELS = { browser: "browser", system: "system" } as const;

/**
 * 内置频道类型（顺序即设置页卡片顺序）。
 *
 * 与 `BUILTIN_CHANNELS` 的键集必须逐项相等：后者是客户端「是不是内置频道」内联判定的由来，
 * 前者是宿主端内置清单的由来。`satisfies` 只保证这一侧 ⊆ 那一侧，反向相等由
 * test/unit/shared/channels.test.ts 双向断言钉住。
 */
export const BUILTIN_CHANNEL_TYPES = [
  "browser",
  "system",
] as const satisfies readonly (keyof typeof BUILTIN_CHANNELS)[];

/** 内置频道类型。 */
export type BuiltinChannelType = (typeof BUILTIN_CHANNEL_TYPES)[number];

/** 运行时成员判定：编译期联合约束不到跨边界传来的值。 */
export function isBuiltinChannelType(value: unknown): value is BuiltinChannelType {
  return typeof value === "string" && (BUILTIN_CHANNEL_TYPES as readonly string[]).includes(value);
}

/**
 * 实例频道 id：`type:id`。
 *
 * 参数刻意用窄类型（`unknown`）而不是宿主端的 `ChannelConfig`：那会把宿主类型拖进跨端面，
 * 而这里只做字符串拼接。空类型 / 空 id 归一成空串——脏配置不该产出 `undefined:undefined`
 * 这种会被当成合法 id 记账的字符串。
 */
export function channelIdFor(channel: { readonly type?: unknown; readonly id?: unknown }): string {
  return String(channel.type || "") + ":" + String(channel.id || "");
}

/** 频道对外 id：内置取裸 `type`，实例取 `type:id`。 */
export function channelIdOf(channel: { readonly type?: unknown; readonly id?: unknown }): string {
  const type = String(channel.type || "");
  return isBuiltinChannelType(type) ? type : channelIdFor(channel);
}
